import { Forbidden } from 'payload'
import type { CollectionBeforeChangeHook, CollectionConfig } from 'payload'

import { editorInChiefOnly } from '../access/roles'
import { exportSubscribersEndpoint, eraseSubscriberEndpoint } from '../endpoints/subscriberStaff'
import { clampLimit } from '../lib/clampLimit'
import { SUBSCRIBER_STATUSES } from '../lib/newsletter'
import { isValidEmail } from '../lib/sanitize'

// Server-owned: only the public endpoints, the importer and the staff endpoints (overrideAccess) write these.
const noClientWrite = { create: () => false, update: () => false }
// Never readable by anyone over REST or in the admin UI (internal use only, through the local API).
const internalOnly = { read: () => false, create: () => false, update: () => false }

/**
 * Staff changing a status over REST may only move a subscriber OUT of the list (unsubscribed, bounced). Confirming
 * or re-activating a subscriber is possible only through the double opt-in links, so consent cannot be faked
 * from the admin UI. Internal writers set `context.subscriberSystemWrite`.
 */
const guardStatusChange: CollectionBeforeChangeHook = ({ data, originalDoc, operation, req }) => {
  if (req.context?.subscriberSystemWrite) return data
  if (operation === 'update' && originalDoc) {
    const from = originalDoc.status as string
    const to = data.status as string | undefined
    if (from === 'erased') throw new Forbidden(req.t)
    if (to !== undefined && to !== from && to !== 'unsubscribed' && to !== 'bounced') throw new Forbidden(req.t)
  }
  return data
}

/**
 * Newsletter subscribers (go-live contract C4.3). Staff-only: `admin` and `editor-in-chief` read; nobody anonymous,
 * never in a public response. Nothing is created or deleted over REST: sign-ups arrive through
 * POST /api/public/newsletter/subscribe (double opt-in) or the Mailchimp import CLI, and "delete" is the audited
 * erase action (POST /api/subscribers/:id/erase, admin only) that keeps a suppression record without the address.
 */
export const Subscribers: CollectionConfig = {
  slug: 'subscribers',
  admin: {
    useAsTitle: 'email',
    defaultColumns: ['email', 'status', 'source', 'consentAt', 'confirmedAt'],
    description: 'Newsletter subscribers. Export (admin only): GET /api/subscribers/export?status=confirmed.',
  },
  endpoints: [exportSubscribersEndpoint, eraseSubscriberEndpoint],
  hooks: { beforeOperation: [clampLimit], beforeChange: [guardStatusChange] },
  access: {
    read: editorInChiefOnly,
    create: () => false,
    update: editorInChiefOnly,
    delete: () => false,
  },
  fields: [
    {
      // Lower-cased. After erasure it holds `erased:<hmac>` instead of an address (see lib/newsletter.ts).
      name: 'email',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      maxLength: 254,
      hooks: { beforeValidate: [({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)] },
      validate: (value: unknown, { siblingData }: { siblingData: Record<string, unknown> }) =>
        siblingData?.status === 'erased' || (typeof value === 'string' && isValidEmail(value))
          ? true
          : 'Enter a valid email address.',
      admin: { readOnly: true },
      access: noClientWrite,
    },
    { name: 'name', type: 'text', maxLength: 120, admin: { readOnly: true }, access: noClientWrite },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      options: SUBSCRIBER_STATUSES.map((v) => ({ label: v, value: v })),
      admin: { description: 'Staff may only move a subscriber to unsubscribed or bounced. Confirmation happens through the e-mailed link.' },
    },
    {
      name: 'source',
      type: 'select',
      required: true,
      options: ['footer', 'article', 'home', 'other'].map((v) => ({ label: v, value: v })),
      admin: { readOnly: true },
      access: noClientWrite,
    },
    {
      name: 'consentTextVersion',
      type: 'text',
      required: true,
      maxLength: 80,
      admin: { readOnly: true, description: 'Version of the consent wording shown when the person signed up.' },
      access: noClientWrite,
    },
    { name: 'consentAt', type: 'date', required: true, admin: { readOnly: true }, access: noClientWrite },
    { name: 'confirmedAt', type: 'date', admin: { readOnly: true }, access: noClientWrite },
    { name: 'unsubscribedAt', type: 'date', admin: { readOnly: true }, access: noClientWrite },
    { name: 'ipHash', type: 'text', admin: { readOnly: true }, access: noClientWrite },
    {
      name: 'importedFrom',
      type: 'select',
      options: ['web', 'mailchimp-import'].map((v) => ({ label: v, value: v })),
      admin: { readOnly: true },
      access: noClientWrite,
    },
    // SHA-256 of the one-time confirmation token. The token itself is never stored. Invisible over REST and in the UI.
    { name: 'confirmTokenHash', type: 'text', index: true, admin: { hidden: true }, access: internalOnly },
    { name: 'confirmTokenExpiresAt', type: 'date', admin: { hidden: true }, access: internalOnly },
  ],
}
