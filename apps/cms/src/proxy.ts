import { NextResponse, type NextRequest } from 'next/server'

import { checkRequestLimits } from './lib/requestLimits'

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts` (Node.js runtime). Rejects oversized or
 * length-less request bodies on /api/* before a route handler reads them. Decision logic and the
 * limits live in lib/requestLimits.ts. See docs/operations.md for the matching reverse-proxy limits.
 *
 * Note: while a proxy file exists Next buffers each request body (up to
 * `experimental.proxyClientMaxBodySize`, set to 12 MB in next.config.mjs so uploads are never truncated).
 */
export function proxy(request: NextRequest) {
  const decision = checkRequestLimits({
    method: request.method,
    pathname: request.nextUrl.pathname,
    headers: request.headers,
  })
  if (decision.ok) return NextResponse.next()
  return NextResponse.json(
    { ok: false, errors: [{ message: decision.message }] },
    { status: decision.status, headers: { 'Cache-Control': 'no-store' } },
  )
}

export const config = {
  matcher: '/api/:path*',
}
