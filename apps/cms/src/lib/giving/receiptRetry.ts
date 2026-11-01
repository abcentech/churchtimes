import type { Payload } from 'payload'

import { safeErrorFields } from '../safeLog'
import { givingDeps, loadGivingRuntime } from './runtime'
import { receiptOwed, sendReceiptOnce } from './service'
import { toDonationRow } from './store'

/**
 * Background retry for receipts still owed: confirmed gifts whose e-mail failed or could not be sent (SMTP missing) at
 * confirmation time, and whose reader never came back to the thanks page. Runs from the scheduler at most every
 * RECEIPT_RETRY_INTERVAL_MS, only when a provider key and SMTP are configured, for gifts paid in the last 48 hours
 * (an address that keeps failing is not retried forever), at most 25 per sweep. Each send is the same atomic,
 * once-only claim as everywhere else. Logs references only.
 */

export const RECEIPT_RETRY_INTERVAL_MS = 10 * 60 * 1000
export const RECEIPT_RETRY_WINDOW_MS = 48 * 3600 * 1000
const BATCH = 25

let lastRun = 0
let running = false

/** Test helper. */
export function resetReceiptRetry(): void {
  lastRun = 0
  running = false
}

export async function retryOwedReceipts(payload: Payload, now = new Date(), opts: { force?: boolean } = {}): Promise<{ sent: number; failed: number } | null> {
  if (running || (!opts.force && now.getTime() - lastRun < RECEIPT_RETRY_INTERVAL_MS)) return null
  lastRun = now.getTime()
  running = true
  try {
    const runtime = await loadGivingRuntime(payload)
    if (!runtime.provider) return null
    const deps = givingDeps(payload, { ...runtime, provider: runtime.provider })
    if (!deps.mailer.configured) return null
    const res = await payload.find({
      collection: 'donations' as never,
      where: {
        and: [
          { status: { equals: 'succeeded' } },
          { receiptSentAt: { exists: false } },
          { email: { exists: true } },
          { paidAt: { greater_than_equal: new Date(now.getTime() - RECEIPT_RETRY_WINDOW_MS).toISOString() } },
        ],
      },
      sort: 'paidAt',
      limit: BATCH,
      depth: 0,
      overrideAccess: true,
    })
    let sent = 0
    let failed = 0
    for (const doc of res.docs) {
      const row = toDonationRow(doc as unknown as Record<string, unknown>)
      if (!receiptOwed(row)) continue
      const result = await sendReceiptOnce(deps, row)
      if (result === 'sent') sent++
      else if (result === 'failed') failed++
    }
    if (sent || failed) payload.logger.info({ sent, failed }, '[giving] receipt retry sweep')
    return { sent, failed }
  } catch (err) {
    payload.logger.error(safeErrorFields(err), '[giving] receipt retry sweep failed')
    return null
  } finally {
    running = false
  }
}
