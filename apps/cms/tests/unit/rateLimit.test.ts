import { afterEach, describe, expect, it, vi } from 'vitest'

import { setRetryAfterHeaders } from '../../src/lib/authRateLimit'
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
    process.env.CLIENT_IP_HEADER = 'x-real-ip'
    expect(getClientIp(reqWith({ 'x-real-ip': '9.9.9.9' }))).toBe('unknown')
    process.env.TRUST_PROXY = 'true'
    expect(getClientIp(reqWith({ 'x-forwarded-for': '1.2.3.4' }))).toBe('1.2.3.4')
    expect(getClientIp(reqWith({}))).toBe('unknown')
  })

  it('takes the entry appended by the trusted proxy (hops from the right), not the spoofable leftmost', () => {
    process.env.TRUST_PROXY = 'true'
    delete process.env.TRUST_PROXY_HOPS
    delete process.env.CLIENT_IP_HEADER
    // An attacker sends "X-Forwarded-For: 6.6.6.6"; the proxy appends the real peer address.
    expect(getClientIp(reqWith({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9')
    expect(getClientIp(reqWith({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9')
    expect(getClientIp(reqWith({ 'x-forwarded-for': ' 6.6.6.6 ,  203.0.113.9 ' }))).toBe('203.0.113.9')
    expect(getClientIp(reqWith({ 'x-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1')

    process.env.TRUST_PROXY_HOPS = '2'
    // spoofed prefix, real client, then the address the first proxy saw (appended by the second proxy)
    expect(getClientIp(reqWith({ 'x-forwarded-for': '6.6.6.6, 198.51.100.4, 172.16.0.8' }))).toBe('198.51.100.4')
    // Fewer entries than hops: the chain is not what is configured, fail closed.
    expect(getClientIp(reqWith({ 'x-forwarded-for': '203.0.113.9' }))).toBe('unknown')
  })

  it('falls back to one hop for an invalid TRUST_PROXY_HOPS', () => {
    process.env.TRUST_PROXY = 'true'
    for (const bad of ['', 'abc', '0', '-1', '1.5', '99']) {
      process.env.TRUST_PROXY_HOPS = bad
      expect(getClientIp(reqWith({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })), bad).toBe('203.0.113.9')
    }
  })

  it('prefers CLIENT_IP_HEADER when configured (Cloudflare / nginx X-Real-IP)', () => {
    process.env.TRUST_PROXY = 'true'
    process.env.CLIENT_IP_HEADER = 'CF-Connecting-IP'
    expect(
      getClientIp(reqWith({ 'cf-connecting-ip': '198.51.100.77', 'x-forwarded-for': '6.6.6.6, 172.16.0.8' })),
    ).toBe('198.51.100.77')
    // Header missing (request did not come through the CDN): fall back to the forwarded chain.
    expect(getClientIp(reqWith({ 'x-forwarded-for': '6.6.6.6, 172.16.0.8' }))).toBe('172.16.0.8')

    process.env.CLIENT_IP_HEADER = 'x-real-ip'
    expect(getClientIp(reqWith({ 'x-real-ip': '192.0.2.50' }))).toBe('192.0.2.50')
  })

  it('rejects values that are not IP addresses', () => {
    process.env.TRUST_PROXY = 'true'
    delete process.env.CLIENT_IP_HEADER
    expect(getClientIp(reqWith({ 'x-forwarded-for': 'not-an-ip' }))).toBe('unknown')
    expect(getClientIp(reqWith({ 'x-forwarded-for': '1.2.3.4, <script>' }))).toBe('unknown')
    process.env.CLIENT_IP_HEADER = 'x-real-ip'
    expect(getClientIp(reqWith({ 'x-real-ip': 'garbage', 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9')
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

describe('setRetryAfterHeaders', () => {
  it('sets Retry-After and exposes it cross-origin, keeping headers already on the request', () => {
    const req: { responseHeaders?: Headers } = {}
    setRetryAfterHeaders(req, 12.2)
    expect(req.responseHeaders?.get('retry-after')).toBe('13')
    expect(req.responseHeaders?.get('access-control-expose-headers')).toBe('Retry-After')

    const existing = new Headers({ 'Set-Cookie': 'a=b', 'Access-Control-Expose-Headers': 'X-Foo' })
    const req2 = { responseHeaders: existing }
    setRetryAfterHeaders(req2, 0)
    expect(req2.responseHeaders.get('set-cookie')).toBe('a=b')
    expect(req2.responseHeaders.get('retry-after')).toBe('1')
    expect(req2.responseHeaders.get('access-control-expose-headers')).toBe('X-Foo, Retry-After')
    setRetryAfterHeaders(req2, 5)
    expect(req2.responseHeaders.get('access-control-expose-headers')).toBe('X-Foo, Retry-After')
  })
})
