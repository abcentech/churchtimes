import { formatMinor, isDonationCurrency } from './currency'
import type { GivingProvider, VerifiedTransaction } from './provider'
import { isDonationReference } from './reference'
import { amountMatches, PENDING_STATUS_TTL_MS } from './service'
import type { DonationRow, DonationStore } from './store'

/**
 * Read-only reconciliation: compares our donation rows with the provider's transaction list for a window and reports
 * every difference. It never writes (fixes go through the webhook / status path or the Paystack dashboard), and the
 * report carries references, amounts and states only: no e-mail address, name or card detail.
 */

export type ReconcileIssue = {
  reference: string
  kind:
    | 'provider-success-not-recorded'
    | 'recorded-success-not-at-provider'
    | 'reversed-at-provider'
    | 'amount-or-currency-mismatch'
    | 'unknown-at-provider'
    | 'missing-locally'
    | 'stale-pending'
  detail: string
}

export type ReconcileReport = {
  from: string
  to: string
  localRows: number
  providerTransactions: number
  totals: Record<string, { localSucceededMinor: number; providerSuccessMinor: number }>
  issues: ReconcileIssue[]
}

export function reconcile(rows: DonationRow[], txs: VerifiedTransaction[], window: { from: Date; to: Date }, now = new Date()): ReconcileReport {
  const ours = txs.filter((t) => isDonationReference(t.reference))
  const byRef = new Map(ours.map((t) => [t.reference, t]))
  const local = new Map(rows.map((r) => [r.reference, r]))
  const issues: ReconcileIssue[] = []
  const totals: ReconcileReport['totals'] = {}
  const bucket = (c: string) => (totals[c] ??= { localSucceededMinor: 0, providerSuccessMinor: 0 })

  for (const r of rows) {
    if (r.status === 'succeeded') bucket(r.currency).localSucceededMinor += r.amountMinor
    const tx = byRef.get(r.reference)
    if (!tx) {
      if (r.status === 'succeeded') issues.push({ reference: r.reference, kind: 'recorded-success-not-at-provider', detail: 'Succeeded here, absent from the provider list for this window.' })
      else if (r.status === 'pending' && now.getTime() - Date.parse(r.createdAt) >= PENDING_STATUS_TTL_MS) issues.push({ reference: r.reference, kind: 'stale-pending', detail: 'Pending for over 24 hours and unknown to the provider (checkout never opened or expired).' })
      continue
    }
    const matches = tx.currency === r.currency && amountMatches(tx, r)
    if (tx.status === 'success' && !matches) {
      issues.push({ reference: r.reference, kind: 'amount-or-currency-mismatch', detail: `Ours ${formatMinor(r.amountMinor, r.currency)}, provider ${isDonationCurrency(tx.currency) ? formatMinor(tx.amountMinor, tx.currency) : `${tx.currency} ${tx.amountMinor} (minor)`}.` })
    } else if (tx.status === 'success' && r.status !== 'succeeded') {
      issues.push({ reference: r.reference, kind: 'provider-success-not-recorded', detail: `Provider success, ours ${r.status}. A status check or webhook retry will confirm it.` })
    } else if (tx.status === 'reversed' && r.status === 'succeeded') {
      issues.push({ reference: r.reference, kind: 'reversed-at-provider', detail: 'Reversed or refunded at the provider; review in the dashboard.' })
    } else if (tx.status !== 'success' && r.status === 'succeeded') {
      issues.push({ reference: r.reference, kind: 'recorded-success-not-at-provider', detail: `Succeeded here, provider says ${tx.status}.` })
    } else if (r.status === 'pending' && now.getTime() - Date.parse(r.createdAt) >= PENDING_STATUS_TTL_MS) {
      issues.push({ reference: r.reference, kind: 'stale-pending', detail: `Pending for over 24 hours; provider says ${tx.status}.` })
    }
  }
  for (const tx of ours) {
    if (tx.status === 'success') bucket(tx.currency).providerSuccessMinor += tx.amountMinor
    if (!local.has(tx.reference)) issues.push({ reference: tx.reference, kind: 'missing-locally', detail: `Provider has ${tx.status} ${tx.currency} ${tx.amountMinor} (minor) with no row here.` })
  }
  return { from: window.from.toISOString(), to: window.to.toISOString(), localRows: rows.length, providerTransactions: ours.length, totals, issues }
}

/** Fetch both sides for [from, to] (provider pages capped) and reconcile. */
export async function runReconcile(store: DonationStore, provider: GivingProvider, window: { from: Date; to: Date }, maxPages = 50): Promise<ReconcileReport> {
  const rows = await store.listCreatedBetween(window.from, window.to)
  const txs: VerifiedTransaction[] = []
  for (let page = 1; page <= maxPages; page++) {
    const { items, hasMore } = await provider.listTransactions({ ...window, page, perPage: 100 })
    txs.push(...items)
    if (!hasMore) break
  }
  return reconcile(rows, txs, window)
}

export function formatReconcileReport(report: ReconcileReport): string {
  const lines = [`Giving reconciliation ${report.from} .. ${report.to}`, `Local rows: ${report.localRows}; provider transactions (ours): ${report.providerTransactions}`, '']
  for (const [currency, t] of Object.entries(report.totals)) {
    const fmt = (n: number) => (isDonationCurrency(currency) ? formatMinor(n, currency) : `${currency} ${n} (minor)`)
    lines.push(`${currency}: recorded succeeded ${fmt(t.localSucceededMinor)}; provider success ${fmt(t.providerSuccessMinor)}${t.localSucceededMinor === t.providerSuccessMinor ? '' : '  <-- differs'}`)
  }
  lines.push('', report.issues.length ? `${report.issues.length} issue(s):` : 'No issues.')
  for (const i of report.issues) lines.push(`- ${i.reference}  ${i.kind}: ${i.detail}`)
  return lines.join('\n')
}
