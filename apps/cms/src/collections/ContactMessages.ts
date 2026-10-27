import type { CollectionConfig } from 'payload'

import { editorInChiefOnly } from '../access/roles'
import { auditDeleteHook } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'

// Server-owned: only the public endpoint (overrideAccess) writes these.
const noClientWrite = { create: () => false, update: () => false }

/**
 * Staff-only inbox for POST /api/public/contact (go-live contract C5), separate from story submissions so
 * the editorial review queue stays editorial. admin and editor-in-chief only; never readable anonymously.
 * Only `status` can be changed over REST (triage). Rows cannot be created over REST.
 */
export const ContactMessages: CollectionConfig = {
  slug: 'contact-messages',
  admin: {
    useAsTitle: 'reference',
    defaultColumns: ['reference', 'topic', 'name', 'status', 'notifyStatus', 'createdAt'],
    description: 'Messages sent through the public contact form. Reply by email; mark the status as you go.',
  },
  hooks: { beforeOperation: [clampLimit], afterDelete: [auditDeleteHook('contact-messages', (d) => (d.reference ? String(d.reference) : undefined))] },
  access: {
    read: editorInChiefOnly,
    create: () => false,
    update: editorInChiefOnly,
    delete: editorInChiefOnly,
  },
  fields: [
    { name: 'reference', type: 'text', required: true, unique: true, index: true, admin: { readOnly: true }, access: noClientWrite },
    { name: 'name', type: 'text', required: true, maxLength: 120, admin: { readOnly: true }, access: noClientWrite },
    { name: 'email', type: 'email', required: true, index: true, admin: { readOnly: true }, access: noClientWrite },
    {
      name: 'topic',
      type: 'select',
      required: true,
      index: true,
      options: ['general', 'advertising', 'corrections', 'tips', 'other'].map((v) => ({ label: v, value: v })),
      admin: { readOnly: true },
      access: noClientWrite,
    },
    { name: 'message', type: 'textarea', required: true, maxLength: 5000, admin: { readOnly: true }, access: noClientWrite },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'new',
      index: true,
      options: ['new', 'read', 'replied', 'spam'].map((v) => ({ label: v, value: v })),
    },
    {
      // Whether the staff notification email left the server. A failure never loses the message; it is shown here.
      name: 'notifyStatus',
      type: 'select',
      options: ['sent', 'failed', 'not-configured'].map((v) => ({ label: v, value: v })),
      admin: { readOnly: true, description: 'Did the notification email go out? "failed" or "not-configured": check the inbox here.' },
      access: noClientWrite,
    },
    { name: 'ipHash', type: 'text', admin: { readOnly: true }, access: noClientWrite },
    { name: 'userAgent', type: 'text', maxLength: 300, admin: { readOnly: true }, access: noClientWrite },
    { name: 'contentHash', type: 'text', index: true, admin: { readOnly: true }, access: noClientWrite },
  ],
}
