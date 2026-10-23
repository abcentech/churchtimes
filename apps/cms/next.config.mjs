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

/**
 * Body buffer (MB) for Next: 12 by default (11 MB media limit + 1 MB). It is raised ONLY when a larger staff upload is configured:
 * MEDIA_UPLOAD_MAX_MB (11 to 500), else MEDIA_AV_MAX_MB when set explicitly; + 2 MB. Keep in step with mediaBodyLimitBytes
 * in src/lib/requestLimits.ts. The value applies to every /api route's buffering, which is why it must stay small by default.
 */
function mediaBufferMb() {
  const override = Number(process.env.MEDIA_UPLOAD_MAX_MB)
  if (Number.isInteger(override) && override >= 11) return Math.min(override, 500) + 2
  const raw = process.env.MEDIA_AV_MAX_MB
  const av = Number(raw)
  if (raw !== undefined && raw.trim() !== '' && Number.isFinite(av) && av >= 1) return Math.max(12, Math.max(10, Math.min(Math.floor(av), 500)) + 2)
  return 12
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Payload recommends keeping these external for the server bundle.
  serverExternalPackages: ['embedded-postgres'],
  poweredByHeader: false,
  // src/proxy.ts exists, so Next buffers every request body in memory and silently truncates it at this
  // size (default 10 MB). Keep it above the largest accepted body so uploads are never cut off; the proxy itself rejects
  // bigger requests first by Content-Length. Same rule as lib/requestLimits.ts (mediaBodyLimitBytes, authenticated):
  // MEDIA_UPLOAD_MAX_MB (11 to 500) if set, else MEDIA_AV_MAX_MB when set explicitly; + 2 MB framing; 12 MB when neither is set.
  // Anonymous /api/media requests are still limited to 11 MB by the proxy, other routes to 1 MB.
  experimental: {
    proxyClientMaxBodySize: `${mediaBufferMb()}mb`,
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
