import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PayloadRequest } from 'payload'

import { startFakePaystack } from '../../scripts/fake-paystack.mjs'
import {
  givingInitEndpoint,
  givingSettingsEndpoint,
  givingStatsEndpoint,
  givingStatusEndpoint,
  givingWebhookEndpoint,
  resetGivingState,
} from '../../src/endpoints/publicGiving'
import { PaystackProvider } from '../../src/lib/giving/paystack'
import { generateDonationReference } from '../../src/lib/giving/reference'
import { loadGivingRuntime, resetGivingSettingsCache, setGivingRuntimeForTests, setGivingStoreForTests, type GivingRuntime } from '../../src/lib/giving/runtime'
import { PENDING_STATUS_TTL_MS } from '../../src/lib/giving/service'
import { normaliseGivingSettings } from '../../src/lib/giving/settings'
import { installTurnstileStub, removeTurnstileStub, TURNSTILE_BAD, TURNSTILE_OK } from '../integration/turnstileStub'
import { captureLogger, fakeKey, MemoryDonationStore, RAW_SETTINGS, TEST_SECRET } from './givingHelpers'

let fake: Awaited<ReturnType<typeof startFakePaystack>>
let store: MemoryDonationStore
let logger: ReturnType<typeof captureLogger>
let runtime: GivingRuntime
const sent: { to: string[]; text: string }[] = []

const payloadStub = () =>
  ({
    logger,
    sendEmail: async (m: { to: string; text: string }) => void sent.push({ to: [m.to], text: m.text }),
    findGlobal: vi.fn(async () => RAW_SETTINGS),
  }) as unknown as PayloadRequest['payload']

function makeReq(method: string, url: string, init: { headers?: Record<string, string>; body?: string | Buffer; routeParams?: Record<string, string>; user?: unknown; payload?: PayloadRequest['payload'] } = {}) {
  const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : new Uint8Array(init.body)
  const headers = new Headers(init.headers)
  if (body !== undefined && !headers.has('content-length')) headers.set('content-length', String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength))
  const r = new Request(`http://cms.test${url}`, { method, headers, body })
  return Object.assign(r, {
    payload: init.payload ?? payloadStub(),
    routeParams: init.routeParams ?? {},
    searchParams: new URL(r.url).searchParams,
    user: init.user ?? null,
  }) as unknown as PayloadRequest
}

const call = (ep: { handler: (req: PayloadRequest) => Promise<Response> | Response }, req: PayloadRequest) => Promise.resolve(ep.handler(req))

const initBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ amountMinor: 500_000, currency: 'NGN', cause: 'general', email: 'reader@example.test', name: 'Ada', anonymous: false, consent: true, turnstileToken: TURNSTILE_OK, ...over })
const postInit = (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  call(givingInitEndpoint, makeReq('POST', '/api/public/giving/init', { headers: { 'content-type': 'application/json', ...headers }, body: initBody(over) }))

function webhookReq(body: unknown, opts: { signature?: string; key?: string; raw?: Buffer; provider?: string; contentType?: string } = {}) {
  const signed = fake.signedWebhook(body, opts.key ?? TEST_SECRET)
  const raw = opts.raw ?? signed.raw
  return makeReq('POST', '/api/public/giving/webhook/paystack', {
    headers: { 'content-type': opts.contentType ?? 'application/json', 'x-paystack-signature': opts.signature ?? signed.signature },
    body: raw,
    routeParams: { provider: opts.provider ?? 'paystack' },
  })
}

async function startOne(over: Record<string, unknown> = {}) {
  const res = await postInit(over)
  expect(res.status).toBe(201)
  return (await res.json()) as { reference: string; checkoutUrl: string }
}

const verifyCount = (reference: string) => fake.calls.filter((c: { op: string; reference?: string }) => c.op === 'verify' && c.reference === reference).length

beforeAll(async () => {
  fake = await startFakePaystack({ secret: TEST_SECRET })
  installTurnstileStub()
})
afterAll(async () => {
  removeTurnstileStub()
  setGivingRuntimeForTests(undefined)
  setGivingStoreForTests(undefined)
  await fake?.close()
})
beforeEach(() => {
  resetGivingState()
  store = new MemoryDonationStore()
  logger = captureLogger()
  sent.length = 0
  const provider = new PaystackProvider({ secret: TEST_SECRET, baseUrl: fake.origin, mode: 'test' }, { timeoutMs: 2000 })
  runtime = { provider, reason: null, settings: normaliseGivingSettings(RAW_SETTINGS, provider), returnUrl: 'http://localhost:5373/give/thanks/', accepting: true }
  setGivingRuntimeForTests(async () => runtime)
  setGivingStoreForTests(() => store)
  process.env.SMTP_HOST = 'smtp.test'
})
afterEach(() => {
  delete process.env.SMTP_HOST
  delete process.env.PAYSTACK_WEBHOOK_IPS
})

describe('feature off', () => {
  it('without PAYSTACK_SECRET_KEY nothing reads settings or touches the network', async () => {
    setGivingRuntimeForTests(undefined)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const payload = payloadStub()
    const saved = process.env.PAYSTACK_SECRET_KEY
    delete process.env.PAYSTACK_SECRET_KEY
    try {
      const rt = await loadGivingRuntime(payload)
      expect(rt).toMatchObject({ provider: null, accepting: false })
      const settings = await call(givingSettingsEndpoint, makeReq('GET', '/api/public/giving/settings', { payload }))
      expect(await settings.json()).toEqual({ enabled: false })
      const init = await call(givingInitEndpoint, makeReq('POST', '/api/public/giving/init', { payload, headers: { 'content-type': 'application/json' }, body: initBody() }))
      expect(init.status).toBe(404)
      const hook = await call(givingWebhookEndpoint, makeReq('POST', '/api/public/giving/webhook/paystack', { payload, headers: { 'content-type': 'application/json', 'x-paystack-signature': 'a'.repeat(128) }, body: '{}', routeParams: { provider: 'paystack' } }))
      expect(hook.status).toBe(404)
      const status = await call(givingStatusEndpoint, makeReq('GET', `/api/public/giving/status?reference=${generateDonationReference()}`, { payload }))
      expect(status.status).toBe(404)
      expect((payload.findGlobal as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      if (saved !== undefined) process.env.PAYSTACK_SECRET_KEY = saved
      fetchSpy.mockRestore()
    }
  })

  it('switch off with a key: no new donations, but confirmations of started ones continue', async () => {
    const { reference } = await startOne()
    runtime = { ...runtime, accepting: false, reason: 'giving-settings.enabled is off.' }
    expect((await postInit()).status).toBe(404)
    expect(await (await call(givingSettingsEndpoint, makeReq('GET', '/api/public/giving/settings'))).json()).toEqual({ enabled: false })
    fake.complete(reference, 'success')
    expect((await call(givingWebhookEndpoint, webhookReq(fake.webhookBodyFor(reference)))).status).toBe(200)
    expect((await store.findByReference(reference))?.status).toBe('succeeded')
  })

  it('loadGivingRuntime: a key plus enabled settings and PUBLIC_SITE_URL is accepting; the key never leaves the server', async () => {
    setGivingRuntimeForTests(undefined)
    resetGivingSettingsCache()
    const rt = await loadGivingRuntime(payloadStub(), { NODE_ENV: 'test', PAYSTACK_SECRET_KEY: TEST_SECRET, PUBLIC_SITE_URL: 'http://localhost:5373' })
    expect(rt).toMatchObject({ accepting: true, returnUrl: 'http://localhost:5373/give/thanks/' })
    resetGivingSettingsCache()
    const noSite = await loadGivingRuntime(payloadStub(), { NODE_ENV: 'production', PAYSTACK_SECRET_KEY: TEST_SECRET, PUBLIC_SITE_URL: 'http://insecure.example' })
    expect(noSite.accepting).toBe(false)
    resetGivingSettingsCache()
  })
})

describe('POST /api/public/giving/init', () => {
  it('201 with a hosted checkout URL and a server reference; the row is pending', async () => {
    const { reference, checkoutUrl } = await startOne()
    expect(reference).toMatch(/^CTG-[0-9a-f]{32}$/)
    expect(checkoutUrl.startsWith(fake.origin)).toBe(true)
    expect((await store.findByReference(reference))?.status).toBe('pending')
  })

  it('refuses client-set fields, missing consent, bad amounts and the honeypot without creating rows', async () => {
    for (const over of [{ status: 'succeeded' }, { reference: generateDonationReference() }, { consent: false }, { amountMinor: 5000.5 }, { amountMinor: 1 }, { currency: 'GBP' }, { website: 'x' }]) {
      expect((await postInit(over)).status).toBe(400)
    }
    expect(store.rows.size).toBe(0)
  })

  it('needs Turnstile, JSON and an allowed Origin', async () => {
    expect((await postInit({ turnstileToken: TURNSTILE_BAD })).status).toBe(403)
    expect((await postInit({ turnstileToken: undefined })).status).toBe(400)
    const text = await call(givingInitEndpoint, makeReq('POST', '/api/public/giving/init', { headers: { 'content-type': 'text/plain' }, body: initBody() }))
    expect(text.status).toBe(415)
    process.env.PUBLIC_SUBMISSION_ORIGINS = 'https://site.example'
    try {
      expect((await postInit({}, { origin: 'https://evil.example' })).status).toBe(403)
    } finally {
      delete process.env.PUBLIC_SUBMISSION_ORIGINS
    }
    expect(store.rows.size).toBe(0)
  })

  it('rate limits per IP and per address', async () => {
    let last = 0
    for (let i = 0; i < 6; i++) last = (await postInit({ email: 'same@example.test' })).status
    expect(last).toBe(429)
    resetGivingState()
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await postInit({ email: `r${i}@example.test` })).status)
    expect(statuses.at(-1)).toBe(429)
  })

  it('oversized body: 413', async () => {
    const res = await call(givingInitEndpoint, makeReq('POST', '/api/public/giving/init', { headers: { 'content-type': 'application/json' }, body: initBody({ name: 'x'.repeat(5000) }) }))
    expect(res.status).toBe(413)
  })
})

describe('POST /api/public/giving/webhook/paystack', () => {
  it('valid signature + provider-verified success: 200, succeeded, one receipt', async () => {
    const { reference } = await startOne()
    fake.complete(reference, 'success')
    const res = await call(givingWebhookEndpoint, webhookReq(fake.webhookBodyFor(reference)))
    expect(res.status).toBe(200)
    expect((await store.findByReference(reference))?.status).toBe('succeeded')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toEqual(['reader@example.test'])
  })

  it('tampered body or forged signature: 401 and nothing changes', async () => {
    const { reference } = await startOne()
    fake.complete(reference, 'success')
    const body = fake.webhookBodyFor(reference)
    const signed = fake.signedWebhook(body)
    const tampered = Buffer.from(signed.raw.toString().replace('"amount":500000', '"amount":500001'))
    expect((await call(givingWebhookEndpoint, webhookReq(body, { raw: tampered, signature: signed.signature }))).status).toBe(401)
    expect((await call(givingWebhookEndpoint, webhookReq(body, { key: fakeKey('attackerattackerattacker') }))).status).toBe(401)
    expect((await call(givingWebhookEndpoint, webhookReq(body, { signature: '' }))).status).toBe(401)
    expect((await store.findByReference(reference))?.status).toBe('pending')
    expect(verifyCount(reference)).toBe(0)
  })

  it('a correctly signed "success" the provider does not confirm is NOT trusted (503 so Paystack retries)', async () => {
    const { reference } = await startOne()
    // The body claims success, but the provider still has the checkout unpaid.
    const lie = { event: 'charge.success', data: { reference, status: 'success', amount: 500_000, currency: 'NGN' } }
    expect((await call(givingWebhookEndpoint, webhookReq(lie))).status).toBe(503)
    expect((await store.findByReference(reference))?.status).toBe('pending')
    expect(sent).toHaveLength(0)
  })

  it('wrong amount: the body and the provider disagree with the row -> not succeeded, acknowledged', async () => {
    const { reference } = await startOne()
    fake.complete(reference, 'success', { amount: 100, requested_amount: 100 })
    expect((await call(givingWebhookEndpoint, webhookReq(fake.webhookBodyFor(reference)))).status).toBe(200)
    expect((await store.findByReference(reference))?.status).toBe('pending')
    expect(sent).toHaveLength(0)
  })

  it('duplicate delivery and replay: one transition, one receipt, the replay does no provider call', async () => {
    const { reference } = await startOne()
    fake.complete(reference, 'success')
    const body = fake.webhookBodyFor(reference)
    expect((await call(givingWebhookEndpoint, webhookReq(body))).status).toBe(200)
    const calls = verifyCount(reference)
    for (let i = 0; i < 3; i++) expect((await call(givingWebhookEndpoint, webhookReq(body))).status).toBe(200)
    expect(verifyCount(reference)).toBe(calls)
    expect(sent).toHaveLength(1)
    // Even with the replay cache gone (restart), a replay changes nothing and sends nothing.
    resetGivingState()
    expect((await call(givingWebhookEndpoint, webhookReq(body))).status).toBe(200)
    expect(sent).toHaveLength(1)
    expect((await store.findByReference(reference))?.status).toBe('succeeded')
  })

  it('simultaneous duplicate deliveries: one receipt', async () => {
    const { reference } = await startOne()
    fake.complete(reference, 'success')
    const body = fake.webhookBodyFor(reference)
    const statuses = await Promise.all(Array.from({ length: 5 }, () => call(givingWebhookEndpoint, webhookReq(body)).then((r) => r.status)))
    expect(statuses.every((s) => s === 200)).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('provider unreachable during verify: 503 (Paystack retries), row unchanged, and the retry succeeds later', async () => {
    const { reference } = await startOne()
    fake.complete(reference, 'success')
    const body = fake.webhookBodyFor(reference)
    fake.state.failVerify = { status: 500, body: { status: false } }
    try {
      expect((await call(givingWebhookEndpoint, webhookReq(body))).status).toBe(503)
    } finally {
      fake.state.failVerify = null
    }
    expect((await store.findByReference(reference))?.status).toBe('pending')
    expect((await call(givingWebhookEndpoint, webhookReq(body))).status).toBe(200)
    expect((await store.findByReference(reference))?.status).toBe('succeeded')
  })

  it('other events, foreign references and unknown references are acknowledged and ignored without a provider call', async () => {
    const before = fake.calls.length
    expect((await call(givingWebhookEndpoint, webhookReq({ event: 'transfer.success', data: { reference: 'x' } }))).status).toBe(200)
    expect((await call(givingWebhookEndpoint, webhookReq({ event: 'charge.success', data: { reference: 'shop-order-17' } }))).status).toBe(200)
    expect((await call(givingWebhookEndpoint, webhookReq({ event: 'charge.success', data: { reference: generateDonationReference() } }))).status).toBe(200)
    expect(fake.calls.length).toBe(before)
  })

  it('transport rules: wrong provider 404, non-JSON 415, oversized 413, unparsable 400', async () => {
    expect((await call(givingWebhookEndpoint, webhookReq({ event: 'x' }, { provider: 'flutterwave' }))).status).toBe(404)
    expect((await call(givingWebhookEndpoint, webhookReq({ event: 'x' }, { contentType: 'text/plain' }))).status).toBe(415)
    const big = { event: 'charge.success', data: { pad: 'x'.repeat(70 * 1024) } }
    expect((await call(givingWebhookEndpoint, webhookReq(big))).status).toBe(413)
    const raw = Buffer.from('not json')
    expect((await call(givingWebhookEndpoint, webhookReq(null, { raw, signature: fake.signedWebhook('not json').signature }))).status).toBe(400)
  })

  it('PAYSTACK_WEBHOOK_IPS, when set, refuses other sources before reading the body', async () => {
    process.env.PAYSTACK_WEBHOOK_IPS = '52.31.139.75,52.49.173.169,52.214.14.220'
    expect((await call(givingWebhookEndpoint, webhookReq({ event: 'charge.success', data: {} }))).status).toBe(403)
  })

  it('repeated bad signatures from one source are throttled', async () => {
    let status = 0
    for (let i = 0; i < 31; i++) status = (await call(givingWebhookEndpoint, webhookReq({ event: 'x' }, { signature: 'f'.repeat(128) }))).status
    expect(status).toBe(429)
  })

  it('logs never contain the key, the e-mail or the payload', async () => {
    const { reference } = await startOne()
    fake.complete(reference, 'success')
    await call(givingWebhookEndpoint, webhookReq(fake.webhookBodyFor(reference)))
    await call(givingWebhookEndpoint, webhookReq(fake.webhookBodyFor(reference), { signature: 'f'.repeat(128) }))
    const text = logger.text()
    for (const s of [TEST_SECRET, 'reader@example.test', 'customer', 'authorization', '"Ada"']) expect(text).not.toContain(s)
  })
})

describe('GET /api/public/giving/status', () => {
  const status = (reference: string) => call(givingStatusEndpoint, makeReq('GET', `/api/public/giving/status?reference=${encodeURIComponent(reference)}`))

  it('reports pending, then succeeded once the provider confirms; no personal data in the answer', async () => {
    const { reference } = await startOne()
    let body = await (await status(reference)).json()
    expect(body).toEqual({ ok: true, reference, status: 'pending', amountMinor: 500_000, currency: 'NGN', expired: false })
    fake.complete(reference, 'success')
    resetGivingState() // skip the per-reference cooldown
    const res = await status(reference)
    expect(res.headers.get('cache-control')).toBe('no-store')
    body = await res.json()
    expect(body.status).toBe('succeeded')
    expect(JSON.stringify(body)).not.toMatch(/reader@example|Ada/)
    expect(sent).toHaveLength(1)
  })

  it('400 for malformed references, 404 for unknown ones', async () => {
    expect((await status('nope')).status).toBe(400)
    expect((await status("CTG-' OR 1=1")).status).toBe(400)
    expect((await status(generateDonationReference())).status).toBe(404)
  })

  it('cooldown: rapid polling does not hammer the provider', async () => {
    const { reference } = await startOne()
    for (let i = 0; i < 5; i++) await status(reference)
    expect(verifyCount(reference)).toBe(1)
  })

  it('expired reference: no provider call, reported as expired', async () => {
    const { reference } = await startOne()
    store.age(reference, PENDING_STATUS_TTL_MS + 1000)
    const before = verifyCount(reference)
    const body = await (await status(reference)).json()
    expect(body).toMatchObject({ status: 'pending', expired: true })
    expect(verifyCount(reference)).toBe(before)
  })

  it('provider down: still answers with the stored state', async () => {
    const { reference } = await startOne()
    fake.state.failVerify = { status: 500, body: {} }
    try {
      expect(await (await status(reference)).json()).toMatchObject({ ok: true, status: 'pending' })
    } finally {
      fake.state.failVerify = null
    }
  })
})

describe('GET /api/public/giving/settings and /api/giving/stats', () => {
  it('settings: public-safe projection only', async () => {
    const body = await (await call(givingSettingsEndpoint, makeReq('GET', '/api/public/giving/settings'))).json()
    expect(body).toMatchObject({ enabled: true, provider: 'paystack', testMode: true })
    expect(body.currencies.map((c: { currency: string }) => c.currency)).toEqual(['NGN', 'USD'])
    expect(JSON.stringify(body)).not.toMatch(/sk_test|secret|returnUrl/i)
  })

  it('stats: anonymous 401, reporters 403', async () => {
    expect((await call(givingStatsEndpoint, makeReq('GET', '/api/giving/stats'))).status).toBe(401)
    expect((await call(givingStatsEndpoint, makeReq('GET', '/api/giving/stats', { user: { id: 1, role: 'reporter' } }))).status).toBe(403)
    expect((await call(givingStatsEndpoint, makeReq('GET', '/api/giving/stats', { user: { id: 1, role: 'section-editor' } }))).status).toBe(403)
  })
})
