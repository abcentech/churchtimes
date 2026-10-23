/**
 * Security regression: transport and abuse handling.
 * Response headers, CORS/Origin/Vary, CSRF, rate limits (429 + Retry-After), account enumeration and timing, password
 * policy, session fixation and cookie flags, first-register, body-size limits, slugs, verb tampering, mass assignment.
 * Requests go through src/proxy.ts and the real Payload REST handlers (harness.ts `send`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import config from '@payload-config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetContactLimiters } from '../../src/endpoints/publicContact'
import { resetNewsletterLimiters } from '../../src/endpoints/publicNewsletter'
import { resetSearchLimiter } from '../../src/endpoints/publicSearch'
import { resetPublicSubmissionLimiters } from '../../src/endpoints/publicSubmissions'
import { resetAuthRateLimiters } from '../../src/lib/authRateLimit'
import { isReservedSlug } from '../../src/lib/reservedSlugs'
import { firstRegisterAllowed } from '../../src/lib/securityConfig'
import { lexical, newRunId, PASSWORD, setupFixtures, type Fixtures } from '../integration/helpers'
import { leaksIn, send } from './harness'

const runId = newRunId()
let f: Fixtures
const here = path.dirname(fileURLToPath(import.meta.url))
const STRONG = 'Correct-horse-battery-staple-91'
const ALLOWED = 'http://allowed.test'
const env = process.env as Record<string, string | undefined>
const saved = { ...process.env }

let ipN = 0
const ip = () => `203.0.${Math.floor(ipN / 250) % 250}.${(ipN += 1) % 250}`
const from = (addr: string, extra: Record<string, string> = {}) => ({ 'x-forwarded-for': addr, ...extra })
const json = { 'content-type': 'application/json' }

beforeAll(async () => {
  env.SEARCH_RATE_LIMIT = '5'
  env.CONTACT_RATE_LIMIT = '3'
  env.NEWSLETTER_RATE_LIMIT = '3'
  resetAll()
  f = await setupFixtures(runId)
})
afterAll(async () => {
  for (const k of ['SEARCH_RATE_LIMIT', 'CONTACT_RATE_LIMIT', 'NEWSLETTER_RATE_LIMIT', 'ALLOW_FIRST_REGISTER']) {
    if (saved[k] === undefined) delete env[k]
    else env[k] = saved[k]
  }
  resetAll()
  await f?.cleanup()
})

function resetAll() {
  resetContactLimiters()
  resetNewsletterLimiters()
  resetSearchLimiter()
  resetPublicSubmissionLimiters()
  resetAuthRateLimiters()
}

let userN = 0
async function mkUser(role = 'reporter') {
  const email = `${runId}-tp${++userN}@test.invalid`
  const user = (await f.payload.create({
    collection: 'users',
    data: { email, name: `${runId} tp${userN}`, password: PASSWORD, role, sections: [] } as never,
    overrideAccess: true,
  })) as { id: number }
  return { id: user.id, email, password: PASSWORD }
}
const login = (email: string, password: string, addr = ip(), headers: Record<string, string> = {}) =>
  send('POST', '/api/users/login', { body: { email, password }, headers: from(addr, headers) })

// ---------------------------------------------------------------------------------------------

describe('response headers', () => {
  const load = async (production: boolean) => {
    const prev = env.NODE_ENV
    env.NODE_ENV = production ? 'production' : 'test'
    try {
      const mod = (await import(/* @vite-ignore */ `../../next.config.mjs?mode=${production ? 'prod' : 'dev'}`)) as {
        default: { poweredByHeader?: boolean; headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> }
      }
      const rules = await mod.default.headers()
      const all = rules.find((r) => r.source === '/:path*')!.headers
      return { cfg: mod.default, headers: Object.fromEntries(all.map((h) => [h.key.toLowerCase(), h.value])), rules }
    } finally {
      env.NODE_ENV = prev
    }
  }

  it('every route (admin included): nosniff, frame-ancestors none, X-Frame-Options, Referrer-Policy, Permissions-Policy', async () => {
    const { headers, cfg } = await load(false)
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['content-security-policy']).toMatch(/frame-ancestors 'none'/)
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['referrer-policy']).toMatch(/^(strict-origin-when-cross-origin|no-referrer|same-origin|strict-origin)$/)
    expect(headers['permissions-policy']).toMatch(/camera=\(\)/)
    expect(cfg.poweredByHeader).toBe(false)
  })

  it('HSTS is sent in production mode (>= 180 days, never includeSubDomains/preload) and not in development', async () => {
    const dev = await load(false)
    expect(dev.headers['strict-transport-security']).toBeUndefined()
    const prod = await load(true)
    const hsts = prod.headers['strict-transport-security']
    expect(hsts).toBeDefined()
    expect(Number(/max-age=(\d+)/.exec(hsts!)?.[1])).toBeGreaterThanOrEqual(15_552_000)
    expect(hsts).not.toMatch(/includeSubDomains|preload/i)
  })

  it('auth responses are never cached', async () => {
    const { rules } = await load(false)
    const users = rules.find((r) => r.source === '/api/users/:path*')
    expect(users?.headers.find((h) => h.key.toLowerCase() === 'cache-control')?.value).toBe('no-store')
  })

  it('no response from the REST layer names the server software', async () => {
    for (const url of ['/api/categories', '/api/nope', '/api/users/me', '/api/public/search?q=x']) {
      const res = await send('GET', url, { headers: from(ip()) })
      expect(res.headers.get('server'), url).toBeNull()
      expect(res.headers.get('x-powered-by'), url).toBeNull()
      expect(res.headers.get('x-payload-version') ?? '', url).toBe('')
    }
  })

  it('public error and JSON bodies are not sniffable HTML', async () => {
    const res = await send('GET', '/api/public/search?q=%3Cscript%3Ealert(1)%3C/script%3E', { headers: from(ip()) })
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })
})

describe('CORS, Origin and Vary', () => {
  it('REST: only CMS_CORS_ORIGINS get a grant; never * ; foreign, null and look-alike origins get none', async () => {
    for (const origin of ['http://evil.test', 'null', 'http://cors-allowed.test.evil.test', 'http://evilcors-allowed.test', 'http://cors-allowed.test@evil.test', 'https://cors-allowed.test', 'http://CORS-ALLOWED.test.']) {
      const res = await send('GET', '/api/categories', { headers: from(ip(), { origin }) })
      expect(res.headers.get('access-control-allow-origin'), origin).toBeNull()
      expect(res.headers.get('access-control-allow-credentials'), origin).toBeNull()
    }
    const ok = await send('GET', '/api/categories', { headers: from(ip(), { origin: 'http://cors-allowed.test' }) })
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://cors-allowed.test')
    expect(ok.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('REST preflight from a foreign origin is not granted', async () => {
    const res = await send('OPTIONS', '/api/users/login', {
      headers: from(ip(), { origin: 'http://evil.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }),
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('every API response is keyed on Origin (Vary), so a shared cache cannot replay one origin\'s grant', async () => {
    for (const url of ['/api/categories', '/api/articles', '/api/public/search?q=x', '/api/public/redirects', '/api/does-not-exist']) {
      const res = await send('GET', url, { headers: from(ip(), { origin: 'http://cors-allowed.test' }) })
      expect((res.headers.get('vary') ?? '').toLowerCase(), url).toContain('origin')
    }
  })

  it('public endpoints: a foreign Origin is a 403 without any CORS grant; the allow-listed one is echoed exactly', async () => {
    const targets: Array<[string, string]> = [
      ['GET', '/api/public/search?q=test'],
      ['GET', '/api/public/redirects'],
      ['GET', '/api/public/advertising'],
      ['POST', '/api/public/contact'],
      ['POST', '/api/public/submissions'],
      ['POST', '/api/public/newsletter/subscribe'],
    ]
    for (const [m, u] of targets) {
      for (const origin of ['http://evil.test', 'http://allowed.test.evil.test', 'http://evilallowed.test', 'null', 'http://allowed.test@evil.test']) {
        const res = await send(m as never, u, { body: m === 'POST' ? {} : undefined, headers: from(ip(), { origin, ...json }) })
        expect(res.status, `${m} ${u} ${origin}`).toBe(403)
        expect(res.headers.get('access-control-allow-origin'), `${u} ${origin}`).toBeNull()
      }
      const ok = await send(m as never, u, { body: m === 'POST' ? {} : undefined, headers: from(ip(), { origin: ALLOWED, ...json }) })
      expect(ok.status, `${m} ${u}`).not.toBe(403)
      const acao = ok.headers.get('access-control-allow-origin')
      if (acao !== null) expect(acao).toBe(ALLOWED)
      expect(acao).not.toBe('*')
    }
  })

  it('public preflights are refused for foreign origins and never carry credentials', async () => {
    for (const u of ['/api/public/search', '/api/public/contact', '/api/public/submissions', '/api/public/newsletter/subscribe', '/api/public/redirects', '/api/public/advertising']) {
      const bad = await send('OPTIONS', u, { headers: from(ip(), { origin: 'http://evil.test', 'access-control-request-method': 'POST' }) })
      expect(bad.headers.get('access-control-allow-origin'), u).toBeNull()
      const good = await send('OPTIONS', u, { headers: from(ip(), { origin: ALLOWED, 'access-control-request-method': 'POST' }) })
      expect(good.headers.get('access-control-allow-credentials'), u).not.toBe('true')
    }
  })
})

describe('CSRF: a session cookie is only honoured from an allow-listed Origin', () => {
  it('state-changing requests carrying the cookie from a foreign origin run as anonymous (refused)', async () => {
    const u = await mkUser('reporter')
    const token = (await login(u.email, u.password)).json.token as string
    const cookie = { cookie: `payload-token=${token}` }
    const body = { title: `${runId} csrf`, slug: `${runId}-csrf`, content: lexical(), category: f.catA.id }
    for (const headers of [{ origin: 'http://evil.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, {}] as Array<Record<string, string>>) {
      const res = await send('POST', '/api/articles', { body, headers: from(ip(), { ...cookie, ...headers }) })
      expect([401, 403], JSON.stringify(headers)).toContain(res.status)
      const patch = await send('PATCH', `/api/users/${u.id}`, { body: { name: 'pwned' }, headers: from(ip(), { ...cookie, ...headers }) })
      expect([401, 403]).toContain(patch.status)
      const logout = await send('POST', '/api/users/logout', { headers: from(ip(), { ...cookie, ...headers }) })
      expect(logout.status).toBeGreaterThanOrEqual(400) // a cross-site page cannot sign the user out
    }
    expect((await send('GET', '/api/users/me', { token })).json.user?.id).toBe(u.id) // still logged in
    const found = await f.payload.find({ collection: 'articles', where: { slug: { equals: `${runId}-csrf` } }, overrideAccess: true })
    expect(found.totalDocs).toBe(0)
    const allowed = await send('POST', '/api/articles', { body, headers: from(ip(), { ...cookie, origin: 'http://csrf-allowed.test' }) })
    expect(allowed.status).toBe(201)
    await f.payload.delete({ collection: 'articles', where: { slug: { equals: `${runId}-csrf` } }, overrideAccess: true })
  })

  it('a bearer token (Authorization header) is not ambient: CSRF does not apply but a cross-site page cannot read it', async () => {
    const u = await mkUser('reporter')
    const token = (await login(u.email, u.password)).json.token as string
    const res = await send('GET', '/api/users/me', { token, headers: from(ip(), { origin: 'http://evil.test' }) })
    expect(res.json.user?.id).toBe(u.id)
    expect(res.headers.get('access-control-allow-origin')).toBeNull() // so evil.test JS cannot read the answer
  })
})

describe('rate limits answer 429 with Retry-After', () => {
  const until429 = async (fn: (addr: string) => ReturnType<typeof send>, cap = 80) => {
    const addr = ip()
    let last: Awaited<ReturnType<typeof send>> | undefined
    for (let i = 0; i < cap; i++) {
      last = await fn(addr)
      if (last.status === 429) return { res: last, after: i }
    }
    return { res: last!, after: cap }
  }
  const expect429 = (r: { res: Awaited<ReturnType<typeof send>> }, label: string) => {
    expect(r.res.status, label).toBe(429)
    expect(r.res.headers.get('retry-after'), label).toMatch(/^[1-9]\d*$/)
    expect(leaksIn(r.res.text)).toEqual([])
  }

  it('login', async () => {
    resetAll()
    expect429(await until429((a) => login(`${runId}-ghost@test.invalid`, 'whatever-password', a)), 'login')
  })
  it('forgot-password', async () => {
    resetAll()
    expect429(await until429((a) => send('POST', '/api/users/forgot-password', { body: { email: `${runId}-fp@test.invalid` }, headers: from(a) })), 'forgot-password')
  })
  it('reset-password', async () => {
    resetAll()
    expect429(await until429((a) => send('POST', '/api/users/reset-password', { body: { token: 'nope', password: STRONG }, headers: from(a) })), 'reset-password')
  })
  it('public submissions', async () => {
    resetAll()
    expect429(await until429((a) => send('POST', '/api/public/submissions', { body: {}, headers: from(a, json) })), 'submissions')
  })
  it('contact', async () => {
    resetAll()
    expect429(await until429((a) => send('POST', '/api/public/contact', { body: {}, headers: from(a, json) })), 'contact')
  })
  it('newsletter subscribe', async () => {
    resetAll()
    expect429(await until429((a) => send('POST', '/api/public/newsletter/subscribe', { body: {}, headers: from(a, json) })), 'newsletter')
  })
  it('search', async () => {
    resetAll()
    expect429(await until429((a) => send('GET', '/api/public/search?q=church', { headers: from(a) })), 'search')
  })
  it('a limited client does not limit another client', async () => {
    resetAll()
    await until429((a) => send('GET', '/api/public/search?q=church', { headers: from(a) }))
    expect((await send('GET', '/api/public/search?q=church', { headers: from(ip()) })).status).toBe(200)
  })
})

describe('account enumeration and timing', () => {
  it('login: unknown e-mail, wrong password, malformed e-mail all get the same status and message', async () => {
    resetAll()
    const u = await mkUser('reporter')
    const wrong = await login(u.email, 'not-the-password-123')
    const unknown = await login(`${runId}-nobody@test.invalid`, 'not-the-password-123')
    const upper = await login(`  ${u.email.toUpperCase()} `, 'not-the-password-123')
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(wrong.status)
    expect(upper.status).toBe(wrong.status)
    expect(unknown.json).toEqual(wrong.json)
    expect(upper.json).toEqual(wrong.json)
    expect(wrong.text).not.toMatch(/exist|no user|not found|unknown/i)
  })

  it('forgot-password and /users/init: identical answers for existing and missing accounts', async () => {
    resetAll()
    const u = await mkUser('reporter')
    const a = await send('POST', '/api/users/forgot-password', { body: { email: u.email }, headers: from(ip()) })
    const b = await send('POST', '/api/users/forgot-password', { body: { email: `${runId}-gone@test.invalid` }, headers: from(ip()) })
    expect(a.status).toBe(b.status)
    expect(a.json).toEqual(b.json)
    expect(Object.keys(Object.fromEntries(a.headers)).sort()).toEqual(Object.keys(Object.fromEntries(b.headers)).sort())
  })

  it('login timing: a missing user is not distinguishable from a wrong password by response time', async () => {
    resetAll()
    const u = await mkUser('reporter')
    const time = async (email: string) => {
      const t0 = performance.now()
      await login(email, 'not-the-password-123')
      return performance.now() - t0
    }
    const existing: number[] = []
    const missing: number[] = []
    await time(u.email) // warm up
    for (let i = 0; i < 3; i++) {
      existing.push(await time(u.email)) // stays below the lockout threshold (5)
      missing.push(await time(`${runId}-missing${i}@test.invalid`))
    }
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!
    const e = median(existing)
    const m = median(missing)
    // "roughly similar": within 3x or 50 ms of each other (PBKDF2 for an existing user must not be skipped for a missing one)
    expect(Math.abs(e - m) < 50 || Math.max(e, m) / Math.min(e, m) < 3, `existing=${e.toFixed(1)}ms missing=${m.toFixed(1)}ms`).toBe(true)
  })
})

describe('passwords, sessions and cookies', () => {
  it('password policy refuses short, common, personal and oversized passwords (create and change)', async () => {
    const personal = `${runId}-pwperson`
    const bad = ['short1!A', 'password1234', 'Password123456', personal, 'a'.repeat(129) + '1A!', '            ', '123456789012']
    for (const password of bad) {
      const res = await send('POST', '/api/users', {
        token: f.tokens.admin,
        body: { email: `${password === personal ? personal : `${runId}-pw${++userN}`}@test.invalid`, name: 'Pw', password, role: 'reporter' },
      })
      expect(res.status, `password ${password.slice(0, 14)}`).toBe(400)
    }
    const good = await send('POST', '/api/users', {
      token: f.tokens.admin,
      body: { email: `${runId}-pwgood${++userN}@test.invalid`, name: 'Pw', password: STRONG, role: 'reporter' },
    })
    expect(good.status).toBe(201)
  })

  it('cookie flags: HttpOnly, SameSite=Lax (never None), host-only, Path=/; Secure is bound to production in config', async () => {
    const u = await mkUser('reporter')
    const res = await login(u.email, u.password)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).not.toMatch(/SameSite=None/i)
    expect(cookie).not.toMatch(/Domain=/i)
    // In tests NODE_ENV is not production, so the Secure flag is off. It is `secure: isProd` in the collection config;
    // pin that so it cannot be dropped, and check the sanitized value follows NODE_ENV.
    const usersSource = fs.readFileSync(path.resolve(here, '../../src/collections/Users.ts'), 'utf8')
    expect(usersSource).toMatch(/secure:\s*isProd/)
    expect(usersSource).toMatch(/sameSite:\s*'Lax'/)
    const cfg = await config
    const auth = cfg.collections.find((c) => c.slug === 'users')!.auth as { cookies?: { secure?: boolean; sameSite?: string } }
    expect(auth.cookies?.secure).toBe(process.env.NODE_ENV === 'production')
  })

  it('session fixation: a token supplied by the client is never adopted; every login issues a fresh session', async () => {
    resetAll()
    const u = await mkUser('reporter')
    const attackerToken = 'attacker.supplied.token'
    const one = await login(u.email, u.password, ip(), { cookie: `payload-token=${attackerToken}` })
    const two = await login(u.email, u.password)
    expect(one.status).toBe(200)
    expect(one.json.token).not.toBe(attackerToken)
    expect(one.json.token).not.toBe(two.json.token)
    expect(one.headers.get('set-cookie')).not.toContain(attackerToken)
    // the fixated value authenticates nobody
    expect((await send('GET', '/api/users/me', { headers: from(ip(), { cookie: `payload-token=${attackerToken}`, origin: 'http://csrf-allowed.test' }) })).json.user).toBeNull()
    // logging out one session leaves the other (server-side session list), and the logged-out token is dead
    await send('POST', '/api/users/logout', { token: one.json.token, headers: from(ip()) })
    expect((await send('GET', '/api/users/me', { token: one.json.token })).json.user).toBeNull()
    expect((await send('GET', '/api/users/me', { token: two.json.token })).json.user?.id).toBe(u.id)
  })

  it('a JWT with alg=none or a tampered payload is rejected', async () => {
    const u = await mkUser('reporter')
    const real = (await login(u.email, u.password)).json.token as string
    const [h, p, s] = real.split('.') as [string, string, string]
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const adminPayload = b64({ ...payload, id: f.users.admin.id })
    for (const token of [`${b64({ alg: 'none', typ: 'JWT' })}.${p}.`, `${h}.${adminPayload}.${s}`, `${h}.${p}.`, `${h}.${p}`, 'x.y.z']) {
      const res = await send('GET', '/api/users/me', { token })
      expect(res.json.user, token.slice(0, 20)).toBeNull()
    }
  })

  it('first-register is refused when users exist, whatever ALLOW_FIRST_REGISTER says', async () => {
    env.ALLOW_FIRST_REGISTER = 'true'
    const email = `${runId}-fr@test.invalid`
    const res = await send('POST', '/api/users/first-register', { body: { email, password: STRONG, name: 'Mallory', role: 'admin' }, headers: from(ip()) })
    delete env.ALLOW_FIRST_REGISTER
    expect(res.status).toBe(403)
    expect((await f.payload.find({ collection: 'users', where: { email: { equals: email } }, overrideAccess: true })).totalDocs).toBe(0)
  })

  it('first-register policy: production refuses it unless ALLOW_FIRST_REGISTER=true', () => {
    expect(firstRegisterAllowed({ NODE_ENV: 'production' } as never)).toBe(false)
    expect(firstRegisterAllowed({ NODE_ENV: 'production', ALLOW_FIRST_REGISTER: 'false' } as never)).toBe(false)
    expect(firstRegisterAllowed({ NODE_ENV: 'production', ALLOW_FIRST_REGISTER: '1' } as never)).toBe(false)
    expect(firstRegisterAllowed({ NODE_ENV: 'production', ALLOW_FIRST_REGISTER: 'true' } as never)).toBe(true)
  })
})

describe('mass assignment and privilege escalation', () => {
  it('a reporter cannot change their own role, sections or server-owned auth fields (JSON, multipart, nested, bulk)', async () => {
    const u = await mkUser('reporter')
    const token = (await login(u.email, u.password)).json.token as string
    const attempts: Array<() => ReturnType<typeof send>> = [
      () => send('PATCH', `/api/users/${u.id}`, { token, body: { role: 'admin' } }),
      () => send('PATCH', `/api/users/${u.id}`, { token, body: { role: 'editor-in-chief', sections: [f.catA.id, f.catB.id] } }),
      () => send('PATCH', `/api/users/${u.id}`, { token, body: { _verified: true, loginAttempts: 0, lockUntil: null, sessions: [], hash: 'x', salt: 'y', resetPasswordToken: 'z', apiKey: 'k', enableAPIKey: true } }),
      () => send('PATCH', `/api/users/${u.id}?depth=0`, { token, body: { 'role': 'admin', 'role[$set]': 'admin' } as never }),
      () => {
        const form = new FormData()
        form.set('_payload', JSON.stringify({ role: 'admin' }))
        return send('PATCH', `/api/users/${u.id}`, { token, body: form })
      },
      () => send('PATCH', `/api/users?where[id][equals]=${u.id}`, { token, body: { role: 'admin' } }),
      () => send('PATCH', `/api/users?where[role][exists]=true`, { token, body: { role: 'admin' } }),
      () => send('POST', '/api/users', { token, body: { email: `${runId}-esc${++userN}@test.invalid`, password: STRONG, name: 'x', role: 'admin' } }),
      () => send('POST', `/api/users/${u.id}`, { token, body: { role: 'admin' }, headers: { 'x-payload-http-method-override': 'PATCH' } }),
    ]
    for (const [i, attempt] of attempts.entries()) await attempt().catch(() => undefined)
    const row = (await f.payload.db.findOne({ collection: 'users', where: { id: { equals: u.id } } })) as Record<string, any>
    expect(row.role, 'role unchanged').toBe('reporter')
    expect(row.enableAPIKey ?? false).toBe(false)
    expect(row.apiKey ?? null).toBeNull()
    expect(row.resetPasswordToken ?? null).toBeNull()
    expect(row.lockUntil ?? null).toBeNull()
    // and nobody else was promoted by the bulk attempts
    const admins = await f.payload.find({ collection: 'users', where: { role: { equals: 'admin' }, email: { like: runId } }, overrideAccess: true })
    expect(admins.docs.map((d) => (d as { email: string }).email)).toEqual([f.users.admin.email])
    const sections = (row.sections ?? []) as unknown[]
    expect(sections.length).toBe(0)
  })

  it('a reporter cannot set server-owned article fields (publishedAt, legacyId, provenance, status=published)', async () => {
    const res = await send('POST', '/api/articles', {
      token: f.tokens.reporter,
      body: {
        title: `${runId} mass`,
        slug: `${runId}-mass`,
        content: lexical(),
        category: f.catA.id,
        status: 'published',
        publishedAt: '2001-01-01T00:00:00.000Z',
        legacyId: 123456789,
        legacyUrl: 'https://evil.example/',
        provenance: { sourceUrl: 'https://evil.example/', importBatch: 'x' },
        author: f.users.admin.id,
      },
    })
    if (res.status === 201) {
      const row = (await f.payload.findByID({ collection: 'articles', id: res.json.doc.id, overrideAccess: true, depth: 0 })) as Record<string, any>
      expect(row.status).not.toBe('published')
      expect(row.legacyId ?? null).toBeNull()
      expect(row.legacyUrl ?? null).toBeNull()
      expect(row.provenance?.sourceUrl ?? null).toBeNull()
      await f.payload.delete({ collection: 'articles', id: row.id, overrideAccess: true })
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
    }
  })

  it('admin-only operations refuse everyone else: unlock with a real e-mail, revoke-sessions of others', async () => {
    const victim = await mkUser('reporter')
    const anonUnlock = await send('POST', '/api/users/unlock', { body: { email: victim.email }, headers: from(ip()) })
    expect([401, 403]).toContain(anonUnlock.status)
    const reporterUnlock = await send('POST', '/api/users/unlock', { token: f.tokens.reporter, body: { email: victim.email } })
    expect([401, 403]).toContain(reporterUnlock.status)
    const revoke = await send('POST', `/api/users/${victim.id}/revoke-sessions`, { token: f.tokens.reporter, body: {} })
    expect([401, 403]).toContain(revoke.status)
  })
})

describe('body limits, chunked bodies and malformed input', () => {
  it('oversized declared Content-Length: 413 before the body is read (JSON routes 1 MB, media 11 MB)', async () => {
    const big = (n: number) => ({ 'content-length': String(n), ...json })
    expect((await send('POST', '/api/articles', { body: {}, headers: from(ip(), big(2 * 1024 * 1024)), token: f.tokens.reporter })).status).toBe(413)
    expect((await send('POST', '/api/users/login', { body: {}, headers: from(ip(), big(5 * 1024 * 1024)) })).status).toBe(413)
    expect((await send('POST', '/api/media', { body: new FormData(), headers: from(ip(), { 'content-length': String(40 * 1024 * 1024) }), token: f.tokens.reporter })).status).toBe(413)
    expect((await send('POST', '/api/public/contact', { body: {}, headers: from(ip(), { origin: ALLOWED, ...big(5 * 1024 * 1024) }) })).status).toBe(413)
  })

  it('invalid or conflicting Content-Length is a 400', async () => {
    for (const cl of ['-1', 'abc', '1e9', '1, 2', '99999999999999999999', ' ']) {
      const res = await send('POST', '/api/users/login', { body: {}, headers: from(ip(), { 'content-length': cl, ...json }) })
      expect(res.status, cl).toBe(400)
    }
  })

  it('chunked bodies on account routes are refused (411); chunked public bodies are capped while streaming', async () => {
    const res = await send('POST', '/api/users/login', { body: '{}', headers: from(ip(), { 'transfer-encoding': 'chunked', ...json }) })
    expect(res.status).toBe(411)
    const huge = JSON.stringify({ name: 'x', email: 'a@b.test', message: 'm'.repeat(300_000) })
    for (const url of ['/api/public/contact', '/api/public/submissions', '/api/public/newsletter/subscribe']) {
      const r = await send('POST', url, { body: huge, headers: from(ip(), { origin: ALLOWED, ...json }) })
      expect(r.status, url).toBe(413)
    }
  })

  it('chunked (Transfer-Encoding) writes are refused with 411 on every API route, even with a session', async () => {
    for (const [method, url] of [['POST', '/api/articles'], ['PATCH', '/api/articles/1'], ['POST', '/api/media'], ['POST', '/api/public/contact']] as const) {
      const res = await send(method, url, { body: '{}', token: f.tokens.reporter, headers: from(ip(), { 'transfer-encoding': 'chunked', ...json }) })
      expect(res.status, `${method} ${url}`).toBe(411)
    }
  })

  it('the larger media allowance needs a VERIFIED session: forged Authorization/Cookie tokens still get the 11 MB cap (413)', async () => {
    const forged = [
      'forged.token.value',
      `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"exp":9999999999}').toString('base64url')}.`,
      `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"exp":9999999999,"id":1}').toString('base64url')}.AAAA`,
    ]
    const big = String(40 * 1024 * 1024)
    for (const t of forged) {
      for (const headers of [{ authorization: `JWT ${t}` }, { cookie: `payload-token=${t}` }] as Array<Record<string, string>>) {
        const res = await send('POST', '/api/media', { body: new FormData(), headers: from(ip(), { 'content-length': big, ...headers }) })
        expect(res.status, t.slice(0, 20)).toBe(413)
      }
    }
    // a genuine session is only allowed more when the deployment configured it; by default the cap is the same 11 MB
    const real = await send('POST', '/api/media', { body: new FormData(), token: f.tokens.reporter, headers: from(ip(), { 'content-length': big }) })
    expect(real.status).toBe(413)
  })

  it('malformed JSON and wrong content types never reach a 500 or leak internals', async () => {
    for (const body of ['{', '[]', 'null', '"x"', '{"a":' + '['.repeat(5000), '\u0000', '{"email":{"$ne":null},"password":{"$ne":null}}']) {
      for (const url of ['/api/users/login', '/api/public/contact', '/api/public/submissions', '/api/public/newsletter/subscribe', '/api/users/forgot-password']) {
        const res = await send('POST', url, { body, headers: from(ip(), { origin: ALLOWED, ...json }) })
        expect(res.status, `${url} ${body.slice(0, 20)}`).toBeLessThan(500)
        expect(leaksIn(res.text)).toEqual([])
      }
    }
    const res = await send('POST', '/api/public/contact', { body: 'a=b', headers: from(ip(), { origin: ALLOWED, 'content-type': 'application/x-www-form-urlencoded' }) })
    expect(res.status).toBe(415)
  })

  it('NoSQL-style operator objects in credentials do not authenticate', async () => {
    resetAll()
    const res = await login({ $ne: null } as never, { $ne: null } as never)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.json?.token).toBeUndefined()
  })
})

describe('slugs: unicode, null bytes, reserved names', () => {
  const create = (slug: string, title = `${runId} slug test`) =>
    send('POST', '/api/articles', { token: f.tokens.reporter, body: { title, slug, content: lexical(), category: f.catA.id } })
  const cleanup = (id?: number) => (id ? f.payload.delete({ collection: 'articles', id, overrideAccess: true }).catch(() => undefined) : undefined)

  it('reserved root slugs are refused (case-insensitive) and null-byte / unicode / traversal slugs never become routes', async () => {
    for (const slug of ['admin', 'API', 'graphql', 'newsroom', 'wp-admin', 'health', 'Search', 'login', 'admin ', ' admin']) {
      const res = await create(slug)
      if (res.status === 201) {
        expect(isReservedSlug(res.json.doc.slug), `${slug} -> ${res.json.doc.slug}`).toBe(false)
        await cleanup(res.json.doc.id)
      } else {
        expect(res.status, slug).toBeLessThan(500)
      }
    }
    for (const slug of [`${runId}-nul\u0000byte`, `${runId}-%00`, `${runId}-‮evil`, `${runId}-ｆｕｌｌｗｉｄｔｈ`, `${runId}-é`, `${runId}-../../etc`, `${runId}-a/b`, `${runId}-a\\b`, `${runId}-${'x'.repeat(500)}`, `${runId}--double`, `-${runId}`, `${runId}-😀`]) {
      const res = await create(slug)
      expect(res.status, JSON.stringify(slug)).toBeLessThan(500)
      if (res.status === 201) {
        expect(res.json.doc.slug, JSON.stringify(slug)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
        await cleanup(res.json.doc.id)
      }
    }
  })

  it('a title that slugifies to a reserved word is given a different slug', async () => {
    for (const title of ['Admin', 'API', 'ａｄｍｉｎ', 'Search']) {
      const res = await send('POST', '/api/articles', { token: f.tokens.reporter, body: { title, content: lexical(), category: f.catA.id } })
      if (res.status === 201) {
        expect(isReservedSlug(res.json.doc.slug), `${title} -> ${res.json.doc.slug}`).toBe(false)
        await cleanup(res.json.doc.id)
      } else {
        expect(res.status).toBeLessThan(500)
      }
    }
  })

  it('slug lookups with hostile values are 4xx/404 and never 500', async () => {
    for (const slug of ['%00', '%2e%2e', 'a%2fb', '%E2%80%AE', 'x'.repeat(5000), "'--", '%']) {
      const res = await send('GET', `/api/live-events/${slug}/updates`, { headers: from(ip()) })
      expect(res.status, slug.slice(0, 20)).toBeLessThan(500)
    }
    for (const q of ['%00', "' OR 1=1 --", 'a'.repeat(5000), '%E2%80%AE', '\\', '%25']) {
      const res = await send('GET', `/api/public/search?q=${q}`, { headers: from(ip()) })
      expect(res.status, q.slice(0, 20)).toBeLessThan(500)
    }
  })
})
