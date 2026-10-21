import fs from 'node:fs'
import path from 'node:path'

import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { writeAuditLog } from '../lib/audit'
import { PLACEMENT_FIELD, PLACEMENTS, requiredVariants } from '../lib/advertising'
import { readManifest, type ManifestSummary } from './manifest'
import type { Tally } from './qa'

/**
 * Rollback of one import run, driven ONLY by its manifest (see manifest.ts and docs/import.md, "Rollback").
 *
 * - Deletes only ids the manifest lists as CREATED by the run: legacy comments, articles, media documents (and their
 *   files, which must be plain file names inside the media folder) and categories. Articles the run only UPDATED are
 *   never touched (counted `articlesUpdatedNotReverted`). Audit rows are KEPT; one `import.rollback` audit row is added.
 * - Safe by default: a DRY RUN unless `apply`. A manifest without an `end` line (the run was killed) is refused unless
 *   `allowIncomplete`. A row must have been created inside the run window (createdAt) and carry the loader marker; a row changed since (updatedAt > createdAt) is skipped unless `force`.
 *   Ids that no longer exist are counted (`alreadyGone`), so a second rollback is a no-op.
 * - A row that something else still depends on is skipped, never force-deleted: an article that still has comments
 *   the run did not create or that staff kept, media still used by an article, ad campaign or live update, a category
 *   still used by an article, live event or user.
 * - One database transaction per item. The report holds counts and fixed reason codes only.
 */

export class RollbackError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'RollbackError'
  }
}

export type RollbackOptions = {
  manifestPath: string
  /** Without it nothing is written (dry run). */
  apply?: boolean
  /** Also delete rows edited after the run. */
  force?: boolean
  /** Accept a manifest with no `end` line (a killed run). */
  allowIncomplete?: boolean
  /** An incomplete manifest younger than this (default 60 s) is refused: the run may still be going. Tests set 0. */
  minIncompleteAgeMs?: number
  progress?: (line: string) => void
}

export type ItemCounts = {
  /** Distinct ids the manifest lists as created. */
  listed: number
  deleted: number
  /** Dry run: what an apply would delete. */
  wouldDelete: number
  /** Not in the database any more (a rollback was already done, or the post never committed). */
  alreadyGone: number
  skipped: Tally
  failed: number
}

export type RollbackReport = {
  mode: 'dry-run' | 'apply'
  force: boolean
  manifest: { startedAt: string | null; complete: boolean; endStatus: string | null; openIntents: number; abortedPosts: number }
  comments: ItemCounts
  articles: ItemCounts
  media: ItemCounts
  categories: ItemCounts
  /** Articles the run only updated: left as they are (their previous content is in Payload article versions). */
  articlesUpdatedNotReverted: number
  /** Audit rows listed by the manifest: kept, never deleted. */
  auditRowsKept: number
  notes: string[]
}

const counts = (listed: number): ItemCounts => ({ listed, deleted: 0, wouldDelete: 0, alreadyGone: 0, skipped: {}, failed: 0 })
const bump = (t: Tally, k: string) => {
  t[k] = (t[k] ?? 0) + 1
}
const uniq = (ids: readonly number[]): number[] => [...new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))]

type Doc = Record<string, unknown> & { id: number; updatedAt?: string }

/** The first reason code the item must not be deleted, or null. `gone` means no such row. */
type Verdict = 'gone' | string | null

type Ctx = {
  payload: Payload
  base: PayloadRequest
  apply: boolean
  force: boolean
  /** Provenance window: a row the run created has `createdAt` between the run's start (minus a few seconds) and its end. */
  windowStart: number
  cutoff: number
  /** Dry run only: rows an apply would already have deleted, so dependants are judged as after it. */
  pending: {
    commentsByArticle: Map<number, number>
    articlesByCategory: Map<number, number>
    articlesByMedia: Map<number, number>
  }
}

const bumpMap = (m: Map<number, number>, k: number) => m.set(k, (m.get(k) ?? 0) + 1)
const asId = (v: unknown): number | null => {
  const id = typeof v === 'object' && v !== null ? (v as { id?: unknown }).id : v
  return typeof id === 'number' ? id : null
}

async function fetchDoc(ctx: Ctx, req: PayloadRequest, collection: string, id: number, select: Record<string, true>): Promise<Doc | null> {
  const found = await ctx.payload.find({
    collection: collection as never,
    where: { id: { equals: id } },
    limit: 1,
    depth: 0,
    pagination: false,
    overrideAccess: true,
    select: { createdAt: true, updatedAt: true, ...select } as never,
    req,
  })
  return (found.docs[0] as Doc | undefined) ?? null
}

/** Clock slack between the manifest's start line and the database timestamps. */
const WINDOW_SLACK_MS = 5000
/** A row nobody touched has updatedAt equal to createdAt; staff or a later run change it by more than this. */
const EDIT_EPSILON_MS = 1000

/** Did the row come into being during this run? `createdAt` must lie inside the run's window. */
const inWindow = (ctx: Ctx, doc: Doc): boolean => {
  const t = typeof doc.createdAt === 'string' ? Date.parse(doc.createdAt) : NaN
  return Number.isFinite(t) && t >= ctx.windowStart - WINDOW_SLACK_MS && t <= ctx.cutoff
}

const edited = (ctx: Ctx, doc: Doc): boolean => {
  if (ctx.force) return false
  const u = typeof doc.updatedAt === 'string' ? Date.parse(doc.updatedAt) : NaN
  const c = typeof doc.createdAt === 'string' ? Date.parse(doc.createdAt) : NaN
  return !Number.isFinite(u) || !Number.isFinite(c) || u > c + EDIT_EPSILON_MS
}

/** Provenance common to every kind (the run's time window) and the kind's own marker, which a loader row always carries. */
const provenance = (ctx: Ctx, doc: Doc, marker: boolean): string | null => {
  if (!inWindow(ctx, doc)) return 'outside-run-window'
  if (!marker) return 'not-an-imported-row'
  return null
}

const count = async (ctx: Ctx, req: PayloadRequest, collection: string, where: Record<string, unknown>): Promise<number> =>
  (await ctx.payload.count({ collection: collection as never, where: where as never, overrideAccess: true, req })).totalDocs

/**
 * A media file name is a plain name: spaces, non-ASCII and a leading underscore are fine, but no separator, drive or
 * stream colon, control character, leading dot or over-long name. The real path must also stay inside the media folder.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILE_RE = /[\u0000-\u001F\u007F-\u009F/\\:]/
const safeFileName = (n: string): boolean => n.length > 0 && n.length <= 255 && !n.startsWith('.') && !UNSAFE_FILE_RE.test(n) && path.basename(n) === n

function mediaFilesConfined(payload: Payload, doc: Doc): boolean {
  const names: string[] = []
  if (typeof doc.filename === 'string') names.push(doc.filename)
  const sizes = doc.sizes as Record<string, { filename?: unknown } | null> | undefined
  if (sizes && typeof sizes === 'object') {
    for (const s of Object.values(sizes)) if (s && typeof s.filename === 'string') names.push(s.filename)
  }
  if (names.some((n) => !safeFileName(n))) return false
  const staticDir = (payload.collections as Record<string, { config: { upload?: { staticDir?: string } } }>).media?.config.upload?.staticDir
  if (!staticDir) return false
  let root: string
  try {
    root = fs.realpathSync.native(path.resolve(staticDir))
  } catch {
    return true // no folder, so no file to delete
  }
  for (const n of names) {
    let real: string
    try {
      real = fs.realpathSync.native(path.join(root, n))
    } catch {
      continue // already missing
    }
    const rel = path.relative(root, real)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
  }
  return true
}

type Handler = {
  collection: 'legacy-comments' | 'articles' | 'media' | 'categories'
  select: Record<string, true>
  check: (ctx: Ctx, req: PayloadRequest, doc: Doc) => Promise<string | null>
  /** Dry run: remember what an apply would remove. */
  note: (ctx: Ctx, doc: Doc) => void
}

const handlers: Record<Handler['collection'], Handler> = {
  'legacy-comments': {
    collection: 'legacy-comments',
    select: { article: true, legacyId: true },
    check: async (ctx, _req, doc) => provenance(ctx, doc, typeof doc.legacyId === 'number') ?? (edited(ctx, doc) ? 'edited-since-import' : null),
    note: (ctx, doc) => {
      const a = asId(doc.article)
      if (a !== null) bumpMap(ctx.pending.commentsByArticle, a)
    },
  },
  articles: {
    collection: 'articles',
    select: { legacyId: true, category: true, featuredImage: true, bodyMedia: true },
    check: async (ctx, req, doc) => {
      // Only rows the loader made carry a legacy id.
      const bad = provenance(ctx, doc, typeof doc.legacyId === 'number')
      if (bad) return bad
      if (edited(ctx, doc)) return 'edited-since-import'
      const remaining = (await count(ctx, req, 'legacy-comments', { article: { equals: doc.id } })) - (ctx.pending.commentsByArticle.get(doc.id) ?? 0)
      return remaining > 0 ? 'has-remaining-comments' : null
    },
    note: (ctx, doc) => {
      const c = asId(doc.category)
      if (c !== null) bumpMap(ctx.pending.articlesByCategory, c)
      const media = new Set<number>()
      const f = asId(doc.featuredImage)
      if (f !== null) media.add(f)
      if (Array.isArray(doc.bodyMedia)) for (const m of doc.bodyMedia) if (asId(m) !== null) media.add(asId(m) as number)
      for (const m of media) bumpMap(ctx.pending.articlesByMedia, m)
    },
  },
  media: {
    collection: 'media',
    select: { filename: true, sizes: true, legacyPath: true },
    check: async (ctx, req, doc) => {
      const bad = provenance(ctx, doc, typeof doc.legacyPath === 'string' && doc.legacyPath !== '')
      if (bad) return bad
      if (!mediaFilesConfined(ctx.payload, doc)) return 'unsafe-file-name'
      if (edited(ctx, doc)) return 'edited-since-import'
      const articles =
        (await count(ctx, req, 'articles', { or: [{ featuredImage: { equals: doc.id } }, { bodyMedia: { equals: doc.id } }] })) -
        (ctx.pending.articlesByMedia.get(doc.id) ?? 0)
      if (articles > 0) return 'still-used'
      // EVERY creative field of every placement (`creativeMedia` only covers the placements a campaign selected).
      const creativeFields = PLACEMENTS.flatMap((p) => requiredVariants(p).map((v) => ({ [`creatives.${PLACEMENT_FIELD[p]}.${v}`]: { equals: doc.id } })))
      if ((await count(ctx, req, 'ad-campaigns', { or: creativeFields })) > 0) return 'still-used'
      if ((await count(ctx, req, 'live-updates', { image: { equals: doc.id } })) > 0) return 'still-used'
      return null
    },
    note: () => {},
  },
  categories: {
    collection: 'categories',
    select: {},
    check: async (ctx, req, doc) => {
      const bad = provenance(ctx, doc, true)
      if (bad) return bad
      if (edited(ctx, doc)) return 'edited-since-import'
      const articles = (await count(ctx, req, 'articles', { category: { equals: doc.id } })) - (ctx.pending.articlesByCategory.get(doc.id) ?? 0)
      if (articles > 0) return 'still-used'
      if ((await count(ctx, req, 'live-events', { category: { equals: doc.id } })) > 0) return 'still-used'
      if ((await count(ctx, req, 'users', { sections: { equals: doc.id } })) > 0) return 'still-used'
      return null
    },
    note: () => {},
  },
}

async function removeOne(ctx: Ctx, h: Handler, id: number, c: ItemCounts): Promise<void> {
  const req = await createLocalReq({ context: { import: true } }, ctx.payload)
  let tx: number | string | null = null
  if (ctx.apply) {
    tx = (await ctx.payload.db.beginTransaction()) as number | string | null
    if (tx) req.transactionID = tx
  }
  try {
    const doc = await fetchDoc(ctx, req, h.collection, id, h.select)
    const verdict: Verdict = doc === null ? 'gone' : await h.check(ctx, req, doc)
    if (verdict === 'gone') c.alreadyGone++
    else if (verdict !== null) bump(c.skipped, verdict)
    else if (ctx.apply) {
      await ctx.payload.delete({ collection: h.collection as never, id, overrideAccess: true, depth: 0, req })
      c.deleted++
    } else {
      h.note(ctx, doc as Doc)
      c.wouldDelete++
    }
    if (tx) await ctx.payload.db.commitTransaction(tx)
  } catch {
    if (tx) {
      try {
        await ctx.payload.db.rollbackTransaction(tx)
      } catch {
        // already ended
      }
    }
    c.failed++
  }
}

export function summariseManifest(manifestPath: string): ManifestSummary {
  let st: fs.Stats
  try {
    st = fs.statSync(manifestPath)
  } catch {
    throw new RollbackError('ROLLBACK_MANIFEST_UNREADABLE')
  }
  if (!st.isFile()) throw new RollbackError('ROLLBACK_MANIFEST_UNREADABLE')
  let m: ManifestSummary
  try {
    m = readManifest(manifestPath)
  } catch {
    throw new RollbackError('ROLLBACK_MANIFEST_UNREADABLE')
  }
  if (!m.started) throw new RollbackError('ROLLBACK_MANIFEST_INVALID')
  return m
}

export async function runRollback(payload: Payload, opts: RollbackOptions): Promise<RollbackReport> {
  const manifestPath = path.resolve(opts.manifestPath)
  const m = summariseManifest(manifestPath)
  if (!m.complete && !opts.allowIncomplete) throw new RollbackError('ROLLBACK_MANIFEST_INCOMPLETE')

  const startMs = m.startedAt ? Date.parse(m.startedAt) : NaN
  if (!Number.isFinite(startMs)) throw new RollbackError('ROLLBACK_MANIFEST_INVALID')
  // End of the run's window: its end line, or (a killed run) the last time anything was appended to the manifest.
  const mtimeMs = fs.statSync(manifestPath).mtimeMs
  // A manifest still being written by a live run must not be rolled back under it.
  if (!m.complete && Date.now() - mtimeMs < (opts.minIncompleteAgeMs ?? 60_000)) throw new RollbackError('ROLLBACK_MANIFEST_TOO_RECENT')
  const parsedEnd = m.endAt ? Date.parse(m.endAt) : NaN
  const endMs = Number.isFinite(parsedEnd) ? parsedEnd : mtimeMs
  const apply = opts.apply === true
  const ids = {
    comments: uniq(m.comments),
    articles: uniq(m.articles.created),
    media: uniq(m.media),
    categories: uniq(m.categories),
  }
  const report: RollbackReport = {
    mode: apply ? 'apply' : 'dry-run',
    force: opts.force === true,
    manifest: { startedAt: m.startedAt, complete: m.complete, endStatus: m.endStatus, openIntents: m.openIntents.length, abortedPosts: m.aborted.length },
    comments: counts(ids.comments.length),
    articles: counts(ids.articles.length),
    media: counts(ids.media.length),
    categories: counts(ids.categories.length),
    articlesUpdatedNotReverted: uniq(m.articles.updated.filter((id) => !m.articles.created.includes(id))).length,
    auditRowsKept: uniq(m.audits).length,
    notes: [],
  }
  if (!m.complete) report.notes.push('incomplete-manifest-allowed')

  const ctx: Ctx = {
    payload,
    base: await createLocalReq({ context: { import: true } }, payload),
    apply,
    force: opts.force === true,
    windowStart: startMs,
    cutoff: endMs,
    pending: { commentsByArticle: new Map(), articlesByCategory: new Map(), articlesByMedia: new Map() },
  }

  // Dependants first: comments, then articles (they reference media and categories), then media and categories.
  const plan: Array<[Handler, number[], ItemCounts]> = [
    [handlers['legacy-comments'], ids.comments, report.comments],
    [handlers.articles, ids.articles, report.articles],
    [handlers.media, ids.media, report.media],
    [handlers.categories, ids.categories, report.categories],
  ]
  for (const [h, list, c] of plan) {
    let n = 0
    for (const id of list) {
      await removeOne(ctx, h, id, c)
      if (++n % 500 === 0) opts.progress?.(`${h.collection}: ${n} of ${list.length} processed`)
    }
  }

  if (apply) {
    const f = (c: ItemCounts) => c.failed
    try {
      await writeAuditLog(ctx.base, {
        action: 'import.rollback',
        collection: 'import',
        docId: 'rollback',
        actorRole: 'import',
        summary: `Import rollback applied: ${report.articles.deleted} articles, ${report.comments.deleted} comments, ${report.media.deleted} media, ${report.categories.deleted} categories deleted`,
        details: {
          force: report.force,
          complete: m.complete,
          deleted: { articles: report.articles.deleted, comments: report.comments.deleted, media: report.media.deleted, categories: report.categories.deleted },
          failed: f(report.articles) + f(report.comments) + f(report.media) + f(report.categories),
        },
      })
      report.notes.push('audit-row-written')
    } catch {
      report.notes.push('audit-row-failed')
    }
  } else {
    report.notes.push('dry-run-nothing-deleted')
  }
  return report
}

const skippedText = (t: Tally): string => {
  const e = Object.entries(t)
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join(' ') : '-'
}

/** Counts and fixed codes only. */
export function formatRollbackReport(r: RollbackReport): string {
  const apply = r.mode === 'apply'
  const line = (name: string, c: ItemCounts) =>
    `  ${name}: listed ${c.listed}, ${apply ? 'deleted' : 'would delete'} ${apply ? c.deleted : c.wouldDelete}, already gone ${c.alreadyGone}, skipped [${skippedText(c.skipped)}], failed ${c.failed}`
  return [
    `Import rollback (${r.mode}${r.force ? ', force' : ''})`,
    `Manifest (started ${r.manifest.startedAt ?? "unknown"}): ${r.manifest.complete ? `complete (${r.manifest.endStatus})` : 'INCOMPLETE'}, open intents ${r.manifest.openIntents}, aborted posts ${r.manifest.abortedPosts}`,
    line('comments', r.comments),
    line('articles', r.articles),
    line('media', r.media),
    line('categories', r.categories),
    `Articles only updated by the run (left as they are): ${r.articlesUpdatedNotReverted}`,
    `Audit rows kept: ${r.auditRowsKept}`,
    `Notes: ${r.notes.join(', ') || '-'}`,
  ].join('\n')
}

export const rollbackHadFailures = (r: RollbackReport): boolean => r.comments.failed + r.articles.failed + r.media.failed + r.categories.failed > 0
