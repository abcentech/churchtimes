import { withPayload } from '@payloadcms/next/withPayload'

const DEFAULT_HSTS_MAX_AGE = 15552000

/**
 * Value of Strict-Transport-Security max-age. CMS_HSTS_MAX_AGE (seconds, 0..31536000) overrides the 180-day default; the on-demand
 * staging on the owner's PC sets 300 because browsers pin HSTS to the host name (all ports) for as long as it says.
 * NOTE: headers are compiled into the build, so the variable must be set when `next build` runs.
 */
export function hstsMaxAge(env = process.env) {
  const raw = env.CMS_HSTS_MAX_AGE?.trim()
  if (!raw) return DEFAULT_HSTS_MAX_AGE
  if (!/^[0-9]{1,8}$/.test(raw) || Number(raw) > 31536000) throw new Error('CMS_HSTS_MAX_AGE must be an integer between 0 and 31536000 (seconds).')
  return Number(raw)
}

// Security headers for every response (admin UI and API). No strict script CSP: the Payload admin
// relies on inline scripts/styles. `frame-ancestors 'none'` is the only CSP directive set, so the
// admin cannot be framed (clickjacking) and nothing else is restricted.
export function buildSecurityHeaders(env = process.env) {
  const isProd = env.NODE_ENV === 'production'
  return [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    },
    // HSTS only in production. No includeSubDomains/preload: those are irreversible, site-wide decisions.
    ...(isProd ? [{ key: 'Strict-Transport-Security', value: `max-age=${hstsMaxAge(env)}` }] : []),
    // Staging only (CMS_NOINDEX=true at build time): keep search engines away from every response, API included.
    ...(env.CMS_NOINDEX === 'true' ? [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] : []),
  ]
}

const securityHeaders = buildSecurityHeaders()

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Payload recommends keeping these external for the server bundle.
  serverExternalPackages: ['embedded-postgres'],
  poweredByHeader: false,
  // src/proxy.ts exists, so Next buffers every request body in memory and silently truncates it at this
  // size (default 10 MB). Keep it above the largest accepted body (11 MB for /api/media, see
  // lib/requestLimits.ts) so uploads are never cut off; the proxy itself rejects bigger requests first.
  experimental: { proxyClientMaxBodySize: '12mb' },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Auth responses carry tokens/cookies: never cache.
      { source: '/api/users/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
    ]
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
