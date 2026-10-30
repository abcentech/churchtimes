import { safeErrorFields } from '../safeLog'
import { generateDonationReference, isDonationReference } from './reference'
import { buildDonationReceipt } from './receipt'
import { ProviderError, type GivingProvider, type VerifiedTransaction } from './provider'
import type { EffectiveGivingSettings } from './settings'
import type { DonationRow, DonationStore } from './store'
import type { ValidGivingInit } from './validate'

/**
 * The money logic, independent of HTTP and of Payload so it is tested offline against a fake provider.
 *
 * Invariants (each has a test in tests/unit/giving-*.test.ts):
 * 1. A row becomes `succeeded` ONLY after our own server-to-server verify call returned `success` for that exact
 *    reference, in the row's currency, for the row's amount. Webhook bodies and browsers are never trusted for status.
 * 2. Every transition is one conditional UPDATE (store.transition), so replays and races are no-ops.
 * 3. `succeeded` is final here: a later `failed`/`abandoned`/`reversed` never downgrades it (reversals and refunds are
 *    handled in the Paystack dashboard and surface in the reconciliation report).
 * 4. One receipt per donation, only after success, claimed atomically; a failed send is released for a later retry.
 * 5. Logs carry the reference, an outcome code and error class only: never e-mail, name, secret or payload.
 */

export type LoggerLike = {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

export type Mailer = { configured: boolean; send(to: string, subject: string, text: string): Promise<void> }

export type GivingDeps = {
  store: DonationStore
  provider: GivingProvider
  logger: LoggerLike
  mailer: Mailer
  /** Full return URL on the public site (Paystack appends ?trxref=&reference=). */
  returnUrl: string
  settings: EffectiveGivingSettings | null
  now?: () => Date
}

/** A pending row older than this is "expired" for the public status check: it stops asking the provider. */
export const PENDING_STATUS_TTL_MS = 24 * 3600 * 1000
/** Provider `abandoned` is only believed for rows older than this (an unpaid checkout reads as abandoned from the start). */
export const ABANDON_GRACE_MS = 30 * 60 * 1000

export type StartResult =
  | { ok: true; reference: string; checkoutUrl: string }
  | { ok: false; status: 502 | 503 | 500; message: string }

export async function startDonation(deps: GivingDeps, data: ValidGivingInit): Promise<StartResult> {
  const now = deps.now ?? (() => new Date())
  const reference = generateDonationReference()
  try {
    await deps.store.create({
      reference,
      provider: deps.provider.name,
      amountMinor: data.amountMinor,
      currency: data.currency,
      cause: data.cause,
      email: data.email,
      name: data.anonymous ? null : data.name,
      anonymous: data.anonymous,
      consentAt: now().toISOString(),
    })
  } catch (err) {
    deps.logger.error(safeErrorFields(err), '[giving] could not store a new donation')
    return { ok: false, status: 500, message: 'Giving is temporarily unavailable. Please try again later.' }
  }
  try {
    const { checkoutUrl } = await deps.provider.initialize({
      reference,
      amountMinor: data.amountMinor,
      currency: data.currency,
      email: data.email,
      callbackUrl: deps.returnUrl,
      metadata: { cause: data.cause, source: 'churchtimes-give' },
    })
    deps.logger.info({ reference, currency: data.currency }, '[giving] checkout started')
    return { ok: true, reference, checkoutUrl }
  } catch (err) {
    // Nothing was charged: the provider never issued a checkout. Close the row so it is not mistaken for an open payment.
    await deps.store.transition(reference, ['pending'], 'failed').catch(() => undefined)
    const kind = err instanceof ProviderError ? err.kind : 'unknown'
    deps.logger.error({ reference, kind, ...(err instanceof ProviderError ? { detail: err.message, status: err.status } : safeErrorFields(err)) }, '[giving] provider initialise failed')
    return kind === 'config'
      ? { ok: false, status: 503, message: 'Giving is temporarily unavailable. Please try again later.' }
      : { ok: false, status: 502, message: 'We could not reach the payment service. Nothing was charged. Please try again.' }
  }
}

export type ConfirmOutcome =
  | 'unknown-reference'
  | 'already-succeeded'
  | 'succeeded'
  | 'failed'
  | 'abandoned'
  | 'still-pending'
  | 'not-found-at-provider'
  | 'mismatch'
  | 'no-change'

/** Amount check: exact, or (when the payer bore the fee) the provider's requested amount is ours and nothing less was charged. */
export function amountMatches(tx: VerifiedTransaction, row: Pick<DonationRow, 'amountMinor'>): boolean {
  if (tx.amountMinor === row.amountMinor) return true
  return tx.requestedAmountMinor === row.amountMinor && tx.amountMinor >= row.amountMinor
}

/**
 * Bring one donation in line with the provider. Throws ProviderError when the provider cannot be asked (the webhook then
 * answers 503 so the provider retries). Never trusts anything but the verify response.
 */
export async function confirmDonation(deps: GivingDeps, reference: string): Promise<{ outcome: ConfirmOutcome; row: DonationRow | null }> {
  if (!isDonationReference(reference)) return { outcome: 'unknown-reference', row: null }
  const row = await deps.store.findByReference(reference)
  if (!row) return { outcome: 'unknown-reference', row: null }
  if (row.provider !== deps.provider.name) return { outcome: 'no-change', row }
  if (row.status === 'succeeded') {
    await sendReceiptOnce(deps, row)
    return { outcome: 'already-succeeded', row }
  }

  const tx = await deps.provider.verify(reference)
  if (!tx) return { outcome: 'not-found-at-provider', row }
  if (tx.reference !== reference) {
    deps.logger.error({ reference, outcome: 'reference-mismatch' }, '[giving] provider answered for another reference')
    return { outcome: 'mismatch', row }
  }

  if (tx.status === 'success') {
    if (tx.currency !== row.currency || !amountMatches(tx, row)) {
      // Money may have moved, but not what this row asked for. Leave the row as it is and flag it for reconciliation.
      deps.logger.error(
        { reference, outcome: 'amount-or-currency-mismatch', expectedCurrency: row.currency, gotCurrency: tx.currency, expectedMinor: row.amountMinor, gotMinor: tx.amountMinor },
        '[giving] verified transaction does not match the donation; NOT marked succeeded',
      )
      return { outcome: 'mismatch', row }
    }
    const won = await deps.store.transition(reference, ['pending', 'failed', 'abandoned'], 'succeeded', {
      paidAt: tx.paidAt ?? (deps.now ?? (() => new Date()))().toISOString(),
      ...(tx.channel ? { channel: tx.channel } : {}),
      ...(tx.providerRef ? { providerRef: tx.providerRef } : {}),
    })
    const fresh = (await deps.store.findByReference(reference)) ?? row
    if (won) deps.logger.info({ reference, outcome: 'succeeded', currency: fresh.currency }, '[giving] donation confirmed')
    if (fresh.status === 'succeeded') await sendReceiptOnce(deps, fresh)
    return { outcome: won ? 'succeeded' : 'already-succeeded', row: fresh }
  }

  // Paystack reports an initialised transaction the reader has not paid YET as `abandoned`; only believe it once the
  // reader has had time to finish (bank transfers and USSD can take minutes).
  const ageMs = (deps.now ?? (() => new Date()))().getTime() - new Date(row.createdAt).getTime()
  if (tx.status === 'abandoned' && ageMs < ABANDON_GRACE_MS) return { outcome: 'still-pending', row }

  if (tx.status === 'failed' || tx.status === 'abandoned') {
    const won = await deps.store.transition(reference, ['pending'], tx.status)
    const fresh = won ? ((await deps.store.findByReference(reference)) ?? row) : row
    return { outcome: won ? tx.status : 'no-change', row: fresh }
  }
  if (tx.status === 'reversed') {
    deps.logger.warn({ reference, outcome: 'reversed' }, '[giving] provider reports a reversed transaction; review in the dashboard')
    return { outcome: 'no-change', row }
  }
  return { outcome: 'still-pending', row }
}

export async function sendReceiptOnce(deps: GivingDeps, row: DonationRow): Promise<'sent' | 'skipped' | 'failed'> {
  if (row.status !== 'succeeded' || row.receiptSentAt || !row.email) return 'skipped'
  if (!deps.mailer.configured) {
    deps.logger.warn({ reference: row.reference }, '[giving] receipt not sent: SMTP is not configured')
    return 'skipped'
  }
  if (!(await deps.store.claimReceipt(row.reference))) return 'skipped'
  const cause = deps.settings?.causes.find((c) => c.key === row.cause)
  const mail = buildDonationReceipt(row, {
    causeLabel: cause?.label ?? 'Church Times Nigeria',
    thankYouNote: deps.settings?.thankYouNote,
    testMode: deps.provider.mode === 'test',
  })
  try {
    await deps.mailer.send(row.email, mail.subject, mail.text)
    deps.logger.info({ reference: row.reference }, '[giving] receipt sent')
    return 'sent'
  } catch (err) {
    await deps.store.releaseReceipt(row.reference).catch(() => undefined)
    deps.logger.error({ reference: row.reference, ...safeErrorFields(err) }, '[giving] receipt e-mail failed; will retry on the next confirmation')
    return 'failed'
  }
}

/** True when the public status check may still ask the provider about this row. */
export function statusMayVerify(row: DonationRow, now: Date): boolean {
  return row.status === 'pending' && now.getTime() - new Date(row.createdAt).getTime() < PENDING_STATUS_TTL_MS
}
