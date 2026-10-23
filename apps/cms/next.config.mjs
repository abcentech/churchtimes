import { withPayload } from '@payloadcms/next/withPayload'

const isProd = process.env.NODE_ENV === 'production'

// Security headers for every response (admin UI and API). No strict script CSP: the Payload admin
// relies on inline scripts/styles. `frame-ancestors 'none'` is the only CSP directive set, so the
// admin cannot be framed (clickjacking) and nothing else is restricted.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  // HSTS only in production. No includeSubDomains/preload: those are irreversible, site-wide decisions.
  ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=15552000' }] : []),
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Payload recommends keeping these external for the server bundle.
  serverExternalPackages: ['embedded-postgres'],
  poweredByHeader: false,
  // src/proxy.ts exists, so Next buffers every request body in memory and silently truncates it at this
  // size (default 10 MB). Keep it above the largest accepted body (11 MB for /api/media, see
  // lib/requestLimits.ts) so uploads are never cut off; the proxy itself rejects bigger requests first.
  // Opt-in: MEDIA_UPLOAD_MAX_MB (11 to 500) raises it to that size + 2 MB; the proxy still refuses other routes above 1 MB.
  experimental: {
    proxyClientMaxBodySize: `${Math.max(12, Number.isInteger(Number(process.env.MEDIA_UPLOAD_MAX_MB)) ? Math.min(Number(process.env.MEDIA_UPLOAD_MAX_MB), 500) + 2 : 0)}mb`,
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Auth responses carry tokens/cookies: never cache.
      { source: '/api/users/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
    ]
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
