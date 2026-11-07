import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { hasValidSession, sessionSigningSecret, sessionTokenFromHeaders, verifySessionJwt } from '../../src/lib/sessionToken'

const env = { PAYLOAD_SECRET: 'unit-test-secret-0123456789-0123456789-abcdef' }
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (claims: Record<string, unknown>, e: Record<string, string> = env, alg = 'HS256') => {
  const head = b64({ alg, typ: 'JWT' })
  const body = b64(claims)
  const sig = createHmac('sha256', sessionSigningSecret(e)).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
const now = Date.now()
const future = Math.floor(now / 1000) + 600

describe('session JWT verification (proxy.ts)', () => {
  it('accepts a correctly signed, unexpired token', () => {
    expect(verifySessionJwt(sign({ id: 1, exp: future }), env, now)).toBe(true)
  })
  it('rejects forged, expired, wrong-secret, wrong-alg, malformed and exp-less tokens', () => {
    expect(verifySessionJwt('x', env, now)).toBe(false)
    expect(verifySessionJwt('a.b.c', env, now)).toBe(false)
    expect(verifySessionJwt(sign({ exp: Math.floor(now / 1000) - 5 }), env, now)).toBe(false)
    expect(verifySessionJwt(sign({ id: 1 }), env, now)).toBe(false)
    expect(verifySessionJwt(sign({ exp: future }, { PAYLOAD_SECRET: 'another-secret-0123456789-0123456789-xyz' }), env, now)).toBe(false)
    expect(verifySessionJwt(sign({ exp: future }, env, 'none'), env, now)).toBe(false)
    const good = sign({ exp: future })
    expect(verifySessionJwt(`${good.slice(0, -2)}AA`, env, now)).toBe(false)
  })
  it('reads the token from "Authorization: JWT" or the payload-token cookie only', () => {
    const t = sign({ exp: future })
    expect(hasValidSession(new Headers({ authorization: `JWT ${t}` }), env, now)).toBe(true)
    expect(hasValidSession(new Headers({ cookie: `a=1; payload-token=${t}` }), env, now)).toBe(true)
    expect(hasValidSession(new Headers({ authorization: 'x' }), env, now)).toBe(false)
    expect(hasValidSession(new Headers({ authorization: 'JWT forged' }), env, now)).toBe(false)
    expect(hasValidSession(new Headers({ cookie: 'a-token=1' }), env, now)).toBe(false)
    expect(hasValidSession(new Headers({ cookie: `other-token=${t}` }), env, now)).toBe(false)
    expect(hasValidSession(new Headers(), env, now)).toBe(false)
    expect(sessionTokenFromHeaders(new Headers({ cookie: 'payload-token=' }))).toBeNull()
  })
})
