import { exceedsMax, cleanText, isValidEmail } from '../sanitize'
import type { FieldError } from '../publicEndpoint'
import { isDonationCurrency, isMinorAmount, type DonationCurrency } from './currency'
import type { DonationCause, EffectiveGivingSettings } from './settings'

/**
 * Validation of POST /api/public/giving/init. The browser sends ONLY what the reader chose; everything else (reference,
 * status, provider, consent time) is decided here. Amounts are integers in minor units, checked against the CMS setting
 * for that currency, which is itself clamped to the provider's minimum and our hard ceiling.
 */

export const GIVING_INIT_MAX_BODY_BYTES = 4 * 1024
export const GIVING_TURNSTILE_ACTION = 'giving-init'
/** Bumped whenever the consent wording on the Give page changes (recorded in docs/w12/giving.md). */
export const GIVING_CONSENT_VERSION = 'giving-v1'

export type ValidGivingInit = {
  amountMinor: number
  currency: DonationCurrency
  cause: DonationCause
  email: string
  /** Null when the reader chose to give anonymously or gave no name. */
  name: string | null
  anonymous: boolean
}

const ALLOWED_KEYS = new Set(['amountMinor', 'currency', 'cause', 'email', 'name', 'anonymous', 'consent', 'turnstileToken', 'cf-turnstile-response', 'website'])

export function validateGivingInit(
  input: unknown,
  settings: EffectiveGivingSettings,
): { ok: true; data: ValidGivingInit; honeypot: boolean } | { ok: false; errors: FieldError[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: [{ message: 'Request body must be a JSON object.' }] }
  const body = input as Record<string, unknown>
  const errors: FieldError[] = []

  // Unknown keys are refused rather than ignored, so a client cannot believe it set `status`, `reference` or similar.
  const unknown = Object.keys(body).filter((k) => !ALLOWED_KEYS.has(k))
  if (unknown.length > 0) errors.push({ message: 'Unexpected fields in request.' })

  const option = isDonationCurrency(body.currency) ? settings.currencies.find((c) => c.currency === body.currency) : undefined
  if (!option) errors.push({ field: 'currency', message: 'Choose a currency we accept.' })

  if (!isMinorAmount(body.amountMinor)) {
    errors.push({ field: 'amountMinor', message: 'Enter a whole amount greater than zero.' })
  } else if (option && (body.amountMinor < option.minimumMinor || body.amountMinor > option.maximumMinor)) {
    errors.push({ field: 'amountMinor', message: 'The amount is outside the accepted range for this currency.' })
  }

  const causeKey = body.cause === undefined || body.cause === null || body.cause === '' ? settings.causes[0]?.key : body.cause
  const cause = settings.causes.find((c) => c.key === causeKey)
  if (!cause) errors.push({ field: 'cause', message: 'Choose one of the listed causes.' })

  const email = typeof body.email === 'string' ? body.email.trim() : ''
  if (!isValidEmail(email)) errors.push({ field: 'email', message: 'Enter a valid email address. It is needed for the payment receipt.' })

  if (body.anonymous !== undefined && typeof body.anonymous !== 'boolean') errors.push({ field: 'anonymous', message: 'Invalid choice.' })
  const anonymous = body.anonymous === true

  if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') errors.push({ field: 'name', message: 'Invalid name.' })
  else if (exceedsMax(body.name ?? '', 100)) errors.push({ field: 'name', message: 'Use at most 100 characters for your name.' })
  const name = anonymous ? null : cleanText(body.name, { max: 100 }) || null

  // NDPA: an explicit, affirmative choice. Only the boolean true counts.
  if (body.consent !== true) errors.push({ field: 'consent', message: 'Please agree to how we use your details before continuing.' })

  const hp = body.website
  const honeypot = !(hp === undefined || hp === null || (typeof hp === 'string' && hp.trim() === ''))

  if (errors.length > 0 || !option || !cause) return { ok: false, errors }
  return {
    ok: true,
    honeypot,
    data: { amountMinor: body.amountMinor as number, currency: option.currency, cause: cause.key, email: email.toLowerCase(), name, anonymous },
  }
}
