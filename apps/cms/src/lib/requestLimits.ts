/**
 * Request-size policy for the REST API, enforced by `src/proxy.ts` (Next.js 16 "proxy", the renamed
 * middleware) before any Payload route handler reads a body.
 *
 * Payload's core routes read request bodies without a size limit, so a client could make the server
 * buffer an arbitrarily large JSON document. The reverse proxy is the primary guard (operations.md:
 * `request_body max_size 12MB` / `client_max_body_size 12m`); this is the second layer, and the only
 * one for deployments that forget the first.
 *
 * Pure function (no Next imports) so it can be unit tested.
 */
import { avMaxBytes } from './avMedia'


/** Largest accepted body for every non-upload API route. */
export const MAX_JSON_BODY_BYTES = 1024 * 1024
/** Largest accepted body for /api/media (10 MB file limit + multipart framing). */
export const MAX_MEDIA_BODY_BYTES = 11 * 1024 * 1024

/** Ceiling for the upload route (whole MB). */
export const MEDIA_UPLOAD_MAX_MB_LIMIT = 500

/**
 * Body limit for /api/media, one rule for the whole app (next.config.mjs repeats it, keep them in step):
 * - an ANONYMOUS request (no auth cookie, no Authorization header) is never allowed more than 11 MB (10 MB image + framing).
 *   Next buffers the body of every request before Payload authenticates it, so a bigger anonymous allowance would let
 *   anyone make the server buffer hundreds of MB for nothing;
 * - an AUTHENTICATED request gets max(image cap, audio/video cap) + 1 MB framing, where the audio/video cap is
 *   `MEDIA_AV_MAX_MB` (default 100). That single variable is the source of truth, so a 40 MB podcast is not refused with a
 *   413 by the request limit while the Media collection would accept it;
 * - `MEDIA_UPLOAD_MAX_MB` (11 to 500) is an optional explicit override of that derived value for authenticated requests
 *   (precedence: MEDIA_UPLOAD_MAX_MB, then MEDIA_AV_MAX_MB, then the 100 MB default).
 * Only this route changes: every other API route keeps its 1 MB limit. See operations.md section 4.4 (the reverse proxy
 * must allow the same size).
 */
export function mediaBodyLimitBytes(env: Record<string, string | undefined> = process.env, authenticated = false): number {
  if (!authenticated) return MAX_MEDIA_BODY_BYTES
  const override = Number(env.MEDIA_UPLOAD_MAX_MB)
  if (Number.isInteger(override) && override >= 11) return (Math.min(override, MEDIA_UPLOAD_MAX_MB_LIMIT) + 1) * 1024 * 1024
  const avMb = Math.floor(avMaxBytes(env) / (1024 * 1024))
  return (Math.max(10, avMb) + 1) * 1024 * 1024
}

/** True when the request carries credentials (Payload's `payload-token` cookie or an Authorization header). Not verified here. */
export function hasAuthCredentials(headers: { get(name: string): string | null }): boolean {
  const authorization = headers.get('authorization')
  if (authorization !== null && authorization.trim() !== '') return true
  const cookie = headers.get('cookie')
  return cookie !== null && /(?:^|;\s*)[A-Za-z0-9_-]*-token=[^;\s]/.test(cookie)
}

export type RequestLimitDecision =
  | { ok: true }
  | { ok: false; status: 400 | 411 | 413; message: string }

type Input = {
  method: string
  pathname: string
  headers: { get(name: string): string | null }
}

const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/')
const isMediaPath = (p: string) => p === '/api/media' || p.startsWith('/api/media/')
const isUsersPath = (p: string) => p === '/api/users' || p.startsWith('/api/users/')
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT'])

export function checkRequestLimits({ method, pathname, headers }: Input): RequestLimitDecision {
  if (!isApiPath(pathname)) return { ok: true }
  const media = isMediaPath(pathname)

  const declared = headers.get('content-length')
  if (declared !== null) {
    const value = declared.trim()
    if (!/^[0-9]{1,15}$/.test(value)) {
      return { ok: false, status: 400, message: 'Invalid Content-Length header.' }
    }
    const limit = media ? mediaBodyLimitBytes(process.env, hasAuthCredentials(headers)) : MAX_JSON_BODY_BYTES
    if (Number(value) > limit) {
      return {
        ok: false,
        status: 413,
        message: `Request body too large (limit ${Math.floor(limit / (1024 * 1024))} MB for this route).`,
      }
    }
    return { ok: true }
  }

  // No Content-Length: a request with a body must then be chunked. Refuse that on the account/auth
  // routes and on /api/media, where nothing legitimate sends unbounded bodies (a chunked body there could not be size-checked). (Bodyless POSTs such as logout have
  // neither header and are fine.)
  if (
    WRITE_METHODS.has(method.toUpperCase()) &&
    (isUsersPath(pathname) || media) &&
    headers.get('transfer-encoding') !== null
  ) {
    return { ok: false, status: 411, message: 'Content-Length is required.' }
  }
  return { ok: true }
}
