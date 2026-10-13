import type { CollectionConfig } from 'payload'

import { editorInChiefOnly } from '../access/roles'

// TODO(phase2): immutability enforced (no update/delete via API for anyone), indexes tuned.
export const AuditLogs: CollectionConfig = {
  slug: 'audit-logs',
  admin: {
    useAsTitle: 'action',
    defaultColumns: ['action', 'collection', 'docId', 'actor', 'createdAt'],
  },
  access: {
    read: editorInChiefOnly,
    create: () => false, // written server-side with overrideAccess via lib/audit.ts
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'action', type: 'text', required: true, index: true },
    { name: 'collection', type: 'text', required: true, index: true },
    { name: 'docId', type: 'text', required: true, index: true },
    { name: 'actor', type: 'relationship', relationTo: 'users' },
    { name: 'actorRole', type: 'text' },
    { name: 'fromStatus', type: 'text' },
    { name: 'toStatus', type: 'text' },
    { name: 'summary', type: 'text' },
  ],
}
