import type { CollectionConfig } from 'payload'

import { anyone, staffOnly } from '../access/roles'

// TODO(phase2): restrict mimeTypes to jpeg/png/webp, reject svg/html, image sizes, delete rules.
export const Media: CollectionConfig = {
  slug: 'media',
  access: {
    read: anyone,
    create: staffOnly,
    update: staffOnly,
    delete: staffOnly,
  },
  upload: true,
  fields: [
    { name: 'alt', type: 'text', required: true },
    { name: 'caption', type: 'text' },
    { name: 'credit', type: 'text' },
  ],
}
