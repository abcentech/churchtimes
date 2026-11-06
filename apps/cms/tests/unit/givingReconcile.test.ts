import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startFakePaystack } from '../../scripts/fake-paystack.mjs'
import { formatReconcileReport, runReconcile } from '../../src/lib/giving/reconcile'
import { confirmDonation, PENDING_STATUS_TTL_MS, startDonation } from '../../src/lib/giving/service'
import { makeDeps, TEST_SECRET } from './givingHelpers'

let fake: Awaited<ReturnType<typeof startFakePaystack>>
beforeAll(async () => {
  fake = await startFakePaystack({ secret: TEST_SECRET })
})
afterAll(async () => fake?.close())

const donor = { amountMinor: 500_000, currency: 'NGN' as const, cause: 'general' as const, email: 'reader@example.test', name: 'Ada Obi', anonymous: false }

describe('giving reconciliation (read-only)', () => {
  it('reports each kind of difference, totals per currency, and never personal data', async () => {
    const { deps, store } = makeDeps(fake.origin)
    const start = async () => {
      const r = await startDonation(deps, donor)
      if (!r.ok) throw new Error('start')
      return r.reference
    }
    const fine = await start()
    fake.complete(fine, 'success')
    await confirmDonation(deps, fine)

    const unrecorded = await start()
    fake.complete(unrecorded, 'success') // no webhook yet

    const wrongAmount = await start()
    fake.complete(wrongAmount, 'success', { amount: 1_000, requested_amount: 1_000 })

    const reversed = await start()
    fake.complete(reversed, 'success')
    await confirmDonation(deps, reversed)
    fake.complete(reversed, 'reversed')

    const stale = await start()
    store.age(stale, PENDING_STATUS_TTL_MS + 1)

    // A transaction of ours at the provider with no row here (e.g. a row deleted by mistake).
    const orphan = await start()
    fake.complete(orphan, 'success')
    store.rows.delete(orphan)

    const before = new Map([...store.rows].map(([k, v]) => [k, { ...v }]))
    const report = await runReconcile(store, deps.provider, { from: new Date(Date.now() - 2 * PENDING_STATUS_TTL_MS), to: new Date(Date.now() + 1000) })
    const kinds = Object.fromEntries(report.issues.map((i) => [i.reference, i.kind]))
    expect(kinds[fine]).toBeUndefined()
    expect(kinds[unrecorded]).toBe('provider-success-not-recorded')
    expect(kinds[wrongAmount]).toBe('amount-or-currency-mismatch')
    expect(kinds[reversed]).toBe('reversed-at-provider')
    expect(kinds[stale]).toBe('stale-pending')
    expect(kinds[orphan]).toBe('missing-locally')
    // Recorded: `fine` + `reversed` (still succeeded here). Provider success: fine, unrecorded, wrongAmount (1,000), orphan.
    expect(report.totals.NGN).toEqual({ localSucceededMinor: 1_000_000, providerSuccessMinor: 1_501_000 })
    // Read-only: nothing changed.
    expect([...store.rows].map(([k, v]) => [k, v.status])).toEqual([...before].map(([k, v]) => [k, v.status]))
    const text = formatReconcileReport(report)
    expect(text).toContain(unrecorded)
    for (const s of ['reader@example.test', 'Ada Obi', TEST_SECRET]) expect(text).not.toContain(s)
  })
})
