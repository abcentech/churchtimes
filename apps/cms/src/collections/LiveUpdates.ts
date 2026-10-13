import {
  APIError,
  type Access,
  type CollectionConfig,
  type FieldAccess,
  type PayloadRequest,
  type Where,
} from 'payload'

import {
  idOf,
  isEditorForCategory,
  isEditorInChief,
  isEditorRole,
  isStaff,
  isTrustedPublisherForCategory,
  type UserLike,
} from '../access/roles'
import { writeAuditLog } from '../lib/audit'
import { cleanText } from '../lib/sanitize'

const asUser = (u: unknown) => u as UserLike | null | undefined
const sameId = (a: unknown, b: unknown) => a !== undefined && b !== undefined && String(a) === String(b)

const read: Access = ({ req }) => {
  const user = asUser(req.user)
  // Anonymous: approved updates of non-draft events only.
  const publicWhere: Where = {
    and: [{ status: { equals: 'approved' } }, { 'event.status': { in: ['live', 'ended'] } }],
  }
  if (!user || !isStaff(user)) return publicWhere
  if (isEditorRole(user)) return true // MVP: all editors read every update (incl. pending/rejected)
  return { or: [{ author: { equals: user.id } }, { status: { equals: 'approved' } }] } as Where
}

/**
 * Update access. Editors pass here; category scope for section-editors is checked in the
 * beforeChange hook (needs the event's category). Others only touch their own rows.
 */
const update: Access = ({ req }) => {
  const user = asUser(req.user)
  if (!user || !isStaff(user)) return false
  if (isEditorRole(user)) return true
  if (user.role === 'trusted-publisher') return { author: { equals: user.id } } as Where
  // reporter: own, still pending
  return { and: [{ author: { equals: user.id } }, { status: { equals: 'pending' } }] } as Where
}

const staffRead: FieldAccess = ({ req }) => isStaff(asUser(req.user))
const serverOnly = { create: () => false, update: () => false }

/**
 * Race note: `sequence` = max(sequence)+1 is read-then-write, so two concurrent creates for the same
 * event can compute the same value. The compound unique index (event, sequence) turns that into a
 * constraint violation (the second request fails and the client may retry) instead of duplicate
 * sequence numbers. Retry-once is not possible from inside a collection hook.
 */
async function nextSequence(
  req: PayloadRequest,
  eventId: number | string,
): Promise<number> {
  const last = await req.payload.find({
    collection: 'live-updates',
    where: { event: { equals: eventId } },
    sort: '-sequence',
    limit: 1,
    depth: 0,
    pagination: false,
    overrideAccess: true,
    select: { sequence: true },
    req,
  })
  const max = (last.docs[0] as { sequence?: number } | undefined)?.sequence ?? 0
  return max + 1
}

export const LiveUpdates: CollectionConfig = {
  slug: 'live-updates',
  admin: { useAsTitle: 'body', defaultColumns: ['event', 'sequence', 'status', 'occurredAt'] },
  access: {
    read,
    create: ({ req }) => isStaff(asUser(req.user)),
    update,
    delete: ({ req }) => isEditorInChief(asUser(req.user)),
  },
  indexes: [{ fields: ['event', 'sequence'], unique: true }],
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req }) => {
        const user = asUser(req.user)
        if (!user) return data // internal/system call (seed, scheduler): trusted

        const eventId = operation === 'create' ? idOf(data.event) : idOf(originalDoc?.event)
        if (eventId === undefined) throw new APIError('A live event is required.', 400)
        if (operation === 'update' && data.event !== undefined && !sameId(idOf(data.event), eventId)) {
          throw new APIError('The event of an update cannot be changed.', 403)
        }

        const event = (await req.payload
          .findByID({ collection: 'live-events', id: eventId, depth: 0, overrideAccess: true, req })
          .catch(() => null)) as { category?: unknown; status?: string } | null
        if (!event) throw new APIError('Live event not found.', 400)

        const categoryId = idOf(event.category)
        const editorInScope = isEditorForCategory(user, categoryId)
        const tpInScope = isTrustedPublisherForCategory(user, categoryId)

        if (isEditorRole(user) && !editorInScope) {
          throw new APIError('This live event is outside your sections.', 403)
        }
        if (event.status === 'ended' && !editorInScope) {
          throw new APIError('This live event has ended.', 403)
        }

        if (operation === 'create') {
          const wantsApproved = data.status === 'approved'
          const canApprove = editorInScope || tpInScope
          data.status = wantsApproved && canApprove ? 'approved' : 'pending'
          data.author = user.id
          if (data.status === 'approved') {
            data.approvedBy = user.id
            data.approvedAt = new Date().toISOString()
          } else {
            data.approvedBy = null
            data.approvedAt = null
          }
          data.sequence = await nextSequence(req, eventId)
          return data
        }

        // ---- update ----
        const own = sameId(idOf(originalDoc?.author), user.id)
        const from = originalDoc?.status as string | undefined
        const to = (data.status ?? from) as string

        if (!editorInScope) {
          // Non-editors: own rows only; reporters / out-of-scope publishers only while pending.
          if (!own) throw new APIError('You can only edit your own updates.', 403)
          if (!tpInScope && from !== 'pending') {
            throw new APIError('Only pending updates can be edited.', 403)
          }
        }

        if (to !== from) {
          if (to === 'approved') {
            if (!(editorInScope || (tpInScope && own))) {
              throw new APIError('You are not allowed to approve updates.', 403)
            }
            data.approvedBy = user.id
            data.approvedAt = new Date().toISOString()
          } else if (!editorInScope) {
            throw new APIError('You are not allowed to change the status of this update.', 403)
          } else {
            data.approvedBy = null
            data.approvedAt = null
          }
        }
        // Immutable once created.
        delete data.sequence
        delete data.author
        return data
      },
    ],
    afterChange: [
      async ({ doc, previousDoc, operation, req }) => {
        if (operation === 'create' || previousDoc?.status !== doc.status) {
          await writeAuditLog(req, {
            action: operation === 'create' ? 'live-update.create' : 'live-update.status',
            collection: 'live-updates',
            docId: doc.id,
            fromStatus: operation === 'create' ? null : previousDoc?.status,
            toStatus: doc.status,
            summary: `Live update #${doc.sequence} (event ${idOf(doc.event)}) ${
              operation === 'create' ? 'created as' : 'moved to'
            } ${doc.status}`,
            details: { event: idOf(doc.event), sequence: doc.sequence },
          })
        }
        return doc
      },
    ],
  },
  fields: [
    { name: 'event', type: 'relationship', relationTo: 'live-events', required: true, index: true },
    {
      name: 'body',
      type: 'textarea',
      required: true,
      maxLength: 5000,
      hooks: { beforeValidate: [({ value }) => cleanText(value, { multiline: true })] },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      options: ['pending', 'approved', 'rejected'].map((s) => ({ label: s, value: s })),
    },
    {
      name: 'sequence',
      type: 'number',
      index: true,
      admin: { readOnly: true },
      access: serverOnly,
    },
    { name: 'occurredAt', type: 'date', required: true, defaultValue: () => new Date().toISOString() },
    {
      name: 'author',
      type: 'relationship',
      relationTo: 'users',
      admin: { readOnly: true },
      access: { read: staffRead, ...serverOnly },
    },
    {
      name: 'approvedBy',
      type: 'relationship',
      relationTo: 'users',
      admin: { readOnly: true },
      access: { read: staffRead, ...serverOnly },
    },
    { name: 'approvedAt', type: 'date', admin: { readOnly: true }, access: serverOnly },
  ],
}
