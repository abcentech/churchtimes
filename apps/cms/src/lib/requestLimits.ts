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
 * - ANONYMOUS (or unverified) callers: never more than 11 MB (10 MB image + framing). Next buffers a request body before
 *   Payload authenticates it, so a bigger allowance for anyone who merely sends an Authorization or Cookie header would let
 *   them make the server buffer it. "Authenticated" means `proxy.ts` verified a genuine, unexpired session token (lib/sessionToken.ts);
 * - Staff with a verified session get a larger limit ONLY when it is configured: `MEDIA_UPLOAD_MAX_MB` (11 to 500) if set, else
 *   max(10, `MEDIA_AV_MAX_MB`) when `MEDIA_AV_MAX_MB` is set explicitly, + 1 MB framing. With neither set the limit stays 11 MB
 *   (the Next body buffer in next.config.mjs is then the small 12 MB too, so nothing is silently truncated). Precedence:
 *   MEDIA_UPLOAD_MAX_MB, then MEDIA_AV_MAX_MB, then 11 MB. (`MEDIA_AV_MAX_MB` alone still sets the per-file audio/video cap, default 100.)
 * Only this route changes: every other API route keeps its 1 MB limit. See operations.md section 4.4.
 */
export function mediaBodyLimitBytes(env: Record<string, string | undefined> = process.env, authenticated = false): number {
  if (!authenticated) return MAX_MEDIA_BODY_BYTES
  const override = Number(env.MEDIA_UPLOAD_MAX_MB)
  if (Number.isInteger(override) && override >= 11) return (Math.min(override, MEDIA_UPLOAD_MAX_MB_LIMIT) + 1) * 1024 * 1024
  if (env.MEDIA_AV_MAX_MB !== undefined && env.MEDIA_AV_MAX_MB.trim() !== '' && Number.isFinite(Number(env.MEDIA_AV_MAX_MB)) && Number(env.MEDIA_AV_MAX_MB) >= 1) {
    const avMb = Math.floor(avMaxBytes(env) / (1024 * 1024))
    return Math.max(MAX_MEDIA_BODY_BYTES, (Math.max(10, avMb) + 1) * 1024 * 1024)
  }
  return MAX_MEDIA_BODY_BYTES
}

export type RequestLimitDecision =
  | { ok: true }
  | { ok: false; status: 400 | 411 | 413; message: string }

type Input = {
  method: string
  pathname: string
  headers: { get(name: string): string | null }
  /** The caller presented a verified session (see `hasValidSession`); only consulted for /api/media. */
  authenticated?: boolean
}

const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/')
const isMediaPath = (p: string) => p === '/api/media' || p.startsWith('/api/media/')
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT'])

export function checkRequestLimits({ method, pathname, headers, authenticated = false }: Input): RequestLimitDecision {
  if (!isApiPath(pathname)) return { ok: true }
  const media = isMediaPath(pathname)

  // A body without a declared length (chunked) cannot be size-checked here and Next would buffer it up to its own limit
  // before any route runs. Nothing legitimate sends one to this API (browsers and the newsroom send Content-Length), so every
  // write is refused with 411. Bodyless POSTs such as logout have neither header and are fine.
  if (WRITE_METHODS.has(method.toUpperCase()) && headers.get('transfer-encoding') !== null) {
    return { ok: false, status: 411, message: 'Content-Length is required.' }
  }

  const declared = headers.get('content-length')
  if (declared !== null) {
    const value = declared.trim()
    if (!/^[0-9]{1,15}$/.test(value)) {
      return { ok: false, status: 400, message: 'Invalid Content-Length header.' }
    }
    const limit = media ? mediaBodyLimitBytes(process.env, authenticated) : MAX_JSON_BODY_BYTES
    if (Number(value) > limit) {
      return {
        ok: false,
        status: 413,
        message: `Request body too large (limit ${Math.floor(limit / (1024 * 1024))} MB for this route).`,
      }
    }
  }
  return { ok: true }
}

/** True when this request may need the larger authenticated media limit (so the proxy should verify the session). */
export const wantsLargeMediaBody = (pathname: string, headers: { get(name: string): string | null }): boolean => {
  if (!isMediaPath(pathname)) return false
  const declared = Number((headers.get('content-length') ?? '').trim())
  return Number.isFinite(declared) && declared > MAX_MEDIA_BODY_BYTES
}
