/**
 * Offline test kit for giving: an in-memory DonationStore with the same conditional-update semantics as the SQL one
 * (a transition or receipt claim succeeds for exactly one caller), a capturing logger (so tests can assert nothing
 * personal or secret is logged) and a capturing mailer.
 */
import type { DonationRow, DonationStatus, DonationStore, NewDonation, TransitionFields } from '../../src/lib/giving/store'
import type { GivingDeps, LoggerLike, Mailer } from '../../src/lib/giving/service'
import { normaliseGivingSettings } from '../../src/lib/giving/settings'
import { PaystackProvider } from '../../src/lib/giving/paystack'

/** Obviously fake test keys, assembled at runtime so no key-shaped literal sits in the source (secret scanners). */
export const fakeKey = (body: string, mode: 'test' | 'live' = 'test') => ['sk', mode, body].join('_')
export const TEST_SECRET = fakeKey('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')

export class MemoryDonationStore implements DonationStore {
  rows = new Map<string, DonationRow>()
  private nextId = 1
  failCreate = false

  async create(data: NewDonation): Promise<DonationRow> {
    if (this.failCreate) throw new Error('db down')
    if (this.rows.has(data.reference)) throw new Error('duplicate reference')
    const row: DonationRow = {
      id: this.nextId++,
      ...data,
      status: 'pending',
      channel: null,
      receiptSentAt: null,
      providerRef: null,
      paidAt: null,
      createdAt: new Date().toISOString(),
    }
    this.rows.set(row.reference, row)
    return { ...row }
  }
  async findByReference(reference: string) {
    const row = this.rows.get(reference)
    return row ? { ...row } : null
  }
  async transition(reference: string, from: DonationStatus[], to: DonationStatus, fields: TransitionFields = {}) {
    // Yield first so concurrent callers interleave like separate requests would.
    await new Promise((r) => setImmediate(r))
    const row = this.rows.get(reference)
    if (!row || !from.includes(row.status)) return false
    row.status = to
    if (fields.paidAt) row.paidAt = fields.paidAt
    if (fields.channel) row.channel = fields.channel
    if (fields.providerRef) row.providerRef = fields.providerRef
    return true
  }
  async claimReceipt(reference: string) {
    await new Promise((r) => setImmediate(r))
    const row = this.rows.get(reference)
    if (!row || row.receiptSentAt || row.status !== 'succeeded') return false
    row.receiptSentAt = new Date().toISOString()
    return true
  }
  async releaseReceipt(reference: string) {
    const row = this.rows.get(reference)
    if (row) row.receiptSentAt = null
  }
  async listCreatedBetween(from: Date, to: Date) {
    return [...this.rows.values()].filter((r) => {
      const t = Date.parse(r.createdAt)
      return t >= from.getTime() && t <= to.getTime()
    })
  }
  /** Make a row look older (expiry tests). */
  age(reference: string, ms: number) {
    const row = this.rows.get(reference)!
    row.createdAt = new Date(Date.parse(row.createdAt) - ms).toISOString()
  }
}

export type LogEntry = { level: string; obj: unknown; msg?: string }
export function captureLogger(): LoggerLike & { entries: LogEntry[]; text: () => string } {
  const entries: LogEntry[] = []
  const at = (level: string) => (obj: unknown, msg?: string) => void entries.push({ level, obj, msg })
  return { entries, info: at('info'), warn: at('warn'), error: at('error'), text: () => JSON.stringify(entries) }
}

export function captureMailer(configured = true): Mailer & { sent: { to: string; subject: string; text: string }[]; failNext: number } {
  const m = {
    configured,
    sent: [] as { to: string; subject: string; text: string }[],
    failNext: 0,
    async send(to: string, subject: string, text: string) {
      if (m.failNext > 0) {
        m.failNext--
        throw Object.assign(new Error('smtp said no to someone@example.test'), { code: 'ECONNREFUSED' })
      }
      m.sent.push({ to, subject, text })
    },
  }
  return m
}

export const RAW_SETTINGS = {
  enabled: true,
  provider: 'paystack',
  currencies: [
    { currency: 'USD', presets: [{ amount: 1000 }, { amount: 2500 }], minimum: 500, maximum: 100_000, label: 'US dollars' },
    { currency: 'NGN', presets: [{ amount: 200_000 }, { amount: 500_000 }, { amount: 1_000_000 }], minimum: 100_000, maximum: 100_000_000, label: 'Naira' },
    { currency: 'GBP', presets: [{ amount: 1000 }], minimum: 300, maximum: 100_000, label: 'Pounds' },
  ],
  causes: [
    { key: 'general', label: 'Where it is needed most', enabled: true },
    { key: 'relief', label: 'Relief reporting', enabled: true },
    { key: 'ministry', label: 'Ministry coverage', enabled: false },
  ],
  thankYouNote: 'Thank you for keeping our reporting free to read.',
  bankTransferNote: 'Prefer a bank transfer? Choose "Bank transfer" or "USSD" on the Paystack page.',
}

export function makeDeps(origin: string, over: Partial<GivingDeps> = {}) {
  const provider = new PaystackProvider({ secret: TEST_SECRET, baseUrl: origin, mode: 'test' }, { timeoutMs: 2000 })
  const store = new MemoryDonationStore()
  const logger = captureLogger()
  const mailer = captureMailer()
  const deps: GivingDeps = {
    store,
    provider,
    logger,
    mailer,
    returnUrl: 'http://localhost:5373/give/thanks/',
    settings: normaliseGivingSettings(RAW_SETTINGS, provider),
    ...over,
  }
  return { deps, store, provider, logger, mailer }
}
