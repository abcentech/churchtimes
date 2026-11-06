/**
 * `npm run giving:reconcile -- [--days N]` (runs `payload run src/scripts/givingReconcile.ts`). READ-ONLY: compares the
 * donations created in the last N days (default 7, at most 92) with Paystack's transaction list and prints the
 * differences (references, amounts and states only). Exit code 0 = no issues, 2 = issues found, 1 = could not run.
 * See docs/w12/giving.md "Reconciliation".
 */
import config from '@payload-config'
import { getPayload } from 'payload'

import { formatReconcileReport, runReconcile } from '../lib/giving/reconcile'
import { resolveGivingProvider } from '../lib/giving/settings'
import { payloadDonationStore } from '../lib/giving/store'
import { safeErrorSummary } from '../lib/safeLog'

const args = process.argv.slice(2)
const i = args.indexOf('--days')
const days = i >= 0 ? Number(args[i + 1]) : 7
if (!Number.isInteger(days) || days < 1 || days > 92) {
  console.error('--days must be a whole number from 1 to 92.')
  process.exit(1)
}

const resolved = resolveGivingProvider(undefined)
if (!resolved.provider) {
  console.error(`Giving provider not configured: ${resolved.reason}`)
  process.exit(1)
}
const payload = await getPayload({ config })
const to = new Date()
const from = new Date(to.getTime() - days * 24 * 3600 * 1000)
try {
  const report = await runReconcile(payloadDonationStore(payload), resolved.provider, { from, to })
  console.log(formatReconcileReport(report))
  process.exit(report.issues.length ? 2 : 0)
} catch (err) {
  console.error(`Reconciliation failed: ${safeErrorSummary(err)}${err instanceof Error && err.name === 'ProviderError' ? ` (${err.message})` : ''}`)
  process.exit(1)
}
