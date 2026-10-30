import type { GlobalConfig } from 'payload'

import { isAdmin, isEditorInChief, type UserLike } from '../access/roles'
import { DONATION_AMOUNT_MINOR_MAX, DONATION_CAUSES, DONATION_CURRENCIES, DONATION_PROVIDERS } from '../collections/Donations'
import { plainTextValidator } from '../lib/newsroomFields'

const asUser = (u: unknown): UserLike | null => (u ? (u as UserLike) : null)

export const GIVING_PRESETS_MAX = 6
export const GIVING_NOTE_MAX = 1000
export const GIVING_LABEL_MAX = 60

type CurrencyRow = { currency?: unknown; presets?: unknown; minimum?: unknown; maximum?: unknown }
type CauseRow = { key?: unknown }

const minorInt = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= DONATION_AMOUNT_MINOR_MAX

/** Each currency once; minimum <= maximum; every preset inside [minimum, maximum]. Returns a message or null. */
export function currenciesProblem(rows: unknown): string | null {
  if (rows === undefined || rows === null) return null
  if (!Array.isArray(rows)) return 'Currencies must be a list.'
  const seen = new Set<unknown>()
  for (const r of rows as CurrencyRow[]) {
    if (seen.has(r?.currency)) return `Currency ${String(r?.currency)} is listed twice.`
    seen.add(r?.currency)
    if (!minorInt(r?.minimum) || !minorInt(r?.maximum)) return 'Minimum and maximum must be whole numbers of minor units (kobo, pence, cents).'
    if ((r.minimum as number) > (r.maximum as number)) return `The minimum for ${String(r.currency)} is above its maximum.`
    const presets = Array.isArray(r.presets) ? r.presets : []
    if (presets.length > GIVING_PRESETS_MAX) return `At most ${GIVING_PRESETS_MAX} preset amounts per currency.`
    for (const p of presets) {
      if (!minorInt(p) || (p as number) < (r.minimum as number) || (p as number) > (r.maximum as number)) {
        return `Preset amounts for ${String(r.currency)} must be whole minor units between the minimum and the maximum.`
      }
    }
  }
  return null
}

export function causesProblem(rows: unknown): string | null {
  if (rows === undefined || rows === null) return null
  if (!Array.isArray(rows)) return 'Causes must be a list.'
  const keys = (rows as CauseRow[]).map((r) => r?.key)
  return new Set(keys).size === keys.length ? null : 'Each cause may be listed once.'
}

/**
 * Giving configuration (Agent D's flow reads it server-side; `GET /api/public/giving/settings` exposes only public-safe
 * fields). Off by default. Read: admin and editor-in-chief; write: admin only (money settings). No secrets here: the
 * provider keys live in the environment (`PAYSTACK_SECRET_KEY`).
 */
export const GivingSettings: GlobalConfig = {
  slug: 'giving-settings',
  label: 'Giving settings',
  admin: { group: 'Giving' },
  access: {
    read: ({ req }) => isEditorInChief(asUser(req.user)),
    update: ({ req }) => isAdmin(asUser(req.user)),
  },
  fields: [
    { name: 'enabled', type: 'checkbox', defaultValue: false, admin: { description: 'Show the Give page and the "Support our journalism" ask. Also needs the provider keys in the server environment.' } },
    { name: 'provider', type: 'select', defaultValue: 'paystack', options: DONATION_PROVIDERS.map((v) => ({ label: v, value: v })) },
    {
      name: 'currencies',
      type: 'array',
      maxRows: DONATION_CURRENCIES.length,
      validate: (v: unknown) => currenciesProblem(v) ?? true,
      admin: { description: 'Amounts are minor units: 500000 kobo = N5,000.' },
      fields: [
        { name: 'currency', type: 'select', required: true, options: DONATION_CURRENCIES.map((v) => ({ label: v, value: v })) },
        { name: 'presets', type: 'number', hasMany: true, maxRows: GIVING_PRESETS_MAX, min: 1, max: DONATION_AMOUNT_MINOR_MAX },
        { name: 'minimum', type: 'number', required: true, min: 1, max: DONATION_AMOUNT_MINOR_MAX },
        { name: 'maximum', type: 'number', required: true, min: 1, max: DONATION_AMOUNT_MINOR_MAX },
        { name: 'label', type: 'text', maxLength: GIVING_LABEL_MAX, validate: plainTextValidator('Label', GIVING_LABEL_MAX) },
      ],
    },
    {
      name: 'causes',
      type: 'array',
      maxRows: DONATION_CAUSES.length,
      validate: (v: unknown) => causesProblem(v) ?? true,
      fields: [
        { name: 'key', type: 'select', required: true, options: DONATION_CAUSES.map((v) => ({ label: v, value: v })) },
        { name: 'label', type: 'text', required: true, maxLength: GIVING_LABEL_MAX, validate: plainTextValidator('Label', GIVING_LABEL_MAX, { required: true }) },
        { name: 'enabled', type: 'checkbox', defaultValue: true },
      ],
    },
    { name: 'thankYouNote', type: 'textarea', maxLength: GIVING_NOTE_MAX, validate: plainTextValidator('Thank-you note', GIVING_NOTE_MAX, { multiline: true }) },
    { name: 'bankTransferNote', type: 'textarea', maxLength: GIVING_NOTE_MAX, validate: plainTextValidator('Bank transfer note', GIVING_NOTE_MAX, { multiline: true }) },
  ],
}
