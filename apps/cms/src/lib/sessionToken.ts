import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifies the signature and expiry of a Payload session JWT without touching the database, for the request-size policy in
 * `src/proxy.ts`: a body larger than the anonymous cap is only accepted from a caller holding a genuine, unexpired session
 * token, never from one who merely sends an `Authorization` or `Cookie` header. (Payload still authenticates the request
 * properly afterwards; this only decides how much body may be buffered first.)
 *
 * Payload signs sessions as HS256 with the secret `sha256(PAYLOAD_SECRET)` as hex, first 32 characters. The cookie is
 * `payload-token` (default prefix, see payload.config.ts) and the header form is `Authorization: JWT <token>`.
 */
const TEST_SECRET = 'test-only-secret-not-for-production-use-0123456789'
export const SESSION_COOKIE = 'payload-token'

export const sessionSigningSecret = (env: Record<string, string | undefined> = process.env): string =>
  createHash('sha256').update(env.PAYLOAD_SECRET || TEST_SECRET).digest('hex').slice(0, 32)

const b64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

export function verifySessionJwt(token: string, env: Record<string, string | undefined> = process.env, nowMs: number = Date.now()): boolean {
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((p) => p === '' || !/^[A-Za-z0-9_-]+$/.test(p))) return false
  try {
    const header = JSON.parse(b64url(parts[0]!).toString('utf8')) as { alg?: unknown }
    if (header.alg !== 'HS256') return false
    const expected = createHmac('sha256', sessionSigningSecret(env)).update(`${parts[0]}.${parts[1]}`).digest()
    const given = b64url(parts[2]!)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
    const claims = JSON.parse(b64url(parts[1]!).toString('utf8')) as { exp?: unknown }
    return typeof claims.exp === 'number' && claims.exp * 1000 > nowMs
  } catch {
    return false
  }
}

/** The token a request presents: `Authorization: JWT <token>`, else the session cookie. */
export function sessionTokenFromHeaders(headers: { get(name: string): string | null }): string | null {
  const auth = headers.get('authorization')
  const m = auth ? /^JWT\s+(\S+)\s*$/i.exec(auth) : null
  if (m) return m[1]!
  const cookie = headers.get('cookie')
  if (!cookie) return null
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim() || null
  }
  return null
}

export function hasValidSession(
  headers: { get(name: string): string | null },
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now(),
): boolean {
  const token = sessionTokenFromHeaders(headers)
  return token !== null && verifySessionJwt(token, env, nowMs)
}
