import { createHash } from 'node:crypto'

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
          // Still full of live keys: evict the oldest inserted key (Map preserves insertion order).
          if (hits.size >= maxKeys) {
            const oldest = hits.keys().next().value
            if (oldest !== undefined) hits.delete(oldest)
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

/**
 * Client IP. Forwarding headers are spoofable, so they are only honoured when TRUST_PROXY === 'true'
 * (set it only when the CMS sits behind a proxy that overwrites x-forwarded-for).
 * Without trusted proxy there is no reliable IP available from a fetch Request, so all clients share
 * the 'unknown' bucket (fail closed for rate limiting).
 */
export function getClientIp(req: HeaderReader): string {
  if (process.env.TRUST_PROXY === 'true') {
    const xff = req.headers.get('x-forwarded-for')
    const first = xff?.split(',')[0]?.trim()
    if (first) return first.slice(0, 64)
    const real = req.headers.get('x-real-ip')?.trim()
    if (real) return real.slice(0, 64)
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
