/**
 * CORS allowlist and preflight on the Payload REST API (not the custom submissions endpoint, which has its own
 * test in submissions.test.ts). Origins come from the staging env: newsroom + public site + the CMS itself.
 */
import { describe, expect, it } from 'vitest'

import { CMS_ORIGIN, Client, EVIL_ORIGIN, NEWSROOM_ORIGIN, PUBLIC_ORIGIN, credentialsFor } from './support'

const acao = (r: { headers: Headers }) => r.headers.get('access-control-allow-origin')

describe('CORS allowlist (CMS_CORS_ORIGINS)', () => {
  it('an allowlisted origin is echoed exactly, with credentials allowed and Vary: Origin', async () => {
    for (const origin of [NEWSROOM_ORIGIN, PUBLIC_ORIGIN, CMS_ORIGIN, 'http://localhost:5174']) {
      const res = await new Client(origin).get('/api/categories?limit=1', { credentials: false })
      expect(res.status, origin).toBe(200)
      expect(acao(res), origin).toBe(origin)
      expect(res.headers.get('access-control-allow-credentials'), origin).toBe('true')
      expect(res.headers.get('vary') ?? '', origin).toMatch(/Origin/i)
    }
  })

  it('a disallowed origin gets NO Access-Control-Allow-Origin (and never a wildcard)', async () => {
    for (const origin of [EVIL_ORIGIN, 'http://newsroom.churchtimes.localhost:5175', 'https://newsroom.churchtimes.localhost:5174', 'null']) {
      const res = await new Client(origin).get('/api/categories?limit=1', { credentials: false })
      expect(res.status, origin).toBe(200) // the request was served; only the CORS grant is withheld
      expect(acao(res), origin).toBeNull()
      expect(res.headers.get('access-control-allow-credentials'), origin).toBeNull()
    }
    const noOrigin = await new Client().get('/api/categories?limit=1', { origin: null, credentials: false })
    expect(noOrigin.status).toBe(200)
    expect(acao(noOrigin)).toBeNull()
  })

  it('OPTIONS preflight for login from the newsroom origin returns the grant for POST + Content-Type', async () => {
    const res = await new Client(NEWSROOM_ORIGIN).request('OPTIONS', '/api/users/login', {
      origin: NEWSROOM_ORIGIN,
      credentials: false,
      headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
    expect([200, 204]).toContain(res.status)
    expect(acao(res)).toBe(NEWSROOM_ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/)
    expect(res.headers.get('access-control-allow-methods')).toMatch(/PATCH/)
    expect(res.headers.get('access-control-allow-headers')).toMatch(/content-type/i)
  })

  it('OPTIONS preflight from a disallowed origin returns no grant', async () => {
    const res = await new Client(EVIL_ORIGIN).request('OPTIONS', '/api/users/login', {
      origin: EVIL_ORIGIN,
      credentials: false,
      headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
    expect(acao(res)).toBeNull()
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('login from the newsroom origin carries the grant on the response and the cookie authenticates later calls from that origin', async () => {
    const c = new Client(NEWSROOM_ORIGIN)
    const { email, password } = credentialsFor('section-editor')
    const login = await c.login(email, password)
    expect(login.status).toBe(200)
    expect(acao(login)).toBe(NEWSROOM_ORIGIN)
    expect(login.headers.get('access-control-allow-credentials')).toBe('true')
    const me = await c.get('/api/users/me')
    expect(me.json.user?.email).toBe(email)
    expect(acao(me)).toBe(NEWSROOM_ORIGIN)
    await c.post('/api/users/logout')
  })
})
