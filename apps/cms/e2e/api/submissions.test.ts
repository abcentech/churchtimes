/**
 * Anonymous story submissions (POST /api/public/submissions) against the real server:
 * pending-only storage, real Cloudflare Siteverify (test secret + dummy token), rate limiting, CORS and body size.
 *
 * Every test uses its own client address (X-Forwarded-For) so the staging per-IP bucket
 * (SUBMISSION_RATE_LIMIT, low on purpose) never leaks between tests. TRUST_PROXY=true, hops=1: the client is the
 * RIGHT-most X-Forwarded-For entry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  Client,
  EVIL_ORIGIN,
  NEWSROOM_ORIGIN,
  PUBLIC_ORIGIN,
  cloudflareReachable,
  loginAs,
  newRunId,
  validSubmission,
} from './support'

const runId = newRunId()
const references: string[] = []

let admin: Client
const online = await cloudflareReachable()
if (!online) {
  console.warn(
    '\n[e2e-api] SKIPPING tests marked "(needs network)": challenges.cloudflare.com is unreachable from this machine.\n',
  )
}
const itOnline = it.skipIf(!online)

const submit = (c: Client, payload: unknown, opts: { origin?: string | null; headers?: Record<string, string> } = {}) =>
  c.post('/api/public/submissions', {
    json: payload,
    credentials: false,
    origin: opts.origin === undefined ? PUBLIC_ORIGIN : opts.origin,
    headers: opts.headers,
  })

beforeAll(async () => {
  admin = (await loginAs('admin')).client
})

afterAll(async () => {
  for (const ref of references) {
    const found = await admin.get(`/api/submissions?where[reference][equals]=${ref}&limit=1`)
    const id = found.json?.docs?.[0]?.id
    if (id) await admin.del(`/api/submissions/${id}`)
  }
})

describe('anonymous submission', () => {
  itOnline('(needs network) real Siteverify with the Cloudflare test secret + dummy token -> 201 {ok, reference, message}', async () => {
    const c = new Client(PUBLIC_ORIGIN)
    const res = await submit(c, validSubmission(runId))
    expect(res.status).toBe(201)
    expect(res.json).toMatchObject({ ok: true, message: 'Received. An editor will review your submission.' })
    expect(res.json.reference).toMatch(/^SUB-[A-Z0-9]{8}$/)
    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_ORIGIN)
    references.push(res.json.reference)
  })

  itOnline('(needs network) the submission is stored as `new`, with a hashed IP, and is NEVER visible publicly', async () => {
    const c = new Client(PUBLIC_ORIGIN)
    const payload = validSubmission(runId, { status: 'accepted', reference: 'SUB-HACKED1', article: 1, reviewerNotes: 'x' })
    const res = await submit(c, payload)
    expect(res.status).toBe(201)
    const ref = res.json.reference as string
    expect(ref).not.toBe('SUB-HACKED1')
    references.push(ref)

    const stored = await admin.get(`/api/submissions?where[reference][equals]=${ref}&limit=1`)
    const doc = stored.json.docs[0]
    expect(doc).toMatchObject({ status: 'new', title: payload.title, email: payload.email })
    expect(doc.reviewerNotes ?? null).toBeNull()
    expect(doc.article ?? null).toBeNull()
    expect(doc.ipHash).toMatch(/^[0-9a-f]{64}$/)
    expect(doc.ipHash).not.toContain(c.ip)

    // Anonymous: no list, no read by id, no search.
    const anon = new Client(PUBLIC_ORIGIN)
    for (const p of ['/api/submissions', `/api/submissions/${doc.id}`, `/api/submissions?where[reference][equals]=${ref}`]) {
      const r = await anon.get(p, { credentials: false })
      expect([401, 403, 404], `${p} -> ${r.status}`).toContain(r.status)
      expect(r.text).not.toContain(payload.title)
    }
    // Nor does it become an article.
    const pub = await anon.get(`/api/articles?where[title][like]=${encodeURIComponent(payload.title)}`, { credentials: false })
    expect(pub.json.docs).toHaveLength(0)
  })

  itOnline('(needs network) resending identical content is a 409 duplicate', async () => {
    const c = new Client(PUBLIC_ORIGIN)
    const payload = validSubmission(runId)
    const first = await submit(c, payload)
    expect(first.status).toBe(201)
    references.push(first.json.reference)
    const second = await submit(c, payload)
    expect(second.status).toBe(409)
    expect(second.json.errors[0].message).toMatch(/already received/i)
  })

  it('a missing Turnstile token is 400 with field turnstileToken, and nothing is stored', async () => {
    const c = new Client(PUBLIC_ORIGIN)
    const payload = validSubmission(runId)
    const { turnstileToken: _omit, ...withoutToken } = payload
    const res = await submit(c, withoutToken)
    expect(res.status).toBe(400)
    expect(res.json.errors[0]).toMatchObject({ field: 'turnstileToken' })
    const stored = await admin.get(`/api/submissions?where[title][equals]=${encodeURIComponent(payload.title)}`)
    expect(stored.json.docs).toHaveLength(0)
  })

  it('an empty/blank Turnstile token is also 400', async () => {
    const res = await submit(new Client(PUBLIC_ORIGIN), validSubmission(runId, { turnstileToken: '   ' }))
    expect(res.status).toBe(400)
    expect(res.json.errors[0].field).toBe('turnstileToken')
  })

  it('field validation errors are an array of {field, message}', async () => {
    const res = await submit(new Client(PUBLIC_ORIGIN), { name: 'A', email: 'nope', title: 'x', body: 'short', turnstileToken: 'x' })
    expect(res.status).toBe(400)
    expect(res.json.ok).toBe(false)
    expect(res.json.errors.map((e: { field: string }) => e.field)).toEqual(expect.arrayContaining(['name', 'email', 'title', 'body']))
  })

  it('the honeypot field returns a normal-looking 201 but stores nothing', async () => {
    const c = new Client(PUBLIC_ORIGIN)
    const payload = validSubmission(runId, { website: 'http://spam.example' })
    const res = await submit(c, payload)
    expect(res.status).toBe(201)
    expect(res.json.ok).toBe(true)
    const stored = await admin.get(`/api/submissions?where[title][equals]=${encodeURIComponent(payload.title)}`)
    expect(stored.json.docs).toHaveLength(0)
  })

  it('a non-JSON Content-Type is 415', async () => {
    const res = await new Client(PUBLIC_ORIGIN).post('/api/public/submissions', {
      body: 'a=b',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      credentials: false,
      origin: PUBLIC_ORIGIN,
    })
    expect(res.status).toBe(415)
  })
})

describe('submission origin policy and CORS', () => {
  it('an allowlisted origin gets an exact ACAO echo and exposes Retry-After', async () => {
    const res = await submit(new Client(NEWSROOM_ORIGIN), { turnstileToken: 'x' }, { origin: NEWSROOM_ORIGIN })
    expect(res.status).toBe(400) // validation, but with the CORS grant
    expect(res.headers.get('access-control-allow-origin')).toBe(NEWSROOM_ORIGIN)
    expect(res.headers.get('access-control-expose-headers')).toMatch(/Retry-After/i)
    expect(res.headers.get('vary')).toMatch(/Origin/i)
  })

  it('a disallowed origin is 403 "Origin not allowed." with NO CORS grant', async () => {
    const res = await submit(new Client(EVIL_ORIGIN), validSubmission(runId), { origin: EVIL_ORIGIN })
    expect(res.status).toBe(403)
    expect(res.json.errors[0].message).toBe('Origin not allowed.')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('OPTIONS preflight from an allowed origin is 204 with ACAO, POST method and Content-Type header', async () => {
    const res = await new Client(PUBLIC_ORIGIN).request('OPTIONS', '/api/public/submissions', {
      origin: PUBLIC_ORIGIN,
      credentials: false,
      headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_ORIGIN)
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/)
    expect(res.headers.get('access-control-allow-headers')).toMatch(/content-type/i)
    expect(res.headers.get('access-control-allow-credentials')).toBeNull() // credentials:'omit' endpoint
  })

  it('OPTIONS preflight from a disallowed origin is 403 with no ACAO', async () => {
    const res = await new Client(EVIL_ORIGIN).request('OPTIONS', '/api/public/submissions', {
      origin: EVIL_ORIGIN,
      credentials: false,
      headers: { 'access-control-request-method': 'POST' },
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('rate limiting (staging SUBMISSION_RATE_LIMIT is low on purpose)', () => {
  it('429 + Retry-After + Access-Control-Expose-Headers after the per-IP limit; forged X-Forwarded-For prefixes do not escape the bucket', async () => {
    const c = new Client(PUBLIC_ORIGIN)
    const limit = Number(process.env.STAGING_SUBMISSION_RATE_LIMIT || 3)

    // Invalid bodies still count against the per-IP bucket (it runs before parsing/Turnstile), so this
    // exercises the limiter without spending Siteverify calls.
    for (let i = 0; i < limit; i++) {
      const res = await submit(c, { turnstileToken: 'x' })
      expect(res.status, `request ${i + 1}/${limit}`).toBe(400)
    }
    const limited = await submit(c, { turnstileToken: 'x' })
    expect(limited.status).toBe(429)
    expect(limited.json.errors[0].message).toMatch(/too many submissions/i)
    const retry = Number(limited.headers.get('retry-after'))
    expect(Number.isInteger(retry) && retry >= 1 && retry <= 900, `Retry-After=${limited.headers.get('retry-after')}`).toBe(true)
    expect(limited.headers.get('access-control-expose-headers')).toMatch(/Retry-After/i)
    expect(limited.headers.get('access-control-allow-origin')).toBe(PUBLIC_ORIGIN)

    // A client cannot pick a fresh bucket by prepending addresses: only the right-most entry counts.
    const forged = await submit(c, { turnstileToken: 'x' }, { headers: { 'x-forwarded-for': `203.0.113.77, ${c.ip}` } })
    expect(forged.status).toBe(429)

    // A different client address has its own bucket.
    const other = await submit(new Client(PUBLIC_ORIGIN), { turnstileToken: 'x' })
    expect(other.status).toBe(400)
  })
})

describe('request body limits (enforced by endpoint and proxy.ts, with CORS so browsers can read the error)', () => {
  it('a >64 KB submission is 413 and keeps the CORS grant', async () => {
    const c = new Client(PUBLIC_ORIGIN)
    const res = await submit(c, validSubmission(runId, { body: 'x'.repeat(70 * 1024) }))
    expect(res.status).toBe(413)
    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_ORIGIN)
  })

  it('a >1 MB JSON body anywhere on /api is 413 from proxy.ts, with CORS for an allowlisted origin', async () => {
    const c = new Client(NEWSROOM_ORIGIN)
    const res = await c.post('/api/articles', {
      body: JSON.stringify({ title: 'x', pad: 'y'.repeat(1024 * 1024 + 10) }),
      headers: { 'content-type': 'application/json' },
      origin: NEWSROOM_ORIGIN,
    })
    expect(res.status).toBe(413)
    expect(res.json).toMatchObject({ ok: false })
    expect(res.json.errors[0].message).toMatch(/too large/i)
    expect(res.headers.get('access-control-allow-origin')).toBe(NEWSROOM_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('cache-control')).toBe('no-store')

    const evil = await new Client(EVIL_ORIGIN).post('/api/articles', {
      body: JSON.stringify({ pad: 'y'.repeat(1024 * 1024 + 10) }),
      headers: { 'content-type': 'application/json' },
      origin: EVIL_ORIGIN,
    })
    expect(evil.status).toBe(413)
    expect(evil.headers.get('access-control-allow-origin')).toBeNull()
  })
})
