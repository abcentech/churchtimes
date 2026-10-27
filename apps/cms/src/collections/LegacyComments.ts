import { APIError } from 'payload'
import type {
  Access,
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  FieldAccess,
  Where,
} from 'payload'

import { isAdmin, isEditorInChief, isStaff, userSectionIds, type UserLike } from '../access/roles'
import { publicLegacyCommentsEndpoints } from '../endpoints/publicLegacyComments'
import { writeAuditLog } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'
import {
  COMMENT_CONTENT_MAX,
  COMMENT_NAME_MAX,
  plainNameForOutput,
  plainTextForOutput,
} from '../lib/legacyComments'

/**
 * Read-only archive of the approved WordPress comments (go-live contract C6). There are no new comments.
 *
 * Data minimisation: no commenter email, website or IP is stored here, so none can be read, exported or leaked.
 *
 * Access:
 * - read: anonymous and non-editor staff only ever see `approved` comments of PUBLISHED articles (a Where, so it holds for
 *   every query shape). Editors see their scope: admin and editor-in-chief everything, a section editor the comments of
 *   articles in their sections.
 * - create: nobody through the API. The importer uses the server-side Local API.
 * - update: editors in scope, and only the `status` field (hide or restore). Text, name, date and ids are never editable
 *   through the API (field-level access).
 * - delete: admin only. Every hide, restore and delete is audited.
 */

type Doc = Record<string, unknown>
const asUser = (u: unknown) => u as UserLike | null | undefined

const publicWhere: Where = {
  and: [{ status: { equals: 'approved' } }, { 'article.status': { equals: 'published' } }],
}

const read: Access = ({ req }) => {
  const user = asUser(req.user)
  if (isEditorInChief(user)) return true
  if (user?.role === 'section-editor') {
    const sections = userSectionIds(user)
    return sections.length ? { or: [publicWhere, { 'article.category': { in: sections } }] } : publicWhere
  }
  return publicWhere
}

const update: Access = ({ req }) => {
  const user = asUser(req.user)
  if (isEditorInChief(user)) return true
  if (user?.role === 'section-editor') {
    const sections = userSectionIds(user)
    return sections.length ? { 'article.category': { in: sections } } : false
  }
  return false
}

const never: FieldAccess = () => false
const never_ = () => false

/**
 * On create only: plain-text cleaning WITHOUT entity decoding (the importer decodes once, in `toLegacyCommentData`; a
 * second decode would turn `&amp;lt;` into `<`). An update never re-cleans stored text; the text fields cannot be
 * updated through the API at all.
 */
const cleanFields: CollectionBeforeValidateHook = ({ data, operation }) => {
  if (!data || operation !== 'create') return data
  if ('authorName' in data) data.authorName = plainNameForOutput(data.authorName)
  if ('content' in data) {
    const content = plainTextForOutput(data.content)
    if (content === '') throw new APIError('Comment text is required.', 400)
    data.content = content
  }
  return data
}

const auditStatus: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  if (operation !== 'update') return doc
  const prev = (previousDoc ?? {}) as Doc
  const next = doc as Doc
  if (prev.status === next.status) return doc
  await writeAuditLog(req, {
    action: next.status === 'hidden' ? 'legacy-comment.hide' : 'legacy-comment.restore',
    collection: 'legacy-comments',
    docId: next.id as number,
    fromStatus: String(prev.status ?? ''),
    toStatus: String(next.status ?? ''),
    summary: `legacy comment ${String(next.legacyId ?? next.id)} ${String(next.status)}`,
  })
  return doc
}

const auditDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
  await writeAuditLog(req, {
    action: 'legacy-comment.delete',
    collection: 'legacy-comments',
    docId: doc.id,
    summary: `legacy comment ${String(doc.legacyId ?? doc.id)} deleted`,
  })
  return doc
}

export const LegacyComments: CollectionConfig = {
  slug: 'legacy-comments',
  admin: {
    useAsTitle: 'authorName',
    defaultColumns: ['authorName', 'article', 'commentedAt', 'status', 'legacyId'],
    listSearchableFields: ['authorName', 'content'],
    description:
      'Archived comments from the old WordPress site. Read-only: staff can hide or restore a comment but not edit it. No commenter email, website or IP is stored.',
  },
  timestamps: true,
  // The public list: where article = ? and status = approved, ordered by commentedAt then legacyId.
  indexes: [{ fields: ['article', 'status', 'commentedAt', 'legacyId'] }],
  access: {
    read,
    create: never_,
    update,
    delete: ({ req }) => isAdmin(asUser(req.user)),
  },
  // Replaces Payload's generic list route on GET /api/legacy-comments (see endpoints/publicLegacyComments.ts).
  endpoints: publicLegacyCommentsEndpoints,
  hooks: {
    beforeOperation: [clampLimit],
    beforeValidate: [cleanFields],
    afterChange: [auditStatus],
    afterDelete: [auditDelete],
  },
  fields: [
    {
      name: 'article',
      type: 'relationship',
      relationTo: 'articles',
      required: true,
      index: true,
      access: { update: never },
    },
    {
      name: 'authorName',
      type: 'text',
      required: true,
      minLength: 1,
      maxLength: COMMENT_NAME_MAX,
      access: { update: never },
    },
    {
      name: 'content',
      type: 'textarea',
      required: true,
      minLength: 1,
      maxLength: COMMENT_CONTENT_MAX,
      admin: { description: 'Plain text. Render with line breaks only.' },
      access: { update: never },
    },
    { name: 'commentedAt', type: 'date', required: true, index: true, access: { update: never } },
    {
      name: 'legacyId',
      type: 'number',
      required: true,
      unique: true,
      index: true,
      admin: { description: 'WordPress comment id.' },
      access: { update: never },
    },
    {
      name: 'parentLegacyId',
      type: 'number',
      index: true,
      admin: { description: 'WordPress id of the comment this answers (threading; display depth is capped at 2).' },
      access: { update: never },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'approved',
      index: true,
      // Staff only: an anonymous reader of GET /api/legacy-comments/:id never sees the moderation status.
      access: { read: ({ req }) => isStaff(asUser(req.user)) },
      options: [
        { label: 'Approved', value: 'approved' },
        { label: 'Hidden', value: 'hidden' },
      ],
    },
  ],
}
