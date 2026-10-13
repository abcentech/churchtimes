import { APIError } from 'payload'
import type { CollectionBeforeOperationHook } from 'payload'

import { createRateLimiter, getClientIp } from './rateLimit'

/**
 * Per-IP rate limits for the unauthenticated auth operations (login, forgot-password,
 * reset-password).
 *
 * Why here: Payload 3.90 locks an *account* after `maxLoginAttempts` failures and throttles
 * forgot-password per *user* (`minRequestInterval`), but has no per-IP limit, so one client could
 * spray many accounts or flood the mailer. `collection.hooks.beforeOperation` runs before the
 * operation touches the database for REST requests, so throwing a 429 there is safe.
 *
 * Applies to REST requests only (`req.payloadAPI === 'REST'`); server-side local API calls
 * (seed, tests) are trusted.
 *
 * Without TRUST_PROXY=true the client IP is unknown ('unknown' bucket). A tiny shared bucket would
 * let anyone lock every staff member out, so the unknown bucket gets a much larger limit.
 *
 * LIMITATION: in-memory, per process (see lib/rateLimit.ts).
 */

export type AuthOperation = 'login' | 'forgotPassword' | 'resetPassword'

const DEFAULTS: Record<AuthOperation, { limit: number; envLimit: string }> = {
  login: { limit: 10, envLimit: 'AUTH_LOGIN_RATE_LIMIT' },
  forgotPassword: { limit: 5, envLimit: 'AUTH_FORGOT_RATE_LIMIT' },
  resetPassword: { limit: 10, envLimit: 'AUTH_RESET_RATE_LIMIT' },
}
const UNKNOWN_IP_MULTIPLIER = 20

type Limiter = ReturnType<typeof createRateLimiter>
const limiters = new Map<string, Limiter>()

const positiveInt = (value: string | undefined, fallback: number): number => {
  const n = Number.parseInt(value ?? '', 10)
  return n > 0 ? n : fallback
}

const getLimiter = (op: AuthOperation, unknownIp: boolean): Limiter => {
  const key = `${op}:${unknownIp ? 'unknown' : 'ip'}`
  let limiter = limiters.get(key)
  if (!limiter) {
    const base = positiveInt(process.env[DEFAULTS[op].envLimit], DEFAULTS[op].limit)
    limiter = createRateLimiter({
      limit: unknownIp ? base * UNKNOWN_IP_MULTIPLIER : base,
      windowMs: positiveInt(process.env.AUTH_RATE_WINDOW_SECONDS, 900) * 1000,
    })
    limiters.set(key, limiter)
  }
  return limiter
}

/** Test helper: forget all counters and re-read limits from the environment. */
export function resetAuthRateLimiters(): void {
  limiters.clear()
}

export function authRateLimitHook(op: AuthOperation): CollectionBeforeOperationHook {
  return ({ args, operation, req }) => {
    if (operation !== op || req?.payloadAPI !== 'REST') return args
    const ip = getClientIp(req)
    const result = getLimiter(op, ip === 'unknown').check(ip)
    if (!result.allowed) {
      throw new APIError(
        `Too many attempts. Try again in ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`,
        429,
      )
    }
    return args
  }
}
