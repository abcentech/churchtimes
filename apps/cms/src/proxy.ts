import { NextResponse, type NextRequest } from 'next/server'

import { checkRelationFilters, checkRequestShape } from './lib/queryGuards'
import { checkRequestLimits } from './lib/requestLimits'
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
 * `experimental.proxyClientMaxBodySize`, set to 12 MB in next.config.mjs so uploads are never truncated).
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

export function proxy(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl
  const limits = checkRequestLimits({ method: request.method, pathname, headers: request.headers })
  const shape = checkRequestShape(pathname, request.nextUrl.search)
  const decision = !shape.ok
    ? { ...shape, errors: [{ message: shape.message }] }
    : limits.ok
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
