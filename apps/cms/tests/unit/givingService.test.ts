import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startFakePaystack } from '../../scripts/fake-paystack.mjs'
import { ABANDON_GRACE_MS, confirmDonation, PENDING_STATUS_TTL_MS, startDonation, statusMayVerify } from '../../src/lib/giving/service'
import { generateDonationReference } from '../../src/lib/giving/reference'
import { makeDeps, TEST_SECRET } from './givingHelpers'

const donor = { amountMinor: 500_000, currency: 'NGN' as const, cause: 'general' as const, email: 'reader@example.test', name: 'Ada Obi', anonymous: false }

let fake: Awaited<ReturnType<typeof startFakePaystack>>
beforeAll(async () => {
  fake = await startFakePaystack({ secret: TEST_SECRET })
})
afterAll(async () => fake?.close())

const verifyCalls = (reference: string) => fake.calls.filter((c: { op: string; reference?: string }) => c.op === 'verify' && c.reference === reference).length

async function started(over = {}) {
  const kit = makeDeps(fake.origin, over)
  const r = await startDonation(kit.deps, donor)
  if (!r.ok) throw new Error('start failed')
  return { ...kit, reference: r.reference, checkoutUrl: r.checkoutUrl }
}

describe('startDonation', () => {
  it('stores a pending row with a server reference and consent time, then returns the hosted checkout', async () => {
    const { store, reference, checkoutUrl } = await started()
    const row = await store.findByReference(reference)
    expect(row).toMatchObject({ status: 'pending', amountMinor: 500_000, currency: 'NGN', provider: 'paystack', email: 'reader@example.test', name: 'Ada Obi' })
    expect(row?.consentAt).toMatch(/Z$/)
    expect(checkoutUrl).toContain('/checkout/')
  })

  it('anonymous: no name is stored', async () => {
    const kit = makeDeps(fake.origin)
    const r = await startDonation(kit.deps, { ...donor, anonymous: true, name: null })
    expect(r.ok && (await kit.store.findByReference(r.reference))?.name).toBeNull()
  })

  it('provider refusal: the row is closed as failed, nothing is charged, the answer is a 502 with a plain message', async () => {
    fake.state.failInitialize = { status: 400, body: { status: false, message: 'Currency not supported by merchant' } }
    try {
      const kit = makeDeps(fake.origin)
      const r = await startDonation(kit.deps, donor)
      expect(r).toMatchObject({ ok: false, status: 502 })
      expect([...kit.store.rows.values()].map((x) => x.status)).toEqual(['failed'])
      expect(kit.logger.text()).not.toContain('reader@example.test')
    } finally {
      fake.state.failInitialize = null
    }
  })

  it('database failure: 500 and no provider call', async () => {
    const kit = makeDeps(fake.origin)
    kit.store.failCreate = true
    const before = fake.calls.length
    expect(await startDonation(kit.deps, donor)).toMatchObject({ ok: false, status: 500 })
    expect(fake.calls.length).toBe(before)
  })
})

describe('confirmDonation (server-side verify is the only source of truth)', () => {
  it('success: marks succeeded with provider details and sends exactly one receipt', async () => {
    const { deps, store, mailer, reference } = await started()
    fake.complete(reference, 'success', { channel: 'ussd' })
    expect((await confirmDonation(deps, reference)).outcome).toBe('succeeded')
    const row = await store.findByReference(reference)
    expect(row).toMatchObject({ status: 'succeeded', channel: 'ussd' })
    expect(row?.paidAt).toBeTruthy()
    expect(row?.providerRef).toMatch(/^\d+$/)
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]!.text).toContain(reference)
    expect(mailer.sent[0]!.text).toContain('NGN 5,000.00')
    expect(mailer.sent[0]!.text).toContain('TEST payment')
    expect(mailer.sent[0]!.text).not.toMatch(/4081|card number|cvv/i)

    // Duplicate (webhook retry / replay / status poll): no state change, no provider call, no second receipt.
    const calls = verifyCalls(reference)
    expect((await confirmDonation(deps, reference)).outcome).toBe('already-succeeded')
    expect(verifyCalls(reference)).toBe(calls)
    expect(mailer.sent).toHaveLength(1)
  })

  it('wrong amount at the provider: NOT marked succeeded, no receipt, flagged in the log', async () => {
    const { deps, store, mailer, logger, reference } = await started()
    fake.complete(reference, 'success', { amount: 50_000, requested_amount: 50_000 })
    expect((await confirmDonation(deps, reference)).outcome).toBe('mismatch')
    expect((await store.findByReference(reference))?.status).toBe('pending')
    expect(mailer.sent).toHaveLength(0)
    expect(logger.text()).toContain('amount-or-currency-mismatch')
  })

  it('wrong currency at the provider: NOT marked succeeded', async () => {
    const { deps, store, reference } = await started()
    fake.complete(reference, 'success', { currency: 'USD' })
    expect((await confirmDonation(deps, reference)).outcome).toBe('mismatch')
    expect((await store.findByReference(reference))?.status).toBe('pending')
  })

  it('payer-bears-fee: requested amount equals ours and more was charged: succeeded', async () => {
    const { deps, store, reference } = await started()
    fake.complete(reference, 'success', { amount: 510_000, requested_amount: 500_000 })
    expect((await confirmDonation(deps, reference)).outcome).toBe('succeeded')
    expect((await store.findByReference(reference))?.status).toBe('succeeded')
  })

  it('less charged than requested is a mismatch even if requested_amount matches', async () => {
    const { deps, reference } = await started()
    fake.complete(reference, 'success', { amount: 400_000, requested_amount: 500_000 })
    expect((await confirmDonation(deps, reference)).outcome).toBe('mismatch')
  })

  it('a provider answer for another reference is refused', async () => {
    const { deps, store, reference } = await started()
    fake.complete(reference, 'success')
    fake.setTransaction(reference, { reference: generateDonationReference() })
    expect((await confirmDonation(deps, reference)).outcome).toBe('mismatch')
    expect((await store.findByReference(reference))?.status).toBe('pending')
  })

  it('unknown or malformed references never reach the provider', async () => {
    const kit = makeDeps(fake.origin)
    const before = fake.calls.length
    expect((await confirmDonation(kit.deps, generateDonationReference())).outcome).toBe('unknown-reference')
    expect((await confirmDonation(kit.deps, "CTG-' or 1=1 --")).outcome).toBe('unknown-reference')
    expect(fake.calls.length).toBe(before)
  })

  it('abandoned is believed only after the grace period; a later success still confirms', async () => {
    const { deps, store, reference } = await started()
    expect((await confirmDonation(deps, reference)).outcome).toBe('still-pending') // fresh checkout reads "abandoned"
    store.age(reference, ABANDON_GRACE_MS + 1000)
    expect((await confirmDonation(deps, reference)).outcome).toBe('abandoned')
    expect((await store.findByReference(reference))?.status).toBe('abandoned')
    fake.complete(reference, 'success')
    expect((await confirmDonation(deps, reference)).outcome).toBe('succeeded')
  })

  it('failed then reversed never downgrade a succeeded donation', async () => {
    const { deps, store, reference } = await started()
    fake.complete(reference, 'failed')
    expect((await confirmDonation(deps, reference)).outcome).toBe('failed')
    fake.complete(reference, 'success')
    expect((await confirmDonation(deps, reference)).outcome).toBe('succeeded')
    fake.complete(reference, 'reversed')
    expect((await confirmDonation(deps, reference)).outcome).toBe('already-succeeded')
    expect((await store.findByReference(reference))?.status).toBe('succeeded')
  })

  it('concurrent confirmations (webhook storm + status polls): one transition, one receipt', async () => {
    const { deps, mailer, reference } = await started()
    fake.complete(reference, 'success')
    const outcomes = (await Promise.all(Array.from({ length: 8 }, () => confirmDonation(deps, reference)))).map((r) => r.outcome)
    expect(outcomes.filter((o) => o === 'succeeded')).toHaveLength(1)
    expect(outcomes.filter((o) => o !== 'succeeded').every((o) => o === 'already-succeeded')).toBe(true)
    expect(mailer.sent).toHaveLength(1)
  })

  it('receipt failure is released and retried on the next confirmation; SMTP details never logged', async () => {
    const { deps, mailer, store, logger, reference } = await started()
    mailer.failNext = 1
    fake.complete(reference, 'success')
    await confirmDonation(deps, reference)
    expect(mailer.sent).toHaveLength(0)
    expect((await store.findByReference(reference))?.receiptSentAt).toBeNull()
    await confirmDonation(deps, reference)
    expect(mailer.sent).toHaveLength(1)
    expect((await store.findByReference(reference))?.receiptSentAt).toBeTruthy()
    expect(logger.text()).not.toContain('someone@example.test')
    expect(logger.text()).not.toContain('reader@example.test')
  })

  it('no SMTP: succeeded without a receipt, nothing claimed', async () => {
    const { deps, store, reference } = await started({ mailer: { configured: false, send: async () => { throw new Error('must not send') } } })
    fake.complete(reference, 'success')
    expect((await confirmDonation(deps, reference)).outcome).toBe('succeeded')
    expect((await store.findByReference(reference))?.receiptSentAt).toBeNull()
  })

  it('provider unreachable: throws (the webhook answers 503 so Paystack retries) and nothing changes', async () => {
    const { deps, store, reference } = await started()
    fake.state.failVerify = { status: 502, body: { status: false, message: 'upstream' } }
    try {
      await expect(confirmDonation(deps, reference)).rejects.toMatchObject({ name: 'ProviderError' })
      expect((await store.findByReference(reference))?.status).toBe('pending')
    } finally {
      fake.state.failVerify = null
    }
  })

  it('logs carry references and outcomes only: no email, name, key or payload', async () => {
    const { deps, logger, reference } = await started()
    fake.complete(reference, 'success')
    await confirmDonation(deps, reference)
    const text = logger.text()
    expect(text).toContain(reference)
    for (const s of ['reader@example.test', 'Ada Obi', TEST_SECRET, 'authorization', 'customer']) expect(text).not.toContain(s)
  })
})

describe('expired references', () => {
  it('the public status check stops asking the provider once a pending row is older than the TTL', async () => {
    const { store, reference } = await started()
    const row = (await store.findByReference(reference))!
    expect(statusMayVerify(row, new Date())).toBe(true)
    store.age(reference, PENDING_STATUS_TTL_MS + 1)
    expect(statusMayVerify((await store.findByReference(reference))!, new Date())).toBe(false)
  })

  it('a late, provider-verified success for an expired reference is still recorded (money was taken)', async () => {
    const { deps, store, reference } = await started()
    store.age(reference, PENDING_STATUS_TTL_MS * 3)
    fake.complete(reference, 'success')
    expect((await confirmDonation(deps, reference)).outcome).toBe('succeeded')
    expect((await store.findByReference(reference))?.status).toBe('succeeded')
  })
})
