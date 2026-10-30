import type { Access, CollectionBeforeValidateHook, CollectionConfig, FieldHook, Where } from 'payload'

import { editorInChiefOnly, isEditorRole, isStaff, type UserLike } from '../access/roles'
import { auditDeleteHook } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'
import {
  AUTHOR_BIO_MAX,
  AUTHOR_NAME_MAX,
  AUTHOR_ROLE_MAX,
  AUTHOR_SOCIAL_KINDS,
  AUTHOR_SOCIALS_MAX,
  SLUG_MAX,
  isSafeProfileUrl,
  plainTextValidator,
  slugValidator,
} from '../lib/newsroomFields'
import { slugify } from '../lib/sanitize'

const asUser = (u: unknown): UserLike | null => (u ? (u as UserLike) : null)

/** Staff read every profile; everyone else only public ones (`isPublic: true`), also when populated into an article. */
export const publicProfileRead: Access = ({ req }) =>
  isStaff(asUser(req.user)) ? true : ({ isPublic: { equals: true } } as Where)

export const editorsWrite: Access = ({ req }) => isEditorRole(asUser(req.user))

/** Empty slug: generated from the name (the unique index refuses a clash with a 400 naming the field). */
export const slugFromName =
  (source: string): CollectionBeforeValidateHook =>
  ({ data }) => {
    if (!data) return data
    if (typeof data.slug === 'string' && data.slug.trim() !== '') {
      data.slug = data.slug.trim()
      return data
    }
    if (typeof data[source] === 'string' && data[source].trim() !== '') data.slug = slugify(data[source], SLUG_MAX, 'profile')
    return data
  }

/**
 * Compact public picture of the profile (virtual, no column): `{ url, width, height, alt, thumbnailUrl }` from the `photo`
 * media, read with the caller's access, or null. Lets an article at depth=1 show the byline photo without depth=2.
 */
const avatarHook: FieldHook = async ({ siblingData, req }) => {
  const raw = siblingData?.photo
  const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : raw
  if (typeof id !== 'number' && typeof id !== 'string') return null
  // One lookup per photo per request: a list of 20 stories by the same writer must not cost 20 media reads.
  const ctx = (req.context ?? {}) as { w12AvatarCache?: Map<string, Promise<unknown>> }
  const cache = (ctx.w12AvatarCache ??= new Map())
  if (req.context) (req.context as typeof ctx).w12AvatarCache = cache
  const key = `${String(id)}:${req.user ? String((req.user as { id?: unknown }).id) : 'anon'}`
  if (!cache.has(key)) cache.set(key, loadAvatar(req, id))
  return cache.get(key)
}

async function loadAvatar(req: Parameters<FieldHook>[0]['req'], id: number | string) {
  const media = (await req.payload
    .findByID({ collection: 'media', id, depth: 0, overrideAccess: false, user: req.user, req, disableErrors: true })
    .catch(() => null)) as {
    url?: string | null
    width?: number | null
    height?: number | null
    alt?: string | null
    mimeType?: string | null
    sizes?: { thumbnail?: { url?: string | null } }
  } | null
  if (!media || typeof media.url !== 'string' || !String(media.mimeType ?? '').startsWith('image/')) return null
  return {
    url: media.url,
    width: media.width ?? null,
    height: media.height ?? null,
    alt: media.alt ?? '',
    thumbnailUrl: media.sizes?.thumbnail?.url ?? null,
  }
}

export const Authors: CollectionConfig = {
  slug: 'authors',
  labels: { singular: 'Author profile', plural: 'Author profiles' },
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'slug', 'role', 'isPublic'],
    group: 'Newsroom',
    description: 'Public byline profiles (author pages). Separate from staff log-in accounts.',
  },
  // What an article carries for `bylineAuthor` at depth >= 1 (and author lists): the card fields, never the full bio.
  defaultPopulate: { name: true, slug: true, role: true, photo: true, avatar: true, isPublic: true },
  access: {
    read: publicProfileRead,
    create: editorsWrite,
    update: editorsWrite,
    delete: editorInChiefOnly,
  },
  hooks: {
    beforeOperation: [clampLimit],
    beforeValidate: [slugFromName('name')],
    afterDelete: [auditDeleteHook('authors', (d) => (d.slug ? `slug ${d.slug}` : undefined))],
  },
  fields: [
    { name: 'name', type: 'text', required: true, maxLength: AUTHOR_NAME_MAX, validate: plainTextValidator('Name', AUTHOR_NAME_MAX, { required: true }) },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      maxLength: SLUG_MAX,
      validate: slugValidator,
      admin: { position: 'sidebar', description: 'Address of the author page (/author/<slug>/). Generated from the name when empty.' },
    },
    { name: 'role', type: 'text', maxLength: AUTHOR_ROLE_MAX, validate: plainTextValidator('Role', AUTHOR_ROLE_MAX), admin: { description: 'For example "Senior Correspondent, Abuja".' } },
    { name: 'bio', type: 'textarea', maxLength: AUTHOR_BIO_MAX, validate: plainTextValidator('Bio', AUTHOR_BIO_MAX, { multiline: true }) },
    {
      name: 'photo',
      type: 'upload',
      relationTo: 'media',
      filterOptions: { mimeType: { in: ['image/jpeg', 'image/png', 'image/webp'] } },
      admin: { description: 'Optional square head-and-shoulders photo with alt text. Public only while the profile is public.' },
    },
    {
      name: 'avatar',
      type: 'json',
      virtual: true,
      admin: { hidden: true },
      access: { create: () => false, update: () => false },
      hooks: { afterRead: [avatarHook] },
    },
    {
      name: 'socials',
      type: 'array',
      maxRows: AUTHOR_SOCIALS_MAX,
      labels: { singular: 'Link', plural: 'Links' },
      fields: [
        { name: 'kind', type: 'select', required: true, options: AUTHOR_SOCIAL_KINDS.map((k) => ({ label: k === 'x' ? 'X (Twitter)' : k[0]!.toUpperCase() + k.slice(1), value: k })) },
        {
          name: 'url',
          type: 'text',
          required: true,
          maxLength: 300,
          validate: (v: unknown) => (isSafeProfileUrl(v) ? true : 'Use a full https:// address (no spaces or quotes), at most 300 characters.'),
        },
      ],
    },
    {
      name: 'isPublic',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      admin: { position: 'sidebar', description: 'Show this profile and its author page to readers.' },
    },
  ],
}
