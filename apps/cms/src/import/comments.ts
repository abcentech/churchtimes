import type { Payload, PayloadRequest } from 'payload'

import {
  ANONYMOUS_NAME,
  EMAIL_REDACTED,
  toLegacyCommentData,
  type LegacyCommentData,
  type SkipReason,
} from '../lib/legacyComments'
import type { WxrComment } from './wxr'

/**
 * Comment import (go-live contract C6). Only approved, ordinary comments of an imported article are kept; the
 * allowlist and the cleaning live in `toLegacyCommentData`. On top of that this module:
 * - takes the parser's comment shape (which has no email, URL or IP field) and maps it to the helper's input;
 * - runs a second, bounded email-shaped-text pass over the author name and the body, so an address that survived
 *   the helper's own cleaning (or a future change to it) is never stored;
 * - keeps `parentLegacyId` only when the parent is itself imported for the same article, and breaks cycles;
 * - skips a comment whose `legacyId` already exists (re-runs are no-ops).
 */

// Bounded on every side (local part 1-64, domain labels 1-63, at most 8 labels), so a hostile run of '@' or '.' stays
// linear. Applied to text that was already cut to the comment length cap.
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const EMAIL_SHAPED = new RegExp(`[A-Za-z0-9._%+'-]{1,64}@${LABEL}(?:\\.${LABEL}){1,7}`, 'g')
const AT_SIGN_FOLDED = /[＠﹫]/g

/** Replace email-shaped text by a marker. Also catches the full-width at-sign form. */
export function stripEmailShaped(text: string): string {
  const bounded = text.length > 20_000 ? text.slice(0, 20_000) : text
  return bounded.replace(AT_SIGN_FOLDED, '@').replace(EMAIL_SHAPED, EMAIL_REDACTED)
}

/** A name that still holds an at-sign after cleaning is not published. */
function safeName(name: string): string {
  const folded = name.replace(AT_SIGN_FOLDED, '@')
  return folded.includes('@') ? ANONYMOUS_NAME : name
}

export function adaptWxrComment(c: WxrComment): Record<string, unknown> {
  return {
    id: c.id,
    author: c.authorName,
    content: c.content,
    dateGmt: c.dateGmt,
    approved: c.approved,
    type: c.type,
    parent: c.parentId,
  }
}

export type PreparedComments = {
  rows: LegacyCommentData[]
  skipped: Partial<Record<SkipReason | 'duplicate-id', number>>
  /** Comments whose parent was not imported (spam, unapproved, missing): imported as top-level. */
  orphanedParents: number
  truncated: number
  dateFromLocal: number
}

/** Pure: no database. `articleId` is the CMS id of the article (0 in a dry run where it does not exist yet). */
export function prepareComments(comments: readonly WxrComment[], articleId: number | string): PreparedComments {
  const out: PreparedComments = { rows: [], skipped: {}, orphanedParents: 0, truncated: 0, dateFromLocal: 0 }
  const seen = new Set<number>()
  for (const c of comments) {
    const r = toLegacyCommentData(adaptWxrComment(c), articleId)
    if (!r.ok) {
      out.skipped[r.reason] = (out.skipped[r.reason] ?? 0) + 1
      continue
    }
    if (seen.has(r.data.legacyId)) {
      out.skipped['duplicate-id'] = (out.skipped['duplicate-id'] ?? 0) + 1
      continue
    }
    seen.add(r.data.legacyId)
    if (r.truncated) out.truncated++
    if (r.dateFromLocal) out.dateFromLocal++
    out.rows.push({
      ...r.data,
      authorName: safeName(stripEmailShaped(r.data.authorName)),
      content: stripEmailShaped(r.data.content),
    })
  }
  // Threading: the parent must be imported for this article, and following parents must not loop.
  const parentOf = new Map(out.rows.map((r) => [r.legacyId, r.parentLegacyId]))
  for (const row of out.rows) {
    if (row.parentLegacyId === null) continue
    if (!parentOf.has(row.parentLegacyId)) {
      row.parentLegacyId = null
      out.orphanedParents++
      continue
    }
    let cur: number | null = row.parentLegacyId
    let steps = 0
    while (cur !== null && cur !== row.legacyId && steps++ < 1000) cur = parentOf.get(cur) ?? null
    if (cur === row.legacyId) {
      row.parentLegacyId = null
      out.orphanedParents++
    }
  }
  return out
}

/** Write prepared rows (skipping legacy ids that exist). In a dry run nothing is written and `created` is empty. */
export async function writeComments(
  payload: Payload,
  req: PayloadRequest,
  rows: readonly LegacyCommentData[],
  dryRun: boolean,
): Promise<{ created: number[]; existing: number; wouldCreate: number }> {
  if (rows.length === 0) return { created: [], existing: 0, wouldCreate: 0 }
  const have = new Set<number>()
  for (let i = 0; i < rows.length; i += 200) {
    const ids = rows.slice(i, i + 200).map((r) => r.legacyId)
    const found = await payload.find({
      collection: 'legacy-comments',
      where: { legacyId: { in: ids } },
      limit: ids.length,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { legacyId: true },
      req,
    })
    for (const d of found.docs as { legacyId?: number }[]) if (typeof d.legacyId === 'number') have.add(d.legacyId)
  }
  const todo = rows.filter((r) => !have.has(r.legacyId))
  if (dryRun) return { created: [], existing: have.size, wouldCreate: todo.length }
  const created: number[] = []
  for (const row of todo) {
    const doc = (await payload.create({
      collection: 'legacy-comments',
      data: row as never,
      overrideAccess: true,
      req,
    })) as { id: number }
    created.push(doc.id)
  }
  return { created, existing: have.size, wouldCreate: todo.length }
}
