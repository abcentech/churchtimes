/**
 * Money for giving. Every amount is an INTEGER in the currency's minor unit (kobo, cents, pence). There is no float
 * anywhere on the money path: the public form converts the typed amount with string arithmetic, the API accepts only safe
 * integers, and the provider is sent the same integer.
 */

/** The `donations.currency` select (schema contract, section 4 of docs/w12-plan.md). */
export const DONATION_CURRENCIES = ['NGN', 'USD', 'GBP', 'EUR'] as const
export type DonationCurrency = (typeof DONATION_CURRENCIES)[number]

export const isDonationCurrency = (value: unknown): value is DonationCurrency =>
  typeof value === 'string' && (DONATION_CURRENCIES as readonly string[]).includes(value)

type CurrencyInfo = {
  /** Minor units per major unit is always 100 for these four. */
  minorPerMajor: 100
  /** Absolute ceiling for ONE donation, whatever the CMS setting says (guards against a typo such as an extra zero). */
  hardMaxMinor: number
  name: string
}

export const CURRENCY_INFO: Record<DonationCurrency, CurrencyInfo> = {
  NGN: { minorPerMajor: 100, hardMaxMinor: 5_000_000_000, name: 'Nigerian naira' }, // NGN 50,000,000.00
  USD: { minorPerMajor: 100, hardMaxMinor: 10_000_000, name: 'US dollar' }, // USD 100,000.00
  GBP: { minorPerMajor: 100, hardMaxMinor: 10_000_000, name: 'Pound sterling' },
  EUR: { minorPerMajor: 100, hardMaxMinor: 10_000_000, name: 'Euro' },
}

/** A positive safe integer, i.e. a valid amount in minor units. */
export const isMinorAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** `NGN 5,000.00` (integer arithmetic only). */
export function formatMinor(amountMinor: number, currency: DonationCurrency): string {
  const major = Math.floor(amountMinor / 100)
  const minor = String(amountMinor % 100).padStart(2, '0')
  return `${currency} ${major.toLocaleString('en-GB')}.${minor}`
}
