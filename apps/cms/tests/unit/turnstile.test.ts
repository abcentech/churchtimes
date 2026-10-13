import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isTurnstileDummySecret,
  resolveTurnstileSecret,
  setTurnstileFetchForTests,
  TURNSTILE_FAILURE_MESSAGE,
  TURNSTILE_TEST_SECRET,
  TURNSTILE_VERIFY_URL,
  verifyTurnstile,
} from '../../src/lib/turnstile'

const quiet = { warn: vi.fn(), error: vi.fn() }
const env = (extra: Record<string, string> = {}) => ({ NODE_ENV: 'test', ...extra }) as NodeJS.ProcessEnv
const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status })

afterEach(() => {
  quiet.warn.mockClear()
  quiet.error.mockClear()
  setTurnstileFetchForTests(undefined)
})

describe('verifyTurnstile', () => {
  it('returns 400 on a missing, empty or non-string token without calling Cloudflare', async () => {
    const fetchImpl = vi.fn()
    for (const token of [undefined, null, '', '   ', 123, {}]) {
      const r = await verifyTurnstile({ token, fetchImpl, env: env(), logger: quiet })
      expect(r).toMatchObject({ ok: false, status: 400, field: 'turnstileToken' })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects over-long tokens (> 2048) without calling Cloudflare', async () => {
    const fetchImpl = vi.fn()
    const r = await verifyTurnstile({ token: 'x'.repeat(2049), fetchImpl, env: env(), logger: quiet })
    expect(r).toMatchObject({ ok: false, status: 403 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('posts secret, response, remoteip and idempotency_key form-encoded to Siteverify', async () => {
    const fetchImpl = vi.fn(reply({ success: true, hostname: 'example.org' }))
    const r = await verifyTurnstile({
      token: 'tok',
      remoteip: '203.0.113.5',
      idempotencyKey: 'key-1',
      secret: 'sekrit',
      fetchImpl,
      env: env(),
      logger: quiet,
    })
    expect(r).toMatchObject({ ok: true, hostname: 'example.org' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(TURNSTILE_VERIFY_URL)
    expect(init.method).toBe('POST')
    const body = new URLSearchParams(String(init.body))
    expect(Object.fromEntries(body)).toEqual({
      secret: 'sekrit',
      response: 'tok',
      remoteip: '203.0.113.5',
      idempotency_key: 'key-1',
    })
  })

  it('omits remoteip when the client IP is unknown', async () => {
    const fetchImpl = vi.fn(reply({ success: true }))
    await verifyTurnstile({ token: 't', remoteip: 'unknown', secret: 's', fetchImpl, env: env(), logger: quiet })
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(new URLSearchParams(String(init.body)).has('remoteip')).toBe(false)
  })

  it('fails closed on success:false and logs the error codes server-side only', async () => {
    const fetchImpl = reply({ success: false, 'error-codes': ['invalid-input-response'] })
    const r = await verifyTurnstile({ token: 't', secret: 's', fetchImpl, env: env(), logger: quiet })
    expect(r).toMatchObject({ ok: false, status: 403, message: TURNSTILE_FAILURE_MESSAGE })
    expect(JSON.stringify(r)).not.toContain('invalid-input-response')
    expect(quiet.warn).toHaveBeenCalledWith({ errorCodes: ['invalid-input-response'] }, expect.any(String))
  })

  it('fails closed on non-200, malformed JSON, non-object JSON and success values other than true', async () => {
    const cases = [
      reply({ success: true }, 500),
      reply({ success: true }, 429),
      async () => new Response('<html>', { status: 200 }),
      reply([true]),
      reply('yes'),
      reply({ success: 'true' }),
      reply({ success: 1 }),
      reply({}),
    ]
    for (const fetchImpl of cases) {
      const r = await verifyTurnstile({ token: 't', secret: 's', fetchImpl, env: env(), logger: quiet })
      expect(r.ok).toBe(false)
    }
  })

  it('fails closed on a network error', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed')
    }
    const r = await verifyTurnstile({ token: 't', secret: 's', fetchImpl, env: env(), logger: quiet })
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'network-error' })
  })

  it('fails closed on timeout (AbortController)', async () => {
    const fetchImpl = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    const started = Date.now()
    const r = await verifyTurnstile({ token: 't', secret: 's', fetchImpl, timeoutMs: 40, env: env(), logger: quiet })
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('enforces TURNSTILE_ALLOWED_HOSTNAMES when set (case-insensitive)', async () => {
    const e = env({ TURNSTILE_ALLOWED_HOSTNAMES: 'www.example.org, Example.org' })
    const ok = await verifyTurnstile({
      token: 't', secret: 's', fetchImpl: reply({ success: true, hostname: 'EXAMPLE.org' }), env: e, logger: quiet,
    })
    expect(ok.ok).toBe(true)
    const bad = await verifyTurnstile({
      token: 't', secret: 's', fetchImpl: reply({ success: true, hostname: 'evil.test' }), env: e, logger: quiet,
    })
    expect(bad).toMatchObject({ ok: false, reason: 'hostname-mismatch' })
    const missing = await verifyTurnstile({
      token: 't', secret: 's', fetchImpl: reply({ success: true }), env: e, logger: quiet,
    })
    expect(missing.ok).toBe(false)
  })

  it('enforces TURNSTILE_EXPECTED_ACTION when set', async () => {
    const e = env({ TURNSTILE_EXPECTED_ACTION: 'submit-story' })
    const ok = await verifyTurnstile({
      token: 't', secret: 's', fetchImpl: reply({ success: true, action: 'submit-story' }), env: e, logger: quiet,
    })
    expect(ok.ok).toBe(true)
    const bad = await verifyTurnstile({
      token: 't', secret: 's', fetchImpl: reply({ success: true, action: 'login' }), env: e, logger: quiet,
    })
    expect(bad).toMatchObject({ ok: false, reason: 'action-mismatch' })
  })

  it('accepts any action in a comma-separated TURNSTILE_EXPECTED_ACTION list and still fails closed', async () => {
    const e = env({ TURNSTILE_EXPECTED_ACTION: ' submit-story , public_story ' })
    const run = (body: Record<string, unknown>) =>
      verifyTurnstile({ token: 't', secret: 's', fetchImpl: reply(body), env: e, logger: quiet })
    expect((await run({ success: true, action: 'submit-story' })).ok).toBe(true)
    expect((await run({ success: true, action: 'public_story' })).ok).toBe(true)
    expect(await run({ success: true, action: 'public_contact' })).toMatchObject({ ok: false, reason: 'action-mismatch' })
    expect(await run({ success: true, action: 'PUBLIC_STORY' })).toMatchObject({ ok: false, reason: 'action-mismatch' })
    expect(await run({ success: true })).toMatchObject({ ok: false, reason: 'action-mismatch' })
    expect(await run({ success: true, action: '' })).toMatchObject({ ok: false, reason: 'action-mismatch' })
  })

  it('fails closed in production when TURNSTILE_SECRET_KEY is missing (never falls back to the test secret)', async () => {
    const fetchImpl = vi.fn()
    const r = await verifyTurnstile({ token: 't', fetchImpl, env: { NODE_ENV: 'production' } as never, logger: quiet })
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'secret-not-configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("uses Cloudflare's always-pass test secret outside production when unset", () => {
    expect(resolveTurnstileSecret(env(), quiet)).toBe(TURNSTILE_TEST_SECRET)
    expect(resolveTurnstileSecret(env({ TURNSTILE_SECRET_KEY: ' real ' }), quiet)).toBe('real')
    expect(resolveTurnstileSecret({ NODE_ENV: 'production' } as never, quiet)).toBeUndefined()
  })

  it('recognises dummy secrets', () => {
    expect(isTurnstileDummySecret('1x0000000000000000000000000000000AA')).toBe(true)
    expect(isTurnstileDummySecret('2x0000000000000000000000000000000AA')).toBe(true)
    expect(isTurnstileDummySecret('3x0000000000000000000000000000000AA')).toBe(true)
    expect(isTurnstileDummySecret('0x4AAAAAAAreal-secret')).toBe(false)
  })
})

describe('setTurnstileFetchForTests', () => {
  it('only replaces the transport and is unavailable outside NODE_ENV=test', async () => {
    setTurnstileFetchForTests(reply({ success: false }))
    const r = await verifyTurnstile({ token: 't', secret: 's', env: env(), logger: quiet })
    expect(r.ok).toBe(false)

    vi.stubEnv('NODE_ENV', 'production')
    try {
      expect(() => setTurnstileFetchForTests(reply({ success: true }))).toThrow(/NODE_ENV=test/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
