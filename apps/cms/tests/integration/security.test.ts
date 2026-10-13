/**
 * Security regression suite: spam protection, authentication, session handling, role escalation,
 * CORS/CSRF and cookie flags. Everything goes through the real REST route handlers. Cloudflare is
 * never contacted: only the Siteverify transport is stubbed (see turnstileStub.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetAuthRateLimiters } from '../../src/lib/authRateLimit'
import { computeContentHash } from '../../src/lib/submissionHash'
import { TURNSTILE_TEST_SECRET } from '../../src/lib/turnstile'
import { api, newRunId, PASSWORD, setupFixtures, type Fixtures } from './helpers'
import {
  installTurnstileStub,
  removeTurnstileStub,
  siteverifyCalls,
  TURNSTILE_BAD,
  TURNSTILE_HTTP_500,
  TURNSTILE_NETWORK_ERROR,
  TURNSTILE_OK,
  TURNSTILE_SPENT,
} from './turnstileStub'

const runId = newRunId()
let f: Fixtures

beforeAll(async () => {
  installTurnstileStub()
  f = await setupFixtures(runId)
})

afterAll(async () => {
  removeTurnstileStub()
  await f?.cleanup()
})

let ipN = 0
const nextIp = () => `192.0.${Math.floor(ipN / 250)}.${(ipN += 1) % 250}`
const withIp = (ip: string, extra: Record<string, string> = {}) => ({ 'x-forwarded-for': ip, ...extra })

const STRONG = 'Correct-horse-battery-staple-91'

let userN = 0
async function mkUser(role = 'reporter', password = PASSWORD) {
  const key = `sec${++userN}`
  const email = `${runId}-${key}@test.invalid`
  const user = (await f.payload.create({
    collection: 'users',
    data: { email, name: `${runId} ${key}`, password, role, sections: [] } as never,
    overrideAccess: true,
  })) as { id: number }
  return { id: user.id, email, password }
}

const login = (email: string, password: string, ip = nextIp()) =>
  api('POST', '/api/users/login', { body: { email, password }, headers: withIp(ip) })

async function loginToken(u: { email: string; password: string }): Promise<string> {
  const res = await login(u.email, u.password)
  expect(res.status).toBe(200)
  return res.json.token as string
}

const me = (token: string) => api('GET', '/api/users/me', { token })
const rawUser = (id: number) =>
  f.payload.db.findOne({ collection: 'users', where: { id: { equals: id } } }) as Promise<Record<string, any>>

// ---------------------------------------------------------------------------------------------
// Public submissions: Turnstile, ordering, duplicates, per-email limit, server-owned fields
// ---------------------------------------------------------------------------------------------

let n = 0
const story = (extra: Record<string, unknown> = {}) => ({
  name: 'Ada Obi',
  email: `ada.${runId}.${++n}@example.com`,
  title: `${runId} Clinic story ${n}`,
  body: 'The church opened a free clinic in Ibadan this week for residents of the district.',
  turnstileToken: TURNSTILE_OK,
  ...extra,
})

const submit = (body: unknown, ip = nextIp(), headers: Record<string, string> = {}) =>
  api('POST', '/api/public/submissions', { body, headers: withIp(ip, { 'user-agent': 'vitest', ...headers }) })

const findByTitle = async (title: string) =>
  (
    await f.payload.find({
      collection: 'submissions',
      where: { title: { equals: title } },
      limit: 5,
      depth: 0,
      overrideAccess: true,
    })
  ).docs as Array<Record<string, any>>

describe('public submissions: Turnstile (server-side Siteverify, fail closed)', () => {
  it('missing token -> 400 field error on turnstileToken; Cloudflare not called; nothing stored', async () => {
    const before = siteverifyCalls.length
    const body = story({ turnstileToken: undefined })
    const res = await submit(body)
    expect(res.status).toBe(400)
    expect(res.json.ok).toBe(false)
    expect(res.json.errors).toEqual([expect.objectContaining({ field: 'turnstileToken' })])
    expect(siteverifyCalls.length).toBe(before)
    expect(await findByTitle(body.title)).toHaveLength(0)
    for (const empty of ['', '   ', 5, null]) {
      expect((await submit(story({ turnstileToken: empty }))).status).toBe(400)
    }
  })

  it('verification rejected -> 403 generic message, nothing stored, error codes not leaked', async () => {
    for (const token of [TURNSTILE_BAD, TURNSTILE_SPENT]) {
      const body = story({ turnstileToken: token })
      const res = await submit(body)
      expect(res.status).toBe(403)
      expect(res.json).toEqual({
        ok: false,
        errors: [{ field: 'turnstileToken', message: 'Verification failed. Please try again.' }],
      })
      expect(res.text).not.toMatch(/invalid-input|timeout-or-duplicate/)
      expect(await findByTitle(body.title)).toHaveLength(0)
    }
  })

  it('network error and non-200 from Cloudflare -> 403 (fail closed), nothing stored', async () => {
    for (const token of [TURNSTILE_NETWORK_ERROR, TURNSTILE_HTTP_500]) {
      const body = story({ turnstileToken: token })
      const res = await submit(body)
      expect(res.status).toBe(403)
      expect(res.json.errors[0]).toMatchObject({ field: 'turnstileToken' })
      expect(await findByTitle(body.title)).toHaveLength(0)
    }
  })

  it('a valid token stores the submission; Siteverify gets the secret, token and client IP', async () => {
    const ip = '203.0.113.201'
    const body = story()
    const res = await submit(body, ip)
    expect(res.status).toBe(201)
    expect(await findByTitle(body.title)).toHaveLength(1)
    const call = siteverifyCalls.at(-1)!
    expect(call.url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    expect(call.secret).toBe(TURNSTILE_TEST_SECRET)
    expect(call.response).toBe(TURNSTILE_OK)
    expect(call.remoteip).toBe(ip)
    // the secret never appears in any response
    expect(res.text).not.toContain(TURNSTILE_TEST_SECRET)
  })

  it('accepts the cf-turnstile-response alias', async () => {
    const body = story({ turnstileToken: undefined, 'cf-turnstile-response': TURNSTILE_OK })
    expect((await submit(body)).status).toBe(201)
    const bad = story({ turnstileToken: undefined, 'cf-turnstile-response': TURNSTILE_BAD })
    expect((await submit(bad)).status).toBe(403)
  })

  it('cannot be bypassed by request content (extra fields, headers, query string)', async () => {
    const body = story({ turnstileToken: TURNSTILE_BAD, skipTurnstile: true, verified: true, turnstile: false })
    const res = await api('POST', '/api/public/submissions?skipTurnstile=1&turnstile=off', {
      body,
      headers: withIp(nextIp(), { 'x-skip-turnstile': '1', 'x-turnstile-verified': 'true', 'cf-connecting-ip': '1.1.1.1' }),
    })
    expect(res.status).toBe(403)
    expect(await findByTitle(body.title)).toHaveLength(0)
  })

  it('never calls Cloudflare when rate limited, honeypotted, invalid, wrong type, or from a bad origin', async () => {
    const ip = '198.51.100.201'
    for (let i = 0; i < 5; i++) expect((await submit(story(), ip)).status).toBe(201)
    const before = siteverifyCalls.length

    expect((await submit(story(), ip)).status).toBe(429) // rate limited
    expect((await submit(story({ website: 'http://spam.example' }))).status).toBe(201) // honeypot
    expect((await submit(story({ email: 'nope' }))).status).toBe(400) // invalid input
    const text = await api('POST', '/api/public/submissions', {
      body: JSON.stringify(story()),
      headers: withIp(nextIp(), { 'content-type': 'text/plain' }),
    })
    expect(text.status).toBe(415)
    const evil = await api('POST', '/api/public/submissions', {
      body: story(),
      headers: withIp(nextIp(), { origin: 'http://evil.test' }),
    })
    expect(evil.status).toBe(403)
    expect(siteverifyCalls.length).toBe(before)
  })
})

describe('public submissions: duplicates, per-email limit, server-owned fields', () => {
  it('rejects an identical resubmission with 409 and stores it once', async () => {
    const body = story()
    expect((await submit(body)).status).toBe(201)
    const again = await submit(body)
    expect(again.status).toBe(409)
    expect(again.json).toEqual({ ok: false, errors: [{ message: 'We already received this submission.' }] })
    expect(await findByTitle(body.title)).toHaveLength(1)

    // cosmetic changes (case, whitespace) are still duplicates; a real change is not
    const cosmetic = await submit({ ...body, title: `  ${body.title.toUpperCase()}  `, email: body.email.toUpperCase() })
    expect(cosmetic.status).toBe(409)
    expect((await submit({ ...body, body: `${body.body} Updated with new details.` })).status).toBe(201)
  })

  it('stores a contentHash and ignores duplicates older than the window', async () => {
    const body = story()
    expect((await submit(body)).status).toBe(201)
    const [doc] = await findByTitle(body.title)
    expect(doc!.contentHash).toBe(computeContentHash(body))

    await f.payload.db.updateOne({
      collection: 'submissions',
      id: doc!.id,
      data: { createdAt: new Date(Date.now() - 80 * 3600 * 1000).toISOString() },
      returning: false,
    })
    expect((await submit(body)).status).toBe(201)
  })

  it('limits each email address (3 per hour by default) in addition to the per-IP limit', async () => {
    const email = `limited.${runId}@example.com`
    for (let i = 0; i < 3; i++) expect((await submit(story({ email }))).status).toBe(201)
    const blocked = await submit(story({ email: email.toUpperCase() }))
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await submit(story({ email: `other.${runId}@example.com` }))).status).toBe(201)
  })

  it('ignores status, article, reviewerNotes, reference, ipHash and contentHash from the body', async () => {
    const body = story({
      status: 'converted',
      article: 1,
      reviewerNotes: 'approved by attacker',
      reference: 'SUB-HACKED00',
      ipHash: 'x',
      contentHash: 'y',
      userAgent: 'evil',
    })
    const res = await submit(body, '203.0.113.202')
    expect(res.status).toBe(201)
    const [doc] = await findByTitle(body.title)
    expect(doc!.status).toBe('new')
    expect(doc!.article ?? null).toBeNull()
    expect(doc!.reviewerNotes ?? null).toBeNull()
    expect(doc!.reference).toBe(res.json.reference)
    expect(doc!.ipHash).not.toBe('x')
    expect(doc!.contentHash).toBe(computeContentHash(body))
    expect(doc!.userAgent).toBe('vitest')
  })
})

// ---------------------------------------------------------------------------------------------
// Public contributors / anonymous users can never approve or publish
// ---------------------------------------------------------------------------------------------

describe('anonymous visitors and public contributors cannot write editorial data', () => {
  it('cannot create or modify articles, submissions, live updates or users', async () => {
    const art = await f.seedArticle({ status: 'in_review', author: f.users.reporter.id })

    const create = await api('POST', '/api/articles', {
      body: { title: `${runId}-anon`, slug: `${runId}-anon`, content: {}, category: f.catA.id, status: 'published' },
    })
    expect([401, 403]).toContain(create.status)
    const publish = await api('PATCH', `/api/articles/${art.id}`, { body: { status: 'published' } })
    expect([401, 403, 404]).toContain(publish.status)
    expect((await f.payload.findByID({ collection: 'articles', id: art.id, overrideAccess: true })).status).toBe('in_review')

    const sub = await api('POST', '/api/submissions', { body: { ...story(), status: 'accepted' } })
    expect([401, 403]).toContain(sub.status)
    const live = await api('POST', '/api/live-updates', { body: { body: 'x', event: 1, status: 'approved' } })
    expect([401, 403]).toContain(live.status)
    const user = await api('POST', '/api/users', { body: { email: `${runId}-anon@test.invalid`, password: STRONG, name: 'x', role: 'admin' } })
    expect([401, 403]).toContain(user.status)
  })

  it('a submission can never be turned into a published article by the submitter', async () => {
    const body = story({ status: 'converted', article: 1 })
    expect((await submit(body)).status).toBe(201)
    const [doc] = await findByTitle(body.title)
    expect(doc!.status).toBe('new')
    const published = await f.payload.find({
      collection: 'articles',
      where: { title: { equals: body.title } },
      overrideAccess: true,
    })
    expect(published.totalDocs).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// Staff roles cannot approve / publish beyond their remit (spot checks; full matrix in articles.test.ts)
// ---------------------------------------------------------------------------------------------

describe('staff privilege limits (server-enforced)', () => {
  const statusOf = async (id: number) =>
    (await f.payload.findByID({ collection: 'articles', id, overrideAccess: true })).status

  it('a reporter cannot publish, approve or self-approve', async () => {
    const direct = await f.createArticle(f.tokens.reporter, { status: 'published' })
    expect(direct.status).toBe(403)

    const draft = await f.createArticle(f.tokens.reporter)
    expect(draft.status).toBe(201)
    for (const status of ['published', 'scheduled', 'approved']) {
      const res = await api('PATCH', `/api/articles/${draft.id}`, { token: f.tokens.reporter, body: { status } })
      expect([400, 403, 404]).toContain(res.status)
      expect(await statusOf(draft.id!)).toBe('draft')
    }

    const submitted = await api('PATCH', `/api/articles/${draft.id}`, {
      token: f.tokens.reporter,
      body: { status: 'in_review' },
    })
    expect(submitted.status).toBe(200)
    const approve = await api('PATCH', `/api/articles/${draft.id}`, { token: f.tokens.reporter, body: { status: 'approved' } })
    expect([400, 403, 404]).toContain(approve.status)
    expect(await statusOf(draft.id!)).toBe('in_review')
  })

  it("a trusted publisher cannot approve/publish someone else's article, nor publish outside their sections", async () => {
    const other = await f.seedArticle({ status: 'in_review', author: f.users.reporter.id })
    for (const status of ['approved', 'published']) {
      const res = await api('PATCH', `/api/articles/${other.id}`, { token: f.tokens.trusted, body: { status } })
      expect([400, 403, 404]).toContain(res.status)
    }
    expect(await statusOf(other.id)).toBe('in_review')

    const outside = await f.createArticle(f.tokens.trusted, { status: 'published', category: f.catB.id })
    expect(outside.status).toBe(403)
  })

  it('a section editor cannot publish outside their sections', async () => {
    const art = await f.seedArticle({ status: 'in_review', category: f.catB.id, author: f.users.reporter.id })
    const res = await api('PATCH', `/api/articles/${art.id}`, { token: f.tokens.sectionEditor, body: { status: 'published' } })
    expect([403, 404]).toContain(res.status)
    expect(await statusOf(art.id)).toBe('in_review')
  })

  it('only editor-in-chief or admin can delete articles', async () => {
    const art = await f.seedArticle({ status: 'draft', author: f.users.reporter.id })
    for (const token of [f.tokens.reporter, f.tokens.trusted, f.tokens.sectionEditor]) {
      const res = await api('DELETE', `/api/articles/${art.id}`, { token })
      expect([403, 404]).toContain(res.status)
    }
    expect((await api('DELETE', `/api/articles/${art.id}`, { token: f.tokens.eic })).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------------------------
// Role escalation
// ---------------------------------------------------------------------------------------------

describe('role escalation is impossible through the API', () => {
  it('a reporter cannot change their own role or sections, nor server-owned auth fields', async () => {
    const u = await mkUser('reporter')
    const token = await loginToken(u)
    const res = await api('PATCH', `/api/users/${u.id}`, {
      token,
      body: {
        role: 'admin',
        sections: [f.catA.id],
        name: `${runId} renamed`,
        loginAttempts: 0,
        lockUntil: null,
        resetPasswordToken: 'attacker-token',
        resetPasswordExpiration: new Date(Date.now() + 3600_000).toISOString(),
        sessions: [],
      },
    })
    expect(res.status).toBe(200)
    const row = await rawUser(u.id)
    expect(row.role).toBe('reporter')
    expect(row.name).toBe(`${runId} renamed`) // normal fields still editable
    expect(row.resetPasswordToken ?? null).toBeNull()
    const full = await f.payload.findByID({ collection: 'users', id: u.id, depth: 0, overrideAccess: true })
    expect((full.sections as unknown[]) ?? []).toHaveLength(0)
  })

  it('an editor-in-chief cannot make themselves or anyone else an admin', async () => {
    const eic = await mkUser('editor-in-chief')
    const target = await mkUser('reporter')
    const token = await loginToken(eic)

    await api('PATCH', `/api/users/${eic.id}`, { token, body: { role: 'admin' } })
    expect((await rawUser(eic.id)).role).toBe('editor-in-chief')

    const other = await api('PATCH', `/api/users/${target.id}`, { token, body: { role: 'admin' } })
    expect([403, 404]).toContain(other.status)
    expect((await rawUser(target.id)).role).toBe('reporter')

    const create = await api('POST', '/api/users', {
      token,
      body: { email: `${runId}-eicmade@test.invalid`, password: STRONG, name: 'x', role: 'admin' },
    })
    expect(create.status).toBe(403)
    const del = await api('DELETE', `/api/users/${target.id}`, { token })
    expect([403, 404]).toContain(del.status)
    expect(await rawUser(target.id)).toBeTruthy()
  })

  it('non-admin staff cannot create users or read other accounts; no secrets are exposed', async () => {
    const create = await api('POST', '/api/users', {
      token: f.tokens.reporter,
      body: { email: `${runId}-repmade@test.invalid`, password: STRONG, name: 'x', role: 'admin' },
    })
    expect(create.status).toBe(403)
    const list = await api('GET', '/api/users', { token: f.tokens.reporter })
    expect(list.status).toBe(200)
    expect(list.json.docs).toHaveLength(1)
    expect(list.json.docs[0].id).toBe(f.users.reporter.id)
    expect(list.text).not.toMatch(/"hash"|"salt"|resetPasswordToken/)

    const eicList = await api('GET', '/api/users', { token: f.tokens.eic })
    expect(eicList.text).not.toMatch(/"hash"|"salt"|resetPasswordToken/)
    // session ids are visible only on one's own record
    for (const doc of eicList.json.docs) {
      if (doc.id !== f.users.eic.id) expect(doc.sessions ?? []).toHaveLength(0)
    }
  })

  it('only an admin can change roles, and the change is audited', async () => {
    const target = await mkUser('reporter')
    const res = await api('PATCH', `/api/users/${target.id}`, { token: f.tokens.admin, body: { role: 'section-editor', sections: [f.catA.id] } })
    expect(res.status).toBe(200)
    expect((await rawUser(target.id)).role).toBe('section-editor')
    const audit = await f.payload.find({
      collection: 'audit-logs',
      where: { and: [{ action: { equals: 'user.role-change' } }, { docId: { equals: String(target.id) } }] },
      overrideAccess: true,
    })
    expect(audit.totalDocs).toBe(1)
  })

  it('/api/users/first-register is refused once any user exists', async () => {
    const email = `${runId}-first@test.invalid`
    const res = await api('POST', '/api/users/first-register', {
      body: { email, password: STRONG, name: 'Mallory', role: 'admin' },
      headers: withIp(nextIp()),
    })
    expect(res.status).toBe(403)
    const found = await f.payload.find({ collection: 'users', where: { email: { equals: email } }, overrideAccess: true })
    expect(found.totalDocs).toBe(0)
  })

  it('any logged-in user can no longer unlock accounts (admin only)', async () => {
    const victim = await mkUser('reporter')
    const ip = nextIp()
    for (let i = 0; i < 5; i++) expect((await login(victim.email, 'wrong-password-123', ip)).status).toBe(401)
    expect((await rawUser(victim.id)).lockUntil).toBeTruthy()

    const attempt = await api('POST', '/api/users/unlock', { token: f.tokens.reporter, body: { email: victim.email } })
    expect(attempt.status).toBe(403)
    expect((await rawUser(victim.id)).lockUntil).toBeTruthy()

    const anon = await api('POST', '/api/users/unlock', { body: { email: victim.email } })
    expect([401, 403]).toContain(anon.status)

    const ok = await api('POST', '/api/users/unlock', { token: f.tokens.admin, body: { email: victim.email } })
    expect(ok.status).toBe(200)
    expect((await login(victim.email, victim.password, ip)).status).toBe(200)
  })

  it('admin can force-logout a user everywhere; nobody else can', async () => {
    const victim = await mkUser('reporter')
    const tokenA = await loginToken(victim)
    const tokenB = await loginToken(victim)
    expect((await me(tokenA)).json.user?.id).toBe(victim.id)

    expect((await api('POST', `/api/users/${victim.id}/revoke-sessions`, { token: tokenA })).status).toBe(403)
    expect((await api('POST', `/api/users/${victim.id}/revoke-sessions`, { token: f.tokens.eic })).status).toBe(403)
    expect([401, 403]).toContain((await api('POST', `/api/users/${victim.id}/revoke-sessions`)).status)
    expect((await me(tokenA)).json.user?.id).toBe(victim.id)

    expect((await api('POST', `/api/users/${victim.id}/revoke-sessions`, { token: f.tokens.admin })).status).toBe(200)
    expect((await me(tokenA)).json.user).toBeNull()
    expect((await me(tokenB)).json.user).toBeNull()
    expect((await login(victim.email, victim.password)).status).toBe(200) // can sign in again
  })
})

// ---------------------------------------------------------------------------------------------
// Login, lockout, logout, cookies
// ---------------------------------------------------------------------------------------------

describe('login, lockout and sessions', () => {
  it('sets an HttpOnly, SameSite=Lax, host-only cookie scoped to / and returns a token', async () => {
    const u = await mkUser('reporter')
    const res = await login(u.email, u.password)
    expect(res.status).toBe(200)
    expect(res.json.token).toEqual(expect.any(String))
    expect(res.json.user.role).toBe('reporter')
    expect(res.text).not.toMatch(/"hash"|"salt"/)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/^payload-token=/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toMatch(/Path=\//)
    expect(cookie).not.toMatch(/Domain=/i)
    expect(cookie).toMatch(/Expires=/i)
  })

  it('bad credentials: 401 with the same message for unknown email and wrong password', async () => {
    const u = await mkUser('reporter')
    const wrong = await login(u.email, 'not-the-password-123')
    const unknown = await login(`${runId}-nobody@test.invalid`, 'not-the-password-123')
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.json).toEqual(unknown.json)
    expect(wrong.json.errors[0].message).toMatch(/email or password provided is incorrect/i)
  })

  it('locks the account after 5 failures (even the right password is then refused) and recovers via unlock', async () => {
    const u = await mkUser('reporter')
    const ip = nextIp()
    for (let i = 0; i < 5; i++) expect((await login(u.email, 'wrong-password-123', ip)).status).toBe(401)
    const locked = await login(u.email, u.password, ip)
    expect(locked.status).toBe(401)
    expect(locked.json.errors[0].message).toMatch(/locked/i)
    await f.payload.unlock({ collection: 'users', data: { email: u.email } as never, overrideAccess: true })
    expect((await login(u.email, u.password, ip)).status).toBe(200)
  })

  it('rate limits login attempts per IP with 429, without touching accounts', async () => {
    const ip = nextIp()
    const limit = 10
    for (let i = 0; i < limit; i++) {
      expect((await login(`${runId}-ghost${i}@test.invalid`, 'whatever-password', ip)).status).toBe(401)
    }
    const blocked = await login(`${runId}-ghost-final@test.invalid`, 'whatever-password', ip)
    expect(blocked.status).toBe(429)
    // a different client is unaffected
    expect((await login(`${runId}-ghost-other@test.invalid`, 'whatever-password', nextIp())).status).toBe(401)
    resetAuthRateLimiters()
  })

  it('logout revokes the session server-side: the old token stops working immediately', async () => {
    const u = await mkUser('editor-in-chief')
    const token = await loginToken(u)
    expect((await me(token)).json.user?.email).toBe(u.email)
    expect((await api('GET', '/api/submissions', { token })).status).toBe(200)

    const out = await api('POST', '/api/users/logout', { token })
    expect(out.status).toBe(200)

    expect((await me(token)).json.user).toBeNull()
    expect([401, 403]).toContain((await api('GET', '/api/submissions', { token })).status)
    expect((await api('POST', '/api/users/refresh', { token })).status).not.toBe(200)
  })

  it('logout only ends the current session; password change ends all the others', async () => {
    const u = await mkUser('reporter')
    const tokenA = await loginToken(u)
    const tokenB = await loginToken(u)
    expect((await api('POST', '/api/users/logout', { token: tokenA })).status).toBe(200)
    expect((await me(tokenA)).json.user).toBeNull()
    expect((await me(tokenB)).json.user?.id).toBe(u.id)

    const tokenC = await loginToken(u)
    const change = await api('PATCH', `/api/users/${u.id}`, { token: tokenC, body: { password: STRONG } })
    expect(change.status).toBe(200)
    expect((await me(tokenB)).json.user).toBeNull() // other session revoked
    expect((await me(tokenC)).json.user?.id).toBe(u.id) // the one that changed it survives
    expect((await login(u.email, u.password)).status).toBe(401)
    expect((await login(u.email, STRONG)).status).toBe(200)
  })

  it('a cookie only authenticates requests from an allowlisted Origin (CSRF)', async () => {
    const u = await mkUser('reporter')
    const token = await loginToken(u)
    const cookie = { cookie: `payload-token=${token}` }
    const as = (headers: Record<string, string>) => api('GET', '/api/users/me', { headers: { ...cookie, ...headers } })

    expect((await as({ origin: 'http://evil.test' })).json.user).toBeNull()
    expect((await as({})).json.user).toBeNull() // no Origin, no Sec-Fetch-Site: not a same-site browser
    expect((await as({ 'sec-fetch-site': 'cross-site' })).json.user).toBeNull()
    expect((await as({ origin: 'http://csrf-allowed.test' })).json.user?.id).toBe(u.id)
    expect((await as({ origin: 'http://localhost:3000' })).json.user?.id).toBe(u.id) // dev default for the CMS itself
    expect((await as({ 'sec-fetch-site': 'same-origin' })).json.user?.id).toBe(u.id)
  })
})

// ---------------------------------------------------------------------------------------------
// Password policy, forgot / reset password
// ---------------------------------------------------------------------------------------------

describe('password policy and reset flow', () => {
  it('rejects weak passwords on create, change and reset', async () => {
    const email = `${runId}-weak@test.invalid`
    for (const password of ['short', 'password1234', '123456789012', email]) {
      const res = await api('POST', '/api/users', { token: f.tokens.admin, body: { email, password, name: 'Weak', role: 'reporter' } })
      expect(res.status, password).toBe(400)
    }
    const none = await f.payload.find({ collection: 'users', where: { email: { equals: email } }, overrideAccess: true })
    expect(none.totalDocs).toBe(0)

    const u = await mkUser('reporter')
    const token = await loginToken(u)
    const change = await api('PATCH', `/api/users/${u.id}`, { token, body: { password: 'Short-1!' } })
    expect(change.status).toBe(400)
    expect(change.text).toMatch(/at least 12/)
    expect((await login(u.email, u.password)).status).toBe(200) // unchanged

    const tok = await f.payload.forgotPassword({ collection: 'users', data: { email: u.email }, disableEmail: true })
    for (const password of ['short', 'qwertyuiop12', u.email]) {
      const res = await api('POST', '/api/users/reset-password', { body: { token: tok, password }, headers: withIp(nextIp()) })
      expect(res.status, password).toBe(400)
    }
  })

  it('forgot-password answers identically for known and unknown emails (no enumeration)', async () => {
    const u = await mkUser('reporter')
    const known = await api('POST', '/api/users/forgot-password', { body: { email: u.email }, headers: withIp(nextIp()) })
    const unknown = await api('POST', '/api/users/forgot-password', {
      body: { email: `${runId}-no-such-user@test.invalid` },
      headers: withIp(nextIp()),
    })
    expect(known.status).toBe(200)
    expect(unknown.status).toBe(200)
    expect(known.json).toEqual(unknown.json)
    expect(known.text).not.toMatch(/token/i)
    // a second request for the same account inside minRequestInterval looks the same too
    const again = await api('POST', '/api/users/forgot-password', { body: { email: u.email }, headers: withIp(nextIp()) })
    expect(again.status).toBe(200)
    expect(again.json).toEqual(known.json)
  })

  it('rate limits forgot-password per IP with 429', async () => {
    const ip = nextIp()
    for (let i = 0; i < 5; i++) {
      const res = await api('POST', '/api/users/forgot-password', { body: { email: `${runId}-fp${i}@test.invalid` }, headers: withIp(ip) })
      expect(res.status).toBe(200)
    }
    const blocked = await api('POST', '/api/users/forgot-password', { body: { email: `${runId}-fp-x@test.invalid` }, headers: withIp(ip) })
    expect(blocked.status).toBe(429)
    resetAuthRateLimiters()
  })

  it('a reset token works once, signs out existing sessions and enforces the policy', async () => {
    const u = await mkUser('reporter')
    const oldToken = await loginToken(u)
    const tok = await f.payload.forgotPassword({ collection: 'users', data: { email: u.email }, disableEmail: true })

    const reset = await api('POST', '/api/users/reset-password', { body: { token: tok, password: STRONG }, headers: withIp(nextIp()) })
    expect(reset.status).toBe(200)
    expect(reset.json.token).toEqual(expect.any(String))

    expect((await me(oldToken)).json.user).toBeNull() // old sessions gone
    expect((await me(reset.json.token)).json.user?.id).toBe(u.id)
    expect((await login(u.email, u.password)).status).toBe(401)
    expect((await login(u.email, STRONG)).status).toBe(200)

    const reuse = await api('POST', '/api/users/reset-password', { body: { token: tok, password: `${STRONG}-2` }, headers: withIp(nextIp()) })
    expect(reuse.status).toBe(403)
    const bogus = await api('POST', '/api/users/reset-password', { body: { token: 'f'.repeat(40), password: STRONG }, headers: withIp(nextIp()) })
    expect(bogus.status).toBe(403)
  })

  it('an expired reset token is refused', async () => {
    const u = await mkUser('reporter')
    const tok = await f.payload.forgotPassword({ collection: 'users', data: { email: u.email }, disableEmail: true })
    await f.payload.db.updateOne({
      collection: 'users',
      id: u.id,
      data: { resetPasswordExpiration: new Date(Date.now() - 1000).toISOString() },
      returning: false,
    })
    const res = await api('POST', '/api/users/reset-password', { body: { token: tok, password: STRONG }, headers: withIp(nextIp()) })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------------------------

describe('CORS allowlist', () => {
  const get = (origin?: string) =>
    api('GET', '/api/categories', { headers: origin ? { origin } : {} })

  it('echoes only allowlisted origins and sends credentials only for them', async () => {
    for (const origin of ['http://localhost:5174', 'http://cors-allowed.test']) {
      const res = await get(origin)
      expect(res.headers.get('access-control-allow-origin')).toBe(origin)
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    }
  })

  it('sends no CORS grant to other origins, and never a wildcard', async () => {
    for (const origin of ['http://evil.test', 'http://localhost:5173', 'null', 'http://cors-allowed.test.evil.test']) {
      const res = await get(origin)
      expect(res.headers.get('access-control-allow-origin'), origin).toBeNull()
      expect(res.headers.get('access-control-allow-credentials'), origin).toBeNull()
    }
    const none = await get()
    expect(none.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers preflights for the login route only for allowlisted origins', async () => {
    const ok = await api('OPTIONS', '/api/users/login', {
      headers: { origin: 'http://localhost:5174', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5174')
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true')
    const bad = await api('OPTIONS', '/api/users/login', {
      headers: { origin: 'http://evil.test', 'access-control-request-method': 'POST' },
    })
    expect(bad.headers.get('access-control-allow-origin')).toBeNull()
  })
})
