import { createHash } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, newRunId, setupFixtures, type Fixtures } from './helpers'
import { installTurnstileStub, removeTurnstileStub, TURNSTILE_OK } from './turnstileStub'

const runId = newRunId()
const ALLOWED = 'http://allowed.test'
let f: Fixtures
let ipCounter = 0
/** Every test uses its own client IP so rate-limit buckets never interact. */
const nextIp = () => `10.${Math.floor(ipCounter / 250)}.${(ipCounter += 1) % 250}.${Math.floor(Math.random() * 200) + 1}`

beforeAll(async () => {
  installTurnstileStub()
  f = await setupFixtures(runId)
})

afterAll(async () => {
  removeTurnstileStub()
  await f?.cleanup()
})

let n = 0
const valid = (extra: Record<string, unknown> = {}) => ({
  name: 'Ada Obi',
  // unique per call so the per-email limit and duplicate detection never interfere between tests
  email: `ada${n}.${runId}@example.com`,
  turnstileToken: TURNSTILE_OK,
  title: `${runId} Church opens clinic ${++n}`,
  body: 'The church opened a free clinic in Ibadan this week for residents of the district.',
  ...extra,
})

const submit = (
  body: unknown,
  opts: { ip?: string; origin?: string; contentType?: string; raw?: string } = {},
) =>
  api('POST', '/api/public/submissions', {
    body: opts.raw ?? body,
    headers: {
      'x-forwarded-for': opts.ip ?? nextIp(),
      'user-agent': 'vitest-agent',
      ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
  })

const findByTitle = async (title: string) =>
  (
    await f.payload.find({
      collection: 'submissions',
      where: { title: { equals: title } },
      limit: 5,
      depth: 0,
      overrideAccess: true,
    })
  ).docs

describe('POST /api/public/submissions', () => {
  it('stores a valid submission as new with a hashed IP, hidden from anonymous and reporters', async () => {
    const ip = '203.0.113.77'
    const payload = valid()
    const res = await submit(payload, { ip })
    expect(res.status).toBe(201)
    expect(res.json.ok).toBe(true)
    expect(res.json.reference).toMatch(/^SUB-[A-Z0-9]{8}$/)

    const [doc] = await findByTitle(payload.title)
    expect(doc).toBeTruthy()
    expect(doc!.reference).toBe(res.json.reference)
    expect(doc!.status).toBe('new')
    const expectedHash = createHash('sha256').update(process.env.IP_HASH_SALT + ip).digest('hex')
    expect(doc!.ipHash).toBe(expectedHash)
    expect(JSON.stringify(doc)).not.toContain(ip)

    const anon = await api('GET', '/api/submissions')
    expect([401, 403]).toContain(anon.status)
    const anonOne = await api('GET', `/api/submissions/${doc!.id}`)
    expect([401, 403, 404]).toContain(anonOne.status)
    expect(anon.text).not.toContain(payload.title)

    const reporter = await api('GET', '/api/submissions', { token: f.tokens.reporter })
    expect(reporter.status).toBe(403)
    const reporterOne = await api('GET', `/api/submissions/${doc!.id}`, { token: f.tokens.reporter })
    expect([403, 404]).toContain(reporterOne.status)

    const eic = await api('GET', `/api/submissions/${doc!.id}`, { token: f.tokens.eic })
    expect(eic.status).toBe(200)

    // The collection itself is not writable over REST by anyone.
    const direct = await api('POST', '/api/submissions', { token: f.tokens.eic, body: valid() })
    expect(direct.status).toBe(403)
  })

  it('stores consentAt (server time) and the text version when consent is true, readable by staff only', async () => {
    const before = Date.now()
    const payload = valid({ consent: true, consentTextVersion: '2026-10', consentAt: '1999-01-01T00:00:00.000Z' })
    const res = await submit(payload)
    expect(res.status).toBe(201)
    const [doc] = await findByTitle(payload.title)
    expect(doc!.consentTextVersion).toBe('2026-10')
    const at = new Date(doc!.consentAt as string).getTime()
    expect(at).toBeGreaterThanOrEqual(before - 1000) // client-supplied consentAt is ignored
    expect(at).toBeLessThanOrEqual(Date.now() + 1000)
    const eic = await api('GET', `/api/submissions/${doc!.id}`, { token: f.tokens.eic })
    expect(eic.json.consentAt).toBeTruthy()
  })

  it('leaves consentAt empty when no consent is sent (default SUBMISSIONS_REQUIRE_CONSENT=false)', async () => {
    const payload = valid()
    expect((await submit(payload)).status).toBe(201)
    const [doc] = await findByTitle(payload.title)
    expect(doc!.consentAt ?? null).toBeNull()
  })

  it('answers 400 on field consent when SUBMISSIONS_REQUIRE_CONSENT=true and consent is missing', async () => {
    const prev = process.env.SUBMISSIONS_REQUIRE_CONSENT
    process.env.SUBMISSIONS_REQUIRE_CONSENT = 'true'
    try {
      const missing = valid()
      const res = await submit(missing)
      expect(res.status).toBe(400)
      expect(res.json.errors.map((e: { field?: string }) => e.field)).toContain('consent')
      expect(await findByTitle(missing.title)).toHaveLength(0)
      expect((await submit(valid({ consent: true }))).status).toBe(201)
    } finally {
      if (prev === undefined) delete process.env.SUBMISSIONS_REQUIRE_CONSENT
      else process.env.SUBMISSIONS_REQUIRE_CONSENT = prev
    }
  })

  it('rejects text/plain with 415', async () => {
    const res = await submit(undefined, {
      contentType: 'text/plain',
      raw: JSON.stringify(valid()),
    })
    expect(res.status).toBe(415)
  })

  it('rejects a body larger than 64 KB with 413', async () => {
    const res = await submit(valid({ body: 'x'.repeat(70 * 1024) }))
    expect(res.status).toBe(413)
    const withHeader = await api('POST', '/api/public/submissions', {
      body: JSON.stringify(valid()),
      headers: {
        'content-type': 'application/json',
        'content-length': String(70 * 1024),
        'x-forwarded-for': nextIp(),
      },
    })
    expect(withHeader.status).toBe(413)
  })

  it('rejects an invalid email with a field error', async () => {
    const res = await submit(valid({ email: 'not-an-email' }))
    expect(res.status).toBe(400)
    expect(res.json.ok).toBe(false)
    expect(res.json.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'email' })]),
    )
    const bad = await submit(undefined, { contentType: 'application/json', raw: '{nope' })
    expect(bad.status).toBe(400)
  })

  it('accepts a honeypot hit with 201 but stores nothing', async () => {
    const payload = valid({ website: 'http://spam.example' })
    const res = await submit(payload)
    expect(res.status).toBe(201)
    expect(res.json.ok).toBe(true)
    expect(res.json.reference).toMatch(/^SUB-/)
    expect(await findByTitle(payload.title)).toHaveLength(0)
    const refs = await f.payload.find({
      collection: 'submissions',
      where: { reference: { equals: res.json.reference } },
      overrideAccess: true,
    })
    expect(refs.totalDocs).toBe(0)
  })

  it('ignores a client-supplied status and other server-owned fields', async () => {
    const payload = valid({ status: 'converted', reference: 'SUB-HACKED00', ipHash: 'x', article: 1 })
    const res = await submit(payload)
    expect(res.status).toBe(201)
    const [doc] = await findByTitle(payload.title)
    expect(doc!.status).toBe('new')
    expect(doc!.reference).toBe(res.json.reference)
    expect(doc!.reference).not.toBe('SUB-HACKED00')
    expect(doc!.ipHash).not.toBe('x')
    expect(doc!.article ?? null).toBeNull()
  })

  it('strips HTML from submitted text', async () => {
    const payload = valid({
      name: '<b>Ada</b> Obi',
      body: 'Hello <script>alert(1)</script><b>world</b> this is a long enough story body <img src=x onerror=alert(1)>.',
    })
    const res = await submit(payload)
    expect(res.status).toBe(201)
    const [doc] = await findByTitle(payload.title)
    expect(doc!.name).toBe('Ada Obi')
    expect(doc!.body).not.toMatch(/[<>]/)
    expect(doc!.body).not.toContain('alert(1)')
    expect(doc!.body).toContain('world')
  })

  it('rate limits per IP with 429 and Retry-After', async () => {
    const ip = '198.51.100.9'
    const limit = Number(process.env.SUBMISSION_RATE_LIMIT)
    for (let i = 0; i < limit; i++) {
      const ok = await submit(valid(), { ip })
      expect(ok.status).toBe(201)
    }
    const blocked = await submit(valid(), { ip })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(blocked.json.ok).toBe(false)
    // Another client is unaffected.
    expect((await submit(valid(), { ip: '198.51.100.10' })).status).toBe(201)
  })

  it('rejects a disallowed Origin with 403 and allows a configured one', async () => {
    const bad = await submit(valid(), { origin: 'http://evil.test' })
    expect(bad.status).toBe(403)
    expect(bad.headers.get('access-control-allow-origin')).toBeNull()
    const good = await submit(valid(), { origin: ALLOWED })
    expect(good.status).toBe(201)
    expect(good.headers.get('access-control-allow-origin')).toBe(ALLOWED)
  })

  it('answers the CORS preflight for an allowed origin only', async () => {
    const pre = await api('OPTIONS', '/api/public/submissions', {
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST')
    expect(pre.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('content-type')

    const denied = await api('OPTIONS', '/api/public/submissions', {
      headers: { origin: 'http://evil.test', 'access-control-request-method': 'POST' },
    })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('POST /api/submissions/:id/convert', () => {
  it('is forbidden for reporters; editors get a draft article with lexical content, once', async () => {
    const payload = valid({ body: 'First paragraph of the story.\n\nSecond paragraph of the story, longer.' })
    expect((await submit(payload)).status).toBe(201)
    const [sub] = await findByTitle(payload.title)
    const url = `/api/submissions/${sub!.id}/convert`

    const asReporter = await api('POST', url, { token: f.tokens.reporter, body: { category: f.catA.id } })
    expect(asReporter.status).toBe(403)
    const anon = await api('POST', url, { body: { category: f.catA.id } })
    expect(anon.status).toBe(401)
    expect((await f.payload.findByID({ collection: 'submissions', id: sub!.id, overrideAccess: true })).status).toBe(
      'new',
    )

    const noCategory = await api('POST', url, { token: f.tokens.eic, body: {} })
    expect(noCategory.status).toBe(400)

    const ok = await api('POST', url, { token: f.tokens.eic, body: { category: f.catA.id } })
    expect(ok.status).toBe(201)
    const articleId = ok.json.article.id as number
    f.created.articles.push(articleId)

    const article = await f.payload.findByID({ collection: 'articles', id: articleId, depth: 0, overrideAccess: true })
    expect(article.status).toBe('draft')
    expect(article.title).toBe(payload.title)
    const root = (article.content as { root: { type: string; children: { type: string }[] } }).root
    expect(root.type).toBe('root')
    expect(root.children).toHaveLength(2)
    expect(root.children[0]!.type).toBe('paragraph')

    const after = await f.payload.findByID({ collection: 'submissions', id: sub!.id, depth: 0, overrideAccess: true })
    expect(after.status).toBe('converted')
    expect(after.article).toBe(articleId)

    const again = await api('POST', url, { token: f.tokens.eic, body: { category: f.catA.id } })
    expect(again.status).toBe(409)
  })
})
