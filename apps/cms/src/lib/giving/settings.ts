import { cleanText } from '../sanitize'
import { CURRENCY_INFO, DONATION_CURRENCIES, isDonationCurrency, isMinorAmount, type DonationCurrency } from './currency'
import { PaystackProvider, resolvePaystackConfig } from './paystack'
import type { GivingEnv, GivingProvider, ProviderName } from './provider'

/**
 * Giving is OFF unless BOTH the `giving-settings.enabled` switch is on AND a provider secret is configured
 * (`PAYSTACK_SECRET_KEY`). With no secret nothing in this module touches the network.
 *
 * Two gates, on purpose:
 * - `acceptingDonations`: the Give page, the "support us" ask and POST /giving/init. Needs enabled + secret + at least one
 *   usable currency.
 * - `provider` (secret configured): confirming donations that were ALREADY started (webhook, status, reconcile). Turning
 *   the switch off stops new donations but must not drop the confirmation of money a reader has already paid.
 */

export const DONATION_CAUSES = ['general', 'relief', 'ministry'] as const
export type DonationCause = (typeof DONATION_CAUSES)[number]
export const isDonationCause = (v: unknown): v is DonationCause =>
  typeof v === 'string' && (DONATION_CAUSES as readonly string[]).includes(v)

const DEFAULT_CAUSE_LABEL: Record<DonationCause, string> = {
  general: 'Where it is needed most',
  relief: 'Relief reporting',
  ministry: 'Ministry and church coverage',
}

export type CurrencyOption = {
  currency: DonationCurrency
  label: string
  /** Suggested amounts in minor units, ascending, each within [minimumMinor, maximumMinor]. */
  presets: number[]
  minimumMinor: number
  maximumMinor: number
}

export type EffectiveGivingSettings = {
  enabled: boolean
  currencies: CurrencyOption[]
  causes: { key: DonationCause; label: string }[]
  thankYouNote: string
  bankTransferNote: string
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A preset may be stored as a bare number or as a row such as `{ amount }` / `{ amountMinor }` / `{ value }`. */
function presetValue(p: unknown): number | null {
  if (isMinorAmount(p)) return p
  if (isObject(p)) for (const k of ['amountMinor', 'amount', 'value']) if (isMinorAmount(p[k])) return p[k] as number
  return null
}

/** Normalise the stored global against what the provider can actually charge. Unusable rows are dropped, never guessed. */
export function normaliseGivingSettings(raw: unknown, provider: Pick<GivingProvider, 'currencies' | 'minimumMinor'> | null): EffectiveGivingSettings {
  const doc = isObject(raw) ? raw : {}
  const seen = new Set<DonationCurrency>()
  const currencies: CurrencyOption[] = []
  for (const row of Array.isArray(doc.currencies) ? doc.currencies : []) {
    if (!isObject(row) || !isDonationCurrency(row.currency) || seen.has(row.currency)) continue
    const currency = row.currency
    if (!provider || !provider.currencies.includes(currency)) continue
    const floor = provider.minimumMinor(currency)
    const minimumMinor = Math.max(isMinorAmount(row.minimum) ? row.minimum : floor, floor)
    const maximumMinor = Math.min(isMinorAmount(row.maximum) ? row.maximum : CURRENCY_INFO[currency].hardMaxMinor, CURRENCY_INFO[currency].hardMaxMinor)
    if (!Number.isFinite(minimumMinor) || minimumMinor > maximumMinor) continue
    const presets = [...new Set((Array.isArray(row.presets) ? row.presets : []).map(presetValue))]
      .filter((n): n is number => n !== null && n >= minimumMinor && n <= maximumMinor)
      .sort((a, b) => a - b)
      .slice(0, 6)
    seen.add(currency)
    currencies.push({
      currency,
      label: cleanText(row.label, { max: 60 }) || CURRENCY_INFO[currency].name,
      presets,
      minimumMinor,
      maximumMinor,
    })
  }
  // Naira first, then the order the editors chose.
  currencies.sort((a, b) => (a.currency === 'NGN' ? -1 : b.currency === 'NGN' ? 1 : 0))

  const causes: { key: DonationCause; label: string }[] = []
  for (const row of Array.isArray(doc.causes) ? doc.causes : []) {
    if (!isObject(row) || !isDonationCause(row.key) || row.enabled === false || causes.some((c) => c.key === row.key)) continue
    causes.push({ key: row.key, label: cleanText(row.label, { max: 80 }) || DEFAULT_CAUSE_LABEL[row.key] })
  }
  if (causes.length === 0) causes.push({ key: 'general', label: DEFAULT_CAUSE_LABEL.general })

  return {
    enabled: doc.enabled === true,
    currencies,
    causes,
    thankYouNote: cleanText(doc.thankYouNote, { max: 1000, multiline: true }),
    bankTransferNote: cleanText(doc.bankTransferNote, { max: 1000, multiline: true }),
  }
}

export type ProviderResolution = { provider: GivingProvider } | { provider: null; reason: string }

/**
 * Which provider (if any) is configured. `GIVING_PROVIDER` (env) and `giving-settings.provider` must agree when both are
 * set; only Paystack is implemented. A missing secret is the normal "off" state, not an error.
 */
export function resolveGivingProvider(settingsProvider: unknown, env: GivingEnv = process.env): ProviderResolution {
  const fromEnv = env.GIVING_PROVIDER?.trim().toLowerCase() || ''
  const fromSettings = typeof settingsProvider === 'string' ? settingsProvider.trim().toLowerCase() : ''
  if (fromEnv && fromSettings && fromEnv !== fromSettings) return { provider: null, reason: 'GIVING_PROVIDER and giving-settings.provider disagree.' }
  const name = (fromEnv || fromSettings || 'paystack') as ProviderName | string
  if (name !== 'paystack') return { provider: null, reason: `Giving provider "${name === 'flutterwave' ? 'flutterwave' : 'unknown'}" is not implemented.` }
  const config = resolvePaystackConfig(env)
  if (config === null) return { provider: null, reason: 'PAYSTACK_SECRET_KEY is not set.' }
  if ('error' in config) return { provider: null, reason: config.error }
  return { provider: new PaystackProvider(config) }
}

/** The public-safe projection served by GET /api/public/giving/settings. Nothing here is secret or personal. */
export function publicGivingSettings(settings: EffectiveGivingSettings | null, provider: GivingProvider | null) {
  if (!settings || !provider || !settings.enabled || settings.currencies.length === 0) return { enabled: false as const }
  return {
    enabled: true as const,
    provider: provider.name,
    testMode: provider.mode === 'test',
    currencies: settings.currencies,
    causes: settings.causes,
    thankYouNote: settings.thankYouNote,
    bankTransferNote: settings.bankTransferNote,
  }
}

export { DONATION_CURRENCIES }
