import type { Access, CollectionConfig, FieldAccess } from 'payload'

import { adminOnly, isAdmin, isEditorInChief, type UserLike } from '../access/roles'
import { auditDeleteHook } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'
import { donationsExportEndpoint } from '../endpoints/donationsExport'

const asUser = (u: unknown): UserLike | null => (u ? (u as UserLike) : null)

export const DONATION_PROVIDERS = ['paystack', 'flutterwave'] as const
export const DONATION_CURRENCIES = ['NGN', 'USD', 'GBP', 'EUR'] as const
export const DONATION_STATUSES = ['pending', 'succeeded', 'failed', 'abandoned'] as const
export const DONATION_CAUSES = ['general', 'relief', 'ministry'] as const
/** Largest amount a row may hold, in minor units (100 million naira in kobo). A sanity bound, not a giving limit. */
export const DONATION_AMOUNT_MINOR_MAX = 10_000_000_000

/** Admin and editor-in-chief see the ledger (no personal data for the editor-in-chief, see `adminField`). */
const ledgerRead: Access = ({ req }) => isEditorInChief(asUser(req.user))
const adminField: FieldAccess = ({ req }) => isAdmin(asUser(req.user))
const never: FieldAccess = () => false

/**
 * One row per giving attempt (Agent D's `POST /api/public/giving/init` creates it; the verified webhook updates it, both
 * through the Local API with overrideAccess). NO card data and NO provider payloads are stored. Nobody can create or edit
 * a row through the REST API or the admin: every money field is server-owned. Admin-only delete (retention, see
 * docs/w12/schema-contract.md). Never publicly readable.
 */
export const Donations: CollectionConfig = {
  slug: 'donations',
  admin: {
    useAsTitle: 'reference',
    defaultColumns: ['reference', 'status', 'amountMinor', 'currency', 'cause', 'createdAt'],
    group: 'Giving',
    description: 'Read-only ledger of giving attempts. Amounts are in minor units (kobo, pence, cents).',
    components: { beforeListTable: ['/components/DonationsExportLink#DonationsExportLink'] },
  },
  endpoints: [donationsExportEndpoint],
  access: {
    read: ledgerRead,
    create: () => false,
    update: () => false,
    delete: adminOnly,
  },
  hooks: {
    beforeOperation: [clampLimit],
    afterDelete: [auditDeleteHook('donations', (d) => (d.reference ? `reference ${d.reference}` : undefined))],
  },
  fields: [
    { name: 'reference', type: 'text', required: true, unique: true, index: true, maxLength: 64, access: { create: never, update: never } },
    { name: 'provider', type: 'select', required: true, options: DONATION_PROVIDERS.map((v) => ({ label: v, value: v })), access: { create: never, update: never } },
    {
      name: 'amountMinor',
      type: 'number',
      required: true,
      min: 1,
      max: DONATION_AMOUNT_MINOR_MAX,
      validate: (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= DONATION_AMOUNT_MINOR_MAX ? true : 'amountMinor must be a whole number of minor units.'),
      access: { create: never, update: never },
    },
    { name: 'currency', type: 'select', required: true, options: DONATION_CURRENCIES.map((v) => ({ label: v, value: v })), access: { create: never, update: never } },
    { name: 'status', type: 'select', required: true, defaultValue: 'pending', index: true, options: DONATION_STATUSES.map((v) => ({ label: v, value: v })), access: { create: never, update: never } },
    { name: 'channel', type: 'text', maxLength: 40, access: { create: never, update: never }, admin: { description: 'Payment channel reported by the provider (card, bank, ussd, ...).' } },
    { name: 'cause', type: 'select', required: true, defaultValue: 'general', options: DONATION_CAUSES.map((v) => ({ label: v, value: v })), access: { create: never, update: never } },
    { name: 'email', type: 'text', maxLength: 254, access: { read: adminField, create: never, update: never } },
    { name: 'name', type: 'text', maxLength: 120, access: { read: adminField, create: never, update: never } },
    { name: 'anonymous', type: 'checkbox', defaultValue: false, access: { create: never, update: never } },
    { name: 'consentAt', type: 'date', access: { create: never, update: never }, admin: { description: 'When the giver accepted the privacy notice (NDPA).' } },
    { name: 'receiptSentAt', type: 'date', access: { create: never, update: never } },
    { name: 'providerRef', type: 'text', maxLength: 120, index: true, access: { read: adminField, create: never, update: never } },
    { name: 'paidAt', type: 'date', access: { create: never, update: never } },
  ],
}
