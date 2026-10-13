import type { CollectionConfig } from 'payload'

import { staffOnly } from '../access/roles'
import { liveEventUpdatesEndpoint } from '../endpoints/liveEventUpdates'

// TODO(phase2): scope-aware access (editors in category scope), public read of live/ended only.
export const LiveEvents: CollectionConfig = {
  slug: 'live-events',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'status', 'startedAt'] },
  endpoints: [liveEventUpdatesEndpoint],
  access: {
    read: ({ req }) => (req.user ? true : { status: { in: ['live', 'ended'] } }),
    create: staffOnly,
    update: staffOnly,
    delete: staffOnly,
  },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true, unique: true, index: true },
    { name: 'summary', type: 'textarea' },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'draft',
      index: true,
      options: ['draft', 'live', 'ended'].map((s) => ({ label: s, value: s })),
    },
    { name: 'category', type: 'relationship', relationTo: 'categories', required: true },
    { name: 'startedAt', type: 'date' },
    { name: 'endedAt', type: 'date' },
  ],
}
