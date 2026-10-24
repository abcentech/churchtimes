import { NextResponse, type NextRequest } from 'next/server'

import { checkRelationFilters, checkRequestShape, scanMultipartPrefix } from './lib/queryGuards'
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

export async function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl
  // The larger /api/media allowance is for verified staff sessions only (a forged header or cookie does not count).
  const authenticated = wantsLargeMediaBody(pathname, request.headers) && hasValidSession(request.headers)
  const limits = checkRequestLimits({ method: request.method, pathname, headers: request.headers, authenticated })
  const shape = checkRequestShape(pathname, request.nextUrl.search)
  const decision = !shape.ok
    ? { ...shape, errors: [{ message: shape.message }] }
    : limits.ok
      ? (() => {
          const q = checkRelationFilters(pathname, searchParams)
          return q.ok ? q : { ...q, errors: [{ field: q.field, message: q.message }] }
        })()
      : { ...limits, errors: [{ message: limits.message }] }
  if (decision.ok && (request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data') && ['POST', 'PATCH', 'PUT'].includes(request.method)) {
    // busboy throws "Malformed part header" (a generic 500) for a NUL in a part header such as the file name.
    // Bounded: only the first 64 KiB of a clone is read (never the whole upload), after the size refusals above.
    if (!(await scanMultipartPrefix(request.clone().body)).clean) {
      return NextResponse.json(
        { ok: false, errors: [{ message: 'Invalid characters in the upload headers.' }] },
        { status: 400, headers: { 'Cache-Control': 'no-store', ...corsHeaders(request.headers.get('origin')) } },
      )
    }
  }
  if (decision.ok) {
    // Payload echoes the request Origin in Access-Control-Allow-Origin, so a shared cache (CDN, reverse
    // proxy) must key API responses on Origin or it could replay one origin's grant to another.
    const res = NextResponse.next()
    res.headers.append('Vary', 'Origin')
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
