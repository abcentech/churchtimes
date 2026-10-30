import type { DonationCurrency } from './currency'

/**
 * The thin provider interface. Paystack is the only adapter today; a Flutterwave adapter implements the same five
 * operations and is selected by `GIVING_PROVIDER` / `giving-settings.provider` (docs/w12/giving.md "Adding a provider").
 * Nothing outside `lib/giving/<provider>.ts` knows a provider's URLs, field names or signature scheme.
 */

/** Environment as read by giving (a plain record, so tests can pass a literal). */
export type GivingEnv = Record<string, string | undefined>

export type ProviderName = 'paystack' | 'flutterwave'

/** Provider-side state of one transaction, normalised. `pending` covers every in-flight state (ongoing, queued, ...). */
export type ProviderTxStatus = 'success' | 'failed' | 'abandoned' | 'reversed' | 'pending'

export type VerifiedTransaction = {
  reference: string
  status: ProviderTxStatus
  /** What the provider says was charged, in minor units. */
  amountMinor: number
  /** What we asked for, when the provider reports it separately (Paystack `requested_amount`, e.g. when the payer bears the fee). */
  requestedAmountMinor?: number
  /** Upper-case ISO 4217 as reported by the provider (may be outside our own list: then it simply never matches a row). */
  currency: string
  channel?: string
  paidAt?: string
  /** The provider's own transaction id, for reconciliation and support. */
  providerRef?: string
}

export type InitializeInput = {
  reference: string
  amountMinor: number
  currency: DonationCurrency
  email: string
  callbackUrl: string
  /** Non-personal metadata only (cause key, our reference). */
  metadata: Record<string, string>
}

export type WebhookEvent = {
  /** Provider event name, e.g. `charge.success`. */
  event: string
  /** Our reference when the event is about a transaction, else null. */
  reference: string | null
}

export type ProviderErrorKind = 'network' | 'timeout' | 'rejected' | 'bad-response' | 'config'

/** Thrown for every provider failure. `message` is a fixed, non-sensitive string (safe to log); no response body is kept. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly status?: number
  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.status = status
  }
}

export interface GivingProvider {
  readonly name: ProviderName
  /** `test` when the configured key is a test key: the public page says "test mode" and no real money moves. */
  readonly mode: 'test' | 'live'
  /** Currencies this provider can charge (intersected with the CMS setting). */
  readonly currencies: readonly DonationCurrency[]
  /** The provider's own smallest accepted charge for a currency, in minor units. */
  minimumMinor(currency: DonationCurrency): number
  initialize(input: InitializeInput): Promise<{ checkoutUrl: string }>
  /** Server-to-server lookup. `null` when the provider has no transaction with this reference. */
  verify(reference: string): Promise<VerifiedTransaction | null>
  /** Authenticate a webhook delivery from its raw bytes and headers. Pure and constant-time; no network. */
  verifyWebhook(raw: Buffer, headers: { get(name: string): string | null }): boolean
  /** Parse an AUTHENTICATED webhook body. `null` when it is not JSON or has no event name. */
  parseWebhook(raw: Buffer): WebhookEvent | null
  /** One page of transactions created in [from, to], newest first (read-only reconciliation). */
  listTransactions(args: { from: Date; to: Date; page: number; perPage: number }): Promise<{ items: VerifiedTransaction[]; hasMore: boolean }>
}
