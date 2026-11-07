import { APIError, type Access, type CollectionConfig, type Where } from 'payload'

import {
  idOf,
  isEditorForCategory,
  isEditorInChief,
  isEditorRole,
  isStaff,
  isTrustedPublisherForCategory,
  userSectionIds,
  type UserLike,
} from '../access/roles'
import { liveEventUpdatesEndpoint } from '../endpoints/liveEventUpdates'
import { auditDeleteHook, writeAuditLog } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'
import { cleanText, SLUG_RE, slugify } from '../lib/sanitize'

const asUser = (u: unknown) => u as UserLike | null | undefined

const canManage = (user: UserLike | null | undefined): boolean =>
  Boolean(user && (isEditorRole(user) || user.role === 'trusted-publisher'))

const read: Access = ({ req }) => {
  if (isStaff(asUser(req.user))) return true
  return { status: { in: ['live', 'ended'] } } as Where
}

const create: Access = ({ req }) => canManage(asUser(req.user))

/** admin/EIC: any. section-editor / trusted-publisher: events whose category is in their sections. */
const update: Access = ({ req }) => {
  const user = asUser(req.user)
  if (!user) return false
  if (isEditorInChief(user)) return true
  if (!canManage(user)) return false
  const sections = userSectionIds(user)
  if (sections.length === 0) return false
  return { category: { in: sections } } as Where
}

export const LiveEvents: CollectionConfig = {
  slug: 'live-events',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'status', 'startedAt'] },
  endpoints: [liveEventUpdatesEndpoint],
  access: {
    read,
    create,
    update,
    delete: ({ req }) => isEditorInChief(asUser(req.user)),
  },
  hooks: {
    beforeOperation: [clampLimit],
    afterDelete: [auditDeleteHook('live-events', (d) => (d.slug ? `slug ${d.slug}, status ${d.status}` : undefined))],
    beforeChange: [
      ({ data, originalDoc, operation, req }) => {
        const user = asUser(req.user)
        if (user) {
          const newCategory = idOf(data.category)
          const oldCategory = idOf(originalDoc?.category)
          const categoryChanged =
            operation === 'create' || (newCategory !== undefined && String(newCategory) !== String(oldCategory))
          if (categoryChanged) {
            const target = newCategory ?? oldCategory
            const ok = isEditorForCategory(user, target) || isTrustedPublisherForCategory(user, target)
            if (!ok) throw new APIError('This category is outside your sections.', 403)
          }
        }
        // Server-managed timestamps. The public discovery list sorts by -startedAt, and Postgres sorts NULL first in
        // a descending order, so a non-draft event must never keep an empty startedAt (an event created directly as
        // 'ended', or moved to 'ended' without ever being 'live', would otherwise push live events off the list).
        const status = data.status ?? originalDoc?.status
        const startedAt = data.startedAt !== undefined ? data.startedAt : originalDoc?.startedAt
        const endedAt = data.endedAt !== undefined ? data.endedAt : originalDoc?.endedAt
        const now = new Date().toISOString()
        if (status && status !== 'draft' && !startedAt) data.startedAt = now
        // ended -> live -> ended must not keep the first endedAt, and a live (or draft) event has no endedAt.
        const previous = operation === 'create' ? undefined : originalDoc?.status
        if (status === 'ended') {
          if ((previous !== 'ended' && !data.endedAt) || !endedAt) data.endedAt = now
        } else if (status === 'live' || status === 'draft') {
          data.endedAt = null
        }
        return data
      },
    ],
    afterChange: [
      async ({ doc, previousDoc, operation, req }) => {
        if ((req.context as { seed?: boolean } | undefined)?.seed === true) return doc
        if (operation === 'create' || previousDoc?.status !== doc.status) {
          await writeAuditLog(req, {
            action: operation === 'create' ? 'live-event.create' : 'live-event.status',
            collection: 'live-events',
            docId: doc.id,
            fromStatus: operation === 'create' ? null : previousDoc?.status,
            toStatus: doc.status,
            summary: `Live event "${doc.title}" ${operation === 'create' ? 'created as' : 'moved to'} ${doc.status}`,
          })
        }
        return doc
      },
    ],
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      required: true,
      maxLength: 240,
      hooks: { beforeValidate: [({ value }) => cleanText(value, { max: 240 })] },
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      maxLength: 160,
      validate: (value: unknown) =>
        typeof value === 'string' && SLUG_RE.test(value) ? true : 'Slug must be lowercase letters, numbers and hyphens.',
      admin: { description: 'Auto-generated from the title when left empty.' },
      hooks: {
        beforeValidate: [
          async ({ value, data, req, originalDoc }) => {
            if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase()
            if (originalDoc?.slug) return originalDoc.slug
            const base = slugify(String(data?.title ?? ''), 150, 'live-event')
            for (let i = 1; i <= 50; i++) {
              const candidate = i === 1 ? base : `${base}-${i}`
              const found = await req.payload.find({
                collection: 'live-events',
                where: { slug: { equals: candidate } },
                limit: 1,
                depth: 0,
                pagination: false,
                overrideAccess: true,
                req,
              })
              if (found.docs.length === 0) return candidate
            }
            return `${base}-${Date.now().toString(36)}`
          },
        ],
      },
    },
    {
      name: 'summary',
      type: 'textarea',
      maxLength: 1000,
      hooks: { beforeValidate: [({ value }) => (value ? cleanText(value, { multiline: true }) : value)] },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'draft',
      index: true,
      options: ['draft', 'live', 'ended'].map((s) => ({ label: s, value: s })),
    },
    { name: 'category', type: 'relationship', relationTo: 'categories', required: true, index: true },
    { name: 'startedAt', type: 'date' },
    { name: 'endedAt', type: 'date' },
  ],
}
