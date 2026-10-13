import type { CollectionConfig } from 'payload'

import { staffOnly } from '../access/roles'
import { convertSubmissionEndpoint } from '../endpoints/convertSubmission'

// TODO(phase2): editor-only access, create via public endpoint only (overrideAccess), reference generation,
// field validation/sanitising, audit hooks.
export const Submissions: CollectionConfig = {
  slug: 'submissions',
  admin: { useAsTitle: 'title', defaultColumns: ['reference', 'title', 'status', 'createdAt'] },
  endpoints: [convertSubmissionEndpoint],
  access: {
    read: staffOnly,
    create: staffOnly,
    update: staffOnly,
    delete: staffOnly,
  },
  fields: [
    { name: 'reference', type: 'text', unique: true, index: true },
    { name: 'name', type: 'text', required: true },
    { name: 'email', type: 'email', required: true },
    { name: 'phone', type: 'text' },
    { name: 'title', type: 'text', required: true },
    { name: 'body', type: 'textarea', required: true },
    { name: 'categorySuggestion', type: 'text' },
    { name: 'location', type: 'text' },
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
    { name: 'ipHash', type: 'text', admin: { readOnly: true } },
  ],
}
