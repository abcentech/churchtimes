import type { CollectionConfig } from 'payload'

import { staffOnly } from '../access/roles'
import { articlePreviewTokenEndpoint } from '../endpoints/articlePreviewToken'

export const ARTICLE_STATUSES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'scheduled',
  'published',
  'archived',
] as const

// TODO(phase2): workflow hooks (transition rules, publishedAt, audit), real access rules, field-level
// read restriction for author/reviewNotes/scheduledFor, slug/length validation, corrections enforcement.
export const Articles: CollectionConfig = {
  slug: 'articles',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'status', 'category', 'updatedAt'] },
  versions: { maxPerDoc: 50 },
  endpoints: [articlePreviewTokenEndpoint],
  access: {
    // TODO(phase2): replace with role-aware rules
    read: ({ req }) => (req.user ? true : { status: { equals: 'published' } }),
    create: staffOnly,
    update: staffOnly,
    delete: staffOnly,
  },
  fields: [
    { name: 'title', type: 'text', required: true, maxLength: 240 },
    { name: 'slug', type: 'text', required: true, unique: true, index: true, maxLength: 160 },
    { name: 'excerpt', type: 'textarea', maxLength: 600 },
    { name: 'content', type: 'richText', required: true },
    { name: 'category', type: 'relationship', relationTo: 'categories', required: true, index: true },
    { name: 'featuredImage', type: 'upload', relationTo: 'media' },
    { name: 'author', type: 'relationship', relationTo: 'users', index: true },
    { name: 'bylineName', type: 'text' },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'draft',
      index: true,
      options: ARTICLE_STATUSES.map((s) => ({ label: s, value: s })),
    },
    { name: 'publishedAt', type: 'date', index: true },
    { name: 'scheduledFor', type: 'date', index: true },
    { name: 'reviewNotes', type: 'textarea' },
    {
      name: 'corrections',
      type: 'array',
      fields: [
        { name: 'correctedAt', type: 'date', required: true },
        { name: 'note', type: 'textarea', required: true },
      ],
    },
    { name: 'legacyUrl', type: 'text' },
    { name: 'legacyId', type: 'number', index: true },
  ],
}
