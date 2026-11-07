import { APIError } from 'payload'
import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
} from 'payload'

import { editorInChiefOnly } from '../access/roles'
import { writeAuditLog } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'
import { cleanText } from '../lib/sanitize'

/**
 * Advertisers (go-live contract C3.1). Staff-only: `admin` and `editor-in-chief` read and write, nobody else, never
 * anonymous. Holds who the advertiser is and how to reach them; no payment-card or bank details are stored here.
 * Nothing from this collection is ever returned by a public endpoint.
 */

const TEXT_FIELDS = ['name', 'contactName', 'notes'] as const

const normalise: CollectionBeforeValidateHook = ({ data }) => {
  if (!data) return data
  for (const k of TEXT_FIELDS) {
    if (typeof data[k] === 'string') data[k] = cleanText(data[k], { multiline: k === 'notes' }) || (k === 'name' ? '' : null)
  }
  if (typeof data.contactEmail === 'string') data.contactEmail = data.contactEmail.trim() || null
  return data
}

// Audit entries carry the advertiser's name only (which row), never contact details or notes.
const auditChange: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  const prev = (previousDoc ?? {}) as Record<string, unknown>
  const changed = ['name', 'contactName', 'contactEmail', 'notes'].filter(
    (k) => (prev[k] ?? null) !== ((doc as Record<string, unknown>)[k] ?? null),
  )
  if (operation === 'update' && changed.length === 0) return doc
  await writeAuditLog(req, {
    action: operation === 'create' ? 'advertiser.create' : 'advertiser.update',
    collection: 'advertisers',
    docId: doc.id,
    summary: String(doc.name ?? ''),
    details: operation === 'update' ? { fields: changed } : null,
  })
  return doc
}

const refuseWhenInUse: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const used = await req.payload.count({
    collection: 'ad-campaigns',
    where: { advertiser: { equals: id } },
    overrideAccess: true,
    req,
  })
  if (used.totalDocs > 0) {
    throw new APIError('This advertiser still has campaigns. Delete or reassign them first.', 409)
  }
}

const auditDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
  await writeAuditLog(req, {
    action: 'advertiser.delete',
    collection: 'advertisers',
    docId: doc.id,
    summary: String(doc.name ?? ''),
  })
  return doc
}

export const Advertisers: CollectionConfig = {
  slug: 'advertisers',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'contactName', 'contactEmail', 'updatedAt'],
    description: 'Who is advertising. Admin and editor-in-chief only. Never shown publicly. Do not store card or bank details.',
  },
  timestamps: true,
  access: {
    read: editorInChiefOnly,
    create: editorInChiefOnly,
    update: editorInChiefOnly,
    delete: editorInChiefOnly,
  },
  hooks: {
    beforeOperation: [clampLimit],
    beforeValidate: [normalise],
    afterChange: [auditChange],
    beforeDelete: [refuseWhenInUse],
    afterDelete: [auditDelete],
  },
  fields: [
    { name: 'name', type: 'text', required: true, maxLength: 200 },
    { name: 'contactName', type: 'text', maxLength: 200 },
    { name: 'contactEmail', type: 'email' },
    { name: 'notes', type: 'textarea', maxLength: 4000 },
  ],
}
