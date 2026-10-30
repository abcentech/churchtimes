import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { signPaystack, startFakePaystack } from '../../scripts/fake-paystack.mjs'
import { formatMinor, isMinorAmount } from '../../src/lib/giving/currency'
import { normalisePaystackTransaction, PAYSTACK_API_BASE, PaystackProvider, resolvePaystackConfig } from '../../src/lib/giving/paystack'
import { ProviderError } from '../../src/lib/giving/provider'
import { generateDonationReference, isDonationReference } from '../../src/lib/giving/reference'
import { normaliseGivingSettings, publicGivingSettings, resolveGivingProvider } from '../../src/lib/giving/settings'
import { computeHmacSha512Hex, verifyHmacSha512 } from '../../src/lib/giving/signature'
import { validateGivingInit } from '../../src/lib/giving/validate'
import { fakeKey, RAW_SETTINGS, TEST_SECRET } from './givingHelpers'

describe('webhook signature (HMAC-SHA512 over the raw body)', () => {
  const raw = Buffer.from('{"event":"charge.success","data":{"reference":"CTG-0123456789abcdef0123456789abcdef","amount":500000}}')
  const good = computeHmacSha512Hex(raw, TEST_SECRET)

  it('matches Paystack\'s documented scheme and the fake server', () => {
    expect(good).toMatch(/^[0-9a-f]{128}$/)
    expect(signPaystack(raw, TEST_SECRET)).toBe(good)
    expect(verifyHmacSha512(raw, good, TEST_SECRET)).toBe(true)
    expect(verifyHmacSha512(raw, good.toUpperCase(), TEST_SECRET)).toBe(true)
  })

  it('rejects a tampered body (one byte), even when the JSON means the same', () => {
    const tampered = Buffer.from(raw.toString().replace('500000', '900000'))
    expect(verifyHmacSha512(tampered, good, TEST_SECRET)).toBe(false)
    // Re-serialising changes bytes: the HMAC must be checked on what was received, not on a parsed object.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 1))
    expect(verifyHmacSha512(reserialised, good, TEST_SECRET)).toBe(false)
  })

  it('rejects a wrong key, and missing, short, long or non-hex headers', () => {
    expect(verifyHmacSha512(raw, computeHmacSha512Hex(raw, fakeKey('other0000000000000000')), TEST_SECRET)).toBe(false)
    for (const h of [null, undefined, '', good.slice(0, 127), good + '0', good.slice(0, 126) + 'zz', `sha512=${good}`]) {
      expect(verifyHmacSha512(raw, h as string, TEST_SECRET)).toBe(false)
    }
    expect(verifyHmacSha512(raw, good, '')).toBe(false)
  })
})

describe('money and references', () => {
  it('only positive safe integers are amounts', () => {
    expect(isMinorAmount(500_000)).toBe(true)
    for (const v of [0, -1, 1.5, '500', NaN, Infinity, 2 ** 53, null]) expect(isMinorAmount(v)).toBe(false)
    expect(formatMinor(500_050, 'NGN')).toBe('NGN 5,000.50')
    expect(formatMinor(7, 'USD')).toBe('USD 0.07')
  })
  it('references are CTG- + 32 hex, unique, and only Paystack-safe characters', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const r = generateDonationReference()
      expect(isDonationReference(r)).toBe(true)
      expect(r).toMatch(/^[A-Za-z0-9.=-]+$/)
      seen.add(r)
    }
    expect(seen.size).toBe(500)
    for (const bad of ['CTG-0123', 'ctg-0123456789abcdef0123456789abcdef', 'CTG-0123456789ABCDEF0123456789ABCDEF', '../etc', 'CTG-0123456789abcdef0123456789abcdef\n']) {
      expect(isDonationReference(bad)).toBe(false)
    }
  })
})

describe('resolvePaystackConfig', () => {
  it('is off without a key and refuses malformed keys without echoing them', () => {
    expect(resolvePaystackConfig({})).toBeNull()
    const r = resolvePaystackConfig({ PAYSTACK_SECRET_KEY: 'pk_live_public-key-by-mistake' })
    expect(r && 'error' in r && r.error).toBeTruthy()
    expect(JSON.stringify(r)).not.toContain('pk_live_public')
  })
  it('detects test and live keys and uses the real API by default', () => {
    expect(resolvePaystackConfig({ PAYSTACK_SECRET_KEY: TEST_SECRET })).toEqual({ secret: TEST_SECRET, baseUrl: PAYSTACK_API_BASE, mode: 'test' })
    expect(resolvePaystackConfig({ PAYSTACK_SECRET_KEY: fakeKey('x'.repeat(40), 'live') })).toMatchObject({ mode: 'live' })
  })
  it('honours PAYSTACK_API_BASE only for loopback, never in production', () => {
    expect(resolvePaystackConfig({ PAYSTACK_SECRET_KEY: TEST_SECRET, PAYSTACK_API_BASE: 'http://127.0.0.1:3291' })).toMatchObject({ baseUrl: 'http://127.0.0.1:3291' })
    for (const base of ['https://evil.example', 'http://10.0.0.5:80', 'http://user:pw@127.0.0.1:1', 'file:///etc/passwd', 'nope']) {
      expect(resolvePaystackConfig({ PAYSTACK_SECRET_KEY: TEST_SECRET, PAYSTACK_API_BASE: base })).toHaveProperty('error')
    }
    expect(resolvePaystackConfig({ PAYSTACK_SECRET_KEY: TEST_SECRET, PAYSTACK_API_BASE: 'http://127.0.0.1:3291', NODE_ENV: 'production' })).toHaveProperty('error')
  })
})

describe('PaystackProvider against the local fake Paystack', () => {
  let fake: Awaited<ReturnType<typeof startFakePaystack>>
  let provider: PaystackProvider
  beforeAll(async () => {
    fake = await startFakePaystack({ secret: TEST_SECRET })
    provider = new PaystackProvider({ secret: TEST_SECRET, baseUrl: fake.origin, mode: 'test' }, { timeoutMs: 2000 })
  })
  afterAll(async () => fake?.close())

  it('initialises with an integer subunit amount and our reference, and returns the hosted checkout URL', async () => {
    const reference = generateDonationReference()
    const { checkoutUrl } = await provider.initialize({ reference, amountMinor: 500_000, currency: 'NGN', email: 'reader@example.test', callbackUrl: 'http://localhost/give/thanks/', metadata: { cause: 'general' } })
    expect(checkoutUrl.startsWith(fake.origin + '/checkout/')).toBe(true)
    const call = fake.calls.find((c: { op: string; body?: { reference: string } }) => c.op === 'initialize' && c.body?.reference === reference)
    expect(call.body).toMatchObject({ amount: 500_000, currency: 'NGN', reference, callback_url: 'http://localhost/give/thanks/' })
    expect(Number.isInteger(call.body.amount)).toBe(true)
  })

  it('verify: unknown reference is null; an unpaid one reads abandoned; a paid one is normalised', async () => {
    expect(await provider.verify(generateDonationReference())).toBeNull()
    const reference = generateDonationReference()
    await provider.initialize({ reference, amountMinor: 1000, currency: 'USD', email: 'a@example.test', callbackUrl: 'http://localhost/x/', metadata: {} })
    expect((await provider.verify(reference))?.status).toBe('abandoned')
    fake.complete(reference, 'success', { channel: 'bank_transfer' })
    const tx = await provider.verify(reference)
    expect(tx).toMatchObject({ reference, status: 'success', amountMinor: 1000, requestedAmountMinor: 1000, currency: 'USD', channel: 'bank_transfer' })
    expect(tx?.paidAt).toMatch(/Z$/)
    expect(tx?.providerRef).toMatch(/^\d+$/)
  })

  it('classifies an unsupported currency and a bad key; errors never carry the key or the provider text', async () => {
    const err = await provider
      .initialize({ reference: generateDonationReference(), amountMinor: 1000, currency: 'GBP', email: 'a@example.test', callbackUrl: 'http://localhost/x/', metadata: {} })
      .catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.kind).toBe('rejected')
    expect(err.message).toContain('currency-not-enabled')
    const bad = new PaystackProvider({ secret: fakeKey('wrongwrongwrongwrong'), baseUrl: fake.origin, mode: 'test' })
    const e2 = await bad.verify(generateDonationReference()).catch((e) => e)
    expect(e2).toMatchObject({ kind: 'config', status: 401 })
    expect(JSON.stringify({ m: e2.message, s: String(e2.stack) })).not.toContain('sk_test_wrong')
  })

  it('a checkout URL that is not Paystack\'s own page is refused', async () => {
    const stub = (url: string) =>
      new PaystackProvider({ secret: TEST_SECRET, baseUrl: PAYSTACK_API_BASE, mode: 'test' }, {
        fetchImpl: async (_u, init) => {
          const body = JSON.parse(String(init.body))
          return Response.json({ status: true, data: { authorization_url: url, access_code: 'x', reference: body.reference } })
        },
      })
    const input = { reference: generateDonationReference(), amountMinor: 5000, currency: 'NGN' as const, email: 'a@example.test', callbackUrl: 'https://site/give/thanks/', metadata: {} }
    await expect(stub('https://checkout.paystack.com/abc').initialize(input)).resolves.toEqual({ checkoutUrl: 'https://checkout.paystack.com/abc' })
    for (const u of ['http://checkout.paystack.com/abc', 'https://checkout.paystack.com.evil.example/abc', 'https://evil.example/', 'javascript:alert(1)', 'https://u:p@checkout.paystack.com/x']) {
      await expect(stub(u).initialize(input)).rejects.toMatchObject({ kind: 'bad-response' })
    }
  })

  it('an answer for another reference is refused', async () => {
    const p = new PaystackProvider({ secret: TEST_SECRET, baseUrl: PAYSTACK_API_BASE, mode: 'test' }, {
      fetchImpl: async () => Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/a', reference: 'someone-else' } }),
    })
    await expect(p.initialize({ reference: generateDonationReference(), amountMinor: 5000, currency: 'NGN', email: 'a@example.test', callbackUrl: 'https://s/', metadata: {} })).rejects.toMatchObject({ kind: 'bad-response' })
  })

  it('times out, refuses redirects and sends the key only in the Authorization header', async () => {
    let seen: RequestInit | undefined
    const slow = new PaystackProvider({ secret: TEST_SECRET, baseUrl: PAYSTACK_API_BASE, mode: 'test' }, {
      timeoutMs: 50,
      fetchImpl: (url, init) => {
        seen = init
        expect(url).not.toContain(TEST_SECRET)
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      },
    })
    await expect(slow.verify(generateDonationReference())).rejects.toMatchObject({ kind: 'timeout' })
    expect(seen?.redirect).toBe('error')
    expect((seen?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_SECRET}`)
  })

  it('a malformed transaction (float amount, no currency) is a bad response, never a guess', () => {
    expect(() => normalisePaystackTransaction({ reference: 'r', amount: 10.5, currency: 'NGN' })).toThrow(ProviderError)
    expect(() => normalisePaystackTransaction({ reference: 'r', amount: 10, currency: 'naira' })).toThrow(ProviderError)
    expect(normalisePaystackTransaction({ reference: 'r', amount: 10, currency: 'ngn', status: 'ongoing' }).status).toBe('pending')
  })

  it('lists transactions for reconciliation', async () => {
    const { items, hasMore } = await provider.listTransactions({ from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 1000), page: 1, perPage: 50 })
    expect(items.length).toBeGreaterThan(0)
    expect(hasMore).toBe(false)
  })

  it('parseWebhook reads event and reference only', () => {
    expect(provider.parseWebhook(Buffer.from('{"event":"charge.success","data":{"reference":"CTG-x"}}'))).toEqual({ event: 'charge.success', reference: 'CTG-x' })
    expect(provider.parseWebhook(Buffer.from('not json'))).toBeNull()
    expect(provider.parseWebhook(Buffer.from('{"data":{}}'))).toBeNull()
    expect(provider.parseWebhook(Buffer.from('{"event":"x y"}'))).toBeNull()
  })
})

describe('settings normalisation', () => {
  const provider = new PaystackProvider({ secret: TEST_SECRET, baseUrl: PAYSTACK_API_BASE, mode: 'test' })

  it('keeps only provider currencies (GBP is not on Paystack), naira first, clamps to the provider minimum and hard maximum', () => {
    const s = normaliseGivingSettings(
      { ...RAW_SETTINGS, currencies: [...RAW_SETTINGS.currencies, { currency: 'NGN', minimum: 1 }, { currency: 'XYZ' }] },
      provider,
    )
    expect(s.currencies.map((c) => c.currency)).toEqual(['NGN', 'USD'])
    const ngn = s.currencies[0]!
    expect(ngn.minimumMinor).toBe(100_000)
    expect(ngn.presets).toEqual([200_000, 500_000, 1_000_000])
    const low = normaliseGivingSettings({ currencies: [{ currency: 'NGN', minimum: 100, maximum: 9e15, presets: [100, 5_000, 1.5, 'x'] }] }, provider).currencies[0]!
    expect(low.minimumMinor).toBe(5_000) // Paystack minimum NGN 50.00
    expect(low.maximumMinor).toBe(5_000_000_000)
    expect(low.presets).toEqual([5_000])
  })

  it('drops disabled causes and falls back to general', () => {
    const s = normaliseGivingSettings(RAW_SETTINGS, provider)
    expect(s.causes.map((c) => c.key)).toEqual(['general', 'relief'])
    expect(normaliseGivingSettings({ causes: [{ key: 'pastor-x', label: 'no' }] }, provider).causes).toEqual([{ key: 'general', label: 'Where it is needed most' }])
  })

  it('public projection: off unless enabled with a currency; never includes the key', () => {
    const s = normaliseGivingSettings(RAW_SETTINGS, provider)
    const pub = publicGivingSettings(s, provider)
    expect(pub).toMatchObject({ enabled: true, provider: 'paystack', testMode: true })
    expect(JSON.stringify(pub)).not.toContain('sk_')
    expect(publicGivingSettings({ ...s, enabled: false }, provider)).toEqual({ enabled: false })
    expect(publicGivingSettings({ ...s, currencies: [] }, provider)).toEqual({ enabled: false })
    expect(publicGivingSettings(s, null)).toEqual({ enabled: false })
  })

  it('provider resolution: no key is off; unknown or mismatched providers are off', () => {
    expect(resolveGivingProvider('paystack', {})).toEqual({ provider: null, reason: 'PAYSTACK_SECRET_KEY is not set.' })
    expect(resolveGivingProvider('flutterwave', { PAYSTACK_SECRET_KEY: TEST_SECRET }).provider).toBeNull()
    expect(resolveGivingProvider('paystack', { PAYSTACK_SECRET_KEY: TEST_SECRET, GIVING_PROVIDER: 'flutterwave' }).provider).toBeNull()
    expect(resolveGivingProvider(undefined, { PAYSTACK_SECRET_KEY: TEST_SECRET }).provider?.name).toBe('paystack')
  })
})

describe('validateGivingInit (never trust the client)', () => {
  const provider = new PaystackProvider({ secret: TEST_SECRET, baseUrl: PAYSTACK_API_BASE, mode: 'test' })
  const settings = normaliseGivingSettings(RAW_SETTINGS, provider)
  const valid = { amountMinor: 500_000, currency: 'NGN', cause: 'relief', email: 'Reader@Example.test', name: 'Ada', anonymous: false, consent: true, turnstileToken: 't' }
  const fields = (r: ReturnType<typeof validateGivingInit>) => (r.ok ? [] : r.errors.map((e) => e.field ?? 'body'))

  it('accepts a valid request and keeps only what the reader chose', () => {
    const r = validateGivingInit(valid, settings)
    expect(r).toEqual({ ok: true, honeypot: false, data: { amountMinor: 500_000, currency: 'NGN', cause: 'relief', email: 'reader@example.test', name: 'Ada', anonymous: false } })
  })

  it('refuses client-chosen status, reference, provider or anything unknown', () => {
    for (const extra of [{ status: 'succeeded' }, { reference: 'CTG-0123456789abcdef0123456789abcdef' }, { provider: 'x' }, { amount: 1 }]) {
      expect(validateGivingInit({ ...valid, ...extra }, settings).ok).toBe(false)
    }
  })

  it('amounts: integers in minor units, inside the configured range', () => {
    for (const amountMinor of [5000.5, '500000', -500_000, 0, 99_999, 100_000_001, 2 ** 53, null]) {
      expect(fields(validateGivingInit({ ...valid, amountMinor }, settings))).toContain('amountMinor')
    }
    expect(validateGivingInit({ ...valid, amountMinor: 100_000 }, settings).ok).toBe(true)
  })

  it('currencies: only enabled and provider-supported (GBP, EUR and lowercase refused)', () => {
    for (const currency of ['GBP', 'EUR', 'ngn', 'GHS', '']) expect(fields(validateGivingInit({ ...valid, currency }, settings))).toContain('currency')
    expect(validateGivingInit({ ...valid, currency: 'USD', amountMinor: 1000 }, settings).ok).toBe(true)
  })

  it('consent must be the boolean true; email is required; disabled causes are refused', () => {
    for (const consent of [undefined, false, 'true', 1]) expect(fields(validateGivingInit({ ...valid, consent }, settings))).toContain('consent')
    expect(fields(validateGivingInit({ ...valid, email: 'nope' }, settings))).toContain('email')
    expect(fields(validateGivingInit({ ...valid, cause: 'ministry' }, settings))).toContain('cause')
    expect(validateGivingInit({ ...valid, cause: undefined }, settings)).toMatchObject({ ok: true, data: { cause: 'general' } })
  })

  it('anonymous gifts store no name; names are cleaned and capped', () => {
    expect(validateGivingInit({ ...valid, anonymous: true, name: 'Ada' }, settings)).toMatchObject({ ok: true, data: { name: null, anonymous: true } })
    expect(validateGivingInit({ ...valid, name: '<b>Ada</b>\r\nBcc: x' }, settings)).toMatchObject({ ok: true, data: { name: 'Ada Bcc: x' } })
    expect(fields(validateGivingInit({ ...valid, name: 'x'.repeat(101) }, settings))).toContain('name')
  })

  it('flags the honeypot', () => {
    expect(validateGivingInit({ ...valid, website: 'http://spam' }, settings)).toMatchObject({ ok: true, honeypot: true })
  })
})
