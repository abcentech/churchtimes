import { APIError } from 'payload'
import type {
  Access,
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  CollectionConfig,
  FieldAccess,
  Where,
} from 'payload'

import { anyone, editorInChiefOnly, idOf, isEditorRole, isStaff, staffOnly, type UserLike } from '../access/roles'
import { writeAuditLog } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'

const asUser = (u: unknown): UserLike | null => (u ? (u as UserLike) : null)

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const

/** Returns the mimetype implied by magic bytes, or null when not a supported image. */
export function sniffImageMime(buf: Uint8Array): (typeof ALLOWED_MIME)[number] | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => buf[i] === b)
  ) {
    return 'image/png'
  }
  if (
    buf.length >= 12 &&
    String.fromCharCode(...buf.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...buf.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

/** Safe filename: ascii letters, digits, dot, dash, underscore; bounded length; never hidden. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot + 1) : ''
  const clean = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
  const safeStem = clean(stem).slice(0, 100) || 'image'
  const safeExt = clean(ext).toLowerCase().slice(0, 5)
  return safeExt ? `${safeStem}.${safeExt}` : safeStem
}

const checkUpload: CollectionBeforeOperationHook = ({ args, operation }) => {
  if (operation !== 'create' && operation !== 'update') return args
  const file = (args.req as { file?: { name: string; data?: Uint8Array; mimetype?: string } }).file
  if (!file) return args
  file.name = sanitizeFilename(file.name)
  if (file.data && file.data.length > 0) {
    const sniffed = sniffImageMime(file.data)
    if (!sniffed) throw new APIError('Unsupported or corrupt image. Use JPEG, PNG or WebP.', 400)
    if (file.mimetype && file.mimetype !== sniffed) {
      throw new APIError('File content does not match its declared type.', 400)
    }
  }
  return args
}

const never: FieldAccess = () => false
const staffRead: FieldAccess = ({ req }) => isStaff(asUser(req.user))

/**
 * Update access. Editors (admin / editor-in-chief / section-editor) may edit any media. Everyone else
 * only the media they uploaded themselves; rows without `uploadedBy` (uploaded before this field
 * existed) are therefore editor-only. The "in use by a published article" freeze is enforced in
 * `guardMediaChange` because it needs a query on another collection.
 */
const updateAccess: Access = ({ req }) => {
  const user = asUser(req.user)
  if (!isStaff(user)) return false
  if (isEditorRole(user)) return true
  return { uploadedBy: { equals: user!.id as number } } as Where
}

type MediaContext = { seed?: boolean; mediaFileReplaced?: boolean }

/**
 * - create: `uploadedBy` is set from the authenticated caller (the field is not client-writable;
 *   trusted server code without a user may supply it).
 * - update by a non-editor: the media must not be the featured image of a published or scheduled
 *   article, nor the image of an approved live update (metadata edits there are public-facing edits, and replacing the file swaps a live
 *   image). Editors are not restricted.
 *
 * VERIFIED against payload@3.90.2: a multipart PATCH carries the new file on `req.file`
 * (`checkUpload` already relies on this); an update without a file has none.
 */
const guardMediaChange: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req }) => {
  const ctx = (req.context ?? {}) as MediaContext
  if (ctx.seed === true) return data
  const user = asUser(req.user)

  if (operation === 'create') {
    data.uploadedBy = user ? user.id : (data.uploadedBy ?? null)
    return data
  }

  const replacing = Boolean((req as { file?: unknown }).file)
  if (replacing) ctx.mediaFileReplaced = true
  if (!user) return data // trusted server-side call

  if (!isEditorRole(user)) {
    if (String(idOf(originalDoc?.uploadedBy) ?? '') !== String(user.id)) {
      throw new APIError('You can only edit media you uploaded.', 403)
    }
    const used = await req.payload.count({
      collection: 'articles',
      where: {
        and: [{ featuredImage: { equals: originalDoc.id } }, { status: { in: ['published', 'scheduled'] } }],
      },
      overrideAccess: true,
      req,
    })
    if (used.totalDocs > 0) {
      throw new APIError(
        replacing
          ? 'This image is used by a published or scheduled article; ask an editor to replace the file.'
          : 'This image is used by a published or scheduled article; ask an editor to change its details.',
        403,
      )
    }
    // Same freeze for an image attached to an approved (public) live update.
    const usedLive = await req.payload.count({
      collection: 'live-updates',
      where: { and: [{ image: { equals: originalDoc.id } }, { status: { equals: 'approved' } }] },
      overrideAccess: true,
      req,
    })
    if (usedLive.totalDocs > 0) {
      throw new APIError(
        replacing
          ? 'This image is used by a published live update; ask an editor to replace the file.'
          : 'This image is used by a published live update; ask an editor to change its details.',
        403,
      )
    }
    // Ownership is never transferable by the owner (field access already strips this).
    data.uploadedBy = idOf(originalDoc.uploadedBy) ?? null
  }
  return data
}

const MEDIA_META_FIELDS = ['alt', 'caption', 'credit', 'focalX', 'focalY'] as const

const auditMedia: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  const ctx = (req.context ?? {}) as MediaContext
  if (ctx.seed === true) return doc
  if (operation === 'create') {
    await writeAuditLog(req, {
      action: 'upload',
      collection: 'media',
      docId: doc.id,
      summary: String(doc.filename ?? ''),
    })
    return doc
  }

  const prev = (previousDoc ?? {}) as Record<string, unknown>
  const replaced = ctx.mediaFileReplaced === true || (prev.filename !== undefined && prev.filename !== doc.filename)
  const changed = MEDIA_META_FIELDS.filter((k) => (prev[k] ?? null) !== ((doc as Record<string, unknown>)[k] ?? null))
  if (replaced) {
    await writeAuditLog(req, {
      action: 'media.replace-file',
      collection: 'media',
      docId: doc.id,
      summary: `File replaced: ${String(prev.filename ?? '')} -> ${String(doc.filename ?? '')}`,
      details: { previousFilename: prev.filename ?? null, filename: doc.filename ?? null },
    })
  }
  if (!replaced || changed.length > 0) {
    await writeAuditLog(req, {
      action: 'media.update',
      collection: 'media',
      docId: doc.id,
      summary: `Media details updated: ${changed.join(', ') || 'no field changes'}`,
      details: { fields: changed },
    })
  }
  return doc
}

const auditDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
  await writeAuditLog(req, {
    action: 'delete',
    collection: 'media',
    docId: doc.id,
    summary: String(doc.filename ?? ''),
  })
  return doc
}

export const Media: CollectionConfig = {
  slug: 'media',
  admin: { useAsTitle: 'filename', defaultColumns: ['filename', 'alt', 'credit', 'createdAt'] },
  access: {
    read: anyone,
    create: staffOnly,
    update: updateAccess,
    delete: editorInChiefOnly,
  },
  hooks: {
    beforeOperation: [clampLimit, checkUpload],
    beforeChange: [guardMediaChange],
    afterChange: [auditMedia],
    afterDelete: [auditDelete],
  },
  upload: {
    staticDir: 'media',
    mimeTypes: [...ALLOWED_MIME],
    focalPoint: true,
    imageSizes: [
      { name: 'thumbnail', width: 400 },
      { name: 'card', width: 800 },
      { name: 'hero', width: 1600, formatOptions: { format: 'webp' } },
    ],
  },
  fields: [
    { name: 'alt', type: 'text', required: true, maxLength: 300 },
    { name: 'caption', type: 'text' },
    { name: 'credit', type: 'text' },
    {
      // Server-set on create; see guardMediaChange / updateAccess. Null for rows that predate the field.
      name: 'uploadedBy',
      type: 'relationship',
      relationTo: 'users',
      index: true,
      admin: { readOnly: true, position: 'sidebar' },
      access: { read: staffRead, create: never, update: never },
    },
  ],
}
