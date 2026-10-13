import type { CollectionConfig } from 'payload'

import { anyone, editorInChiefOnly } from '../access/roles'

export const Categories: CollectionConfig = {
  slug: 'categories',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'slug'] },
  access: {
    read: anyone,
    create: editorInChiefOnly,
    update: editorInChiefOnly,
    delete: editorInChiefOnly,
  },
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      validate: (v: unknown) =>
        typeof v === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v)
          ? true
          : 'Slug must be lowercase letters, numbers and hyphens.',
    },
    { name: 'description', type: 'textarea' },
  ],
}
