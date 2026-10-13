import type { Access, CollectionConfig } from 'payload'

import { isEditorInChief, isEditorRole, type UserLike } from '../access/roles'
import { convertSubmissionEndpoint } from '../endpoints/convertSubmission'
import { writeAuditLog } from '../lib/audit'

const editorsOnly: Access = ({ req }) => isEditorRole(req.user as UserLike | null)

const noClientWrite = { create: () => false, update: () => false }

/**
 * Staff-only inbox. Public creation happens only through POST /api/public/submissions
 * (overrideAccess), so `create` is closed for the REST API. MVP: every editor role (including
 * section-editors) can read and triage all submissions.
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
    { name: 'reviewerNotes', type: 'textarea' },
    { name: 'article', type: 'relationship', relationTo: 'articles' },
    { name: 'ipHash', type: 'text', admin: { readOnly: true }, access: noClientWrite },
    { name: 'userAgent', type: 'text', maxLength: 300, admin: { readOnly: true }, access: noClientWrite },
  ],
}
