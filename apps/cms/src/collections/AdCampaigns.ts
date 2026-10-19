import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { APIError } from 'payload'
import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  Field,
  PayloadRequest,
} from 'payload'

import { editorInChiefOnly, isAdmin, type UserLike } from '../access/roles'
import { writeAuditLog } from '../lib/audit'
import {
  CAMPAIGN_STATUSES,
  CREATIVE_MIME,
  MAX_CREATIVE_BYTES,
  PAYMENT_STATUSES,
  PLACEMENTS,
  PLACEMENT_FIELD,
  PLACEMENT_SIZES,
  PUBLIC_FIELDS,
  approvalProblems,
  checkCreativeSize,
  creativeMediaIds,
  idOf,
  isAdTimestamp,
  isAnimatedImage,
  normalizeDestinationUrl,
  readCreatives,
  requirePayment,
  requiredVariants,
  toMs,
  type Placement,
  type Variant,
} from '../lib/advertising'
import { clampLimit } from '../lib/clampLimit'
import { deepEqual } from '../lib/deepEqual'
import { cleanText } from '../lib/sanitize'

/**
 * Ad campaigns (go-live contract C3.1). Staff-only: `admin` and `editor-in-chief` create, edit and approve; no other role and
 * never anonymous. The public face is `GET /api/public/advertising` (endpoints/publicAdvertising.ts), which copies a
 * whitelist of fields and only for live campaigns.
 *
 * Server-enforced rules, in `beforeChange`:
 * - the approval gate (rights confirmed, complete creative set, payment paid or waived while ADS_REQUIRE_PAYMENT);
 * - `waived` payment is admin-only;
 * - creative checks (JPEG/PNG/WebP, exact size per placement, at most 500 KB, not animated);
 * - an approved campaign whose public fields change, or whose gate stops holding, goes back to `pending_approval`;
 * - `approvedBy` / `approvedAt` and `creativeMedia` are server-owned.
 * Every status transition (and create, update, delete) is written to `audit-logs`.
 */

type Doc = Record<string, unknown>
type AdContext = { adReason?: string }

const asUser = (u: unknown): UserLike | null => (u ? (u as UserLike) : null)

const bad = (message: string, status = 400): never => {
  throw new APIError(message, status)
}

const never = () => false

const mediaField = (name: Variant, label: string): Field => ({
  name,
  type: 'upload',
  relationTo: 'media',
  admin: { description: label },
})

const creativesFields: Field[] = PLACEMENTS.map(
  (p): Field => ({
    name: PLACEMENT_FIELD[p],
    type: 'group',
    label: p,
    fields: requiredVariants(p).map((v) => {
      const size = PLACEMENT_SIZES[p][v]!
      return mediaField(v, `${v} creative, exactly ${size.width}x${size.height}, JPEG/PNG/WebP, at most 500 KB, not animated.`)
    }),
  }),
)

/** Trim, strip markup and validate the plain fields before Payload's own validation. */
const normalise: CollectionBeforeValidateHook = ({ data, originalDoc }) => {
  if (!data) return data
  if (typeof data.sponsor === 'string') data.sponsor = cleanText(data.sponsor)
  if (typeof data.alt === 'string') data.alt = cleanText(data.alt)
  if ('destinationUrl' in data && data.destinationUrl !== undefined && data.destinationUrl !== null) {
    const url = normalizeDestinationUrl(data.destinationUrl)
    if (!url) {
      return bad('destinationUrl must be an absolute https address (no credentials, at most 500 characters).')
    }
    data.destinationUrl = url
  }
  for (const k of ['startsAt', 'endsAt'] as const) {
    if (k in data && data[k] !== undefined && data[k] !== null) {
      if (!isAdTimestamp(data[k])) return bad(`${k} must be a date and time.`)
      if (typeof data[k] === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/i.test(String(data[k]).trim())) {
        return bad(`${k} must include a timezone (for example 2026-10-14T00:00:00Z).`)
      }
    }
  }
  const orig = (originalDoc ?? {}) as Doc
  const startsAt = data.startsAt ?? orig.startsAt
  const endsAt = data.endsAt ?? orig.endsAt
  if (isAdTimestamp(startsAt) && isAdTimestamp(endsAt) && toMs(endsAt) <= toMs(startsAt)) {
    return bad('endsAt must be after startsAt.')
  }
  return data
}

const mergeCreatives = (orig: unknown, patch: unknown): Record<string, Record<string, unknown>> => {
  const out: Record<string, Record<string, unknown>> = {}
  const o = (orig ?? {}) as Record<string, Record<string, unknown> | null>
  const p = (patch ?? {}) as Record<string, Record<string, unknown> | null>
  for (const p0 of PLACEMENTS) {
    const f = PLACEMENT_FIELD[p0]
    out[f] = { ...(o[f] ?? {}), ...(p[f] ?? {}) }
  }
  return out
}

type MediaDoc = {
  id: number | string
  filename?: string | null
  mimeType?: string | null
  filesize?: number | null
  width?: number | null
  height?: number | null
}

/** Dimension, type, size and animation checks for every creative of the selected placements. */
async function checkCreatives(req: PayloadRequest, placements: Placement[], creatives: unknown): Promise<void> {
  const set = readCreatives(creatives)
  const staticDir = (req.payload.collections.media.config.upload as { staticDir?: string } | false)
  for (const p of placements) {
    for (const v of Object.keys(set[p] ?? {}) as Variant[]) {
      const id = idOf(set[p]![v])
      if (id === undefined) continue
      const label = `${p} ${v} creative`
      const media = (await req.payload
        .findByID({ collection: 'media', id, depth: 0, overrideAccess: true, req })
        .catch(() => null)) as MediaDoc | null
      if (!media) return bad(`The ${label} does not exist.`)
      if (!media.mimeType || !(CREATIVE_MIME as readonly string[]).includes(media.mimeType)) {
        return bad(`The ${label} must be a JPEG, PNG or WebP image.`)
      }
      const sizeProblem = checkCreativeSize(p, v, media)
      if (sizeProblem) return bad(sizeProblem)
      if (typeof media.filesize !== 'number' || media.filesize > MAX_CREATIVE_BYTES) {
        return bad(`The ${label} is larger than ${MAX_CREATIVE_BYTES / 1024} KB.`)
      }
      if (media.mimeType !== 'image/jpeg' && media.filename && staticDir && staticDir.staticDir) {
        const bytes = await readFile(path.join(staticDir.staticDir, media.filename)).catch(() => null)
        if (!bytes) return bad(`The ${label} file could not be read.`)
        if (isAnimatedImage(bytes)) return bad(`The ${label} is animated; animated images are not accepted.`)
      }
    }
  }
}

const normForCompare = (field: string, value: unknown): unknown => {
  if (field === 'creatives') {
    const set = readCreatives(value)
    return PLACEMENTS.map((p) => [p, ...(['desktop', 'mobile'] as const).map((v) => String(idOf(set[p]?.[v]) ?? ''))])
  }
  if (field === 'placements') return [...((Array.isArray(value) ? value : []) as string[])].sort()
  if (field === 'startsAt' || field === 'endsAt') return value ? toMs(value) : null
  if (field === 'priority') return Number(value ?? 0)
  return value ?? null
}

const publicFieldsChanged = (orig: Doc, merged: Doc): boolean =>
  PUBLIC_FIELDS.some((f) => !deepEqual(normForCompare(f, orig[f]), normForCompare(f, merged[f])))

const enforceRules: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req }) => {
  const orig = (originalDoc ?? {}) as Doc
  const user = asUser(req.user)
  const ctx = (req.context ?? {}) as AdContext

  const merged: Doc = { ...orig, ...data, creatives: mergeCreatives(orig.creatives, data.creatives) }

  if (
    'paymentStatus' in data &&
    data.paymentStatus === 'waived' &&
    orig.paymentStatus !== 'waived' &&
    user &&
    !isAdmin(user)
  ) {
    return bad('Only an admin can mark a campaign as waived.', 403)
  }

  const placements = (Array.isArray(merged.placements) ? merged.placements : []).filter((p): p is Placement =>
    PLACEMENTS.includes(p as Placement),
  )
  const previousStatus = operation === 'create' ? undefined : String(orig.status ?? 'draft')
  const targetStatus = String(data.status ?? orig.status ?? 'draft')
  const enteringApproved = targetStatus === 'approved' && previousStatus !== 'approved'
  const touchesCreatives = operation === 'create' || 'creatives' in data || 'placements' in data

  if (touchesCreatives || enteringApproved) await checkCreatives(req, placements, merged.creatives)
  if (touchesCreatives) data.creativeMedia = creativeMediaIds(merged.creatives, placements)

  const require = requirePayment()
  if (enteringApproved) {
    if (!isAdTimestamp(merged.startsAt) || !isAdTimestamp(merged.endsAt)) {
      return bad('startsAt and endsAt are required before approval.')
    }
    const problems = approvalProblems(merged, require)
    if (problems.length > 0) return bad(`Cannot approve: ${problems.join(' ')}`)
    data.status = 'approved'
    data.approvedBy = user ? user.id : null
    data.approvedAt = new Date().toISOString()
  } else if (targetStatus === 'approved') {
    // Already approved and staying approved: a public edit, or a gate that no longer holds, needs a new approval.
    const gateBroken = approvalProblems(merged, require).length > 0
    const changed = operation === 'update' && publicFieldsChanged(orig, merged)
    if (gateBroken || changed) {
      data.status = 'pending_approval'
      data.approvedBy = null
      data.approvedAt = null
      ctx.adReason = gateBroken && !changed ? 'approval conditions no longer hold' : 'public fields changed'
      req.context = ctx
    }
  } else if (targetStatus === 'draft' || targetStatus === 'pending_approval') {
    data.approvedBy = null
    data.approvedAt = null
  }
  return data
}

const refuseDeleteWhenApproved: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const doc = (await req.payload
    .findByID({ collection: 'ad-campaigns', id, depth: 0, overrideAccess: true, req })
    .catch(() => null)) as Doc | null
  if (doc?.status === 'approved') bad('Pause or cancel an approved campaign before deleting it.', 409)
}

const AUDITED = ['advertiser', 'sponsor', 'alt', 'destinationUrl', 'placements', 'creatives', 'startsAt', 'endsAt', 'priority', 'rightsConfirmed', 'paymentStatus'] as const

const auditChange: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
  const d = doc as Doc
  const prev = (previousDoc ?? {}) as Doc
  const ctx = (req.context ?? {}) as AdContext
  if (operation === 'create') {
    await writeAuditLog(req, {
      action: 'ad-campaign.create',
      collection: 'ad-campaigns',
      docId: d.id as number,
      toStatus: String(d.status),
      summary: String(d.sponsor ?? ''),
    })
    return doc
  }
  const fields = AUDITED.filter((f) => !deepEqual(normForCompare(f, prev[f]), normForCompare(f, d[f])))
  // Which fields changed, never their values: payment status and contact data stay out of the log text.
  if (prev.status !== d.status) {
    await writeAuditLog(req, {
      action: 'ad-campaign.status',
      collection: 'ad-campaigns',
      docId: d.id as number,
      fromStatus: String(prev.status ?? ''),
      toStatus: String(d.status),
      summary: String(d.sponsor ?? ''),
      details: { reason: ctx.adReason ?? null, fields },
    })
  } else if (fields.length > 0) {
    await writeAuditLog(req, {
      action: 'ad-campaign.update',
      collection: 'ad-campaigns',
      docId: d.id as number,
      summary: String(d.sponsor ?? ''),
      details: { fields },
    })
  }
  return doc
}

const auditDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
  await writeAuditLog(req, {
    action: 'ad-campaign.delete',
    collection: 'ad-campaigns',
    docId: doc.id,
    summary: String(doc.sponsor ?? ''),
  })
  return doc
}

export const AdCampaigns: CollectionConfig = {
  slug: 'ad-campaigns',
  admin: {
    useAsTitle: 'sponsor',
    defaultColumns: ['sponsor', 'status', 'startsAt', 'endsAt', 'paymentStatus'],
    description:
      'Paid placements. Admin and editor-in-chief only. A campaign is delivered only when approved, paid (or waived) and inside its dates.',
  },
  timestamps: true,
  access: {
    read: editorInChiefOnly,
    create: editorInChiefOnly,
    update: editorInChiefOnly,
    delete: editorInChiefOnly,
  },
  hooks: {
    beforeOperation: [clampLimit],
    beforeValidate: [normalise],
    beforeChange: [enforceRules],
    afterChange: [auditChange],
    beforeDelete: [refuseDeleteWhenApproved],
    afterDelete: [auditDelete],
  },
  fields: [
    { name: 'advertiser', type: 'relationship', relationTo: 'advertisers', required: true, index: true },
    { name: 'sponsor', type: 'text', required: true, minLength: 1, maxLength: 100, admin: { description: 'Public display name.' } },
    { name: 'alt', type: 'text', required: true, minLength: 1, maxLength: 240, admin: { description: 'Describe the creative and the offer (public).' } },
    {
      name: 'destinationUrl',
      type: 'text',
      required: true,
      maxLength: 500,
      admin: { description: 'Absolute https address, no credentials.' },
    },
    {
      name: 'placements',
      type: 'select',
      hasMany: true,
      required: true,
      options: PLACEMENTS.map((p) => ({ label: p, value: p })),
    },
    { name: 'creatives', type: 'group', fields: creativesFields },
    { name: 'startsAt', type: 'date', required: true, index: true, admin: { date: { pickerAppearance: 'dayAndTime' } } },
    { name: 'endsAt', type: 'date', required: true, index: true, admin: { date: { pickerAppearance: 'dayAndTime' } } },
    { name: 'priority', type: 'number', required: true, defaultValue: 0, min: 0, max: 100 },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'draft',
      index: true,
      options: CAMPAIGN_STATUSES.map((s) => ({ label: s, value: s })),
    },
    {
      name: 'rightsConfirmed',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: 'A person has checked the creative rights and the advertiser authorisation.' },
    },
    {
      name: 'paymentStatus',
      type: 'select',
      required: true,
      defaultValue: 'unpaid',
      index: true,
      options: PAYMENT_STATUSES.map((s) => ({ label: s, value: s })),
      admin: { description: 'Staff only, never public. Only an admin can set waived.' },
    },
    {
      name: 'approvedBy',
      type: 'relationship',
      relationTo: 'users',
      access: { create: never, update: never },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      name: 'approvedAt',
      type: 'date',
      access: { create: never, update: never },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      // Derived from `creatives` for the selected placements. It exists so Media's read rule can ask "is this file the
      // creative of a live campaign" with one join, exactly like Articles.bodyMedia.
      name: 'creativeMedia',
      type: 'relationship',
      relationTo: 'media',
      hasMany: true,
      index: true,
      access: { create: never, update: never },
      admin: { readOnly: true, hidden: true },
    },
  ],
}
