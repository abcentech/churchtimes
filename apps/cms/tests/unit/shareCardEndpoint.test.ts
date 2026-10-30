import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renders: Array<{ title: string; label?: string | null; resolve: (b: Buffer) => void }> = []
let autoResolve = true

vi.mock('../../src/lib/shareCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/shareCard')>()
  return {
    ...actual,
    renderShareCard: vi.fn(
      (input: { title: string; label?: string | null }) =>
        new Promise<Buffer>((resolve) => {
          if (autoResolve) resolve(Buffer.from(`png:${input.title}`))
          else renders.push({ ...input, resolve })
        }),
    ),
  }
})

const { renderShareCard } = await import('../../src/lib/shareCard')
const {
  cardKey,
  parseCardSlug,
  resetShareCardState,
  respondShareCard,
  shareCardCacheSize,
  shareCardEndpoints,
  warmShareCard,
} = await import('../../src/endpoints/publicShareCard')

type Doc = Record<string, unknown>

function fakePayload(docs: Doc[], { kicker = false }: { kicker?: boolean } = {}) {
  const find = vi.fn(async (args: { where: { and: Array<Record<string, { equals: unknown }>> } }) => {
    const [cond] = args.where.and
    const [field, test] = Object.entries(cond!)[0]!
    const hit = docs.find((d) => d[field] === test.equals && d.status === 'published')
    return { docs: hit ? [hit] : [] }
  })
  return {
    find,
    logger: { error: vi.fn() },
    collections: {
      articles: { config: { flattenedFields: [{ name: 'title' }, ...(kicker ? [{ name: 'kicker' }] : [])] } },
    },
  }
}

function fakeReq(payload: ReturnType<typeof fakePayload>, slug: unknown, headers: Record<string, string> = {}) {
  return { payload, routeParams: { slug }, headers: new Headers(headers) } as never
}

const published: Doc = {
  id: 7,
  slug: 'bishops-meet',
  title: 'Bishops meet in Abuja',
  status: 'published',
  publishedAt: '2026-10-30T08:00:00.000Z',
  category: { id: 1, title: 'Church' },
}
const draft: Doc = { ...published, id: 8, slug: 'draft-story', status: 'draft' }

beforeEach(() => {
  process.env.SHARE_CARDS_ENABLED = 'true'
  delete process.env.SHARE_CARD_RATE_LIMIT
  delete process.env.SHARE_CARD_MAX_CONCURRENT
  delete process.env.SHARE_CARD_CACHE_MAX
  autoResolve = true
  renders.length = 0
  resetShareCardState()
  vi.mocked(renderShareCard).mockClear()
})
afterEach(() => {
  delete process.env.SHARE_CARDS_ENABLED
})

describe('parseCardSlug', () => {
  it('accepts slugs with or without .png and rejects anything else', () => {
    expect(parseCardSlug('bishops-meet')).toBe('bishops-meet')
    expect(parseCardSlug('bishops-meet.png')).toBe('bishops-meet')
    for (const bad of ['', '.png', 'Bishops', 'a--b', '../x', 'a b', 'x'.repeat(161), 7, undefined]) {
      expect(parseCardSlug(bad)).toBeNull()
    }
  })
})

describe('GET /api/public/share-card/:slug', () => {
  it('registers GET and HEAD on one path', () => {
    expect(shareCardEndpoints.map((e) => `${e.method} ${e.path}`)).toEqual([
      'get /public/share-card/:slug',
      'head /public/share-card/:slug',
    ])
  })

  it('is 404 and never touches the database when the feature is off', async () => {
    delete process.env.SHARE_CARDS_ENABLED
    const payload = fakePayload([published])
    const res = await respondShareCard(fakeReq(payload, 'bishops-meet'), true)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(payload.find).not.toHaveBeenCalled()
  })

  it('rejects an invalid slug before any lookup', async () => {
    const payload = fakePayload([published])
    expect((await respondShareCard(fakeReq(payload, '../etc'), true)).status).toBe(404)
    expect(payload.find).not.toHaveBeenCalled()
  })

  it('is 404 for unknown and unpublished articles, and only ever queries published rows', async () => {
    const payload = fakePayload([published, draft])
    expect((await respondShareCard(fakeReq(payload, 'nope'), true)).status).toBe(404)
    expect((await respondShareCard(fakeReq(payload, 'draft-story'), true)).status).toBe(404)
    for (const call of payload.find.mock.calls) {
      const args = call[0] as unknown as { where: { and: unknown[] }; overrideAccess: boolean }
      expect(args.where.and).toContainEqual({ status: { equals: 'published' } })
    }
    expect(renderShareCard).not.toHaveBeenCalled()
  })

  it('serves a cacheable PNG with an input-derived ETag, then answers 304 without rendering', async () => {
    const payload = fakePayload([published])
    const res = await respondShareCard(fakeReq(payload, 'bishops-meet.png'), true)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const etag = res.headers.get('etag')!
    expect(etag).toBe(`"${cardKey({ title: 'Bishops meet in Abuja', label: 'Church', date: '2026-10-30T08:00:00.000Z' })}"`)
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('png:Bishops meet in Abuja')

    const again = await respondShareCard(fakeReq(payload, 'bishops-meet', { 'if-none-match': etag }), true)
    expect(again.status).toBe(304)
    expect(renderShareCard).toHaveBeenCalledTimes(1)
  })

  it('serves repeat requests from the in-process cache', async () => {
    const payload = fakePayload([published])
    await respondShareCard(fakeReq(payload, 'bishops-meet'), true)
    await respondShareCard(fakeReq(payload, 'bishops-meet'), true)
    expect(renderShareCard).toHaveBeenCalledTimes(1)
  })

  it('HEAD has the headers and no body', async () => {
    const res = await respondShareCard(fakeReq(fakePayload([published]), 'bishops-meet'), false)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String('png:Bishops meet in Abuja'.length))
    expect(res.body).toBeNull()
  })

  it('uses the kicker as the label when the field exists, else the category', async () => {
    const payload = fakePayload([{ ...published, kicker: 'Exclusive' }], { kicker: true })
    await respondShareCard(fakeReq(payload, 'bishops-meet'), true)
    expect(vi.mocked(renderShareCard).mock.calls[0]![0].label).toBe('Exclusive')
    const select = (payload.find.mock.calls[0]![0] as unknown as { select: Record<string, boolean> }).select
    expect(select.kicker).toBe(true)

    resetShareCardState()
    const older = fakePayload([{ ...published, kicker: 'ignored' }])
    await respondShareCard(fakeReq(older, 'bishops-meet'), true)
    expect(vi.mocked(renderShareCard).mock.calls.at(-1)![0].label).toBe('Church')
    expect((older.find.mock.calls[0]![0] as unknown as { select: Record<string, boolean> }).select.kicker).toBeUndefined()
  })

  it('rate-limits per client with 429 and Retry-After', async () => {
    process.env.SHARE_CARD_RATE_LIMIT = '2'
    resetShareCardState()
    const payload = fakePayload([published])
    await respondShareCard(fakeReq(payload, 'bishops-meet'), true)
    await respondShareCard(fakeReq(payload, 'bishops-meet'), true)
    const res = await respondShareCard(fakeReq(payload, 'bishops-meet'), true)
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('caps concurrent renders (503 + Retry-After) and shares one render between identical requests', async () => {
    process.env.SHARE_CARD_MAX_CONCURRENT = '1'
    autoResolve = false
    const docs = [published, { ...published, id: 9, slug: 'second-story', title: 'Second' }]
    const payload = fakePayload(docs)
    const first = respondShareCard(fakeReq(payload, 'bishops-meet'), true)
    const same = respondShareCard(fakeReq(payload, 'bishops-meet'), true)
    await vi.waitFor(() => expect(renders).toHaveLength(1))
    const busy = await respondShareCard(fakeReq(payload, 'second-story'), true)
    expect(busy.status).toBe(503)
    expect(busy.headers.get('retry-after')).toBe('5')
    renders[0]!.resolve(Buffer.from('png'))
    expect((await first).status).toBe(200)
    expect((await same).status).toBe(200)
    expect(renderShareCard).toHaveBeenCalledTimes(1)
  })

  it('answers 503 (not 500) when rendering fails, and logs no article data', async () => {
    vi.mocked(renderShareCard).mockRejectedValueOnce(new Error('boom: Bishops meet in Abuja'))
    const payload = fakePayload([published])
    const res = await respondShareCard(fakeReq(payload, 'bishops-meet'), true)
    expect(res.status).toBe(503)
    expect(JSON.stringify(payload.logger.error.mock.calls)).not.toContain('Bishops')
  })

  it('bounds the cache by entry count', async () => {
    process.env.SHARE_CARD_CACHE_MAX = '2'
    const docs = ['a', 'b', 'c'].map((s, i) => ({ ...published, id: i + 1, slug: `story-${s}`, title: s }))
    const payload = fakePayload(docs)
    for (const d of docs) await respondShareCard(fakeReq(payload, d.slug), true)
    expect(shareCardCacheSize().entries).toBe(2)
  })
})

describe('warmShareCard', () => {
  it('renders a published article into the cache and refuses drafts or a disabled feature', async () => {
    const payload = fakePayload([published, draft])
    expect(await warmShareCard(payload as never, 7)).toBe(true)
    expect(shareCardCacheSize().entries).toBe(1)
    expect(await warmShareCard(payload as never, 8)).toBe(false)
    delete process.env.SHARE_CARDS_ENABLED
    expect(await warmShareCard(payload as never, 7)).toBe(false)
  })
})
