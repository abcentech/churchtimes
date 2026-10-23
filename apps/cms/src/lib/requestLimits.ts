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

/** Largest accepted body for every non-upload API route. */
export const MAX_JSON_BODY_BYTES = 1024 * 1024
/** Largest accepted body for /api/media (10 MB file limit + multipart framing). */
export const MAX_MEDIA_BODY_BYTES = 11 * 1024 * 1024

/** Opt-in ceiling for the upload route: `MEDIA_UPLOAD_MAX_MB` (whole MB, 11 to 500). Unset or invalid keeps the default. */
export const MEDIA_UPLOAD_MAX_MB_LIMIT = 500

/**
 * Body limit for /api/media. Default 11 MB (10 MB image + framing). With `MEDIA_UPLOAD_MAX_MB=N` (N from 11 to 500) it is
 * N MB + 1 MB framing. Only this route changes: every other API route keeps its 1 MB limit. See operations.md section 4.4
 * for the other two places that must be raised with it (next.config.mjs reads the same variable; the reverse proxy does not).
 */
export function mediaBodyLimitBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MEDIA_UPLOAD_MAX_MB)
  if (!Number.isInteger(n) || n < 11) return MAX_MEDIA_BODY_BYTES
  return (Math.min(n, MEDIA_UPLOAD_MAX_MB_LIMIT) + 1) * 1024 * 1024
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

  const declared = headers.get('content-length')
  if (declared !== null) {
    const value = declared.trim()
    if (!/^[0-9]{1,15}$/.test(value)) {
      return { ok: false, status: 400, message: 'Invalid Content-Length header.' }
    }
    const limit = isMediaPath(pathname) ? mediaBodyLimitBytes() : MAX_JSON_BODY_BYTES
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
  // routes, where nothing legitimate sends unbounded bodies. (Bodyless POSTs such as logout have
  // neither header and are fine.)
  if (
    WRITE_METHODS.has(method.toUpperCase()) &&
    isUsersPath(pathname) &&
    headers.get('transfer-encoding') !== null
  ) {
    return { ok: false, status: 411, message: 'Content-Length is required.' }
  }
  return { ok: true }
}
