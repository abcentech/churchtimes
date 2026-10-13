import type { CollectionConfig } from 'payload'

import { staffOnly } from '../access/roles'

// TODO(phase2): server-assigned `sequence` (per event, monotonic, not client-writable), approval workflow,
// scope-aware access, public read of approved only (on live/ended events).
export const LiveUpdates: CollectionConfig = {
  slug: 'live-updates',
  admin: { useAsTitle: 'body', defaultColumns: ['event', 'sequence', 'status', 'occurredAt'] },
  access: {
    read: ({ req }) => (req.user ? true : { status: { equals: 'approved' } }),
    create: staffOnly,
    update: staffOnly,
    delete: staffOnly,
  },
  fields: [
    { name: 'event', type: 'relationship', relationTo: 'live-events', required: true, index: true },
    { name: 'body', type: 'textarea', required: true, maxLength: 5000 },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      options: ['pending', 'approved', 'rejected'].map((s) => ({ label: s, value: s })),
    },
    { name: 'sequence', type: 'number', index: true },
    { name: 'occurredAt', type: 'date', required: true, defaultValue: () => new Date().toISOString() },
    { name: 'approvedAt', type: 'date' },
  ],
}
