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
import {
  ARTICLE_STATUSES,
  type ArticleStatus,
  canEditContent,
  canTransition,
  isArticleStatus,
} from '../workflow/articleWorkflow'

export { ARTICLE_STATUSES }

const MAX_LIMIT = 100
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

/** Clamp client-driven list queries to MAX_LIMIT (Payload 3 has no collection-level maxLimit). */
const clampLimit: CollectionBeforeOperationHook = ({ args, operation }) => {
  if (operation === 'read' && args && typeof args === 'object' && !(args as Doc).overrideAccess) {
    const a = args as { limit?: number }
    if (a.limit !== undefined && (a.limit === 0 || a.limit > MAX_LIMIT)) a.limit = MAX_LIMIT
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

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

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
  const ctx = (req.context ?? {}) as { seed?: boolean; systemTransition?: boolean; systemNow?: string }
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
  if (!isCreate && prevStatus === 'published' && nextStatus === 'published') {
    const material = (['title', 'excerpt', 'content'] as const).some(
      (k) => k in data && !same(data[k], orig[k]),
    )
    if (material) {
      const origLen = Array.isArray(orig.corrections) ? orig.corrections.length : 0
      const incoming = Array.isArray(data.corrections) ? (data.corrections as Doc[]) : []
      if (incoming.length <= origLen) {
        return fail(400, 'Editing a published article requires adding a corrections entry.')
      }
      data.corrections = incoming.map((c, i) =>
        i >= origLen && !c.correctedAt ? { ...c, correctedAt: now.toISOString() } : c,
      )
    }
  }

  return data
}

const auditChanges: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  const ctx = (req.context ?? {}) as { seed?: boolean; systemTransition?: boolean }
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
  },
  hooks: {
    beforeOperation: [clampLimit],
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
