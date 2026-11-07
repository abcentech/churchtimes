import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

/**
 * In-memory fixed-window rate limiter.
 *
 * LIMITATION: state lives in this process only. With more than one CMS instance (or serverless
 * cold starts) each instance counts separately, so the effective limit is `limit * instances`.
 * For multi-instance deployments back this with Redis or a database table.
 */

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number }

export type RateLimiterOptions = {
  limit: number
  windowMs: number
  now?: () => number
  /** Hard cap on tracked keys to bound memory. Default 10 000. */
  maxKeys?: number
  /** How often (ms) stale keys are swept during check(). Default = windowMs. */
  cleanupIntervalMs?: number
}

export function createRateLimiter(options: RateLimiterOptions) {
  const { limit, windowMs } = options
  const now = options.now ?? Date.now
  const maxKeys = options.maxKeys ?? 10_000
  const cleanupIntervalMs = options.cleanupIntervalMs ?? windowMs
  const hits = new Map<string, { count: number; resetAt: number }>()
  let lastCleanup = now()

  const cleanup = (t: number) => {
    lastCleanup = t
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key)
  }

  return {
    check(key: string): RateLimitResult {
      const t = now()
      if (t - lastCleanup >= cleanupIntervalMs) cleanup(t)

      let entry = hits.get(key)
      if (entry && entry.resetAt <= t) {
        hits.delete(key)
        entry = undefined
      }
      if (!entry) {
        if (hits.size >= maxKeys) {
          cleanup(t)
          if (hits.size >= maxKeys) {
            // Still full of live keys. Never evict a key that is already rate-limited (a key flood must not
            // reset a blocked bucket): evict the oldest bucket that still has headroom instead. If every
            // bucket is blocked, fail closed for the new key until the soonest one expires.
            let victim: string | undefined
            let soonest = Infinity
            for (const [k, e] of hits) {
              if (e.count < limit) {
                victim = k
                break
              }
              soonest = Math.min(soonest, e.resetAt)
            }
            if (victim === undefined) {
              return {
                allowed: false,
                remaining: 0,
                retryAfterSeconds: Math.max(1, Math.ceil((soonest - t) / 1000)),
              }
            }
            hits.delete(victim)
          }
        }
        entry = { count: 0, resetAt: t + windowMs }
        hits.set(key, entry)
      }

      if (entry.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)),
        }
      }
      entry.count += 1
      return { allowed: true, remaining: limit - entry.count, retryAfterSeconds: 0 }
    },
    reset() {
      hits.clear()
    },
    size: () => hits.size,
  }
}

type HeaderReader = { headers: { get(name: string): string | null } }

const MAX_TRUSTED_HOPS = 10

/** Number of trusted reverse proxies in front of the app (TRUST_PROXY_HOPS, 1..10, default 1). */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUST_PROXY_HOPS?.trim()
  if (!raw || !/^[0-9]{1,3}$/.test(raw)) return 1
  const n = Number(raw)
  return n >= 1 && n <= MAX_TRUSTED_HOPS ? n : 1
}

/** Expand an IPv6 address into its eight 16-bit groups, or null when malformed. */
function ipv6Groups(addr: string): number[] | null {
  let a = addr.split('%')[0]
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (v4) {
    const o = v4[1].split('.').map(Number)
    if (o.some((n) => n > 255)) return null
    a = a.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16)
  }
  const halves = a.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail].map((g) => parseInt(g, 16))
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

/**
 * Rate-limit bucket for an IP: IPv4 exact, IPv4-mapped IPv6 as the embedded IPv4, any other IPv6 by its /64
 * prefix (one subscriber is normally handed a whole /64, so keying on the full address would let one client
 * mint billions of buckets).
 */
export function ipBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip
  const g = ipv6Groups(ip)
  if (!g) return ip
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
}

/** Normalise a header value to a bare IP bucket, or null when it is not an IP. */
const toIp = (value: string | null | undefined): string | null => {
  const v = value?.trim().replace(/^\[|\]$/g, '')
  if (!v || v.length > 64 || isIP(v) === 0) return null
  return ipBucket(v.toLowerCase())
}

/**
 * Client IP, derived only from headers that a trusted reverse proxy controls.
 *
 * Forwarding headers are client-controlled unless a proxy overwrites or appends to them, so nothing is
 * read unless TRUST_PROXY === 'true' (otherwise every client shares the 'unknown' bucket, which fails
 * closed for rate limiting).
 *
 * 1. CLIENT_IP_HEADER (optional, e.g. `cf-connecting-ip` behind Cloudflare, or `x-real-ip` when nginx
 *    sets it with `proxy_set_header X-Real-IP $remote_addr`) wins when present and valid. The proxy
 *    must overwrite that header on every request.
 * 2. Otherwise X-Forwarded-For is read from the RIGHT: each trusted proxy appends the address it
 *    received the connection from, so with TRUST_PROXY_HOPS=N the client is the Nth entry from the
 *    right. Entries to its left were supplied by the client (or earlier, untrusted hops) and are
 *    ignored; a client cannot change which bucket it lands in by prepending addresses. A chain shorter
 *    than the configured hop count means the proxy setup differs from the configuration, so it fails
 *    closed ('unknown').
 */
export function getClientIp(req: HeaderReader): string {
  if (process.env.TRUST_PROXY !== 'true') return 'unknown'

  const headerName = process.env.CLIENT_IP_HEADER?.trim().toLowerCase()
  if (headerName) {
    const ip = toIp(req.headers.get(headerName))
    if (ip) return ip
  }

  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const hops = trustedProxyHops()
    const parts = xff.split(',')
    if (parts.length >= hops) {
      const ip = toIp(parts[parts.length - hops])
      if (ip) return ip
    }
  }
  return 'unknown'
}

/** sha256(IP_HASH_SALT + ip) as hex. Salt must be >= 16 chars outside NODE_ENV=test. */
export function hashIp(ip: string): string {
  const salt = process.env.IP_HASH_SALT ?? ''
  if (process.env.NODE_ENV !== 'test' && salt.length < 16) {
    throw new Error('IP_HASH_SALT must be set and at least 16 characters long.')
  }
  return createHash('sha256').update(salt + ip).digest('hex')
}
