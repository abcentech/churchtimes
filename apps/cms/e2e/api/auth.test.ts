/**
 * Staff authentication against the real server: login / me / logout with the cookie AND the JWT header,
 * invalid / expired / revoked tokens, and CSRF (a cookie only counts from an allowlisted Origin).
 */
import { describe, expect, it } from 'vitest'

import {
  CMS_ORIGIN,
  Client,
  EVIL_ORIGIN,
  NEWSROOM_ORIGIN,
  credentialsFor,
  loginAs,
  resignToken,
  stagingPayloadSecret,
} from './support'

describe('staff login / me / logout', () => {
  it('login with email + password returns 200, a JWT, the user and a hardened payload-token cookie', async () => {
    const c = new Client()
    const { email, password } = credentialsFor('editor-in-chief')
    const res = await c.login(email, password)

    expect(res.status).toBe(200)
    expect(res.json.message).toBe('Authentication Passed')
    expect(typeof res.json.token).toBe('string')
    expect(res.json.token.split('.')).toHaveLength(3)
    expect(res.json.user).toMatchObject({ email, role: 'editor-in-chief' })
    expect(res.json.user.hash).toBeUndefined()
    expect(res.json.user.salt).toBeUndefined()
    expect(JSON.stringify(res.json)).not.toMatch(/"password"/)

    const cookie = res.setCookies.find((s) => s.startsWith('payload-token='))
    expect(cookie, 'Set-Cookie payload-token').toBeTruthy()
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toMatch(/Secure/i) // NODE_ENV=production under `next start`
    expect(cookie).toMatch(/Path=\//i)
    expect(cookie).not.toMatch(/Domain=/i) // host-only
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
  })

  it('GET /api/users/me with the cookie returns the signed-in user', async () => {
    const { client, user } = await loginAs('reporter')
    const me = await client.get('/api/users/me')
    expect(me.status).toBe(200)
    expect(me.json.user).toMatchObject({ id: user.id, role: 'reporter', collection: 'users' })
    expect(me.json.user.hash).toBeUndefined()
  })

  it('GET /api/users/me with `Authorization: JWT <token>` (no cookie) returns the signed-in user', async () => {
    const { token, user } = await loginAs('admin')
    const anon = new Client()
    const me = await anon.get('/api/users/me', { token })
    expect(me.status).toBe(200)
    expect(me.json.user).toMatchObject({ id: user.id, role: 'admin' })
  })

  it('wrong credentials: 401 with the same message for an unknown e-mail (no enumeration)', async () => {
    const c = new Client()
    const unknown = await c.login('nobody-e2e@staging.invalid', 'Definitely-not-the-password-1')
    expect(unknown.status).toBe(401)
    expect(unknown.json.errors[0].message).toBe('The email or password provided is incorrect.')
    expect(unknown.setCookies.find((s) => s.startsWith('payload-token='))).toBeUndefined()
  })

  it('logout returns 200, clears the cookie and ends the session: the old cookie AND the old JWT are then anonymous', async () => {
    const { client, token } = await loginAs('trusted-publisher')
    const cookieBefore = client.cookieHeader()
    expect((await client.get('/api/users/me')).json.user).not.toBeNull()

    const out = await client.post('/api/users/logout')
    expect(out.status).toBe(200)
    expect(out.json.message).toMatch(/logout successful/i)
    expect(client.cookies.has('payload-token'), 'cookie cleared in the jar').toBe(false)

    // Replay the pre-logout cookie: the server-side session is gone, so it no longer authenticates.
    const replayCookie = new Client()
    const meCookie = await replayCookie.get('/api/users/me', { headers: { cookie: cookieBefore } })
    expect(meCookie.status).toBe(200)
    expect(meCookie.json.user).toBeNull()

    const meJwt = await new Client().get('/api/users/me', { token })
    expect(meJwt.json.user).toBeNull()
  })

  it('me after logout (fresh jar) returns 200 with user: null, not an error', async () => {
    const { client } = await loginAs('reporter')
    await client.post('/api/users/logout')
    const me = await client.get('/api/users/me')
    expect(me.status).toBe(200)
    expect(me.json.user).toBeNull()
  })
})

describe('invalid, tampered and expired sessions', () => {
  it('a garbage token is unauthenticated (me -> user null) and protected collections refuse it', async () => {
    const c = new Client()
    const me = await c.get('/api/users/me', { token: 'not.a.jwt' })
    expect(me.status).toBe(200)
    expect(me.json.user).toBeNull()
    const subs = await c.get('/api/submissions', { token: 'not.a.jwt' })
    expect([401, 403]).toContain(subs.status)
  })

  it('a token signed with the wrong key is rejected', async () => {
    const { token } = await loginAs('admin')
    const forged = resignToken(token, {}, 'a-completely-different-secret-0123456789', true)
    const me = await new Client().get('/api/users/me', { token: forged })
    expect(me.json.user).toBeNull()
  })

  it('an EXPIRED token (valid signature, exp in the past) is rejected', async (ctx) => {
    const secret = stagingPayloadSecret()
    if (!secret) return ctx.skip()
    const { token, user } = await loginAs('admin')
    // Sanity: the genuine token works, and re-signing it unchanged (same key derivation) also works.
    const unchanged = resignToken(token, {}, secret)
    expect((await new Client().get('/api/users/me', { token: unchanged })).json.user?.id, 'forging helper is faithful').toBe(user.id)

    const past = Math.floor(Date.now() / 1000) - 3600
    const expired = resignToken(token, { iat: past - 3600, exp: past }, secret)
    const me = await new Client().get('/api/users/me', { token: expired })
    expect(me.status).toBe(200)
    expect(me.json.user).toBeNull()
    const protectedRead = await new Client().get('/api/audit-logs?limit=1', { token: expired })
    expect([401, 403]).toContain(protectedRead.status)
  })

  it('a valid cookie sent from a NON-allowlisted Origin is treated as anonymous (CSRF protection)', async () => {
    const { client } = await loginAs('admin')
    const evil = await client.get('/api/users/me', { origin: EVIL_ORIGIN })
    expect(evil.json.user, 'cookie must not authenticate from an unlisted origin').toBeNull()
    const ok = await client.get('/api/users/me', { origin: NEWSROOM_ORIGIN })
    expect(ok.json.user, 'allowlisted newsroom origin').not.toBeNull()
    const self = await client.get('/api/users/me', { origin: CMS_ORIGIN })
    expect(self.json.user, 'the CMS origin itself').not.toBeNull()
  })

  it('anonymous callers cannot read staff-only collections', async () => {
    const c = new Client()
    for (const p of ['/api/submissions', '/api/audit-logs', '/api/users', '/api/live-updates?limit=1']) {
      const res = await c.get(p, { credentials: false })
      if (p.startsWith('/api/live-updates')) {
        // Readable collection, but only approved rows (checked in public-visibility.test.ts).
        expect(res.status, p).toBe(200)
      } else {
        expect([401, 403], `${p} -> ${res.status}`).toContain(res.status)
      }
    }
  })
})
