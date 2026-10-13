import type { CollectionConfig } from 'payload'

import { editorInChiefOnly } from '../access/roles'

const ro = { readOnly: true }

/**
 * Immutable via the API for everyone (create/update/delete = false). Rows are written server-side
 * through lib/audit.ts with overrideAccess. NOTE: the `collection` field name stores the target
 * collection slug; it works with Payload/Drizzle (column `collection`).
 */
export const AuditLogs: CollectionConfig = {
  slug: 'audit-logs',
  admin: {
    useAsTitle: 'action',
    defaultColumns: ['action', 'collection', 'docId', 'actor', 'createdAt'],
    description: 'Read-only record of workflow and moderation actions.',
  },
  timestamps: true,
  access: {
    read: editorInChiefOnly,
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'action', type: 'text', required: true, index: true, admin: ro },
    { name: 'collection', type: 'text', required: true, index: true, admin: ro },
    { name: 'docId', type: 'text', required: true, index: true, admin: ro },
    { name: 'actor', type: 'relationship', relationTo: 'users', admin: ro },
    { name: 'actorRole', type: 'text', admin: ro },
    { name: 'fromStatus', type: 'text', admin: ro },
    { name: 'toStatus', type: 'text', admin: ro },
    { name: 'summary', type: 'textarea', admin: ro },
    { name: 'details', type: 'json', admin: ro },
  ],
}
