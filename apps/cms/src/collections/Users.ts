import type { CollectionConfig } from 'payload'

import {
  adminOnly,
  fieldAdminOnly,
  isAdmin,
  isEditorInChief,
  ROLES,
  type UserLike,
} from '../access/roles'

const isProd = process.env.NODE_ENV === 'production'

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'email', 'role'],
  },
  auth: {
    maxLoginAttempts: 5,
    lockTime: 600000, // 10 minutes
    tokenExpiration: 60 * 60 * 12,
    cookies: {
      secure: isProd,
      sameSite: 'Lax',
    },
  },
  access: {
    create: adminOnly,
    read: ({ req }) => {
      const user = req.user as UserLike | null
      if (!user) return false
      if (isEditorInChief(user)) return true
      return { id: { equals: user.id } }
    },
    update: ({ req }) => {
      const user = req.user as UserLike | null
      if (!user) return false
      if (isAdmin(user)) return true
      return { id: { equals: user.id } }
    },
    delete: adminOnly,
  },
  fields: [
    { name: 'name', type: 'text', required: true },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'reporter',
      saveToJWT: true,
      options: ROLES.map((r) => ({ label: r, value: r })),
      access: { create: fieldAdminOnly, update: fieldAdminOnly },
    },
    {
      name: 'sections',
      type: 'relationship',
      relationTo: 'categories',
      hasMany: true,
      saveToJWT: true,
      admin: {
        description: 'Categories this user edits (section-editor) or may publish in (trusted-publisher).',
      },
      access: { create: fieldAdminOnly, update: fieldAdminOnly },
    },
  ],
}
