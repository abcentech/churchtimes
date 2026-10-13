import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRateLimiter, getClientIp, hashIp } from '../../src/lib/rateLimit'

describe('createRateLimiter', () => {
  it('allows up to limit then blocks with retryAfter', () => {
    let t = 1_000
    const rl = createRateLimiter({ limit: 2, windowMs: 10_000, now: () => t })
    expect(rl.check('a')).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 0 })
    expect(rl.check('a').remaining).toBe(0)
    t += 2_500
    const blocked = rl.check('a')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBe(8)
    expect(rl.check('b').allowed).toBe(true)
  })

  it('resets after the window', () => {
    let t = 0
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t })
    expect(rl.check('a').allowed).toBe(true)
    expect(rl.check('a').allowed).toBe(false)
    t = 1000
    expect(rl.check('a').allowed).toBe(true)
  })

  it('cleans stale keys and caps the number of keys', () => {
    let t = 0
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t, maxKeys: 3 })
    for (const k of ['a', 'b', 'c', 'd', 'e']) rl.check(k)
    expect(rl.size()).toBe(3)
    t = 5000
    rl.check('z')
    expect(rl.size()).toBe(1)
  })
})

const reqWith = (headers: Record<string, string>) => ({
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
})

describe('getClientIp / hashIp', () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = { ...env }
    vi.unstubAllEnvs()
  })

  it('ignores forwarding headers unless TRUST_PROXY=true', () => {
    delete process.env.TRUST_PROXY
    expect(getClientIp(reqWith({ 'x-forwarded-for': '1.2.3.4' }))).toBe('unknown')
    process.env.TRUST_PROXY = 'true'
    expect(getClientIp(reqWith({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4')
    expect(getClientIp(reqWith({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9')
    expect(getClientIp(reqWith({}))).toBe('unknown')
  })

  it('hashes with salt', () => {
    process.env.IP_HASH_SALT = 'a-long-enough-salt-value'
    const h = hashIp('1.2.3.4')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    process.env.IP_HASH_SALT = 'another-long-salt-value!'
    expect(hashIp('1.2.3.4')).not.toBe(h)
  })

  it('requires a salt of 16+ chars outside test env', () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.IP_HASH_SALT = 'short'
    expect(() => hashIp('1.2.3.4')).toThrow()
  })
})
