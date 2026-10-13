import { APIError } from 'payload'
import type {
  Access,
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
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
import { articlePreviewTokenEndpoint } from '../endpoints/articlePreviewToken'
import { writeAuditLog } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'
import { deepEqual } from '../lib/deepEqual'
import {
  ARTICLE_STATUSES,
  type ArticleStatus,
  canEditContent,
  canTransition,
  isArticleStatus,
} from '../workflow/articleWorkflow'
import { reconcileCorrections } from '../workflow/corrections'

export { ARTICLE_STATUSES }

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

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
  for (let i = 2; i < 50; i++) {
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

const CONTENT_KEYS = ['title', 'slug', 'excerpt', 'content', 'featuredImage', 'bylineName'] as const

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
  }
  const isCreate = operation === 'create'
  const orig = (originalDoc ?? {}) as Doc
  const now = ctx.systemNow ? new Date(ctx.systemNow) : new Date()

  if (ctx.seed === true) return data

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
        (k) =>
          k in data &&
          !same(
            k === 'featuredImage' ? idOf(data[k]) : data[k],
            k === 'featuredImage' ? idOf(orig[k]) : orig[k],
          ),
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

const auditDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
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
    beforeOperation: [clampLimit, markRestore],
    beforeValidate: [autoSlug],
    beforeChange: [enforceWorkflow],
    afterChange: [auditChanges],
    afterDelete: [auditDelete],
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
        return true
      },
    },
    { name: 'excerpt', type: 'textarea', maxLength: 600 },
    { name: 'content', type: 'richText', required: true },
    {
      name: 'category',
      type: 'relationship',
      relationTo: 'categories',
      required: true,
      index: true,
      admin: { position: 'sidebar' },
    },
    { name: 'featuredImage', type: 'upload', relationTo: 'media' },
    {
      name: 'author',
      type: 'relationship',
      relationTo: 'users',
      index: true,
      access: { read: staffRead, create: editorWrite, update: editorWrite },
      admin: { position: 'sidebar' },
    },
    { name: 'bylineName', type: 'text' },
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
    { name: 'legacyUrl', type: 'text' },
    { name: 'legacyId', type: 'number', index: true },
  ],
}
