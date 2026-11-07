import { Forbidden } from 'payload'
import type { CollectionAfterChangeHook, CollectionBeforeChangeHook, CollectionConfig } from 'payload'

import { adminOnly } from '../access/roles'
import { writeAuditLog } from '../lib/audit'
import { exportSubscribersEndpoint, eraseSubscriberEndpoint, subjectExportEndpoint } from '../endpoints/subscriberStaff'
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
 * Staff status changes (REST, admin UI): audited, and a move to `unsubscribed` or `bounced` stamps `unsubscribedAt` (unsubscribed)
 * and invalidates any pending confirmation token, so an old link cannot bring the person back. Done in afterChange with a
 * system write because token and timestamp fields are not client-writable.
 */
const auditStaffStatusChange: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  if (req.context?.subscriberSystemWrite || operation !== 'update' || !previousDoc) return doc
  const from = previousDoc.status as string
  const to = doc.status as string
  if (from === to) return doc
  if (to === 'unsubscribed' || to === 'bounced') {
    await req.payload.update({
      collection: 'subscribers',
      id: doc.id,
      data: {
        ...(to === 'unsubscribed' ? { unsubscribedAt: new Date().toISOString() } : {}),
        confirmTokenHash: null,
        confirmTokenExpiresAt: null,
      } as never,
      overrideAccess: true,
      context: { subscriberSystemWrite: true },
      req,
    })
  }
  await writeAuditLog(req, {
    action: 'subscriber.status-change',
    collection: 'subscribers',
    docId: doc.id,
    fromStatus: from,
    toStatus: to,
    summary: `Staff changed subscriber ${doc.id} from ${from} to ${to}`,
  })
  return doc
}

/**
 * Newsletter subscribers (go-live contract C4.3). Staff-only: `admin` only (read and update; the editor-in-chief cannot read personal data); nobody anonymous,
 * never in a public response. Nothing is created or deleted over REST: sign-ups arrive through
 * POST /api/public/newsletter/subscribe (double opt-in) or the Mailchimp import CLI, and "delete" is the audited
 * erase action (POST /api/subscribers/:id/erase, admin only) that keeps a suppression record without the address.
 */
export const Subscribers: CollectionConfig = {
  slug: 'subscribers',
  admin: {
    useAsTitle: 'email',
    defaultColumns: ['email', 'status', 'source', 'consentAt', 'confirmedAt'],
    description: 'Newsletter subscribers (admin only). Export: GET /api/subscribers/export?status=confirmed. Per-person data export: GET /api/subscribers/:id/subject-data.',
  },
  endpoints: [exportSubscribersEndpoint, eraseSubscriberEndpoint, subjectExportEndpoint],
  hooks: { beforeOperation: [clampLimit], beforeChange: [guardStatusChange], afterChange: [auditStaffStatusChange] },
  access: {
    read: adminOnly,
    create: () => false,
    update: adminOnly,
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
    {
      // Null for a Mailchimp import row that carried no OPTIN_TIME (importedFrom says so): the import time is NOT consent time.
      name: 'consentAt',
      type: 'date',
      admin: { readOnly: true },
      access: noClientWrite,
    },
    { name: 'confirmedAt', type: 'date', admin: { readOnly: true }, access: noClientWrite },
    { name: 'unsubscribedAt', type: 'date', admin: { readOnly: true }, access: noClientWrite },
    { name: 'ipHash', type: 'text', admin: { readOnly: true }, access: noClientWrite },
    {
      name: 'importedFrom',
      type: 'select',
      options: ['web', 'mailchimp-import', 'mailchimp-import-no-optin-time'].map((v) => ({ label: v, value: v })),
      admin: { readOnly: true },
      access: noClientWrite,
    },
    // SHA-256 of the one-time confirmation token. The token itself is never stored. Invisible over REST and in the UI.
    { name: 'confirmTokenHash', type: 'text', index: true, admin: { hidden: true }, access: internalOnly },
    { name: 'confirmTokenExpiresAt', type: 'date', admin: { hidden: true }, access: internalOnly },
    // Anti mail-bombing bookkeeping for confirmation e-mails (resend cooldown and daily cap). Internal only.
    { name: 'lastConfirmMailAt', type: 'date', admin: { hidden: true }, access: internalOnly },
    { name: 'confirmMailsDayStart', type: 'date', admin: { hidden: true }, access: internalOnly },
    { name: 'confirmMailsInDay', type: 'number', admin: { hidden: true }, access: internalOnly },
  ],
}
