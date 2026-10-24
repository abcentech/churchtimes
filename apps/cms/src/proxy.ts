import { NextResponse, type NextRequest } from 'next/server'

import { checkRelationFilters } from './lib/queryGuards'
import { checkRequestLimits, wantsLargeMediaBody } from './lib/requestLimits'
import { hasValidSession } from './lib/sessionToken'
import { csv, normaliseOrigin } from './lib/securityConfig'

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts` (Node.js runtime). Rejects oversized or
 * length-less request bodies (lib/requestLimits.ts) and malformed relationship filters
 * (lib/queryGuards.ts) on /api/* before a route handler runs. See docs/operations.md for the matching
 * reverse-proxy limits.
 *
 * Rejections are answered here, so Payload never adds CORS headers to them. Without the grant below a
 * browser on an allowlisted origin would see an opaque network error instead of the 4xx body; we echo
 * the origin only when it is in CMS_CORS_ORIGINS (never `*`), exactly like Payload does.
 *
 * Note: while a proxy file exists Next buffers each request body (up to
 * `experimental.proxyClientMaxBodySize`, sized in next.config.mjs from MEDIA_AV_MAX_MB so uploads are never truncated).
 */
const corsHeaders = (origin: string | null): Record<string, string> => {
  if (!origin) return {}
  let allowed: string[] = []
  try {
    allowed = csv(process.env.CMS_CORS_ORIGINS).map(normaliseOrigin)
  } catch {
    return {}
  }
  return allowed.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' }
    : {}
}

/**
 * Shared-cache policy for the anonymous public reads of Payload's own REST routes (they carry no Cache-Control of their
 * own). Only a GET/HEAD with NO credentials is given one: any Cookie or Authorization header (staff, preview, anything
 * personal) leaves the response untouched, and so does a `draft` or `preview` query. An anonymous caller can only ever
 * read published rows (collection access), so the body is the same for everyone. Short on purpose: an unpublished or
 * corrected article leaves a cache within one minute. See docs/performance.md.
 */
export const PUBLIC_READ_CACHE: ReadonlyArray<{ path: RegExp; cacheControl: string }> = [
  { path: /^\/api\/articles\/?$/, cacheControl: 'public, max-age=60' },
  { path: /^\/api\/categories\/?$/, cacheControl: 'public, max-age=300' },
]

export function publicReadCacheControl(
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  headers: Headers,
): string | null {
  if (method !== 'GET' && method !== 'HEAD') return null
  if (headers.get('cookie') || headers.get('authorization')) return null
  if (searchParams.has('draft') || searchParams.has('preview')) return null
  return PUBLIC_READ_CACHE.find((r) => r.path.test(pathname))?.cacheControl ?? null
}

export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl
  // The larger /api/media allowance is for verified staff sessions only (a forged header or cookie does not count).
  const authenticated = wantsLargeMediaBody(pathname, request.headers) && hasValidSession(request.headers)
  const limits = checkRequestLimits({ method: request.method, pathname, headers: request.headers, authenticated })
  const decision = limits.ok
    ? (() => {
        const q = checkRelationFilters(pathname, searchParams)
        return q.ok ? q : { ...q, errors: [{ field: q.field, message: q.message }] }
      })()
    : { ...limits, errors: [{ message: limits.message }] }
  if (decision.ok) {
    // Payload echoes the request Origin in Access-Control-Allow-Origin, so a shared cache (CDN, reverse
    // proxy) must key API responses on Origin or it could replay one origin's grant to another.
    const res = NextResponse.next()
    res.headers.append('Vary', 'Origin')
    const cacheControl = publicReadCacheControl(request.method, pathname, searchParams, request.headers)
    if (cacheControl) res.headers.set('Cache-Control', cacheControl)
    return res
  }
  return NextResponse.json(
    { ok: false, errors: decision.errors },
    {
      status: decision.status,
      headers: { 'Cache-Control': 'no-store', ...corsHeaders(request.headers.get('origin')) },
    },
  )
}

export const config = {
  matcher: '/api/:path*',
}
