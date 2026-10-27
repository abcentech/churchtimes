import type { Access, CollectionConfig } from 'payload'

import { isEditorInChief, isEditorRole, type UserLike } from '../access/roles'
import { convertSubmissionEndpoint } from '../endpoints/convertSubmission'
import { auditDeleteHook, writeAuditLog } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'

const editorsOnly: Access = ({ req }) => isEditorRole(req.user as UserLike | null)

const noClientWrite = { create: () => false, update: () => false }

/**
 * Staff-only inbox. Public creation happens only through POST /api/public/submissions
 * (overrideAccess), so `create` is closed for the REST API. MVP: every editor role (including
 * section-editors) can read and triage all submissions,
 * including e-mail and phone: the review queue shows them and verifying a tip needs them. Restricting contact details to
 * editor-in-chief/admin is a documented product decision (api-contracts.md v1.15), not changed here.
 */
export const Submissions: CollectionConfig = {
  slug: 'submissions',
  admin: { useAsTitle: 'title', defaultColumns: ['reference', 'title', 'status', 'createdAt'] },
  endpoints: [convertSubmissionEndpoint],
  access: {
    read: editorsOnly,
    create: () => false,
    update: editorsOnly,
    delete: ({ req }) => isEditorInChief(req.user as UserLike | null),
  },
  hooks: {
    beforeOperation: [clampLimit],
    afterDelete: [auditDeleteHook('submissions', (d) => (d.reference ? `${d.reference}, status ${d.status}` : undefined))],
    afterChange: [
      async ({ doc, previousDoc, operation, req }) => {
        if (operation === 'update' && previousDoc?.status !== doc.status) {
          await writeAuditLog(req, {
            action: 'submission.status',
            collection: 'submissions',
            docId: doc.id,
            fromStatus: previousDoc?.status,
            toStatus: doc.status,
            summary: `Submission ${doc.reference} moved to ${doc.status}`,
          })
        }
        return doc
      },
    ],
  },
  fields: [
    {
      name: 'reference',
      type: 'text',
      unique: true,
      index: true,
      admin: { readOnly: true },
      access: noClientWrite,
    },
    { name: 'name', type: 'text', required: true, maxLength: 120 },
    { name: 'email', type: 'email', required: true },
    { name: 'phone', type: 'text', maxLength: 40 },
    { name: 'title', type: 'text', required: true, maxLength: 200 },
    { name: 'body', type: 'textarea', required: true, maxLength: 20000 },
    { name: 'categorySuggestion', type: 'text', maxLength: 100 },
    { name: 'location', type: 'text', maxLength: 120 },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'new',
      index: true,
      options: ['new', 'under_review', 'accepted', 'rejected', 'converted'].map((s) => ({
        label: s,
        value: s,
      })),
    },
    { name: 'reviewerNotes', type: 'textarea', maxLength: 5000 },
    { name: 'article', type: 'relationship', relationTo: 'articles' },
    { name: 'ipHash', type: 'text', admin: { readOnly: true }, access: noClientWrite },
    {
      // sha256 of normalised email + title + body (lib/submissionHash.ts); duplicate detection.
      name: 'contentHash',
      type: 'text',
      index: true,
      admin: { readOnly: true },
      access: { read: ({ req }) => isEditorRole(req.user as UserLike | null), create: () => false, update: () => false },
    },
    {
      // Server time when the submitter ticked the consent box (empty: no consent was sent). Staff read only.
      name: 'consentAt',
      type: 'date',
      admin: { readOnly: true },
      access: { read: ({ req }) => isEditorRole(req.user as UserLike | null), create: () => false, update: () => false },
    },
    {
      name: 'consentTextVersion',
      type: 'text',
      maxLength: 80,
      admin: { readOnly: true, description: 'Version of the consent wording shown on the public form.' },
      access: { read: ({ req }) => isEditorRole(req.user as UserLike | null), create: () => false, update: () => false },
    },
    { name: 'userAgent', type: 'text', maxLength: 300, admin: { readOnly: true }, access: noClientWrite },
  ],
}
