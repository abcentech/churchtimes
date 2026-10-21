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

import { editorInChiefOnly, idOf, isEditorInChief, isEditorRole, isStaff, staffOnly, type UserLike } from '../access/roles'
import { writeAuditLog } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'
import { liveCampaignClauses, requirePayment } from '../lib/advertising'
import { LEGACY_PATH_MAX, isValidLegacyPath } from '../lib/legacyMediaPath'
import { verifyPreviewToken } from '../lib/previewToken'
import { nextCounter } from './LiveUpdates'

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

/**
 * Joins are never needed from a media read (the three join fields below exist only for `readAccess`). VERIFIED against
 * payload@3.90.2: `joins` is destructured from `args` AFTER the beforeOperation hooks (`operations/find.js` L34,
 * `operations/findByID.js` L29), and the db adapter otherwise defaults `joinQuery` to `{}`, i.e. it adds one correlated
 * subquery per join field to every media row read (list, by id, and every depth>=1 population of a media). Field-level
 * `access.read` does NOT prevent that: `sanitizeJoinQuery` only checks the joined collection's access. `joins: false`
 * switches them all off; the Where built by `readAccess` makes its own SQL joins and is unaffected. The file route
 * (`uploads/checkFileAccess.js`) calls `db.findOne` directly, so it still evaluates the joins once per file hit.
 */
const skipJoins: CollectionBeforeOperationHook = ({ args, operation }) => {
  if (operation === 'read') (args as { joins?: unknown }).joins = false
  return args
}

/**
 * Go-live C3: the FILE of a media that is a creative of an `approved` or `pending_approval` campaign can never be replaced,
 * by any role (editors and trusted server code included), single or bulk. Creatives are checked (exact size, type, weight,
 * not animated) when they are attached, so swapping the file underneath would skip every check and the approval. The
 * workflow is: upload a new media, repoint the campaign (which sends an approved campaign back to `pending_approval`).
 * Runs in `beforeOperation`, before Payload deletes the old file. Metadata edits are handled by the freeze above.
 */
const guardAdCreativeFile: CollectionBeforeOperationHook = async ({ args, operation }) => {
  if (operation !== 'update') return args
  const a = args as { id?: number | string; where?: Where; req: PayloadRequest }
  if (!(a.req as { file?: unknown }).file) return args
  let ids: Array<number | string>
  if (a.id !== undefined && a.id !== null) {
    ids = [a.id]
  } else {
    // Bulk: resolve the targets (trusted read, capped) and refuse when any of them is a protected creative.
    const hit = await a.req.payload.find({
      collection: 'media',
      where: a.where ?? {},
      limit: 1000,
      pagination: false,
      depth: 0,
      select: { filename: true },
      overrideAccess: true,
      req: a.req,
    })
    ids = (hit.docs as Array<{ id: number | string }>).map((d) => d.id)
  }
  if (ids.length === 0) return args
  const used = await a.req.payload.count({
    collection: 'ad-campaigns',
    where: { and: [{ creativeMedia: { in: ids } }, { status: { in: ['approved', 'pending_approval'] } }] },
    overrideAccess: true,
    req: a.req,
  })
  if (used.totalDocs > 0) {
    throw new APIError(
      'This image is a creative of an approved or pending ad campaign and its file cannot be replaced. Upload a new image and point the campaign at it.',
      403,
    )
  }
  return args
}

const checkUpload: CollectionBeforeOperationHook =({ args, operation }) => {
  if (operation !== 'create' && operation !== 'update') return args
  const file = (args.req as { file?: { name: string; data?: Uint8Array; mimetype?: string } }).file
  if (!file) return args
  // A file upload that then fails field validation is not harmless on update: VERIFIED against payload@3.90.2,
  // `operations/utilities/update.js` ~L90 deletes the OLD file (deleteAssociatedFiles) and ~L152 writes the new one
  // BEFORE field validation runs, so a refused replacement (empty or too long alt) would leave the record pointing at a
  // deleted file (URL answers 500). Validate `alt` here, before any file handling.
  const data = (args as { data?: Record<string, unknown> }).data
  if (data && (operation === 'create' || 'alt' in data)) {
    const alt = data.alt
    if (typeof alt !== 'string' || alt.trim() === '' || alt.length > 300) {
      throw new APIError('Alt text is required and must be 1 to 300 characters.', 400)
    }
  }
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
function previewArticleId(req: PayloadRequest): number | string | undefined {
  let token: string | null = null
  try {
    token = req.searchParams?.get('preview') ?? new URL(req.url ?? 'http://x').searchParams.get('preview')
  } catch {
    return undefined
  }
  if (!token) return undefined
  const id = verifyPreviewToken(token)?.articleId
  if (id === undefined) return undefined
  return typeof id === 'string' && /^\d{1,15}$/.test(id) ? Number(id) : id
}

const readAccess: Access = ({ req }) => {
  if (isStaff(asUser(req.user))) return true
  // A valid preview token (`?preview=<token>` on the media URL, appended by `GET /api/preview/articles`) also grants the
  // media of THAT article only (featuredImage + bodyMedia), whatever its status. verifyPreviewToken is HMAC +
  // constant-time compare + expiry; the article id comes from the signed payload, never from the request.
  const previewArticle = previewArticleId(req)
  return {
    or: [
      ...(previewArticle === undefined
        ? []
        : [
            { 'publishedAsFeatured.id': { equals: previewArticle } },
            { 'publishedInBody.id': { equals: previewArticle } },
          ]),
      { 'publishedAsFeatured.status': { equals: 'published' } },
      { 'publishedInBody.status': { equals: 'published' } },
      {
        and: [
          { 'liveUpdateImages.status': { equals: 'approved' } },
          { 'liveUpdateImages.event.status': { in: ['live', 'ended'] } },
        ],
      },
      // Go-live C3: the creative of a campaign that is delivered right now (approved, paid or waived, inside its dates).
      // Same clauses as GET /api/public/advertising, so a file is public exactly while its campaign is served.
      { and: liveCampaignClauses('adCampaignCreatives.', Date.now(), requirePayment()) },
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
  const usedAd = await req.payload.count({
    collection: 'ad-campaigns',
    where: { and: [{ creativeMedia: { equals: mediaId } }, { status: { equals: 'approved' } }] },
    overrideAccess: true,
    req,
  })
  if (usedAd.totalDocs > 0) {
    throw new APIError(
      replacing
        ? 'This image is the creative of an approved ad campaign; ask an editor to replace the file.'
        : 'This image is the creative of an approved ad campaign; ask an editor to change its details.',
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
  // The public feed shows this media's url (the file name changes on replacement) and alt text. Approved live updates
  // that use it must be re-delivered to pollers whose cursor already passed them, exactly like an edit of their
  // image: give each a new publishSequence. Written through the adapter (no hooks): LiveUpdates' own hooks would run
  // as this user and strip the counter.
  if (replaced || changed.includes('alt')) {
    const affected = await req.payload.find({
      collection: 'live-updates',
      where: { and: [{ image: { equals: doc.id } }, { status: { equals: 'approved' } }] },
      sort: 'publishSequence',
      limit: 100,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { event: true },
      req,
    })
    for (const u of affected.docs as Array<{ id: number | string; event: unknown }>) {
      const eventId = idOf(u.event)
      if (eventId === undefined) continue
      const publishSequence = await nextCounter(req, eventId, 'publishSequence')
      await req.payload.db.updateOne({ collection: 'live-updates', id: u.id, data: { publishSequence }, req, returning: false })
    }
  }
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
    beforeOperation: [clampLimit, skipJoins, guardAdCreativeFile, guardFrozenMediaBeforeFiles, checkUpload],
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
    {
      // Go-live C1.2: the original WordPress upload path (`2023/10/photo.jpg`), kept so old /wp-content/uploads
      // addresses can be mapped. Additive and optional. Staff-only: readable by editor roles (admin, editor-in-chief,
      // section-editor), writable by admin / editor-in-chief through the API and by server code (Local API, which
      // skips field access). Anonymous callers and reporters can neither read nor filter on it.
      name: 'legacyPath',
      type: 'text',
      index: true,
      maxLength: LEGACY_PATH_MAX,
      validate: (value: unknown) => {
        if (value === undefined || value === null || value === '') return true
        return isValidLegacyPath(value)
          ? true
          : 'Use the path after /wp-content/uploads/ without a leading slash, for example 2023/10/photo.jpg.'
      },
      access: {
        read: ({ req }) => isEditorRole(asUser(req.user)),
        create: ({ req }) => isEditorInChief(asUser(req.user)),
        update: ({ req }) => isEditorInChief(asUser(req.user)),
      },
      admin: { position: 'sidebar', description: 'Original WordPress upload path. Set by the import; staff only.' },
    },
    // Virtual (no column, no migration) reverse relations used ONLY by `readAccess` to decide public visibility.
    // Field read access is denied for everyone so they never appear in a response unless a caller reads with
    // overrideAccess (e.g. the preview endpoint, which strips them anyway), and `skipJoins` (beforeOperation, read) turns
    // the per-row join subqueries off so they cost nothing. Access Where clauses are not subject to either (see readAccess).
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
    {
      name: 'adCampaignCreatives',
      type: 'join',
      collection: 'ad-campaigns',
      on: 'creativeMedia',
      access: { read: never },
      admin: { hidden: true },
    },
  ],
}
