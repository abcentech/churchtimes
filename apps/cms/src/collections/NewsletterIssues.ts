import type { Access, CollectionConfig, FieldAccess } from 'payload'

import { isEditorInChief, isEditorRole, type UserLike } from '../access/roles'
import { auditDeleteHook } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'
import { plainTextValidator } from '../lib/newsroomFields'

const asUser = (u: unknown): UserLike | null => (u ? (u as UserLike) : null)

export const NEWSLETTER_ISSUE_STATUSES = ['draft', 'sending', 'sent', 'failed'] as const
export const NEWSLETTER_SUBJECT_MAX = 150
export const NEWSLETTER_BODY_MAX = 200_000

const editorsRead: Access = ({ req }) => isEditorRole(asUser(req.user))
/** Subject edits: admin / editor-in-chief, and only while the issue is still a draft. */
const subjectWhileDraft: Access = ({ req }) => (isEditorInChief(asUser(req.user)) ? { status: { equals: 'draft' } } : false)
const eicDelete: Access = ({ req }) => (isEditorInChief(asUser(req.user)) ? { status: { in: ['draft', 'failed'] } } : false)
const never: FieldAccess = () => false

/**
 * One row per newsletter issue (Agent E's digest builder writes them through the Local API with overrideAccess; a dry run
 * writes a `draft` and sends nothing). Bodies are generated from a strict template, never typed by staff, so every field
 * except `subject` is server-owned. Never publicly readable.
 */
export const NewsletterIssues: CollectionConfig = {
  slug: 'newsletter-issues',
  labels: { singular: 'Newsletter issue', plural: 'Newsletter issues' },
  admin: { useAsTitle: 'subject', defaultColumns: ['subject', 'date', 'status', 'sentCount', 'failedCount'], group: 'Newsletter' },
  access: {
    read: editorsRead,
    create: () => false,
    update: subjectWhileDraft,
    delete: eicDelete,
  },
  hooks: {
    beforeOperation: [clampLimit],
    afterDelete: [auditDeleteHook('newsletter-issues', (d) => (d.subject ? `subject ${String(d.subject).slice(0, 80)}` : undefined))],
  },
  fields: [
    { name: 'date', type: 'date', required: true, index: true, access: { create: never, update: never } },
    { name: 'subject', type: 'text', required: true, maxLength: NEWSLETTER_SUBJECT_MAX, validate: plainTextValidator('Subject', NEWSLETTER_SUBJECT_MAX, { required: true }) },
    { name: 'status', type: 'select', required: true, defaultValue: 'draft', index: true, options: NEWSLETTER_ISSUE_STATUSES.map((v) => ({ label: v, value: v })), access: { create: never, update: never } },
    { name: 'bodyText', type: 'textarea', maxLength: NEWSLETTER_BODY_MAX, access: { create: never, update: never }, admin: { readOnly: true } },
    { name: 'bodyHtml', type: 'textarea', maxLength: NEWSLETTER_BODY_MAX, access: { create: never, update: never }, admin: { readOnly: true, description: 'Generated from the fixed template; shown as source, never rendered here.' } },
    { name: 'sentCount', type: 'number', defaultValue: 0, min: 0, access: { create: never, update: never } },
    { name: 'failedCount', type: 'number', defaultValue: 0, min: 0, access: { create: never, update: never } },
    { name: 'capApplied', type: 'checkbox', defaultValue: false, access: { create: never, update: never }, admin: { description: 'The daily send cap stopped this issue before every subscriber was reached.' } },
    { name: 'lastError', type: 'text', maxLength: 500, access: { create: never, update: never } },
  ],
}
