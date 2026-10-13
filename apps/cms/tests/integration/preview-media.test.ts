import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPreviewToken } from '../../src/lib/previewToken'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

const runId = newRunId()
let f: Fixtures

beforeAll(async () => {
  f = await setupFixtures(runId)
})

afterAll(async () => {
  await f?.cleanup()
})

const mint = (token: string | undefined, id: number, body?: unknown) =>
  api('POST', `/api/articles/${id}/preview-token`, { token, body })
const fetchPreview = (token: string) => api('GET', `/api/preview/articles?token=${encodeURIComponent(token)}`)

describe('article preview tokens', () => {
  it('lets a reporter mint a token for their own draft and fetch it', async () => {
    const art = await f.createArticle(f.tokens.reporter, { reviewNotes: 'x' })
    expect(art.status).toBe(201)
    const res = await mint(f.tokens.reporter, art.id!, { ttlSeconds: 300 })
    expect(res.status).toBe(200)
    expect(res.json.token).toBeTruthy()
    expect(Date.parse(res.json.expiresAt)).toBeGreaterThan(Date.now())
    expect(res.json.url).toContain('/api/preview/articles?token=')

    const got = await fetchPreview(res.json.token)
    expect(got.status).toBe(200)
    expect(got.headers.get('cache-control')).toBe('no-store')
    expect(got.json.doc.id).toBe(art.id)
    expect(got.json.doc.status).toBe('draft')
    expect(got.json.doc).not.toHaveProperty('author')
    expect(got.json.doc).not.toHaveProperty('reviewNotes')
    expect(got.json.doc).not.toHaveProperty('scheduledFor')

    // The draft is still not publicly readable.
    expect((await api('GET', `/api/articles/${art.id}`)).status).toBe(404)
  })

  it('rejects missing, tampered and expired tokens with 401', async () => {
    const art = await f.createArticle(f.tokens.reporter)
    const { token } = (await mint(f.tokens.reporter, art.id!)).json
    expect((await api('GET', '/api/preview/articles')).status).toBe(401)
    expect((await fetchPreview('garbage')).status).toBe(401)

    const [payloadPart, sig] = token.split('.') as [string, string]
    const flipped = sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA')
    expect((await fetchPreview(`${payloadPart}.${flipped}`)).status).toBe(401)

    // Re-point a valid signature at another article id.
    const forgedPayload = Buffer.from(JSON.stringify({ a: 999999, e: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')
    expect((await fetchPreview(`${forgedPayload}.${sig}`)).status).toBe(401)

    const expired = createPreviewToken({
      articleId: art.id!,
      ttlSeconds: 60,
      now: new Date(Date.now() - 3_600_000),
    })
    expect((await fetchPreview(expired.token)).status).toBe(401)
  })

  it("does not mint tokens for someone else's draft (404) or without auth (401)", async () => {
    const art = await f.createArticle(f.tokens.reporter)
    expect((await mint(f.tokens.reporter2, art.id!)).status).toBe(404)
    expect((await mint(undefined, art.id!)).status).toBe(401)
    expect((await mint(f.tokens.eic, art.id!)).status).toBe(200)
  })
})

// 1x1 transparent PNG
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const upload = (token: string | undefined, bytes: Buffer, name: string, type: string, alt = `${runId} alt`) => {
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt }))
  form.set('file', new Blob([new Uint8Array(bytes)], { type }), name)
  return api('POST', '/api/media', { token, body: form })
}

describe('media uploads', () => {
  it('rejects a .jpg that is not a JPEG', async () => {
    const res = await upload(f.tokens.reporter, Buffer.from('this is definitely not a jpeg image'), 'fake.jpg', 'image/jpeg')
    expect(res.status).toBe(400)
  })

  it('rejects content whose bytes do not match the declared type', async () => {
    const res = await upload(f.tokens.reporter, PNG_1X1, 'sneaky.jpg', 'image/jpeg')
    expect(res.status).toBe(400)
  })

  it('rejects SVG', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const res = await upload(f.tokens.reporter, svg, 'x.svg', 'image/svg+xml')
    expect(res.status).toBe(400)
    const disguised = await upload(f.tokens.reporter, svg, 'x.png', 'image/png')
    expect(disguised.status).toBe(400)
  })

  it('accepts a valid PNG from staff and rejects anonymous uploads', async () => {
    const ok = await upload(f.tokens.reporter, PNG_1X1, '../../weird name.png', 'image/png')
    expect(ok.status).toBe(201)
    expect(ok.json.doc.mimeType).toBe('image/png')
    expect(ok.json.doc.filename).toMatch(/^[A-Za-z0-9_.-]+$/)
    // CMS_PUBLIC_URL is unset in tests, so Payload returns a root-relative URL; with it set the URL is absolute.
    expect(ok.json.doc.url).toMatch(/^\/api\/media\/file\/[A-Za-z0-9_.-]+$/)
    f.created.media.push(ok.json.doc.id)

    const anon = await upload(undefined, PNG_1X1, 'anon.png', 'image/png')
    expect([401, 403]).toContain(anon.status)
  })
})
