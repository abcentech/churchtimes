import { randomBytes } from 'node:crypto'

import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Go-live C3. Real REST handlers, real PostgreSQL (embedded), real hooks and real uploaded images. No mocks.
 */

const runId = newRunId()
const ALLOWED_ORIGIN = 'http://allowed.test' // PUBLIC_SUBMISSION_ORIGINS in tests/integration/global-setup.ts
let f: Fixtures
let advertiserId: number
const CMS_URL = 'http://cms.test'
const savedCmsUrl = process.env.CMS_PUBLIC_URL

const messages = (res: { json: any }): string => JSON.stringify(res.json?.errors ?? res.json)
const iso = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

const solid = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } })

type Media = { id: number; filename: string }
const media: Record<string, Media> = {}

async function upload(token: string, label: string, buf: Buffer, mime: string, ext: string): Promise<Media> {
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt: `${runId} ${label}` }))
  form.set('file', new Blob([new Uint8Array(buf)], { type: mime }), `${runId}-${label}.${ext}`)
  const res = await api('POST', '/api/media', { token, body: form })
  expect(res.status, messages(res)).toBe(201)
  return { id: res.json.doc.id as number, filename: res.json.doc.filename as string }
}

beforeAll(async () => {
  process.env.CMS_PUBLIC_URL = CMS_URL
  f = await setupFixtures(runId)
  const adv = await f.payload.create({
    collection: 'advertisers',
    data: { name: `${runId} Secret Advertiser Ltd`, contactName: 'Pat Contact', contactEmail: 'pat@adv-secret.test', notes: 'internal-note-xyz' },
    overrideAccess: true,
  })
  advertiserId = (adv as { id: number }).id
  const t = f.tokens.eic
  media.bbDesktop = await upload(t, 'bb-desktop', await solid(970, 250).webp().toBuffer(), 'image/webp', 'webp')
  media.bbMobile = await upload(t, 'bb-mobile', await solid(320, 100).png().toBuffer(), 'image/png', 'png')
  media.inDesktop = await upload(t, 'in-desktop', await solid(728, 90).jpeg().toBuffer(), 'image/jpeg', 'jpg')
  media.inMobile = await upload(t, 'in-mobile', await solid(320, 100).webp().toBuffer(), 'image/webp', 'webp')
  media.mbMobile = await upload(t, 'mb-mobile', await solid(320, 50).png().toBuffer(), 'image/png', 'png')
  media.wrong = await upload(t, 'wrong-size', await solid(300, 100).png().toBuffer(), 'image/png', 'png')
  const noise = await sharp(randomBytes(970 * 250 * 3), { raw: { width: 970, height: 250, channels: 3 } }).png().toBuffer()
  media.big = await upload(t, 'too-big', noise, 'image/png', 'png')
  // Two 320x50 frames stacked and flagged as pages: sharp writes an animated WebP.
  const frames = Buffer.concat([
    await solid(320, 50).raw().toBuffer(),
    await sharp({ create: { width: 320, height: 50, channels: 3, background: '#cc3333' } }).raw().toBuffer(),
  ])
  const animated = await sharp(frames, { raw: { width: 320, height: 100, channels: 3, pageHeight: 50 } }).webp().toBuffer()
  media.animated = await upload(t, 'animated', animated, 'image/webp', 'webp')
})

const wipeCampaigns = async () => {
  const db = f.payload.db
  await db.deleteMany({ collection: 'ad-campaigns', where: { sponsor: { like: runId } }, req: undefined as never })
}

afterEach(wipeCampaigns)

afterAll(async () => {
  await wipeCampaigns().catch(() => undefined)
  await f?.payload.db.deleteMany({ collection: 'advertisers', where: { name: { like: runId } }, req: undefined as never }).catch(() => undefined)
  await f?.payload.delete({ collection: 'audit-logs', where: { summary: { like: runId } }, overrideAccess: true }).catch(() => undefined)
  await f?.cleanup()
  if (savedCmsUrl === undefined) delete process.env.CMS_PUBLIC_URL
  else process.env.CMS_PUBLIC_URL = savedCmsUrl
})

const creativesFull = () => ({
  homepageBillboard: { desktop: media.bbDesktop!.id, mobile: media.bbMobile!.id },
})

let n = 0
const body = (extra: Record<string, unknown> = {}) => ({
  advertiser: advertiserId,
  sponsor: `${runId} sponsor ${++n}`,
  alt: 'A very good offer',
  destinationUrl: 'https://example.test/offer',
  placements: ['homepage-billboard'],
  creatives: creativesFull(),
  startsAt: iso(-3600),
  endsAt: iso(3600),
  priority: 10,
  ...extra,
})

const create = (token: string, extra: Record<string, unknown> = {}) =>
  api('POST', '/api/ad-campaigns', { token, body: body(extra) })
/** Approving requires the version the approver reviewed: attach the current `updatedAt` unless the test sets it itself. */
const patch = async (token: string, id: number, data: Record<string, unknown>) => {
  let body = data
  if (data.status === 'approved' && !('expectedUpdatedAt' in data)) {
    const cur = await api('GET', `/api/ad-campaigns/${id}?depth=0`, { token })
    body = { ...data, expectedUpdatedAt: cur.json?.updatedAt }
  }
  return api('PATCH', `/api/ad-campaigns/${id}`, { token, body })
}

/** A campaign that satisfies the whole approval gate, still in `draft`. */
async function ready(extra: Record<string, unknown> = {}): Promise<{ id: number; sponsor: string }> {
  const res = await create(f.tokens.eic, { rightsConfirmed: true, paymentStatus: 'paid', ...extra })
  expect(res.status, messages(res)).toBe(201)
  return { id: res.json.doc.id as number, sponsor: res.json.doc.sponsor as string }
}
async function live(extra: Record<string, unknown> = {}) {
  const c = await ready(extra)
  const res = await patch(f.tokens.eic, c.id, { status: 'approved' })
  expect(res.status, messages(res)).toBe(200)
  return c
}

const ads = (headers: Record<string, string> = {}) => api('GET', '/api/public/advertising', { headers })
const mine = (res: { json: any }) => (res.json.campaigns as any[]).filter((c) => String(c.sponsor).startsWith(runId))
const fileStatus = async (m: Media) => (await api('GET', `/api/media/file/${m.filename}`)).status

describe('staff access (C3.1)', () => {
  it('only admin and editor-in-chief can read or write advertisers and campaigns', async () => {
    const c = await ready()
    for (const key of ['reporter', 'sectionEditor', 'trusted'] as const) {
      const t = f.tokens[key]
      expect((await api('GET', '/api/advertisers', { token: t })).status, key).toBe(403)
      expect((await api('POST', '/api/advertisers', { token: t, body: { name: `${runId} x` } })).status, key).toBe(403)
      expect((await api('GET', '/api/ad-campaigns', { token: t })).status, key).toBe(403)
      expect((await api('GET', `/api/ad-campaigns/${c.id}`, { token: t })).status, key).toBe(403)
      expect((await create(t)).status, key).toBe(403)
      expect((await patch(t, c.id, { priority: 1 })).status, key).toBe(403)
    }
    expect((await api('GET', '/api/advertisers')).status).toBe(403)
    expect((await api('GET', '/api/ad-campaigns')).status).toBe(403)
    expect((await api('GET', `/api/ad-campaigns/${c.id}`)).status).toBe(403)
    expect((await create(f.tokens.admin)).status).toBe(201)
    expect((await api('GET', '/api/advertisers', { token: f.tokens.eic })).status).toBe(200)
  })

  it('refuses to delete an advertiser that still has campaigns, and an approved campaign', async () => {
    const adv = await api('POST', '/api/advertisers', { token: f.tokens.eic, body: { name: `${runId} Temp Adv` } })
    expect(adv.status).toBe(201)
    const c = await create(f.tokens.eic, { advertiser: adv.json.doc.id })
    expect(c.status).toBe(201)
    expect((await api('DELETE', `/api/advertisers/${adv.json.doc.id}`, { token: f.tokens.eic })).status).toBe(409)
    const a = await live()
    expect((await api('DELETE', `/api/ad-campaigns/${a.id}`, { token: f.tokens.eic })).status).toBe(409)
    expect((await api('DELETE', `/api/ad-campaigns/${c.json.doc.id}`, { token: f.tokens.eic })).status).toBe(200)
    expect((await api('DELETE', `/api/advertisers/${adv.json.doc.id}`, { token: f.tokens.eic })).status).toBe(200)
  })
})

describe('field validation', () => {
  it('rejects bad destination URLs, dates and priority', async () => {
    for (const destinationUrl of ['http://example.test', 'javascript:alert(1)', 'https://u:p@example.test', '/relative', 'https://a b.test']) {
      const res = await create(f.tokens.eic, { destinationUrl })
      expect(res.status, destinationUrl).toBe(400)
    }
    expect((await create(f.tokens.eic, { startsAt: iso(100), endsAt: iso(50) })).status).toBe(400)
    expect((await create(f.tokens.eic, { startsAt: iso(100), endsAt: iso(100) })).status).toBe(400)
    expect((await create(f.tokens.eic, { startsAt: '2026-10-14T00:00:00', endsAt: '2026-10-15T00:00:00' })).status).toBe(400)
    expect((await create(f.tokens.eic, { priority: 101 })).status).toBe(400)
    expect((await create(f.tokens.eic, { priority: -1 })).status).toBe(400)
    expect((await create(f.tokens.eic, { sponsor: 'x'.repeat(101) })).status).toBe(400)
    expect((await create(f.tokens.eic, { alt: 'x'.repeat(241) })).status).toBe(400)
    expect((await create(f.tokens.eic, { placements: ['sidebar'] })).status).toBe(400)
    expect((await create(f.tokens.eic, { placements: [] })).status).toBe(400)
  })

  it('strips markup from the public text fields', async () => {
    const res = await create(f.tokens.eic, { sponsor: `${runId} <b>Bold</b> Co`, alt: 'Offer <script>x()</script>now' })
    expect(res.status, messages(res)).toBe(201)
    expect(res.json.doc.sponsor).toBe(`${runId} Bold Co`)
    expect(res.json.doc.alt).toBe('Offer now')
  })
})

describe('creative checks', () => {
  it('requires the exact size per placement and variant', async () => {
    let res = await create(f.tokens.eic, { creatives: { homepageBillboard: { desktop: media.wrong!.id, mobile: media.bbMobile!.id } } })
    expect(res.status).toBe(400)
    expect(messages(res)).toMatch(/970x250/)
    // 320x100 is not a 320x50 mobile banner, and a billboard desktop slot does not take an article-inline size
    res = await create(f.tokens.eic, { placements: ['mobile-banner'], creatives: { mobileBanner: { mobile: media.bbMobile!.id } } })
    expect(res.status).toBe(400)
    expect(messages(res)).toMatch(/320x50/)
    res = await create(f.tokens.eic, { creatives: { homepageBillboard: { desktop: media.inDesktop!.id, mobile: media.bbMobile!.id } } })
    expect(res.status).toBe(400)
  })

  it('accepts the three placements with their sizes, in JPEG, PNG and WebP', async () => {
    const res = await create(f.tokens.eic, {
      placements: ['homepage-billboard', 'article-inline', 'mobile-banner'],
      creatives: {
        homepageBillboard: { desktop: media.bbDesktop!.id, mobile: media.bbMobile!.id },
        articleInline: { desktop: media.inDesktop!.id, mobile: media.inMobile!.id },
        mobileBanner: { mobile: media.mbMobile!.id },
      },
    })
    expect(res.status, messages(res)).toBe(201)
    expect((res.json.doc.creativeMedia as any[]).length).toBe(5)
  })

  it('rejects files above 500 KB and animated images', async () => {
    let res = await create(f.tokens.eic, { creatives: { homepageBillboard: { desktop: media.big!.id, mobile: media.bbMobile!.id } } })
    expect(res.status).toBe(400)
    expect(messages(res)).toMatch(/500 KB/)
    res = await create(f.tokens.eic, { placements: ['mobile-banner'], creatives: { mobileBanner: { mobile: media.animated!.id } } })
    expect(res.status, messages(res)).toBe(400)
    expect(messages(res)).toMatch(/animated/)
  })

  it('only derives creativeMedia from the selected placements (server-owned)', async () => {
    const res = await create(f.tokens.eic, {
      creatives: { ...creativesFull(), articleInline: { desktop: media.inDesktop!.id, mobile: media.inMobile!.id } },
      creativeMedia: [media.mbMobile!.id],
    })
    expect(res.status, messages(res)).toBe(201)
    const ids = (res.json.doc.creativeMedia as any[]).map((m) => (typeof m === 'object' ? m.id : m)).sort()
    expect(ids).toEqual([media.bbDesktop!.id, media.bbMobile!.id].sort())
  })
})

describe('approval and payment gating', () => {
  it('blocks approval without rights, a full creative set or payment', async () => {
    const c = await create(f.tokens.eic)
    expect(c.status).toBe(201)
    const id = c.json.doc.id as number
    let res = await patch(f.tokens.eic, id, { status: 'approved' })
    expect(res.status).toBe(400)
    expect(messages(res)).toMatch(/rights/i)
    expect(messages(res)).toMatch(/Payment/)
    res = await patch(f.tokens.eic, id, { rightsConfirmed: true, status: 'approved' })
    expect(res.status).toBe(400)
    expect(messages(res)).not.toMatch(/rights/i)
    expect((await patch(f.tokens.eic, id, { rightsConfirmed: true })).status).toBe(200) // the failed request changed nothing
    res = await patch(f.tokens.eic, id, { paymentStatus: 'invoiced', status: 'approved' })
    expect(res.status).toBe(400)
    // incomplete creative set
    const partial = await create(f.tokens.eic, { rightsConfirmed: true, paymentStatus: 'paid', creatives: { homepageBillboard: { desktop: media.bbDesktop!.id } } })
    expect(partial.status).toBe(201)
    res = await patch(f.tokens.eic, partial.json.doc.id, { status: 'approved' })
    expect(res.status).toBe(400)
    expect(messages(res)).toMatch(/homepage-billboard mobile/)
    res = await patch(f.tokens.eic, id, { paymentStatus: 'paid', status: 'approved' })
    expect(res.status, messages(res)).toBe(200)
    expect(res.json.doc.status).toBe('approved')
  })

  it('records approvedBy/approvedAt on the server and ignores client values', async () => {
    const c = await ready()
    const res = await patch(f.tokens.eic, c.id, { status: 'approved', approvedBy: f.users.admin.id, approvedAt: '2000-01-01T00:00:00Z' })
    expect(res.status, messages(res)).toBe(200)
    const by = res.json.doc.approvedBy
    expect(typeof by === 'object' ? by.id : by).toBe(f.users.eic.id)
    expect(new Date(res.json.doc.approvedAt).getFullYear()).toBeGreaterThan(2000)
  })

  it('waived is admin-only', async () => {
    const c = await create(f.tokens.eic)
    expect((await patch(f.tokens.eic, c.json.doc.id, { paymentStatus: 'waived' })).status).toBe(403)
    expect((await create(f.tokens.eic, { paymentStatus: 'waived' })).status).toBe(403)
    expect((await patch(f.tokens.admin, c.json.doc.id, { paymentStatus: 'waived' })).status).toBe(200)
    // an editor-in-chief can still edit other fields of a campaign an admin waived
    expect((await patch(f.tokens.eic, c.json.doc.id, { priority: 5 })).status).toBe(200)
    const ok = await patch(f.tokens.admin, c.json.doc.id, { rightsConfirmed: true, status: 'approved' })
    expect(ok.status, messages(ok)).toBe(200)
  })

  it('ADS_REQUIRE_PAYMENT=false lifts the payment gate only', async () => {
    const saved = process.env.ADS_REQUIRE_PAYMENT
    process.env.ADS_REQUIRE_PAYMENT = 'false'
    try {
      const c = await create(f.tokens.eic, { rightsConfirmed: true })
      expect((await patch(f.tokens.eic, c.json.doc.id, { status: 'approved' })).status).toBe(200)
      expect(mine(await ads())).toHaveLength(1)
      const noRights = await create(f.tokens.eic)
      expect((await patch(f.tokens.eic, noRights.json.doc.id, { status: 'approved' })).status).toBe(400)
    } finally {
      if (saved === undefined) delete process.env.ADS_REQUIRE_PAYMENT
      else process.env.ADS_REQUIRE_PAYMENT = saved
    }
  })

  it('sends an approved campaign back to pending_approval when a public field changes or payment lapses', async () => {
    const c = await live()
    let res = await patch(f.tokens.eic, c.id, { alt: 'A different offer' })
    expect(res.status).toBe(200)
    expect(res.json.doc.status).toBe('pending_approval')
    expect(res.json.doc.approvedBy ?? null).toBeNull()
    expect(mine(await ads())).toHaveLength(0)

    // re-approve, then change only a non-public field: stays approved
    expect((await patch(f.tokens.eic, c.id, { status: 'approved' })).json.doc.status).toBe('approved')
    res = await patch(f.tokens.eic, c.id, { advertiser: advertiserId })
    expect(res.json.doc.status).toBe('approved')

    // a creative swap and a date change are public changes too
    res = await patch(f.tokens.eic, c.id, { creatives: { homepageBillboard: { mobile: media.bbMobile!.id } } })
    expect(res.json.doc.status).toBe('approved') // same creative: not a change
    res = await patch(f.tokens.eic, c.id, { endsAt: iso(7200) })
    expect(res.json.doc.status).toBe('pending_approval')

    // payment lapsing on an approved campaign stops delivery too
    expect((await patch(f.tokens.eic, c.id, { status: 'approved' })).json.doc.status).toBe('approved')
    res = await patch(f.tokens.eic, c.id, { paymentStatus: 'unpaid' })
    expect(res.json.doc.status).toBe('pending_approval')
    expect(mine(await ads())).toHaveLength(0)
  })

  it('writes an audit row for create, status transitions and updates, without payment or contact data', async () => {
    const c = await ready()
    await patch(f.tokens.eic, c.id, { status: 'approved' })
    await patch(f.tokens.eic, c.id, { status: 'paused' })
    const rows = (
      await f.payload.find({
        collection: 'audit-logs',
        where: { and: [{ collection: { equals: 'ad-campaigns' } }, { docId: { equals: String(c.id) } }] },
        sort: 'createdAt',
        limit: 20,
        overrideAccess: true,
      })
    ).docs as any[]
    expect(rows.map((r) => r.action)).toEqual(['ad-campaign.create', 'ad-campaign.status', 'ad-campaign.status'])
    expect(rows[1].fromStatus).toBe('draft')
    expect(rows[1].toStatus).toBe('approved')
    expect(rows[2].toStatus).toBe('paused')
    expect(rows[1].actor === f.users.eic.id || rows[1].actor?.id === f.users.eic.id).toBe(true)
    expect(JSON.stringify(rows)).not.toMatch(/pat@adv-secret|internal-note|Secret Advertiser/)
  })
})

describe('GET /api/public/advertising (C3.2)', () => {
  it('returns exactly the contract shape for a live campaign and nothing staff-only', async () => {
    const c = await live({ priority: 42 })
    const res = await ads()
    expect(res.status).toBe(200)
    expect(res.json.adsense).toEqual({ enabled: false, reviewed: false })
    const [one] = mine(res)
    expect(one).toEqual({
      id: `ac_${c.id}`,
      status: 'active',
      sponsor: c.sponsor,
      alt: 'A very good offer',
      destinationUrl: 'https://example.test/offer',
      startsAt: expect.stringMatching(/Z$/),
      endsAt: expect.stringMatching(/Z$/),
      priority: 42,
      placements: ['homepage-billboard'],
      creatives: {
        'homepage-billboard': {
          desktop: { src: `${CMS_URL}/api/media/file/${media.bbDesktop!.filename}`, width: 970, height: 250 },
          mobile: { src: `${CMS_URL}/api/media/file/${media.bbMobile!.filename}`, width: 320, height: 100 },
        },
      },
    })
    expect(Object.keys(res.json)).toEqual(['campaigns', 'adsense'])
    expect(res.text).not.toMatch(/Secret Advertiser|pat@adv-secret|internal-note|paymentStatus|paid|approvedBy|rightsConfirmed|advertiser"/)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('shows only approved, paid-or-waived campaigns inside their window', async () => {
    const draft = await ready()
    const paused = await live()
    await patch(f.tokens.eic, paused.id, { status: 'paused' })
    const cancelled = await live()
    await patch(f.tokens.eic, cancelled.id, { status: 'cancelled' })
    const future = await live({ startsAt: iso(600), endsAt: iso(7200) })
    const past = await live({ startsAt: iso(-7200), endsAt: iso(-600) })
    const lapsed = await live()
    // payment lapses without going through the hooks (e.g. a manual database change): delivery still stops
    await f.payload.db.updateOne({ collection: 'ad-campaigns', id: lapsed.id, data: { paymentStatus: 'unpaid' }, returning: false } as never)
    const ok = await live()
    const res = await ads()
    expect(mine(res).map((c) => c.id)).toEqual([`ac_${ok.id}`])
    for (const c of [draft, paused, cancelled, future, past, lapsed]) expect(res.text).not.toContain(c.sponsor)
  })

  it('start is inclusive and end is exclusive against the database clock', async () => {
    const c = await live({ startsAt: iso(-3600), endsAt: iso(3600) })
    const set = (startsAt: string, endsAt: string) =>
      f.payload.db.updateOne({ collection: 'ad-campaigns', id: c.id, data: { startsAt, endsAt }, returning: false } as never)
    await set(iso(-1), iso(60))
    expect(mine(await ads())).toHaveLength(1)
    await set(iso(-60), iso(-0.001))
    expect(mine(await ads())).toHaveLength(0)
    await set(iso(0.5), iso(60))
    expect(mine(await ads())).toHaveLength(0)
  })

  it('orders by priority, highest first', async () => {
    const low = await live({ priority: 1 })
    const high = await live({ priority: 90 })
    const mid = await live({ priority: 50 })
    expect(mine(await ads()).map((c) => c.id)).toEqual([`ac_${high.id}`, `ac_${mid.id}`, `ac_${low.id}`])
  })

  it('sets max-age to min(60, seconds to the next boundary)', async () => {
    await live({ startsAt: iso(-3600), endsAt: iso(3600) })
    expect((await ads()).headers.get('cache-control')).toBe('public, max-age=60')
    const soon = await live({ startsAt: iso(-3600), endsAt: iso(20) })
    let cc = (await ads()).headers.get('cache-control')!
    let age = Number(/max-age=(\d+)/.exec(cc)![1])
    expect(age).toBeLessThanOrEqual(20)
    expect(age).toBeGreaterThanOrEqual(17)
    // an upcoming start counts too
    await patch(f.tokens.eic, soon.id, { status: 'paused' })
    await live({ startsAt: iso(11), endsAt: iso(7200) })
    cc = (await ads()).headers.get('cache-control')!
    age = Number(/max-age=(\d+)/.exec(cc)![1])
    expect(age).toBeLessThanOrEqual(11)
    expect(cc).toMatch(/^public, max-age=\d+$/)
  })

  it('never lets a campaign outlive its end because of the cache header', async () => {
    const c = await live()
    await f.payload.db.updateOne({ collection: 'ad-campaigns', id: c.id, data: { endsAt: iso(2.5) }, returning: false } as never)
    const res = await ads()
    expect(mine(res)).toHaveLength(1)
    expect(Number(/max-age=(\d+)/.exec(res.headers.get('cache-control')!)![1])).toBeLessThanOrEqual(2)
  })

  it('sends an ETag for CDNs and answers a forwarded If-None-Match with 304', async () => {
    await live()
    const first = await ads()
    const etag = first.headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/)
    const again = await ads({ 'If-None-Match': etag })
    expect(again.status).toBe(304)
    expect(again.text).toBe('')
    expect((await ads({ 'If-None-Match': '"other"' })).status).toBe(200)
  })

  it('reports the AdSense flags from configuration and never a publisher id', async () => {
    const saved = { e: process.env.PUBLIC_ADSENSE_ENABLED, r: process.env.PUBLIC_ADSENSE_REVIEWED, p: process.env.ADSENSE_PUBLISHER_ID }
    process.env.PUBLIC_ADSENSE_ENABLED = 'true'
    process.env.PUBLIC_ADSENSE_REVIEWED = 'TRUE'
    process.env.ADSENSE_PUBLISHER_ID = 'pub-1234567890'
    try {
      const res = await ads()
      expect(res.json.adsense).toEqual({ enabled: true, reviewed: true })
      expect(res.text).not.toContain('pub-1234567890')
    } finally {
      for (const [k, v] of [['PUBLIC_ADSENSE_ENABLED', saved.e], ['PUBLIC_ADSENSE_REVIEWED', saved.r], ['ADSENSE_PUBLISHER_ID', saved.p]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    expect((await ads()).json.adsense).toEqual({ enabled: false, reviewed: false })
  })

  it('applies the Origin allowlist and exposes no extra headers', async () => {
    const none = await ads()
    expect(none.status).toBe(200)
    expect(none.headers.get('access-control-allow-origin')).toBeNull()

    const ok = await ads({ Origin: ALLOWED_ORIGIN })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull()
    expect(ok.headers.get('access-control-expose-headers')).toBeNull()
    expect(ok.headers.get('access-control-allow-headers') ?? '').not.toMatch(/if-none-match/i)
    expect(ok.headers.get('vary')).toMatch(/Origin/)

    const denied = await ads({ Origin: 'http://evil.test' })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    expect(denied.headers.get('cache-control')).toBe('no-store')

    const pre = await api('OPTIONS', '/api/public/advertising', { headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'GET' } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect((await api('OPTIONS', '/api/public/advertising', { headers: { Origin: 'http://evil.test' } })).status).toBe(403)
  })
})

describe('creative media privacy', () => {
  it('is private until the campaign is delivered and private again when it stops', async () => {
    const c = await ready()
    expect(await fileStatus(media.bbDesktop!)).toBe(403)
    expect((await api('GET', `/api/media/${media.bbDesktop!.id}`)).status).toBe(404)

    await patch(f.tokens.eic, c.id, { status: 'approved' })
    expect(await fileStatus(media.bbDesktop!)).toBe(200)
    expect(await fileStatus(media.bbMobile!)).toBe(200)
    expect((await api('GET', `/api/media/${media.bbDesktop!.id}`)).status).toBe(200)
    // creatives of other placements/campaigns stay private
    expect(await fileStatus(media.inDesktop!)).toBe(403)

    await patch(f.tokens.eic, c.id, { status: 'paused' })
    expect(await fileStatus(media.bbDesktop!)).toBe(403)

    await patch(f.tokens.eic, c.id, { status: 'approved' })
    expect(await fileStatus(media.bbDesktop!)).toBe(200)

    // the end of the window flips it without any write through the hooks
    await f.payload.db.updateOne({ collection: 'ad-campaigns', id: c.id, data: { endsAt: iso(-1) }, returning: false } as never)
    expect(await fileStatus(media.bbDesktop!)).toBe(403)
    await f.payload.db.updateOne({ collection: 'ad-campaigns', id: c.id, data: { endsAt: iso(3600), startsAt: iso(600) }, returning: false } as never)
    expect(await fileStatus(media.bbDesktop!)).toBe(403) // not started yet
    await f.payload.db.updateOne({ collection: 'ad-campaigns', id: c.id, data: { startsAt: iso(-60) }, returning: false } as never)
    expect(await fileStatus(media.bbDesktop!)).toBe(200)
    await f.payload.db.updateOne({ collection: 'ad-campaigns', id: c.id, data: { paymentStatus: 'unpaid' }, returning: false } as never)
    expect(await fileStatus(media.bbDesktop!)).toBe(403)
  })

  it('does not publish a creative of a placement that is not selected', async () => {
    await live({
      creatives: { ...creativesFull(), articleInline: { desktop: media.inDesktop!.id, mobile: media.inMobile!.id } },
    })
    expect(await fileStatus(media.bbDesktop!)).toBe(200)
    expect(await fileStatus(media.inDesktop!)).toBe(403)
  })

  it('freezes the creative of an approved campaign against non-editor edits', async () => {
    const reporterMedia = await upload(f.tokens.reporter, 'reporter-creative', await solid(320, 50).png().toBuffer(), 'image/png', 'png')
    const c = await ready({ placements: ['mobile-banner'], creatives: { mobileBanner: { mobile: reporterMedia.id } } })
    const edit = () => api('PATCH', `/api/media/${reporterMedia.id}`, { token: f.tokens.reporter, body: { alt: `${runId} renamed` } })
    expect((await edit()).status).toBe(200)
    await patch(f.tokens.eic, c.id, { status: 'approved' })
    expect((await edit()).status).toBe(403)
  })
})

const setMediaDims = (id: number, width: number, height: number) =>
  f.payload.db.updateOne({ collection: 'media', id, data: { width, height }, returning: false } as never)

const replaceFile = async (token: string, m: Media, buf: Buffer) => {
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt: `${runId} replaced` }))
  form.set('file', new Blob([new Uint8Array(buf)], { type: 'image/png' }), `${runId}-replacement.png`)
  return api('PATCH', `/api/media/${m.id}`, { token, body: form })
}

describe('review fixes (M1, M2, S1 to S9)', () => {
  it('M1: no role can replace the file of a creative of an approved or pending campaign, single or bulk', async () => {
    const own = await upload(f.tokens.eic, 'm1-creative', await solid(320, 50).png().toBuffer(), 'image/png', 'png')
    const c = await ready({ placements: ['mobile-banner'], creatives: { mobileBanner: { mobile: own.id } } })
    const replacement = await solid(320, 50).png({ compressionLevel: 9 }).toBuffer()
    // draft: replacing is still possible (nothing was approved on the strength of this file)
    const draftReplace = await replaceFile(f.tokens.sectionEditor, own, replacement)
    expect(draftReplace.status, messages(draftReplace)).toBe(200)

    for (const status of ['approved', 'pending_approval'] as const) {
      const fresh = await upload(f.tokens.eic, `m1-${status}`, await solid(320, 50).png().toBuffer(), 'image/png', 'png')
      await patch(f.tokens.eic, c.id, { creatives: { mobileBanner: { mobile: fresh.id } } })
      expect((await patch(f.tokens.eic, c.id, { status: 'approved' })).status).toBe(200)
      if (status === 'pending_approval') await patch(f.tokens.eic, c.id, { status: 'pending_approval' })
      for (const key of ['sectionEditor', 'eic', 'admin'] as const) {
        const res = await replaceFile(f.tokens[key], fresh, replacement)
        expect(res.status, `${status} ${key}`).toBe(403)
      }
      // bulk update with a file, targeting the creative by its alt
      const bulkForm = new FormData()
      bulkForm.set('_payload', JSON.stringify({ alt: `${runId} m1-${status}` }))
      bulkForm.set('file', new Blob([new Uint8Array(replacement)], { type: 'image/png' }), `${runId}-bulk.png`)
      const bulk = await api('PATCH', `/api/media?where[alt][equals]=${encodeURIComponent(`${runId} m1-${status}`)}`, {
        token: f.tokens.eic,
        body: bulkForm,
      })
      expect(bulk.status, `bulk ${status}`).toBe(403)
      // the stored file is untouched
      expect(await fileStatus({ ...fresh })).toBe(status === 'approved' ? 200 : 403)
    }
    // paused and cancelled campaigns no longer protect the file
    await patch(f.tokens.eic, c.id, { status: 'paused' })
    const cur = (await f.payload.findByID({ collection: 'ad-campaigns', id: c.id, depth: 0, overrideAccess: true })) as any
    const mediaId = cur.creatives.mobileBanner.mobile as number
    const res = await replaceFile(f.tokens.eic, { id: mediaId, filename: '' }, replacement)
    expect(res.status, messages(res)).toBe(200)
  })

  it('M2: pausing, cancelling and editing never re-run creative checks (a corrupt creative cannot trap a live campaign)', async () => {
    const own = await upload(f.tokens.eic, 'm2-creative', await solid(320, 50).png().toBuffer(), 'image/png', 'png')
    const c = await live({ placements: ['mobile-banner'], creatives: { mobileBanner: { mobile: own.id } } })
    await setMediaDims(own.id, 1, 1) // what a bad import or a manual change could leave behind
    let res = await patch(f.tokens.eic, c.id, { status: 'paused' })
    expect(res.status, messages(res)).toBe(200)
    res = await patch(f.tokens.eic, c.id, { priority: 3 })
    expect(res.status, messages(res)).toBe(200)
    res = await patch(f.tokens.eic, c.id, { status: 'cancelled' })
    expect(res.status, messages(res)).toBe(200)
    // but approving the broken creative is refused
    res = await patch(f.tokens.eic, c.id, { status: 'approved' })
    expect(res.status).toBe(400)
    expect(messages(res)).toMatch(/320x50/)
  })

  it('S1: approving needs the version that was reviewed (409 when it changed, 400 when missing)', async () => {
    const c = await ready()
    const id = c.id
    const missing = await api('PATCH', `/api/ad-campaigns/${id}`, { token: f.tokens.eic, body: { status: 'approved' } })
    expect(missing.status).toBe(400)
    expect(messages(missing)).toMatch(/expectedUpdatedAt/)
    const seen = (await api('GET', `/api/ad-campaigns/${id}?depth=0`, { token: f.tokens.eic })).json.updatedAt as string
    // a colleague edits the public text after it was reviewed
    expect((await patch(f.tokens.eic, id, { alt: 'Changed after review' })).status).toBe(200)
    const stale = await api('PATCH', `/api/ad-campaigns/${id}`, { token: f.tokens.eic, body: { status: 'approved', expectedUpdatedAt: seen } })
    expect(stale.status).toBe(409)
    expect((await f.payload.findByID({ collection: 'ad-campaigns', id, depth: 0, overrideAccess: true })).status).toBe('draft')
    expect((await patch(f.tokens.eic, id, { status: 'approved' })).status).toBe(200)
    expect((await api('PATCH', `/api/ad-campaigns/${id}`, { token: f.tokens.eic, body: { status: 'approved', expectedUpdatedAt: 'nonsense' } })).status).toBe(400)
  })

  it('S4: creative links come from configuration only, never from the Host header; unset fails closed', async () => {
    await live()
    const forged = await api('GET', '/api/public/advertising', { headers: { Host: 'evil.test', 'X-Forwarded-Host': 'evil.test' } })
    expect(forged.status).toBe(200)
    expect(forged.text).toContain(`${CMS_URL}/api/media/file/`)
    expect(forged.text).not.toContain('evil.test')
    const saved = process.env.CMS_PUBLIC_URL
    process.env.CMS_PUBLIC_URL = ''
    try {
      const res = await ads()
      expect(res.status).toBe(503)
      expect(res.headers.get('cache-control')).toBe('no-store')
      await wipeCampaigns()
      const empty = await ads() // nothing to deliver, nothing to build: still fine
      expect(empty.status).toBe(200)
      expect(empty.json.campaigns).toEqual([])
    } finally {
      process.env.CMS_PUBLIC_URL = saved
    }
  })

  it('S3: stores the normalised https address and skips a row that bypassed the hooks with a bad one', async () => {
    const c = await live({ destinationUrl: 'https://Example.TEST' })
    expect((await f.payload.findByID({ collection: 'ad-campaigns', id: c.id, depth: 0, overrideAccess: true })).destinationUrl).toBe('https://example.test/')
    await f.payload.db.updateOne({ collection: 'ad-campaigns', id: c.id, data: { destinationUrl: 'javascript:alert(1)' }, returning: false } as never)
    expect(mine(await ads())).toHaveLength(0)
  })

  it('S7: priority must be a whole number', async () => {
    expect((await create(f.tokens.eic, { priority: 1.5 })).status).toBe(400)
    expect((await create(f.tokens.eic, { priority: 100 })).status).toBe(201)
  })

  it('S9: rights unticked behind the hooks removes the campaign from the feed and the file route', async () => {
    const c = await live()
    expect(await fileStatus(media.bbDesktop!)).toBe(200)
    await f.payload.db.updateOne({ collection: 'ad-campaigns', id: c.id, data: { rightsConfirmed: false }, returning: false } as never)
    expect(mine(await ads())).toHaveLength(0)
    expect(await fileStatus(media.bbDesktop!)).toBe(403)
  })

  it('S9: a creative shared by two campaigns stays public while either is delivered', async () => {
    const a = await live()
    const b = await live()
    expect(await fileStatus(media.bbDesktop!)).toBe(200)
    await patch(f.tokens.eic, a.id, { status: 'paused' })
    expect(await fileStatus(media.bbDesktop!)).toBe(200)
    await patch(f.tokens.eic, b.id, { status: 'paused' })
    expect(await fileStatus(media.bbDesktop!)).toBe(403)
  })

  it('S9: anonymous callers cannot filter media through the campaign join (no oracle for advertiser data)', async () => {
    await live()
    const probe = (path: string) =>
      api('GET', `/api/media?where[${path}][like]=pat@adv-secret&depth=0`)
    for (const path of [
      // (a nested path such as adCampaignCreatives.advertiser.contactEmail is refused the same way, 400, but Payload leaves a
      // floating rejected promise for nested join paths on every join field; that is kept out of this test)
      'adCampaignCreatives.paymentStatus',
      'adCampaignCreatives.sponsor',
    ]) {
      const res = await probe(path)
      expect([400, 403], `${path} -> ${res.status}`).toContain(res.status)
      expect(res.text).not.toContain('pat@adv-secret')
    }
    // staff roles cannot filter through the join either
    expect((await api('GET', '/api/media?where[adCampaignCreatives.status][equals]=approved&depth=0', { token: f.tokens.reporter })).status).toBeGreaterThanOrEqual(400)
  })

  it('S9: the feed never carries more than 100 campaigns', async () => {
    const base = body({ rightsConfirmed: true, paymentStatus: 'paid', status: 'approved' }) as Record<string, unknown>
    for (let i = 0; i < 101; i++) {
      await f.payload.create({
        collection: 'ad-campaigns',
        data: { ...base, sponsor: `${runId} cap ${i}`, priority: i % 100 } as never,
        overrideAccess: true,
      })
    }
    const res = await ads()
    expect(res.status).toBe(200)
    expect(res.json.campaigns).toHaveLength(100)
    expect(res.json.campaigns[0].priority).toBe(99)
  })
})
