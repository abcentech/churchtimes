import type { DonationCurrency } from './currency'
import {
  ProviderError,
  type GivingEnv,
  type GivingProvider,
  type InitializeInput,
  type ProviderTxStatus,
  type VerifiedTransaction,
  type WebhookEvent,
} from './provider'
import { verifyHmacSha512 } from './signature'

/**
 * Paystack adapter (docs/w12/giving.md records the documentation this follows and when it was checked).
 * - Initialise: POST https://api.paystack.co/transaction/initialize { email, amount (subunit integer), currency, reference,
 *   callback_url, metadata } -> data.authorization_url (hosted checkout on checkout.paystack.com).
 * - Verify: GET /transaction/verify/:reference -> data.status success|failed|abandoned|reversed|ongoing|pending|..., amount,
 *   requested_amount, currency, channel, paid_at, id.
 * - Webhook: `x-paystack-signature` = hex HMAC-SHA512(secret key, raw body).
 * - Currencies: NGN, USD, GHS, ZAR, KES. Of our four (NGN, USD, GBP, EUR) only NGN and USD exist on Paystack, and USD
 *   only once Paystack has approved international payments / USD for the business.
 *
 * The secret key is sent only in the Authorization header to the configured API origin, never logged and never put in an
 * error. Redirects are refused so the header can never follow a redirect elsewhere.
 */

export const PAYSTACK_API_BASE = 'https://api.paystack.co'
export const PAYSTACK_CHECKOUT_HOST = 'checkout.paystack.com'
const SECRET_RE = /^sk_(test|live)_[A-Za-z0-9]{16,}$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

/** Paystack's per-currency minimum charge (subunits): NGN 50.00 and USD 2.00. */
const PAYSTACK_MINIMUMS: Partial<Record<DonationCurrency, number>> = { NGN: 5_000, USD: 200 }
export const PAYSTACK_CURRENCIES: readonly DonationCurrency[] = ['NGN', 'USD']

export type PaystackConfig = { secret: string; baseUrl: string; mode: 'test' | 'live' }

/**
 * `null` when PAYSTACK_SECRET_KEY is unset (giving is simply off). `{ error }` when something is set but unusable; the
 * error string never contains the key. `PAYSTACK_API_BASE` (the local fake server) is honoured only outside production
 * and only for a loopback http(s) URL, so a mis-set variable can never send the live key to another host.
 */
export function resolvePaystackConfig(env: GivingEnv = process.env): PaystackConfig | { error: string } | null {
  const secret = env.PAYSTACK_SECRET_KEY?.trim()
  if (!secret) return null
  const match = SECRET_RE.exec(secret)
  if (!match) return { error: 'PAYSTACK_SECRET_KEY does not look like a Paystack secret key (sk_test_... or sk_live_...).' }
  const mode = match[1] === 'live' ? 'live' : 'test'
  const override = env.PAYSTACK_API_BASE?.trim()
  if (!override) return { secret, baseUrl: PAYSTACK_API_BASE, mode }
  if (env.NODE_ENV === 'production') return { error: 'PAYSTACK_API_BASE must not be set in production.' }
  let url: URL
  try {
    url = new URL(override)
  } catch {
    return { error: 'PAYSTACK_API_BASE is not a URL.' }
  }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) {
    return { error: 'PAYSTACK_API_BASE may only point at a loopback test server.' }
  }
  return { secret, baseUrl: url.origin, mode }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

const PAYSTACK_STATUS: Record<string, ProviderTxStatus> = {
  success: 'success',
  failed: 'failed',
  abandoned: 'abandoned',
  reversed: 'reversed',
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function toDateIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 40) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** Normalise one Paystack transaction object. Throws `bad-response` when the money fields are not what we expect. */
export function normalisePaystackTransaction(data: unknown): VerifiedTransaction {
  if (!isObject(data)) throw new ProviderError('bad-response', 'Paystack returned no transaction data.')
  const { reference, amount, currency } = data
  if (typeof reference !== 'string' || reference.length === 0 || reference.length > 100) {
    throw new ProviderError('bad-response', 'Paystack transaction has no usable reference.')
  }
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
    throw new ProviderError('bad-response', 'Paystack transaction amount is not an integer.')
  }
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new ProviderError('bad-response', 'Paystack transaction currency is not a currency code.')
  }
  const requested = data.requested_amount
  const channel = typeof data.channel === 'string' && /^[a-z_]{1,40}$/.test(data.channel) ? data.channel : undefined
  const id = data.id
  return {
    reference,
    status: PAYSTACK_STATUS[String(data.status)] ?? 'pending',
    amountMinor: amount,
    ...(typeof requested === 'number' && Number.isSafeInteger(requested) && requested >= 0 ? { requestedAmountMinor: requested } : {}),
    currency: currency.toUpperCase(),
    ...(channel ? { channel } : {}),
    ...(toDateIso(data.paid_at ?? data.paidAt) ? { paidAt: toDateIso(data.paid_at ?? data.paidAt) } : {}),
    ...((typeof id === 'number' && Number.isSafeInteger(id)) || (typeof id === 'string' && /^[0-9]{1,20}$/.test(id))
      ? { providerRef: String(id) }
      : {}),
  }
}

/** Classify an initialise refusal into a short, fixed code (safe to log); never the provider's own text. */
function classifyRefusal(message: unknown): string {
  const text = typeof message === 'string' ? message.toLowerCase() : ''
  if (text.includes('currency')) return 'currency-not-enabled'
  if (text.includes('duplicate') || text.includes('reference')) return 'reference-rejected'
  if (text.includes('amount')) return 'amount-rejected'
  if (text.includes('email')) return 'email-rejected'
  return 'refused'
}

export class PaystackProvider implements GivingProvider {
  readonly name = 'paystack' as const
  readonly mode: 'test' | 'live'
  readonly currencies = PAYSTACK_CURRENCIES
  private readonly secret: string
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(config: PaystackConfig, options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}) {
    this.secret = config.secret
    this.baseUrl = config.baseUrl
    this.mode = config.mode
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  minimumMinor(currency: DonationCurrency): number {
    return PAYSTACK_MINIMUMS[currency] ?? Number.POSITIVE_INFINITY
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      let res: Response
      try {
        res = await this.fetchImpl(this.baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.secret}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: controller.signal,
        })
      } catch {
        throw controller.signal.aborted
          ? new ProviderError('timeout', 'Paystack did not answer in time.')
          : new ProviderError('network', 'Paystack could not be reached.')
      }
      let buf: ArrayBuffer
      try {
        buf = await res.arrayBuffer()
      } catch {
        throw controller.signal.aborted
          ? new ProviderError('timeout', 'Paystack did not answer in time.', res.status)
          : new ProviderError('network', 'Paystack response could not be read.', res.status)
      }
      if (buf.byteLength > MAX_RESPONSE_BYTES) throw new ProviderError('bad-response', 'Paystack response too large.', res.status)
      let json: unknown = null
      try {
        json = buf.byteLength ? JSON.parse(Buffer.from(buf).toString('utf8')) : null
      } catch {
        json = null
      }
      return { status: res.status, json }
    } finally {
      clearTimeout(timer)
    }
  }

  private checkAuth(status: number): void {
    if (status === 401 || status === 403) throw new ProviderError('config', 'Paystack rejected the secret key.', status)
  }

  /** Hosted checkout must be Paystack's own page (or, for the local fake, the fake's own origin). */
  private validCheckoutUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 500) return null
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (url.username || url.password) return null
    if (this.baseUrl === PAYSTACK_API_BASE) return url.protocol === 'https:' && url.hostname === PAYSTACK_CHECKOUT_HOST ? url.href : null
    return url.origin === this.baseUrl ? url.href : null
  }

  async initialize(input: InitializeInput): Promise<{ checkoutUrl: string }> {
    const { status, json } = await this.call('POST', '/transaction/initialize', {
      email: input.email,
      amount: input.amountMinor,
      currency: input.currency,
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    })
    this.checkAuth(status)
    if (status !== 200 || !isObject(json) || json.status !== true || !isObject(json.data)) {
      throw new ProviderError('rejected', `Paystack refused to initialise (${classifyRefusal(isObject(json) ? json.message : '')}).`, status)
    }
    if (json.data.reference !== input.reference) throw new ProviderError('bad-response', 'Paystack answered for another reference.', status)
    const checkoutUrl = this.validCheckoutUrl(json.data.authorization_url)
    if (!checkoutUrl) throw new ProviderError('bad-response', 'Paystack returned an unexpected checkout URL.', status)
    return { checkoutUrl }
  }

  async verify(reference: string): Promise<VerifiedTransaction | null> {
    const { status, json } = await this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`)
    this.checkAuth(status)
    if (status === 404) return null
    if (status === 400 && isObject(json) && json.status === false && /not found/i.test(String(json.message ?? ''))) return null
    if (status !== 200 || !isObject(json) || json.status !== true) {
      throw new ProviderError(status >= 500 ? 'network' : 'rejected', 'Paystack verify failed.', status)
    }
    return normalisePaystackTransaction(json.data)
  }

  verifyWebhook(raw: Buffer, headers: { get(name: string): string | null }): boolean {
    return verifyHmacSha512(raw, headers.get('x-paystack-signature'), this.secret)
  }

  parseWebhook(raw: Buffer): WebhookEvent | null {
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return null
    }
    if (!isObject(body) || typeof body.event !== 'string' || !/^[a-z0-9_.]{1,80}$/i.test(body.event)) return null
    const data = isObject(body.data) ? body.data : {}
    const reference = typeof data.reference === 'string' && data.reference.length <= 100 ? data.reference : null
    return { event: body.event, reference }
  }

  async listTransactions(args: { from: Date; to: Date; page: number; perPage: number }): Promise<{ items: VerifiedTransaction[]; hasMore: boolean }> {
    const q = new URLSearchParams({
      perPage: String(args.perPage),
      per_page: String(args.perPage),
      page: String(args.page),
      from: args.from.toISOString(),
      to: args.to.toISOString(),
    })
    const { status, json } = await this.call('GET', `/transaction?${q.toString()}`)
    this.checkAuth(status)
    if (status !== 200 || !isObject(json) || json.status !== true || !Array.isArray(json.data)) {
      throw new ProviderError(status >= 500 ? 'network' : 'rejected', 'Paystack list failed.', status)
    }
    const items = json.data.map((t) => normalisePaystackTransaction(t))
    const meta = isObject(json.meta) ? json.meta : {}
    const page = Number(meta.page)
    const pageCount = Number(meta.pageCount)
    const hasMore = Number.isFinite(page) && Number.isFinite(pageCount) ? page < pageCount : items.length === args.perPage
    return { items, hasMore }
  }
}
