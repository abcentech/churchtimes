import { APIError } from 'payload'
import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
} from 'payload'

import { editorInChiefOnly, staffOnly } from '../access/roles'
import { writeAuditLog } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'
import { databaseRuleLookup } from '../lib/redirectData'
import {
  REDIRECT_SOURCES,
  REDIRECT_STATUSES,
  findWriteConflict,
  isRedirectSource,
  isRedirectStatus,
} from '../lib/redirectMap'
import {
  PATH_MAX,
  RedirectConfigError,
  normalizePath,
  normalizeTarget,
  parseAllowedHosts,
  resolveArticlePathTemplate,
} from '../lib/redirectPaths'
import { cleanText } from '../lib/sanitize'

/**
 * Staff-managed exact-match redirects (go-live contract C7.1). Admin and editor-in-chief write; every staff role reads
 * (never anonymous: the public list is `GET /api/public/redirects`, which carries no staff data). Every write is audited.
 *
 * `from` and `to` are stored in canonical form (lib/redirectPaths.ts), so the unique index on `from` is a unique index
 * on the normalised address. A `410` row has no `to`.
 */

type Doc = Record<string, unknown>
type RedirectContext = { redirectImport?: boolean }

const badRequest = (message: string): never => {
  throw new APIError(message, 400)
}

const configGuard = <T,>(fn: () => T): T => {
  try {
    return fn()
  } catch (err) {
    if (err instanceof RedirectConfigError) throw new APIError(err.message, 500)
    throw err
  }
}

/** Normalise and validate the fields that are present, before Payload's own field validation. */
const normalizeRedirect: CollectionBeforeValidateHook = async ({ data, operation, originalDoc }) => {
  if (!data) return data
  const orig = (originalDoc ?? {}) as Doc

  if ('from' in data) {
    const from = normalizePath(data.from)
    if (!from.ok) return badRequest(`"from" ${from.reason}.`)
    if (from.path === '/') return badRequest('"from" cannot be the home page ("/").')
    data.from = from.path
  }

  if ('status' in data && data.status !== undefined && !isRedirectStatus(data.status)) {
    return badRequest(`Status must be one of ${REDIRECT_STATUSES.join(', ')}.`)
  }
  if ('source' in data && data.source !== undefined && !isRedirectSource(data.source)) {
    return badRequest(`Source must be one of ${REDIRECT_SOURCES.join(', ')}.`)
  }
  if ('note' in data) {
    if (data.note !== null && data.note !== undefined && typeof data.note !== 'string') return badRequest('Note must be plain text.')
    const note = cleanText(data.note, { max: 500 })
    data.note = note === '' ? null : note
  }

  const status = (data.status ?? orig.status ?? 301) as number
  if (status === 410) {
    data.to = null
  } else if ('to' in data || operation === 'create' || (orig.status === 410 && 'status' in data)) {
    const targetResult = configGuard(() =>
      normalizeTarget(data.to ?? (orig.status === 410 ? undefined : orig.to), parseAllowedHosts()),
    )
    if (!targetResult.ok) {
      return badRequest(
        data.to === undefined || data.to === null || data.to === ''
          ? '"to" is required for a 301 or 302 redirect.'
          : `"to" ${targetResult.reason}.`,
      )
    }
    data.to = targetResult.to
  }
  return data
}

/** Loops are always refused; a manual row may not chain. The conflicting rule is named in the message. */
const refuseLoopsAndChains: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req }) => {
  if ((req.context as RedirectContext | undefined)?.redirectImport === true) return data // import validates the whole set itself
  const orig = (originalDoc ?? {}) as Doc
  const merged = { ...orig, ...data } as Doc
  const changed =
    operation === 'create' ||
    ['from', 'to', 'status', 'source'].some((k) => k in data && data[k] !== orig[k])
  if (!changed) return data

  const from = String(merged.from ?? '')
  const to = typeof merged.to === 'string' ? merged.to : null
  const status = Number(merged.status ?? 301)
  const source = String(merged.source ?? 'manual')
  if (!isRedirectStatus(status) || !isRedirectSource(source)) return data

  const template = configGuard(() => resolveArticlePathTemplate())
  const lookup = databaseRuleLookup(req.payload, req, template, orig.id as number | undefined)
  const conflict = await findWriteConflict({ from, to, status, source }, lookup)
  if (conflict) return badRequest(conflict)
  return data
}

const summaryOf = (doc: Doc): string => `${String(doc.from)} -> ${doc.to ? String(doc.to) : 'gone'} (${String(doc.status)})`

const auditChange: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  if ((req.context as RedirectContext | undefined)?.redirectImport === true) return doc
  const prev = (previousDoc ?? {}) as Doc
  if (operation === 'update') {
    const same = ['from', 'to', 'status', 'source', 'note'].every((k) => (doc as Doc)[k] === prev[k])
    if (same) return doc
  }
  await writeAuditLog(req, {
    action: operation === 'create' ? 'redirect.create' : 'redirect.update',
    collection: 'redirects',
    docId: doc.id,
    summary: summaryOf(doc as Doc),
    details:
      operation === 'update'
        ? {
            before: { from: prev.from, to: prev.to ?? null, status: prev.status, source: prev.source },
            after: { from: doc.from, to: doc.to ?? null, status: doc.status, source: doc.source },
          }
        : null,
  })
  return doc
}

const auditDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
  await writeAuditLog(req, {
    action: 'redirect.delete',
    collection: 'redirects',
    docId: doc.id,
    summary: summaryOf(doc as Doc),
  })
  return doc
}

export const Redirects: CollectionConfig = {
  slug: 'redirects',
  admin: {
    useAsTitle: 'from',
    defaultColumns: ['from', 'to', 'status', 'source', 'updatedAt'],
    listSearchableFields: ['from', 'to'],
    description:
      'Exact old addresses and where they go. Admin and editor-in-chief only. Articles with a legacy address get their rule automatically.',
  },
  timestamps: true,
  access: {
    read: staffOnly,
    create: editorInChiefOnly,
    update: editorInChiefOnly,
    delete: editorInChiefOnly,
  },
  hooks: {
    beforeOperation: [clampLimit],
    beforeValidate: [normalizeRedirect],
    beforeChange: [refuseLoopsAndChains],
    afterChange: [auditChange],
    afterDelete: [auditDelete],
  },
  fields: [
    {
      name: 'from',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      maxLength: PATH_MAX,
      admin: { description: 'Old path, for example /old-slug/. Stored in canonical form (leading and trailing slash).' },
    },
    {
      name: 'to',
      type: 'text',
      maxLength: 2048,
      admin: {
        description:
          'New path (/new-slug/) or an https address on an allowed host. Leave empty for 410 (gone).',
        condition: (data) => data?.status !== 410,
      },
    },
    {
      name: 'status',
      type: 'number',
      required: true,
      defaultValue: 301,
      index: true,
      validate: (value: unknown) =>
        isRedirectStatus(value) ? true : `Status must be one of ${REDIRECT_STATUSES.join(', ')}.`,
      admin: { description: '301 moved permanently, 302 temporary, 410 gone.' },
    },
    {
      name: 'source',
      type: 'select',
      required: true,
      defaultValue: 'manual',
      index: true,
      options: REDIRECT_SOURCES.map((s) => ({ label: s, value: s })),
      admin: { description: 'manual rows may not chain; rank-math and legacy-url rows are flattened when the list is generated.' },
    },
    { name: 'note', type: 'textarea', maxLength: 500 },
  ],
}
