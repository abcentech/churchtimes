/**
 * Giving against the real schema (donations collection, giving-settings global, PostgreSQL) and the local fake Paystack.
 * No network: Paystack is scripts/fake-paystack.mjs on loopback, Turnstile and SMTP are stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { startFakePaystack } from '../../scripts/fake-paystack.mjs'
import { resetGivingState } from '../../src/endpoints/publicGiving'
import { resetGivingSettingsCache } from '../../src/lib/giving/runtime'
import { generateDonationReference } from '../../src/lib/giving/reference'
import { payloadDonationStore } from '../../src/lib/giving/store'
import { TEST_SECRET } from '../unit/givingHelpers'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'
import { installActionTurnstileStub, installMailCapture, removeActionTurnstileStub, tsToken, type MailCapture } from './publicStubs'

const runId = newRunId()
let f: Fixtures
let mail: MailCapture
let fake: Awaited<ReturnType<typeof startFakePaystack>>
const refs: string[] = []
const saved: Record<string, string | undefined> = {}
const ENV = ['PAYSTACK_SECRET_KEY', 'PAYSTACK_API_BASE', 'PUBLIC_SITE_URL', 'SMTP_HOST', 'GIVING_PROVIDER', 'GIVING_RETURN_URL']

const settings = {
  enabled: true,
  provider: 'paystack',
  currencies: [
    { currency: 'NGN', presets: [200_000, 500_000], minimum: 100_000, maximum: 100_000_000, label: 'Naira' },
    { currency: 'USD', presets: [1_000, 2_500], minimum: 500, maximum: 100_000, label: 'US dollars' },
  ],
  causes: [
    { key: 'general', label: 'Where it is needed most', enabled: true },
    { key: 'relief', label: 'Relief reporting', enabled: true },
  ],
  thankYouNote: 'Thank you for keeping our reporting free to read.',
  bankTransferNote: 'Bank transfer and USSD are offered on the Paystack page.',
}

const email = () => `${runId}-${Math.random().toString(36).slice(2, 8)}@example.test`
const init = (over: Record<string, unknown> = {}) =>
  api('POST', '/api/public/giving/init', {
    body: { amountMinor: 500_000, currency: 'NGN', cause: 'general', email: email(), name: `${runId} Donor`, anonymous: false, consent: true, turnstileToken: tsToken('giving-init'), ...over },
  })
const webhook = (body: unknown, key = TEST_SECRET) => {
  const { raw, signature } = fake.signedWebhook(body, key)
  return api('POST', '/api/public/giving/webhook/paystack', { body: raw.toString('utf8'), headers: { 'content-type': 'application/json', 'x-paystack-signature': signature } })
}
const row = async (reference: string) =>
  (await f.payload.find({ collection: 'donations' as never, where: { reference: { equals: reference } }, overrideAccess: true, depth: 0 })).docs[0] as unknown as Record<string, unknown>

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  fake = await startFakePaystack({ secret: TEST_SECRET })
  process.env.PAYSTACK_SECRET_KEY = TEST_SECRET
  process.env.PAYSTACK_API_BASE = fake.origin
  process.env.PUBLIC_SITE_URL = 'http://localhost:5373'
  process.env.SMTP_HOST = 'smtp.stub.example.test'
  delete process.env.GIVING_PROVIDER
  delete process.env.GIVING_RETURN_URL
  installActionTurnstileStub()
  f = await setupFixtures(runId)
  mail = installMailCapture(f.payload)
  await f.payload.updateGlobal({ slug: 'giving-settings' as never, data: settings as never, overrideAccess: true })
})

afterAll(async () => {
  removeActionTurnstileStub()
  mail?.restore()
  if (f) {
    await f.payload.delete({ collection: 'donations' as never, where: { reference: { in: refs } }, overrideAccess: true }).catch(() => undefined)
    await f.payload.updateGlobal({ slug: 'giving-settings' as never, data: { enabled: false } as never, overrideAccess: true }).catch(() => undefined)
    await f.cleanup()
  }
  await fake?.close()
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]
  else process.env[k] = saved[k]
  resetGivingSettingsCache()
})

beforeEach(() => {
  resetGivingState()
  resetGivingSettingsCache()
  mail.sent.length = 0
})

async function started(over: Record<string, unknown> = {}) {
  const res = await init(over)
  expect(res.status, res.text).toBe(201)
  refs.push(res.json.reference)
  return res.json as { reference: string; checkoutUrl: string }
}

describe('giving end to end (real schema, fake Paystack)', () => {
  it('settings expose public-safe fields only', async () => {
    const res = await api('GET', '/api/public/giving/settings')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ enabled: true, provider: 'paystack', testMode: true })
    expect(res.json.currencies.map((c: { currency: string }) => c.currency)).toEqual(['NGN', 'USD'])
    expect(res.text).not.toMatch(/sk_(test|live)|secret|api_base/i)
  })

  it('init stores a pending row with consent time and the provider receives the same integer amount', async () => {
    const { reference, checkoutUrl } = await started()
    expect(checkoutUrl.startsWith(fake.origin)).toBe(true)
    const doc = await row(reference)
    expect(doc).toMatchObject({ reference, status: 'pending', provider: 'paystack', amountMinor: 500_000, currency: 'NGN', cause: 'general', anonymous: false })
    expect(doc.consentAt).toBeTruthy()
    expect(doc.receiptSentAt ?? null).toBeNull()
    const call = fake.calls.find((c: { op: string; body?: { reference?: string } }) => c.op === 'initialize' && c.body?.reference === reference)
    expect(call.body.amount).toBe(500_000)
    expect(call.body.callback_url).toBe('http://localhost:5373/give/thanks/')
  })

  it('anonymous: no name stored', async () => {
    const { reference } = await started({ anonymous: true })
    expect((await row(reference)).name ?? null).toBeNull()
  })

  it('signed webhook + provider verify -> succeeded with provider details, one receipt; replays change nothing', async () => {
    const { reference } = await started({ currency: 'USD', amountMinor: 2_500 })
    fake.complete(reference, 'success', { channel: 'card' })
    const body = fake.webhookBodyFor(reference)
    expect((await webhook(body)).status).toBe(200)
    const doc = await row(reference)
    expect(doc).toMatchObject({ status: 'succeeded', channel: 'card' })
    expect(doc.paidAt).toBeTruthy()
    expect(String(doc.providerRef)).toMatch(/^\d+$/)
    expect(doc.receiptSentAt).toBeTruthy()
    expect(mail.sent).toHaveLength(1)
    expect(String(mail.sent[0]!.text)).toContain('USD 25.00')
    resetGivingState() // lose the in-memory replay cache too: the database alone must keep it idempotent
    expect((await webhook(body)).status).toBe(200)
    expect(mail.sent).toHaveLength(1)
  })

  it('tampered or forged webhooks are refused and change nothing', async () => {
    const { reference } = await started()
    fake.complete(reference, 'success')
    expect((await webhook(fake.webhookBodyFor(reference), TEST_SECRET.replace('a1', 'b2'))).status).toBe(401)
    expect((await row(reference)).status).toBe('pending')
  })

  it('wrong amount at the provider: stays pending, no receipt', async () => {
    const { reference } = await started()
    fake.complete(reference, 'success', { amount: 100_000, requested_amount: 100_000 })
    expect((await webhook(fake.webhookBodyFor(reference))).status).toBe(200)
    expect((await row(reference)).status).toBe('pending')
    expect(mail.sent).toHaveLength(0)
  })

  it('status reports the confirmed state without personal data', async () => {
    const { reference } = await started()
    fake.complete(reference, 'success')
    const res = await api('GET', `/api/public/giving/status?reference=${reference}`)
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, reference, status: 'succeeded', amountMinor: 500_000, currency: 'NGN', expired: false })
    expect(res.text).not.toContain(runId)
  })

  it('the SQL store: concurrent transitions and receipt claims have exactly one winner', async () => {
    const { reference } = await started()
    const store = payloadDonationStore(f.payload)
    const wins = await Promise.all(Array.from({ length: 6 }, () => store.transition(reference, ['pending'], 'succeeded', { paidAt: new Date().toISOString(), channel: 'ussd', providerRef: '42' })))
    expect(wins.filter(Boolean)).toHaveLength(1)
    const claims = await Promise.all(Array.from({ length: 6 }, () => store.claimReceipt(reference)))
    expect(claims.filter(Boolean)).toHaveLength(1)
    await store.releaseReceipt(reference)
    expect((await store.findByReference(reference))?.receiptSentAt).toBeNull()
    // succeeded never goes back
    expect(await store.transition(reference, ['pending'], 'failed')).toBe(false)
    expect((await store.findByReference(reference))?.status).toBe('succeeded')
  })

  it('REST: nobody creates or edits donations; anonymous and reporters cannot read them', async () => {
    expect([401, 403]).toContain((await api('GET', '/api/donations')).status)
    expect([401, 403]).toContain((await api('GET', '/api/donations', { token: f.tokens.reporter })).status)
    expect([401, 403]).toContain((await api('POST', '/api/donations', { token: f.tokens.admin, body: { reference: generateDonationReference(), provider: 'paystack', amountMinor: 1, currency: 'NGN' } })).status)
  })

  it('stats: totals for the editor-in-chief, refused for reporters', async () => {
    expect((await api('GET', '/api/giving/stats', { token: f.tokens.reporter })).status).toBe(403)
    const res = await api('GET', '/api/giving/stats', { token: f.tokens.eic })
    expect(res.status).toBe(200)
    expect(res.json.byCurrency.NGN.counts.succeeded).toBeGreaterThanOrEqual(1)
    expect(res.json.byCurrency.USD.succeededMinor).toBeGreaterThanOrEqual(2_500)
    expect(res.text).not.toContain('@')
  })

  it('switch off: no new gifts, settings say disabled, confirmations of started gifts still work', async () => {
    const { reference } = await started()
    await f.payload.updateGlobal({ slug: 'giving-settings' as never, data: { enabled: false } as never, overrideAccess: true })
    resetGivingSettingsCache()
    try {
      expect((await init()).status).toBe(404)
      expect((await api('GET', '/api/public/giving/settings')).json).toEqual({ enabled: false })
      fake.complete(reference, 'success')
      expect((await webhook(fake.webhookBodyFor(reference))).status).toBe(200)
      expect((await row(reference)).status).toBe('succeeded')
    } finally {
      await f.payload.updateGlobal({ slug: 'giving-settings' as never, data: { enabled: true } as never, overrideAccess: true })
    }
  })

  it('no key: every giving endpoint is off', async () => {
    delete process.env.PAYSTACK_SECRET_KEY
    try {
      expect((await init()).status).toBe(404)
      expect((await api('GET', '/api/public/giving/settings')).json).toEqual({ enabled: false })
      expect((await webhook({ event: 'charge.success', data: {} })).status).toBe(404)
    } finally {
      process.env.PAYSTACK_SECRET_KEY = TEST_SECRET
    }
  })
})
