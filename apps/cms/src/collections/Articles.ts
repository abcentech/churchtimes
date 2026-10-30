import { APIError } from 'payload'
import type {
  Access,
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeOperationHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  FieldAccess,
  Where,
} from 'payload'

import {
  type UserLike,
  editorInChiefOnly,
  idOf,
  isEditorInChief,
  isEditorRole,
  isStaff,
  staffOnly,
  userSectionIds,
} from '../access/roles'
import { articleContentEditor } from './articleEditor'
import { MAX_SECONDARY_CATEGORIES, categoryIds, checkSecondaryCategories } from '../lib/articleCategories'
import { removeArticleSearch, syncArticleSearch } from '../lib/articleSearch'
import { articlePreviewTokenEndpoint } from '../endpoints/articlePreviewToken'
import { writeAuditLog } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'
import { deepEqual } from '../lib/deepEqual'
import { collectAvBlocks, collectAvMedia, collectGalleryMedia, findEmbedProblem } from '../lib/lexicalEmbeds'
import {
  CONTENT_TYPES,
  CONTENT_TYPE_LABELS,
  DEFAULT_CONTENT_TYPE,
  KEY_POINTS_MAX,
  KEY_POINT_MAX,
  KICKER_MAX,
  TOPICS_PER_ARTICLE_MAX,
  keyPointTexts,
  keyPointsProblem,
  plainTextProblem,
  plainTextValidator,
  updateStampProblem,
} from '../lib/newsroomFields'
import { assertExpectedUpdatedAt, captureExpectedUpdatedAt } from '../lib/expectedUpdatedAt'
import { collectUploadNodes, uploadValueId } from '../lib/lexicalMedia'
import { ALLOWED_IMAGE_MIME, assertAttachableAv, assertAttachableImage, isMediaId } from '../lib/mediaChecks'
import { SEO_DESCRIPTION_MAX, SEO_FIELD_KEYS, SEO_TITLE_MAX, cleanSeoValue, seoFieldValidator } from '../lib/seoFields'
import {
  ARTICLE_STATUSES,
  type ArticleStatus,
  canEditContent,
  canTransition,
  isArticleStatus,
} from '../workflow/articleWorkflow'
import {
  FOUR_EYES_MESSAGE,
  PROVENANCE_CONFIDENCE,
  PROVENANCE_REVIEW_STATUSES,
  fourEyesBlocked,
  publishBlockedByProvenance,
  reviewAndPublishInOneWrite,
  reviewStamp,
  storedReviewedBy,
} from '../lib/provenance'
import { reconcileCorrections } from '../workflow/corrections'
import { articlePath, resolveArticlePathTemplate } from '../lib/redirectPaths'
import { isReservedSlug } from '../lib/reservedSlugs'

export { ARTICLE_STATUSES }

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Under `/{slug}/` an article sits at the site root, so the reserved route names are refused (lib/reservedSlugs.ts). */
const rootSlugsApply = (): boolean => {
  try {
    return resolveArticlePathTemplate() === '/{slug}/'
  } catch {
    return true
  }
}

type Doc = Record<string, unknown>
const asUser = (u: unknown): UserLike | null => (u ? (u as UserLike) : null)

/** Lowercase, ASCII-fold, hyphenate, max 160 chars. */
export function slugify(input: string): string {
  const s = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160)
    .replace(/-+$/g, '')
  return s || 'article'
}

// ---------------------------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------------------------

const publishedOnly: Where = { status: { equals: 'published' } }

const readAccess: Access = ({ req }) => {
  const user = asUser(req.user)
  if (!isStaff(user)) return publishedOnly
  if (isEditorInChief(user)) return true
  const or: Where[] = [publishedOnly, { author: { equals: user!.id as number } }]
  const sections = userSectionIds(user)
  if (user!.role !== 'reporter' && sections.length > 0) {
    or.push({ category: { in: sections as number[] } })
  }
  return { or }
}

/**
 * `GET /api/articles/versions[/:id]` and restore. Without this, Payload's default for
 * `readVersions` is "any logged-in user", which exposes every draft (and review notes) to every staff
 * member. Same rule as `readAccess`, expressed on the version document: the stored article fields live
 * under `version.*` in `_articles_v` (`version.status`, `version.author`, `version.category`).
 * Anonymous callers get 403.
 */
const readVersionsAccess: Access = ({ req }) => {
  const user = asUser(req.user)
  if (!isStaff(user)) return false
  if (isEditorInChief(user)) return true
  const or: Where[] = [
    { 'version.status': { equals: 'published' } },
    { 'version.author': { equals: user!.id as number } },
  ]
  const sections = userSectionIds(user)
  if (user!.role !== 'reporter' && sections.length > 0) {
    or.push({ 'version.category': { in: sections as number[] } })
  }
  return { or }
}

const updateAccess: Access = ({ req }) => {
  const user = asUser(req.user)
  if (!isStaff(user)) return false
  if (isEditorInChief(user)) return true
  const own: Where = { author: { equals: user!.id as number } }
  if (user!.role === 'section-editor') {
    const sections = userSectionIds(user)
    return sections.length > 0 ? { or: [own, { category: { in: sections as number[] } }] } : own
  }
  if (user!.role === 'trusted-publisher') return own // category scope enforced in beforeChange hook
  // reporter: own AND still editable (draft / changes_requested). Moving draft -> in_review is an
  // update on a draft doc, so it passes; once in_review the reporter can no longer write.
  return { and: [own, { status: { in: ['draft', 'changes_requested'] } }] }
}

const staffRead: FieldAccess = ({ req }) => isStaff(asUser(req.user))
const editorWrite: FieldAccess = ({ req }) => isEditorRole(asUser(req.user))
const never: FieldAccess = () => false

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

/**
 * Mark restoreVersion requests. `req.context` is server-side only (clients cannot set it) and is the
 * same object the later `beforeChange` hook sees, so `enforceWorkflow` can tell a restore from a PATCH.
 */
const markRestore: CollectionBeforeOperationHook = ({ args, operation }) => {
  if (operation === 'restoreVersion') {
    ;(args.req.context as { restoreVersion?: boolean }).restoreVersion = true
  }
  return args
}

/**
 * `provenance: null` in a write would reach Payload's group handling as a null object (500), before any collection
 * beforeValidate hook runs, so it is dropped here (treated as "not sent") in beforeOperation.
 */
const dropNullProvenance: CollectionBeforeOperationHook = ({ args, operation }) => {
  if (operation !== 'create' && operation !== 'update') return args
  const data = (args as { data?: Record<string, unknown> }).data
  if (data && typeof data === 'object' && data.provenance === null) delete data.provenance
  return args
}

const autoSlug: CollectionBeforeValidateHook = async ({ data, operation, originalDoc, req }) => {
  if (!data) return data
  const provided = typeof data.slug === 'string' ? data.slug.trim() : ''
  if (provided) {
    data.slug = provided
    return data
  }
  if (!(operation === 'create' || 'slug' in data)) return data
  const title = typeof data.title === 'string' ? data.title : String((originalDoc as Doc)?.title ?? '')
  const base = slugify(title)
  let candidate = base
  const blockRoot = rootSlugsApply()
  for (let i = 2; i < 50; i++) {
    if (blockRoot && isReservedSlug(candidate)) {
      const suffix = `-${i}`
      candidate = base.slice(0, 160 - suffix.length).replace(/-+$/, '') + suffix
      continue
    }
    const hit = await req.payload.find({
      collection: 'articles',
      where: {
        and: [
          { slug: { equals: candidate } },
          ...(originalDoc?.id ? [{ id: { not_equals: originalDoc.id } }] : []),
        ],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
      req,
    })
    if (hit.totalDocs === 0) break
    const suffix = `-${i}`
    candidate = base.slice(0, 160 - suffix.length).replace(/-+$/, '') + suffix
  }
  data.slug = candidate
  return data
}

// Canonical comparison: jsonb (Lexical content) does not preserve key order, JSON.stringify does.
const same = deepEqual

/**
 * `seoTitle` / `seoDescription` (contract C2): strip markup and control characters before field validation so
 * the length check applies to what is actually stored, and store "empty" as null. A non-string is a 400 rather
 * than being silently dropped. Not "material" for corrections (see `enforceWorkflow`), but still a content edit
 * for who-may-edit purposes (CONTENT_KEYS).
 */
const normalizeSeoFields: CollectionBeforeValidateHook = async ({ data }) => {
  if (!data) return data
  for (const key of SEO_FIELD_KEYS) {
    if (!(key in data)) continue
    const cleaned = cleanSeoValue(data[key])
    if (cleaned === 'invalid') throw new APIError(`${key} must be plain text.`, 400)
    data[key] = cleaned
  }
  return data
}

/**
 * The only embed a body may hold is the registered `youtubeEmbed` block with a well-formed 11-character video id
 * (contract C1.1). A malformed block, a raw `embed` node (the archive importer's old shape), an iframe-like node
 * or an unknown block is a 400 ("Embeds other than YouTube are not accepted"). Runs on every write that carries
 * `content`; skipped for trusted seed/system calls, exactly like `validateBodyImages`.
 */
const validateEmbeds: CollectionBeforeValidateHook = ({ data, req }) => {
  const ctx = (req.context ?? {}) as { seed?: boolean }
  if (ctx.seed === true || !data || data.content === undefined) return data
  const problem = findEmbedProblem(data.content)
  if (problem) throw new APIError(problem, 400)
  return data
}

/**
 * Every `upload` node of the body must be a real, usable image: relationTo 'media', an integer id in
 * 1..2147483647 (a populated media object is accepted for its id), and media that exists and passes the same
 * rules as a live-update photo (JPEG/PNG/WebP, non-empty alt). Payload itself only checks relationTo and the
 * id format, so an out-of-range id would otherwise be stored and later fail every depth>=1 read with a 500.
 * Runs on every write that carries `content`; skipped for trusted seed/system calls.
 */
const validateBodyImages: CollectionBeforeValidateHook = async ({ data, req }) => {
  const ctx = (req.context ?? {}) as { seed?: boolean }
  if (ctx.seed === true || !data || data.content === undefined) return data
  const seen = new Set<number>()
  for (const node of collectUploadNodes(data.content)) {
    if (node.relationTo !== 'media') {
      throw new APIError('Images in the article body must come from the media library (relationTo "media").', 400)
    }
    const id = uploadValueId(node.value)
    if (!isMediaId(id)) {
      throw new APIError('An image in the article body has an invalid media id (expected an integer from 1 to 2147483647).', 400)
    }
    if (seen.has(id)) continue
    seen.add(id)
    await assertAttachableImage(req, id, `An image in the article body (media ${id})`)
  }
  for (const id of collectGalleryMedia(data.content)) {
    if (seen.has(id)) continue
    seen.add(id)
    await assertAttachableImage(req, id, `A gallery image (media ${id})`)
  }
  return data
}

/**
 * Every `audioVideo` block that names a media file must point at a real audio/video file whose type is allowed for the
 * block kind (video: mp4/webm; audio: mp3/m4a/ogg) with a description, and a poster must be a JPEG/PNG/WebP image.
 * A block with only a legacy `sourceUrl` has nothing to check here (its shape is checked by validateEmbeds). Runs
 * after validateEmbeds, on every write that carries `content`; skipped for trusted seed/system calls.
 */
const validateAvMedia: CollectionBeforeValidateHook = async ({ data, req }) => {
  const ctx = (req.context ?? {}) as { seed?: boolean }
  if (ctx.seed === true || !data || data.content === undefined) return data
  for (const entry of collectAvBlocks(data.content)) {
    if (entry.media !== undefined) await assertAttachableAv(req, entry.media, entry.kind, `The audio/video file (media ${entry.media})`)
    if (entry.poster !== undefined) await assertAttachableImage(req, entry.poster, `The audio/video poster (media ${entry.poster})`)
  }
  return data
}

/**
 * The featured image must be an image (JPEG/PNG/WebP): audio and video files in the Media library are for the
 * `audioVideo` block only. Checked whenever a featured image is set (create or update); skipped for trusted seed calls.
 */
const validateFeaturedImage: CollectionBeforeValidateHook = async ({ data, req }) => {
  const ctx = (req.context ?? {}) as { seed?: boolean }
  if (ctx.seed === true || !data || data.featuredImage === undefined || data.featuredImage === null) return data
  const id = idOf(data.featuredImage)
  const media = (await req.payload
    .findByID({ collection: 'media', id: id as number, depth: 0, overrideAccess: true, req })
    .catch(() => null)) as { mimeType?: string | null } | null
  if (media && !(typeof media.mimeType === 'string' && ALLOWED_IMAGE_MIME.includes(media.mimeType))) {
    throw new APIError('The featured image must be a JPEG, PNG or WebP image.', 400)
  }
  return data
}

/**
 * `categories` (secondary categories) next to the primary `category`: at most 5, no duplicates, never the primary. On a
 * partial update the missing side comes from the stored document, so changing only `category` cannot make it collide with
 * an existing extra.
 */
const validateSecondaryCategories: CollectionBeforeValidateHook = async ({ data, originalDoc, req }) => {
  if (!data || (data.categories === undefined && data.category === undefined)) return data
  const orig = (originalDoc ?? {}) as Doc
  const list = data.categories !== undefined ? data.categories : orig.categories
  const primary = data.category !== undefined ? data.category : orig.category
  const message = checkSecondaryCategories(primary, list)
  if (message) throw new APIError(message, 400)
  if (data.categories !== undefined) {
    // An id that is not a category would otherwise end in a foreign-key error (500).
    const wanted = categoryIds(data.categories)
    if (wanted.length > 0) {
      const found = await req.payload.find({
        collection: 'categories',
        where: { id: { in: wanted.map(Number) } },
        limit: wanted.length,
        depth: 0,
        pagination: false,
        overrideAccess: true,
        req,
      })
      if (found.docs.length !== wanted.length) throw new APIError('Additional categories must be existing categories.', 400)
    }
  }
  return data
}

/**
 * Waves 1-2 newsroom fields (docs/w12/schema-contract.md), checked server-side whatever the client: kicker (plain text, 60),
 * key points (at most 5 x 200 characters of plain text), `lastSubstantiveUpdate` (a real date, not in the future; set by an
 * editor, never automatically), topics (at most 10, existing) and `bylineAuthor` (an existing author profile). Ids that do not
 * exist would otherwise end in a foreign-key error (500). Runs for seed and import too: they must not store bad values either.
 */
const validateNewsroomFields: CollectionBeforeValidateHook = async ({ data, req }) => {
  if (!data) return data
  if ('kicker' in data) {
    if (data.kicker === '' || data.kicker === null) data.kicker = null
    else {
      if (typeof data.kicker === 'string') data.kicker = data.kicker.trim() || null
      const p = plainTextProblem(data.kicker, 'The kicker', KICKER_MAX)
      if (p) throw new APIError(p, 400)
    }
  }
  if ('contentType' in data && data.contentType !== null && !(CONTENT_TYPES as readonly unknown[]).includes(data.contentType)) {
    throw new APIError(`contentType must be one of: ${CONTENT_TYPES.join(', ')}.`, 400)
  }
  if ('keyPoints' in data) {
    if (data.keyPoints === null) data.keyPoints = []
    if (Array.isArray(data.keyPoints)) {
      data.keyPoints = (data.keyPoints as unknown[]).map((r) =>
        r && typeof r === 'object' && typeof (r as { text?: unknown }).text === 'string'
          ? { ...(r as object), text: (r as { text: string }).text.trim() }
          : r,
      )
    }
    const p = keyPointsProblem(data.keyPoints)
    if (p) throw new APIError(p, 400)
  }
  if ('lastSubstantiveUpdate' in data) {
    if (data.lastSubstantiveUpdate === '') data.lastSubstantiveUpdate = null
    const p = updateStampProblem(data.lastSubstantiveUpdate)
    if (p) throw new APIError(p, 400)
  }
  if (data.topics !== undefined && data.topics !== null) {
    if (!Array.isArray(data.topics)) throw new APIError('Topics must be a list.', 400)
    const wanted = [...new Set((data.topics as unknown[]).map((t) => String(idOf(t))))]
    if (wanted.some((id) => !/^[1-9]\d{0,9}$/.test(id))) throw new APIError('Topics must be topic ids.', 400)
    if (wanted.length > TOPICS_PER_ARTICLE_MAX) throw new APIError(`At most ${TOPICS_PER_ARTICLE_MAX} topics per article.`, 400)
    if (wanted.length > 0) {
      const found = await req.payload.count({ collection: 'topics', where: { id: { in: wanted.map(Number) } }, overrideAccess: true, req })
      if (found.totalDocs !== wanted.length) throw new APIError('Topics must be existing topics.', 400)
    }
    data.topics = wanted.map(Number)
  }
  if (data.bylineAuthor === '') data.bylineAuthor = null
  if (data.bylineAuthor !== undefined && data.bylineAuthor !== null) {
    const id = String(idOf(data.bylineAuthor))
    if (!/^[1-9]\d{0,9}$/.test(id)) throw new APIError('bylineAuthor must be an author profile id.', 400)
    const found = await req.payload.count({ collection: 'authors', where: { id: { equals: Number(id) } }, overrideAccess: true, req })
    if (found.totalDocs !== 1) throw new APIError('bylineAuthor must be an existing author profile.', 400)
    data.bylineAuthor = Number(id)
  }
  return data
}

/**
 * `bodyMedia` is derived, server-only: the distinct media ids referenced by the body's upload nodes. It exists
 * so the media freeze (collections/Media.ts) can find "media shown in a published article body" with a plain
 * query instead of scanning jsonb. Recomputed whenever `content` is written (client values are stripped by field
 * access before this runs).
 */
const deriveBodyMedia: CollectionBeforeChangeHook = ({ data }) => {
  if (data.content === undefined) return data
  const ids: number[] = []
  for (const node of collectUploadNodes(data.content)) {
    const id = uploadValueId(node.value)
    if (node.relationTo === 'media' && isMediaId(id) && !ids.includes(id)) ids.push(id)
  }
  const av = collectAvMedia(data.content)
  for (const id of [...av.media, ...av.poster, ...collectGalleryMedia(data.content)]) if (!ids.includes(id)) ids.push(id)
  data.bodyMedia = ids
  return data
}

const CONTENT_KEYS = [
  'title',
  'slug',
  'excerpt',
  'content',
  'featuredImage',
  'bylineName',
  'seoTitle',
  'seoDescription',
  // Waves 1-2: the same who-may-edit rule (a reporter cannot change them once the story is in review).
  'kicker',
  'contentType',
  'keyPoints',
  'lastSubstantiveUpdate',
  'topics',
  'bylineAuthor',
] as const

/** The comparable value of a content key: relationship ids rather than populated objects, key-point texts without row ids. */
const comparable = (key: (typeof CONTENT_KEYS)[number], value: unknown): unknown => {
  if (key === 'featuredImage' || key === 'bylineAuthor') return idOf(value) ?? null
  if (key === 'topics') return Array.isArray(value) ? value.map((t) => String(idOf(t))) : []
  if (key === 'keyPoints') return keyPointTexts(value)
  if (key === 'lastSubstantiveUpdate') return value ? new Date(value as string).getTime() : null
  if (key === 'kicker' || key === 'contentType') return value ?? null
  return value
}

const fail = (status: number, message: string): never => {
  throw new APIError(message, status)
}

/*
 * VERIFIED against payload@3.90.2 (collections/operations/utilities/update.js and
 * fields/hooks/beforeValidate/promise.js): field-level `access.create/update` is evaluated in the
 * *beforeValidate* field phase, where a denied field is deleted from client input and replaced by the
 * stored value. Collection `beforeChange` hooks run afterwards, so values this hook assigns to
 * `publishedAt` / `author` are kept. Local-API calls with `overrideAccess: true` skip field access.
 *
 * req.context cannot be set by REST clients, only by server code (scheduler: systemTransition,
 * seed: seed).
 */
const enforceWorkflow: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req }) => {
  const ctx = (req.context ?? {}) as {
    seed?: boolean
    systemTransition?: boolean
    systemNow?: string
    restoreVersion?: boolean
    correctionAmended?: boolean
    import?: boolean
  }
  const isCreate = operation === 'create'
  const orig = (originalDoc ?? {}) as Doc
  const now = ctx.systemNow ? new Date(ctx.systemNow) : new Date()

  if (ctx.seed === true) return data
  // Archive importer (src/import/run.ts): server-side only. Skips the editorial workflow (the import publishes the
  // archive as it was) but NOT the validators (embeds, body images, SEO fields, slug rules), unlike seed.
  if (ctx.import === true) return data

  const prevStatus = (isCreate ? undefined : orig.status) as ArticleStatus | undefined
  const nextStatus = (data.status ?? prevStatus ?? 'draft') as ArticleStatus
  if (!isArticleStatus(nextStatus)) return fail(400, `Unknown status "${String(data.status)}".`)

  if (ctx.systemTransition === true) {
    const res = canTransition({ user: null, from: prevStatus, to: nextStatus, isAuthor: false, system: true })
    if (!res.ok) return fail(res.status, res.message)
    if (!orig.publishedAt) data.publishedAt = now.toISOString()
    return data
  }

  const user = asUser(req.user)
  if (!isStaff(user)) return fail(403, 'Not permitted.')

  // author: set to caller on create; only editors may change it afterwards (field access enforces).
  if (isCreate) {
    const requested = idOf(data.author)
    data.author = requested !== undefined && isEditorRole(user) ? requested : user!.id
  }
  const authorId = isCreate ? idOf(data.author) : idOf(orig.author)
  const isAuthor = authorId !== undefined && String(authorId) === String(user!.id)

  const categoryId = idOf(data.category ?? orig.category)
  const origCategoryId = idOf(orig.category)

  // --- content editing ---------------------------------------------------------------------
  if (!isCreate) {
    const contentChanged =
      CONTENT_KEYS.some(
        (k) => k in data && !same(comparable(k, data[k]), comparable(k, orig[k])),
      ) ||
      (data.category !== undefined && String(idOf(data.category)) !== String(origCategoryId))
    if (contentChanged) {
      const okNow = canEditContent({ user, status: prevStatus, isAuthor, categoryId: origCategoryId })
      const okNew = canEditContent({ user, status: prevStatus, isAuthor, categoryId })
      if (!okNow || !okNew) return fail(403, 'Not permitted to edit this article in its current state.')
    }
  }

  // --- corrections: append-only ---------------------------------------------------------------
  // restoreVersion by an admin / editor-in-chief replaces the whole document with an older version;
  // that is an amendment of history by definition and is audited as `article.restore`.
  const restoring = ctx.restoreVersion === true && isEditorInChief(user)
  let correctionsAdded = 0
  if (isCreate && Array.isArray(data.corrections)) {
    // New articles: the server clock stamps every entry, whatever the client sent.
    data.corrections = (data.corrections as Doc[]).map((c) => ({ note: c.note, correctedAt: now.toISOString() }))
  } else if (!isCreate && !restoring && data.corrections !== undefined) {
    const rec = reconcileCorrections(orig.corrections, data.corrections, { now, canAmend: isEditorInChief(user) })
    if (!rec.ok) return fail(400, rec.message)
    if (rec.changed && !canEditContent({ user, status: prevStatus, isAuthor, categoryId: origCategoryId })) {
      return fail(403, 'Not permitted to edit corrections on this article.')
    }
    if (rec.amended) ctx.correctionAmended = true
    data.corrections = rec.rows
    correctionsAdded = rec.added
  }

  // --- status transition --------------------------------------------------------------------
  const res = canTransition({ user, from: prevStatus, to: nextStatus, isAuthor, categoryId, isCreate })
  if (!res.ok) return fail(res.status, res.message)
  // moving an article out of an out-of-scope category must also be allowed for the old category
  if (
    !isCreate &&
    prevStatus !== nextStatus &&
    origCategoryId !== undefined &&
    String(origCategoryId) !== String(categoryId)
  ) {
    const r2 = canTransition({ user, from: prevStatus, to: nextStatus, isAuthor, categoryId: origCategoryId })
    if (!r2.ok) return fail(r2.status, r2.message)
  }

  // --- scheduling ---------------------------------------------------------------------------
  if (nextStatus === 'scheduled') {
    const when = (data.scheduledFor ?? orig.scheduledFor) as string | undefined
    const changed =
      isCreate ||
      prevStatus !== 'scheduled' ||
      (data.scheduledFor !== undefined && !same(data.scheduledFor, orig.scheduledFor))
    if (!when || Number.isNaN(new Date(when).getTime())) {
      return fail(400, 'scheduledFor is required to schedule an article.')
    }
    if (changed && new Date(when).getTime() <= now.getTime()) {
      return fail(400, 'scheduledFor must be in the future.')
    }
  }

  // --- publishedAt (server-owned) -------------------------------------------------------------
  if (nextStatus === 'published' && !orig.publishedAt) data.publishedAt = now.toISOString()

  // --- corrections on published articles -------------------------------------------------------
  if (!isCreate && !restoring && prevStatus === 'published' && nextStatus === 'published') {
    const material = (['title', 'excerpt', 'content'] as const).some(
      (k) => k in data && !same(data[k], orig[k]),
    )
    if (material && correctionsAdded < 1) {
      return fail(400, 'Editing a published article requires adding a corrections entry.')
    }
  }

  return data
}

/**
 * Archive-candidate articles (provenance.importBatch set) cannot be published or scheduled until an editor sets
 * provenance.reviewStatus to "reviewed". Applies to every caller, including the scheduler, seed and importer.
 */
const guardUnreviewedImport: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
  const orig = (originalDoc ?? undefined) as Record<string, unknown> | undefined
  // restoreVersion replaces the whole document with an old snapshot. Provenance and its review decision are not content: an
  // old "reviewed" must never overrule a later "rejected" (or "pending"), so the stored provenance always wins on a restore.
  if ((req.context as { restoreVersion?: boolean } | undefined)?.restoreVersion === true && orig && orig.provenance !== undefined) {
    ;(data as Record<string, unknown>).provenance = orig.provenance
  }
  // A review decision only means something on a recovered archive article (one with an import batch, which only the importer sets).
  {
    const incoming = (data as Record<string, unknown>).provenance as { reviewStatus?: unknown; importBatch?: unknown } | undefined
    if (incoming && typeof incoming === 'object' && incoming.reviewStatus !== undefined && incoming.reviewStatus !== null) {
      const storedBatch = (orig?.provenance as { importBatch?: unknown } | undefined)?.importBatch
      const batch = 'importBatch' in incoming ? incoming.importBatch : storedBatch
      if (typeof batch !== 'string' || batch === '') return fail(400, 'A review status can only be set on a recovered archive article.')
    }
  }
  // Approving and publishing a recovered article are separate decisions: not in one request, unless the actor is an admin.
  const actor = asUser(req.user)
  if (actor && actor.role !== 'admin' && reviewAndPublishInOneWrite(data as Record<string, unknown>, orig)) {
    return fail(409, 'Mark a recovered archive article as reviewed first, then publish or schedule it in a separate request.')
  }
  if (publishBlockedByProvenance(data as Record<string, unknown>, (originalDoc ?? undefined) as Record<string, unknown> | undefined)) {
    return fail(409, 'This recovered archive article must be reviewed (provenance review status "reviewed") before it can be published or scheduled.')
  }
  // Server-owned review stamp: whoever flips reviewStatus to "reviewed" is recorded; any client-sent value is overwritten.
  const ctx = (req.context ?? {}) as { systemNow?: string }
  const stamp = reviewStamp(data as Record<string, unknown>, orig, actor, ctx.systemNow ? new Date(ctx.systemNow) : new Date())
  const d = data as Record<string, unknown>
  const prov = d.provenance as Record<string, unknown> | undefined
  if (stamp) {
    d.provenance = { ...(prov ?? {}), ...stamp }
  } else if (prov && typeof prov === 'object') {
    // Not a review change: nothing a client or a restored snapshot sent may alter the stamp (the stored values stay).
    const { reviewedBy: _by, reviewedByName: _name, reviewedAt: _at, ...rest } = prov
    d.provenance = rest
  }
  // Four-eyes: the approver of a recovered article cannot publish or schedule it (admins may do both). Covers REST, bulk,
  // Local API with a user and version restore; the scheduler has no user and publishes what a different person scheduled.
  const approver = stamp ? stamp.reviewedBy : storedReviewedBy(orig)
  if (fourEyesBlocked({ data: d, orig, actor, reviewedById: approver })) return fail(409, FOUR_EYES_MESSAGE)
  return data
}

/**
 * A published article's slug is its public address. Changing it breaks every link, bookmark and search result for the
 * old URL, so after `publishedAt` is set only an editor-in-chief or admin may change it (403 otherwise). Server-side
 * callers (seed, archive importer, scheduler) are exempt: the importer owns its own slugs and redirects.
 */
const slugGuardExempt = (req: { context?: unknown }): boolean => {
  const ctx = (req.context ?? {}) as { seed?: boolean; import?: boolean; systemTransition?: boolean }
  return ctx.seed === true || ctx.import === true || ctx.systemTransition === true
}

const guardPublishedSlug: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req }) => {
  if (operation === 'create' || slugGuardExempt(req)) return data
  const orig = (originalDoc ?? {}) as Doc
  if (!orig.publishedAt || typeof data.slug !== 'string' || data.slug === orig.slug) return data
  if (!isEditorInChief(asUser(req.user))) {
    return fail(403, 'The URL slug of a published story can only be changed by the editor-in-chief or an admin.')
  }
  return data
}

/**
 * Audit a slug change on a published article and keep the old URL alive: a 301 rule old -> new in `redirects` (C7).
 * Rules already pointing at the old address are re-pointed at the new one (no chains), and a stale rule sending the new
 * address back to the old one is removed. Runs in the request transaction: if the redirect cannot be written (for example
 * a conflicting rule) the whole slug change is rolled back with an error.
 */
const redirectOnSlugChange: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  if (operation !== 'update' || slugGuardExempt(req)) return doc
  const prev = (previousDoc ?? {}) as Doc
  const next = doc as Doc
  if (!prev.publishedAt || typeof prev.slug !== 'string' || typeof next.slug !== 'string' || prev.slug === next.slug) return doc

  const template = resolveArticlePathTemplate()
  const oldPath = articlePath(template, prev.slug)
  const newPath = articlePath(template, next.slug)
  const opts = { overrideAccess: true, req, depth: 0, limit: 100 } as const

  const back = await req.payload.find({ collection: 'redirects', where: { and: [{ from: { equals: newPath } }, { to: { equals: oldPath } }] }, ...opts })
  for (const r of back.docs) await req.payload.delete({ collection: 'redirects', id: r.id, overrideAccess: true, req })

  const pointing = await req.payload.find({ collection: 'redirects', where: { to: { equals: oldPath } }, ...opts })
  for (const r of pointing.docs) {
    await req.payload.update({ collection: 'redirects', id: r.id, data: { to: newPath }, overrideAccess: true, req })
  }

  const existing = await req.payload.find({ collection: 'redirects', where: { from: { equals: oldPath } }, ...opts })
  const note = `Slug of article ${String(doc.id)} changed from "${prev.slug}" to "${next.slug}"`
  if (existing.docs[0]) {
    await req.payload.update({
      collection: 'redirects',
      id: existing.docs[0].id,
      data: { to: newPath, status: 301, note },
      overrideAccess: true,
      req,
    })
  } else {
    await req.payload.create({
      collection: 'redirects',
      data: { from: oldPath, to: newPath, status: 301, source: 'manual', note },
      overrideAccess: true,
      req,
    })
  }
  await writeAuditLog(req, {
    action: 'article.slug-change',
    collection: 'articles',
    docId: doc.id,
    toStatus: next.status as string,
    summary: `Slug changed: ${prev.slug} -> ${next.slug}`,
    details: { before: prev.slug, after: next.slug, redirect: `${oldPath} -> ${newPath}` },
  })
  return doc
}

const auditChanges: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  const ctx = (req.context ?? {}) as {
    seed?: boolean
    systemTransition?: boolean
    restoreVersion?: boolean
    correctionAmended?: boolean
  }
  if (ctx.seed === true) return doc
  const actorRole = ctx.systemTransition ? 'system' : undefined
  const title = String((doc as Doc).title ?? '')

  if (operation === 'create') {
    await writeAuditLog(req, {
      action: 'create',
      collection: 'articles',
      docId: doc.id,
      toStatus: doc.status,
      summary: title,
      actorRole,
    })
    // An article created already approved or rejected is a review decision too.
    const createdReview = (doc.provenance as { reviewStatus?: unknown } | null | undefined)?.reviewStatus
    if (typeof createdReview === 'string' && createdReview !== 'pending') {
      await writeAuditLog(req, {
        action: 'archive.review',
        collection: 'articles',
        docId: doc.id,
        toStatus: doc.status,
        summary: `Archive review status none -> ${createdReview} (at creation): ${title}`.slice(0, 1000),
        details: { from: null, to: createdReview },
        actorRole,
      })
    }
    return doc
  }
  const prev = (previousDoc ?? {}) as Doc
  if (prev.status !== doc.status) {
    await writeAuditLog(req, {
      action: 'status-change',
      collection: 'articles',
      docId: doc.id,
      fromStatus: prev.status as string,
      toStatus: doc.status,
      summary: title,
      actorRole,
    })
  }
  const prevReview = (prev.provenance as { reviewStatus?: unknown } | null | undefined)?.reviewStatus ?? null
  const nextReview = (doc.provenance as { reviewStatus?: unknown } | null | undefined)?.reviewStatus ?? null
  if (prevReview !== nextReview && typeof nextReview === 'string') {
    // Archive-candidate review decision (docs/archive-candidate-schema.md): who and when come from the audit row's actor and createdAt.
    await writeAuditLog(req, {
      action: 'archive.review',
      collection: 'articles',
      docId: doc.id,
      toStatus: doc.status,
      summary: `Archive review status ${String(prevReview ?? 'none')} -> ${nextReview}: ${title}`.slice(0, 1000),
      details: { from: prevReview, to: nextReview },
      actorRole,
    })
  }
  const before = Array.isArray(prev.corrections) ? prev.corrections.length : 0
  const after = Array.isArray(doc.corrections) ? doc.corrections.length : 0
  if (after > before) {
    await writeAuditLog(req, {
      action: 'correction',
      collection: 'articles',
      docId: doc.id,
      toStatus: doc.status,
      summary: `${after - before} correction(s) added`,
      actorRole,
    })
  }
  if (ctx.correctionAmended) {
    await writeAuditLog(req, {
      action: 'correction.amend',
      collection: 'articles',
      docId: doc.id,
      toStatus: doc.status,
      summary: `Corrections history amended (${before} -> ${after} entries)`,
      details: { before: prev.corrections ?? [], after: doc.corrections ?? [] },
      actorRole,
    })
  }
  if (ctx.restoreVersion) {
    await writeAuditLog(req, {
      action: 'article.restore',
      collection: 'articles',
      docId: doc.id,
      toStatus: doc.status,
      summary: `Article restored from an earlier version (${before} -> ${after} corrections)`,
      actorRole,
    })
  }
  return doc
}

/**
 * Go-live C6: an article that still has archived legacy comments cannot be deleted (409). The comments belong to the
 * archive and `legacy-comments.article` is required, so the delete would otherwise fail inside the database (500) or,
 * if we deleted the comments for the editor, silently destroy archive data. An admin deletes the comments first
 * (audited), or the article is archived instead.
 */
const refuseDeleteWithLegacyComments: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const found = await req.payload.count({
    collection: 'legacy-comments',
    where: { article: { equals: id } },
    overrideAccess: true,
    req,
  })
  if (found.totalDocs > 0) {
    throw new APIError(
      `This article has ${found.totalDocs} archived comment${found.totalDocs === 1 ? '' : 's'}. Archive the article instead, or ask an admin to delete its comments first.`,
      409,
    )
  }
}

/** Keep the public search projection in step (published: upsert; any other status: remove). Also runs for the importer and seeds. */
const syncSearch: CollectionAfterChangeHook = async ({ doc, req }) => {
  await syncArticleSearch(req, doc)
  return doc
}

const dropSearch: CollectionAfterDeleteHook = async ({ doc, req }) => {
  await removeArticleSearch(req, doc.id)
  return doc
}

const auditDelete: CollectionAfterDeleteHook =async ({ doc, req }) => {
  if ((req.context as { seed?: boolean } | undefined)?.seed === true) return doc
  await writeAuditLog(req, {
    action: 'delete',
    collection: 'articles',
    docId: doc.id,
    fromStatus: doc.status,
    summary: String(doc.title ?? ''),
  })
  return doc
}

// ---------------------------------------------------------------------------------------------

export const Articles: CollectionConfig = {
  slug: 'articles',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'status', 'category', 'updatedAt'],
    listSearchableFields: ['title', 'slug'],
  },
  // Public list (status = published, newest first): a composite index lets Postgres read
  // the page from the index (scanned backwards) instead of sorting every article row. See docs/performance.md.
  indexes: [{ fields: ['status', 'publishedAt', 'createdAt'] }],
  versions: { maxPerDoc: 50 },
  endpoints: [articlePreviewTokenEndpoint],
  access: {
    read: readAccess,
    create: staffOnly,
    update: updateAccess,
    delete: editorInChiefOnly,
    readVersions: readVersionsAccess,
  },
  hooks: {
    beforeOperation: [clampLimit, markRestore, dropNullProvenance, captureExpectedUpdatedAt],
    beforeValidate: [autoSlug, normalizeSeoFields, validateNewsroomFields, validateEmbeds, validateBodyImages, validateAvMedia, validateFeaturedImage, validateSecondaryCategories],
    beforeChange: [assertExpectedUpdatedAt('articles'), guardUnreviewedImport, deriveBodyMedia, guardPublishedSlug, enforceWorkflow],
    beforeDelete: [refuseDeleteWithLegacyComments],
    afterChange: [auditChanges, redirectOnSlugChange, syncSearch],
    afterDelete: [auditDelete, dropSearch],
  },
  fields: [
    { name: 'title', type: 'text', required: true, maxLength: 240 },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      maxLength: 160,
      admin: { position: 'sidebar', description: 'Generated from the title when left empty.' },
      validate: (value: unknown) => {
        if (typeof value !== 'string' || value.length === 0) return 'Slug is required.'
        if (value.length > 160) return 'Slug must be at most 160 characters.'
        if (!SLUG_RE.test(value)) return 'Use lowercase letters, numbers and single hyphens only.'
        if (rootSlugsApply() && isReservedSlug(value)) return `"${value}" is reserved for a site page; choose another slug.`
        return true
      },
    },
    { name: 'excerpt', type: 'textarea', maxLength: 600 },
    {
      // Waves 1-2: short label above the headline ("Exclusive", "Analysis: Kaduna"). Plain text.
      name: 'kicker',
      type: 'text',
      maxLength: KICKER_MAX,
      validate: plainTextValidator('The kicker', KICKER_MAX),
      admin: { description: `Optional short label above the headline, up to ${KICKER_MAX} characters.` },
    },
    {
      // Reader-facing label of the story type. Legacy rows read as "news". "sponsored" must be used for paid content.
      name: 'contentType',
      type: 'select',
      defaultValue: DEFAULT_CONTENT_TYPE,
      options: CONTENT_TYPES.map((v) => ({ label: CONTENT_TYPE_LABELS[v], value: v })),
      admin: { position: 'sidebar', description: 'Shown to readers. Use "Sponsored" for any paid or partner content.' },
    },
    {
      name: 'keyPoints',
      type: 'array',
      maxRows: KEY_POINTS_MAX,
      labels: { singular: 'Key point', plural: 'Key points' },
      admin: { description: `"What you need to know": up to ${KEY_POINTS_MAX} short points, each up to ${KEY_POINT_MAX} characters.` },
      fields: [
        { name: 'text', type: 'text', required: true, maxLength: KEY_POINT_MAX, validate: plainTextValidator('Each key point', KEY_POINT_MAX, { required: true }) },
      ],
    },
    {
      // Editor-set only (never stamped automatically): shown to readers as "Updated <date>".
      name: 'lastSubstantiveUpdate',
      type: 'date',
      validate: (v: unknown) => updateStampProblem(v) ?? true,
      admin: {
        position: 'sidebar',
        date: { pickerAppearance: 'dayAndTime' },
        description: 'Set only when the story changed in substance; readers see "Updated" with this date.',
      },
    },
    {
      name: 'topics',
      type: 'relationship',
      relationTo: 'topics',
      hasMany: true,
      maxRows: TOPICS_PER_ARTICLE_MAX,
      admin: { position: 'sidebar', description: `Up to ${TOPICS_PER_ARTICLE_MAX} topics readers can follow. Only public topics are shown to readers.` },
    },
    {
      // Public byline profile (author page). `bylineName` stays the fallback text byline; `author` stays the staff account.
      name: 'bylineAuthor',
      type: 'relationship',
      relationTo: 'authors',
      index: true,
      admin: { position: 'sidebar', description: 'Optional author profile for the byline link. Only public profiles are shown to readers.' },
    },
    {
      name: 'seoTitle',
      type: 'text',
      maxLength: SEO_TITLE_MAX,
      validate: seoFieldValidator('seoTitle'),
      admin: { description: `Optional search-result title, up to ${SEO_TITLE_MAX} characters. Leave empty to use the headline.` },
    },
    {
      name: 'seoDescription',
      type: 'textarea',
      maxLength: SEO_DESCRIPTION_MAX,
      validate: seoFieldValidator('seoDescription'),
      admin: { description: `Optional search-result description, up to ${SEO_DESCRIPTION_MAX} characters. Leave empty to use the excerpt.` },
    },
    { name: 'content', type: 'richText', required: true, editor: articleContentEditor },
    {
      name: 'category',
      type: 'relationship',
      relationTo: 'categories',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    {
      // Additional (secondary) categories; `category` above stays the primary one. Public read like `category`.
      name: 'categories',
      type: 'relationship',
      relationTo: 'categories',
      hasMany: true,
      maxRows: MAX_SECONDARY_CATEGORIES,
      admin: { position: 'sidebar', description: 'Optional extra sections (up to 5). The primary category above is not repeated here.' },
    },
    { name: 'featuredImage', type: 'upload', relationTo: 'media' },
    {
      // Derived from `content` by deriveBodyMedia; never client-writable, staff-readable only.
      name: 'bodyMedia',
      type: 'relationship',
      relationTo: 'media',
      hasMany: true,
      access: { read: staffRead, create: never, update: never },
      admin: { readOnly: true, hidden: true },
    },
    {
      name: 'author',
      type: 'relationship',
      relationTo: 'users',
      index: true,
      access: { read: staffRead, create: editorWrite, update: editorWrite },
      admin: { position: 'sidebar' },
    },
    { name: 'bylineName', type: 'text', maxLength: 200 },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'draft',
      index: true,
      options: ARTICLE_STATUSES.map((s) => ({ label: s, value: s })),
      admin: { position: 'sidebar' },
    },
    {
      name: 'publishedAt',
      type: 'date',
      index: true,
      // Public read; never client-writable. Set by the beforeChange hook.
      access: { create: never, update: never },
      admin: { position: 'sidebar', readOnly: true, date: { pickerAppearance: 'dayAndTime' } },
    },
    {
      name: 'scheduledFor',
      type: 'date',
      index: true,
      access: { read: staffRead },
      admin: {
        position: 'sidebar',
        condition: (data) => data?.status === 'scheduled',
        date: { pickerAppearance: 'dayAndTime' },
      },
    },
    {
      name: 'reviewNotes',
      type: 'textarea',
      access: { read: staffRead, create: editorWrite, update: editorWrite },
    },
    {
      name: 'corrections',
      type: 'array',
      labels: { singular: 'Correction', plural: 'Corrections' },
      fields: [
        {
          name: 'correctedAt',
          type: 'date',
          required: true,
          defaultValue: () => new Date().toISOString(),
        },
        { name: 'note', type: 'textarea', required: true },
      ],
    },
    // Server-owned (set by the archive importer through the Local API, which skips field access): no client may
    // set or change them, or one article could claim another's WordPress id and hijack its redirects.
    { name: 'legacyUrl', type: 'text', access: { create: never, update: never } },
    { name: 'legacyId', type: 'number', index: true, unique: true, access: { create: never, update: never } },
    {
      // Archive-candidate provenance (docs/archive-candidate-schema.md). Staff-only: never on a public projection.
      // Everything is server-owned (importer, Local API) except reviewStatus, which editors flip in the admin.
      name: 'provenance',
      type: 'group',
      access: { read: staffRead, create: never, update: editorWrite },
      admin: { description: 'Where a recovered archive article came from. Review it, then set the review status to "reviewed" before publishing.' },
      fields: [
        { name: 'sourceUrl', type: 'text', index: true, maxLength: 2000, access: { read: staffRead, create: never, update: never }, admin: { readOnly: true } },
        { name: 'sourceHost', type: 'text', maxLength: 253, access: { read: staffRead, create: never, update: never }, admin: { readOnly: true } },
        { name: 'captureTimestamp', type: 'date', access: { read: staffRead, create: never, update: never }, admin: { readOnly: true } },
        { name: 'originalDate', type: 'date', access: { read: staffRead, create: never, update: never }, admin: { readOnly: true, description: 'Publication date claimed by the recovered page (not verified).' } },
        { name: 'sourceSha256', type: 'text', index: true, maxLength: 64, access: { read: staffRead, create: never, update: never }, admin: { readOnly: true } },
        {
          name: 'confidence',
          type: 'select',
          options: PROVENANCE_CONFIDENCE.map((v) => ({ label: v, value: v })),
          access: { read: staffRead, create: never, update: never },
          admin: { readOnly: true },
        },
        { name: 'importBatch', type: 'text', index: true, maxLength: 80, access: { read: staffRead, create: never, update: never }, admin: { readOnly: true } },
        {
          name: 'reviewStatus',
          type: 'select',
          options: PROVENANCE_REVIEW_STATUSES.map((v) => ({ label: v, value: v })),
          access: { read: staffRead, create: never, update: editorWrite },
        },
        // Server-set when reviewStatus changes to "reviewed" (four-eyes rule); cleared when it changes away. Never client-writable.
        { name: 'reviewedBy', type: 'relationship', relationTo: 'users', validate: (): true => true, access: { read: editorWrite, create: never, update: never }, admin: { readOnly: true } },
        // Display snapshot of the approver's name (section editors cannot read other users). Same visibility as reviewedBy.
        { name: 'reviewedByName', type: 'text', maxLength: 200, access: { read: editorWrite, create: never, update: never }, admin: { readOnly: true } },
        { name: 'reviewedAt', type: 'date', access: { read: editorWrite, create: never, update: never }, admin: { readOnly: true } },
      ],
    },
  ],
}
