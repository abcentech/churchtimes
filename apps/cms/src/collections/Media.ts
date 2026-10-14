import { APIError } from 'payload'
import type {
  Access,
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  CollectionConfig,
  FieldAccess,
  PayloadRequest,
  Where,
} from 'payload'

import { editorInChiefOnly, idOf, isEditorRole, isStaff, staffOnly, type UserLike } from '../access/roles'
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
 * Read access (list, by id, and the upload file route `/api/media/file/<name>`, image size variants included).
 *
 * - Any authenticated staff role reads everything (the media library, pickers, previews of drafts).
 * - Everyone else (anonymous, or any non-staff user) only reads media that readers can already see on the
 *   public site: the featured image or a body image of a PUBLISHED article (scheduled and archived articles are
 *   not public), or the image of an APPROVED live update whose event is live or ended (the same rule as
 *   `LiveUpdates.read`). Uploads that are unreferenced, used only by drafts / in-review / scheduled / archived
 *   articles, or attached to pending / rejected live updates are private.
 *
 * The visibility rule is a Where over the three virtual join fields below, so it is evaluated in SQL (one
 * query, no per-row hooks) and is index-friendly: articles.featured_image_id (articles_featured_image_idx),
 * articles_rels.media_id + path (articles_rels_media_id_idx, articles_rels_path_idx) and live_updates.image_id
 * (live_updates_image_idx), then the status columns (articles_status_idx, live_updates_status_idx).
 *
 * VERIFIED against payload@3.90.2: the file route (`uploads/endpoints/getFile.js` L21 -> `uploads/checkFileAccess.js`
 * L10-16) runs this same `access.read`; when it returns a Where, L29-57 look the file up with
 * `(filename = x OR sizes.<name>.filename = x) AND <this where>` and answer 403 (L79) when nothing matches, so size
 * variants share the original's visibility. List/by-id reads AND the Where into the query (`operations/find.js`
 * L72, `operations/findByID.js` L56) and relationship population (articles -> featuredImage / body upload nodes)
 * goes through the same by-id read with the caller's `overrideAccess` (`fields/hooks/afterRead/
 * relationshipPopulationPromise.js` L29-44), so an inaccessible media shows up as a bare id, a public one is
 * populated. `validateQueryPaths` only validates the CLIENT's where (`find.js` L130), not this access result, which
 * is why the join fields may deny field-level read.
 */
const readAccess: Access = ({ req }) => {
  if (isStaff(asUser(req.user))) return true
  return {
    or: [
      { 'publishedAsFeatured.status': { equals: 'published' } },
      { 'publishedInBody.status': { equals: 'published' } },
      {
        and: [
          { 'liveUpdateImages.status': { equals: 'approved' } },
          { 'liveUpdateImages.event.status': { in: ['live', 'ended'] } },
        ],
      },
    ],
  } as Where
}

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
 * "Frozen" media is shown to readers: it is the featured image or a body image of a published or scheduled
 * article (`bodyMedia` is derived from the Lexical upload nodes), or the image of an approved live update.
 * Non-editors may not change its details or replace its file. Throws 403 with a message that says why.
 */
async function assertMediaNotFrozen(req: PayloadRequest, mediaId: number | string, replacing: boolean): Promise<void> {
  const used = await req.payload.count({
    collection: 'articles',
    where: {
      and: [
        { or: [{ featuredImage: { equals: mediaId } }, { bodyMedia: { equals: mediaId } }] },
        { status: { in: ['published', 'scheduled'] } },
      ],
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
  const usedLive = await req.payload.count({
    collection: 'live-updates',
    where: { and: [{ image: { equals: mediaId } }, { status: { equals: 'approved' } }] },
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
}

/**
 * The freeze must be decided BEFORE Payload touches any file. VERIFIED against payload@3.90.2: in
 * `collections/operations/updateByID.js` the `beforeOperation` hooks run first (L59-66), then access (L95), the lookup,
 * `generateFileData` (L157), and then `updateDocument` (`operations/utilities/update.js`), which calls
 * `deleteAssociatedFiles` (the OLD file is removed from disk, ~L90) and `uploadFiles` (the new one is written, ~L152)
 * BEFORE the collection `beforeChange` hooks run (~L157). A `beforeChange` guard therefore returns 403 only after the
 * original file is already gone (the DB row is untouched, so the public URL answers 500). Hence this check lives here,
 * in `beforeOperation`; `guardMediaChange` stays as a second line of defence. (Delete is editor-in-chief only via
 * `access.delete`, which `deleteByID.js` evaluates at L39, before `deleteAssociatedFiles` at L90.)
 *
 * Bulk updates (no id, `where`) would hit the same file handling per document and are not part of the contract: refused
 * for non-editors.
 */
const guardFrozenMediaBeforeFiles: CollectionBeforeOperationHook = async ({ args, operation }) => {
  if (operation !== 'update') return args
  const a = args as { overrideAccess?: boolean; id?: number | string; req: PayloadRequest }
  const ctx = (a.req.context ?? {}) as MediaContext
  if (a.overrideAccess === true || ctx.seed === true) return args
  const user = asUser(a.req.user)
  if (!user || isEditorRole(user)) return args
  if (a.id === undefined || a.id === null) throw new APIError('Bulk media updates are not permitted.', 403)
  await assertMediaNotFrozen(a.req, a.id, Boolean((a.req as { file?: unknown }).file))
  return args
}

/**
 * - create: `uploadedBy` is set from the authenticated caller (the field is not client-writable;
 *   trusted server code without a user may supply it).
 * - update by a non-editor: the media must not be the featured image of a published or scheduled
 *   article (or an image inside its body), nor the image of an approved live update (metadata edits there are public-facing edits, and replacing the file swaps a live
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
    await assertMediaNotFrozen(req, originalDoc.id, replacing) // second line of defence, see guardFrozenMediaBeforeFiles
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
    read: readAccess,
    create: staffOnly,
    update: updateAccess,
    delete: editorInChiefOnly,
  },
  hooks: {
    beforeOperation: [clampLimit, guardFrozenMediaBeforeFiles, checkUpload],
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
    // Virtual (no column, no migration) reverse relations used ONLY by `readAccess` to decide public visibility.
    // Field read access is denied for everyone so Payload never populates or returns them (no extra queries per media
    // row, nothing in responses); access Where clauses are not subject to field access (see readAccess).
    {
      name: 'publishedAsFeatured',
      type: 'join',
      collection: 'articles',
      on: 'featuredImage',
      access: { read: never },
      admin: { hidden: true },
    },
    {
      name: 'publishedInBody',
      type: 'join',
      collection: 'articles',
      on: 'bodyMedia',
      access: { read: never },
      admin: { hidden: true },
    },
    {
      name: 'liveUpdateImages',
      type: 'join',
      collection: 'live-updates',
      on: 'image',
      access: { read: never },
      admin: { hidden: true },
    },
  ],
}
