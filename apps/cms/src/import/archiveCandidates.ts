import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { writeAuditLog } from '../lib/audit'
import { normaliseSourceUrl, normaliseTitle, validateLine, type ArchiveCandidate } from '../lib/archiveCandidate'
import { resolveArticlePathTemplate } from '../lib/redirectPaths'
import { isReservedSlug } from '../lib/reservedSlugs'
import { safeErrorSummary } from '../lib/safeLog'
import { SLUG_RE, slugify } from '../lib/sanitize'
import { htmlToLexical } from './htmlToLexical'
import { openManifest, type ManifestSink } from './manifest'
import { bumpTally, type Tally } from './qa'
import { isInsideRepo } from './safePaths'

/**
 * Archive-candidate importer (`archive-candidate/1`, docs/archive-candidate-schema.md): recovered pages become DRAFT
 * articles with provenance. Nothing is ever published: the Articles hook refuses `published` / `scheduled` until an editor
 * sets `provenance.reviewStatus` to `reviewed`.
 *
 * - Dry run by default (reads the file and the database, writes nothing, creates no files).
 * - One database transaction per candidate, `req.context.import = true` (workflow skipped, validators stay on).
 * - Dedup, in this order, each counted: invalid line; duplicate inside the file (address or raw hash); already in the CMS
 *   (provenance source address variant, provenance raw hash, or a WordPress `legacyUrl`); already present by slug and
 *   title. A slug taken by a DIFFERENT article, or a reserved route name, gets `-archive[-N]` and is counted.
 * - Idempotent: a second run over the same file creates nothing.
 * - Append-only rollback manifest (manifest.ts, compatible with `npm run import:rollback`) and a per-row detail file
 *   (JSON Lines, row number and fixed outcome code, no text) both OUTSIDE every git work tree, mode 0o600.
 * - Output is counts only.
 */

export class ArchiveImportError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'ArchiveImportError'
  }
}

export type ArchiveImportOptions = {
  /** `archive-candidate/1` JSON Lines file, outside every repository. */
  file: string
  apply: boolean
  /** Existing directory outside every repository for the rollback manifest and the detail file. Required with `apply`. */
  manifestDir?: string
  /** Category slug that receives the drafts (default `uncategorised`, created when missing). */
  category?: string
  /** Batch label stored in `provenance.importBatch` (default derived from the file hash). */
  batch?: string
  signal?: { readonly stopped: boolean }
  progress?: (line: string) => void
  cwd?: string
  /** Test hook: clock for the future-capture check. */
  now?: number
}

export type ArchiveImportReport = {
  mode: 'dry-run' | 'apply'
  batch: string
  lines: number
  blank: number
  invalid: Tally
  duplicateInFile: Tally
  alreadyPresent: Tally
  /** Drafts created (apply) or that would be created (dry run). */
  created: number
  slugRenamed: number
  slugRenamedReserved: number
  categoryCreated: number
  failed: Tally
  confidence: Tally
  /** Candidates with media references (the references are validated and counted, not imported). */
  withMedia: number
  mediaRefs: number
  stopped: boolean
  detailFile: string | null
  manifestFile: string | null
}

const BATCH_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const DEFAULT_CATEGORY = { slug: 'uncategorised', title: 'Uncategorised' }
const MAX_CONSECUTIVE_FAILURES = 20

const sum = (t: Tally): number => Object.values(t).reduce((a, b) => a + b, 0)

/** Address spellings that mean the same page: scheme, `www.`, trailing slash. At most 8. */
export function urlVariants(raw: string): string[] {
  const u = new URL(raw)
  const hosts = new Set([u.host, u.host.replace(/^www\./i, ''), `www.${u.host.replace(/^www\./i, '')}`])
  const paths = new Set([u.pathname, u.pathname.endsWith('/') ? u.pathname.replace(/\/+$/, '') || '/' : `${u.pathname}/`])
  const out = new Set<string>([raw])
  for (const scheme of ['http:', 'https:']) for (const host of hosts) for (const p of paths) out.add(`${scheme}//${host}${p}${u.search}`)
  return [...out].slice(0, 12)
}

type Ctx = {
  payload: Payload
  req: PayloadRequest
  opts: ArchiveImportOptions
  report: ArchiveImportReport
  manifest: ManifestSink | undefined
  detail: number | undefined
  categoryId: number | undefined
  claimedSlugs: Set<string>
  seenUrls: Set<string>
  seenSha: Set<string>
  batch: string
}

const detailLine = (ctx: Ctx, row: number, outcome: string, extra: Record<string, unknown> = {}): void => {
  if (ctx.detail === undefined) return
  fs.writeSync(ctx.detail, JSON.stringify({ row, outcome, ...extra }) + '\n')
}

async function findExisting(ctx: Ctx, c: ArchiveCandidate): Promise<'present-source-url' | 'present-source-hash' | 'present-legacy-url' | null> {
  const { payload, req } = ctx
  const urls = urlVariants(c.originalUrl)
  const bySource = await payload.find({
    collection: 'articles',
    where: { 'provenance.sourceUrl': { in: urls } },
    limit: 1,
    depth: 0,
    pagination: false,
    overrideAccess: true,
    select: { slug: true },
    req,
  })
  if (bySource.docs.length) return 'present-source-url'
  const byHash = await payload.find({
    collection: 'articles',
    where: { 'provenance.sourceSha256': { equals: c.rawSha256 } },
    limit: 1,
    depth: 0,
    pagination: false,
    overrideAccess: true,
    select: { slug: true },
    req,
  })
  if (byHash.docs.length) return 'present-source-hash'
  const byLegacy = await payload.find({
    collection: 'articles',
    where: { legacyUrl: { in: urls } },
    limit: 1,
    depth: 0,
    pagination: false,
    overrideAccess: true,
    select: { slug: true },
    req,
  })
  return byLegacy.docs.length ? 'present-legacy-url' : null
}

type SlugDecision = { slug: string; renamed: boolean; reserved: boolean } | { present: true }

async function decideSlug(ctx: Ctx, c: ArchiveCandidate): Promise<SlugDecision | null> {
  const { payload, req } = ctx
  const base = slugify(c.title, 150, 'archive')
  const blockReserved = resolveArticlePathTemplate() === '/{slug}/'
  const reservedHit = blockReserved && isReservedSlug(base)
  const fit = (s: string) => s.slice(0, 160).replace(/-+$/, '')
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? base : fit(`${base.slice(0, 140)}-archive${attempt > 1 ? `-${attempt}` : ''}`)
    if (attempt === 0 && reservedHit) continue
    if (!SLUG_RE.test(candidate)) continue
    if (ctx.claimedSlugs.has(candidate)) continue
    const hit = (await payload.find({
      collection: 'articles',
      where: { slug: { equals: candidate } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
      select: { slug: true, title: true },
      req,
    })).docs[0] as { title?: string } | undefined
    if (hit) {
      // Same slug and same normalised title: the article is already on the site.
      if (attempt === 0 && typeof hit.title === 'string' && normaliseTitle(hit.title) === normaliseTitle(c.title)) return { present: true }
      continue
    }
    return { slug: candidate, renamed: attempt > 0, reserved: reservedHit }
  }
  return null
}

async function findOrCreateCategory(ctx: Ctx, slug: string): Promise<number> {
  const { payload } = ctx
  const found = await payload.find({ collection: 'categories', where: { slug: { equals: slug } }, limit: 1, depth: 0, overrideAccess: true, select: { slug: true }, req: ctx.req })
  if (found.docs[0]) return (found.docs[0] as { id: number }).id
  ctx.report.categoryCreated++
  if (!ctx.opts.apply) return 0
  const title = slug === DEFAULT_CATEGORY.slug ? DEFAULT_CATEGORY.title : slug
  const doc = (await payload.create({ collection: 'categories', data: { title, slug } as never, overrideAccess: true, req: ctx.req })) as { id: number }
  ctx.manifest?.id('categories', 'created', doc.id)
  return doc.id
}

function failureCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(code)) return `write-failed-${code}`
  return 'write-failed'
}

async function writeOne(ctx: Ctx, row: number, c: ArchiveCandidate, slug: string): Promise<void> {
  const { payload, opts } = ctx
  const req = await createLocalReq({ context: { import: true } }, payload)
  let txId: number | string | null = null
  if (opts.apply) {
    txId = (await payload.db.beginTransaction()) as number | string | null
    if (txId) req.transactionID = txId
  }
  ctx.manifest?.append({ type: 'intent', legacyId: row })
  try {
    // Images are not imported by this command: every image is reported unresolved and dropped by the converter.
    const converted = htmlToLexical(c.bodyHtml, { oldHosts: [c.host], slugMap: {}, resolveImage: () => null, articleTitle: c.title })
    const kids = (converted.content.root as { children?: unknown[] }).children
    const empty =
      !Array.isArray(kids) ||
      kids.length === 0 ||
      kids.every((k) => {
        const n = k as { type?: string; children?: { type?: string; text?: string }[] }
        return n.type === 'paragraph' && (n.children ?? []).every((t) => t.type === 'text' && !t.text)
      })
    if (empty) throw new ArchiveImportError('empty-body')
    if (opts.apply) {
      const doc = (await payload.create({
        collection: 'articles',
        data: {
          title: c.title,
          slug,
          content: converted.content,
          category: ctx.categoryId,
          status: 'draft',
          bylineName: c.byline ?? undefined,
          provenance: {
            sourceUrl: c.originalUrl,
            sourceHost: c.host,
            captureTimestamp: c.captureTimestamp,
            originalDate: c.date ? new Date(c.date).toISOString() : undefined,
            sourceSha256: c.rawSha256,
            confidence: c.confidence,
            importBatch: ctx.batch,
            reviewStatus: 'pending',
          },
        } as never,
        overrideAccess: true,
        depth: 0,
        req,
      })) as { id: number }
      ctx.manifest?.id('articles', 'created', doc.id)
      const audit = (await writeAuditLog(req, {
        action: 'import.article',
        collection: 'articles',
        docId: doc.id,
        toStatus: 'draft',
        actorRole: 'import',
        summary: `Archive candidate imported as draft (batch ${ctx.batch})`,
        details: { batch: ctx.batch, confidence: c.confidence },
      })) as { id: number }
      ctx.manifest?.id('audit-logs', 'created', audit.id)
    }
    if (txId) await payload.db.commitTransaction(txId)
    ctx.manifest?.append({ type: 'commit', legacyId: row })
  } catch (err) {
    if (txId) {
      try {
        await payload.db.rollbackTransaction(txId)
      } catch {
        // already ended
      }
    }
    ctx.manifest?.append({ type: 'abort', legacyId: row })
    throw err
  }
}

function openPrivate(file: string): number {
  const fd = fs.openSync(file, 'wx', 0o600)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Windows ignores POSIX modes.
  }
  return fd
}

export async function runArchiveImport(payload: Payload, opts: ArchiveImportOptions): Promise<ArchiveImportReport> {
  const cwd = opts.cwd ?? process.cwd()
  const file = path.resolve(cwd, opts.file)
  if (isInsideRepo(file, cwd)) throw new ArchiveImportError('ARCHIVE_FILE_INSIDE_REPO')
  let content: Buffer
  try {
    if (!fs.statSync(file).isFile()) throw new Error('not a file')
    content = fs.readFileSync(file)
  } catch {
    throw new ArchiveImportError('ARCHIVE_FILE_UNREADABLE')
  }
  const batch = opts.batch ?? `arc-${createHash('sha256').update(content).digest('hex').slice(0, 12)}`
  if (!BATCH_RE.test(batch)) throw new ArchiveImportError('ARCHIVE_BATCH_INVALID')
  const categorySlug = opts.category ?? DEFAULT_CATEGORY.slug
  if (!SLUG_RE.test(categorySlug) || categorySlug.length > 100) throw new ArchiveImportError('ARCHIVE_CATEGORY_INVALID')

  let dir: string | undefined
  if (opts.manifestDir) {
    dir = path.resolve(cwd, opts.manifestDir)
    if (isInsideRepo(dir, cwd)) throw new ArchiveImportError('ARCHIVE_MANIFEST_INSIDE_REPO')
    try {
      if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new ArchiveImportError('ARCHIVE_MANIFEST_DIR_MISSING')
    }
  } else if (opts.apply) {
    throw new ArchiveImportError('ARCHIVE_MANIFEST_REQUIRED')
  }

  const report: ArchiveImportReport = {
    mode: opts.apply ? 'apply' : 'dry-run',
    batch,
    lines: 0,
    blank: 0,
    invalid: {},
    duplicateInFile: {},
    alreadyPresent: {},
    created: 0,
    slugRenamed: 0,
    slugRenamedReserved: 0,
    categoryCreated: 0,
    failed: {},
    confidence: {},
    withMedia: 0,
    mediaRefs: 0,
    stopped: false,
    detailFile: null,
    manifestFile: null,
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
  let manifest: ManifestSink | undefined
  let detail: number | undefined
  try {
    if (dir) {
      const detailPath = path.join(dir, `archive-candidates-${batch}-${stamp}.detail.jsonl`)
      detail = openPrivate(detailPath)
      report.detailFile = detailPath
      if (opts.apply) {
        const manifestPath = path.join(dir, `archive-candidates-${batch}-${stamp}.manifest.jsonl`)
        manifest = openManifest(manifestPath)
        report.manifestFile = manifestPath
      }
    }
  } catch {
    if (detail !== undefined) fs.closeSync(detail)
    throw new ArchiveImportError('ARCHIVE_MANIFEST_UNWRITABLE')
  }

  let endStatus: 'complete' | 'failed' | 'stopped' = 'failed'
  try {
    const req = await createLocalReq({ context: { import: true } }, payload)
    const ctx: Ctx = {
      payload,
      req,
      opts,
      report,
      manifest,
      detail,
      categoryId: undefined,
      claimedSlugs: new Set(),
      seenUrls: new Set(),
      seenSha: new Set(),
      batch,
    }
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
    let consecutiveFailures = 0
    let row = 0
    try {
      for await (const raw of rl) {
        row++
        if (opts.signal?.stopped) {
          report.stopped = true
          break
        }
        const line = raw.replace(/^﻿/, '')
        if (!line.trim()) {
          report.blank++
          continue
        }
        report.lines++
        const v = validateLine(line, opts.now)
        if (!v.ok) {
          bumpTally(report.invalid, v.reason)
          detailLine(ctx, row, 'invalid', { reason: v.reason })
          continue
        }
        const c = v.value
        const urlKey = normaliseSourceUrl(c.originalUrl)
        if (ctx.seenUrls.has(urlKey)) {
          bumpTally(report.duplicateInFile, 'source-url')
          detailLine(ctx, row, 'duplicate-in-file', { reason: 'source-url' })
          continue
        }
        if (ctx.seenSha.has(c.rawSha256)) {
          bumpTally(report.duplicateInFile, 'source-hash')
          detailLine(ctx, row, 'duplicate-in-file', { reason: 'source-hash' })
          continue
        }
        ctx.seenUrls.add(urlKey)
        ctx.seenSha.add(c.rawSha256)

        try {
          const existing = await findExisting(ctx, c)
          if (existing) {
            bumpTally(report.alreadyPresent, existing)
            detailLine(ctx, row, 'already-present', { reason: existing })
            continue
          }
          const slug = await decideSlug(ctx, c)
          if (slug === null) {
            bumpTally(report.failed, 'slug-unavailable')
            detailLine(ctx, row, 'failed', { reason: 'slug-unavailable' })
            continue
          }
          if ('present' in slug) {
            bumpTally(report.alreadyPresent, 'present-slug-title')
            detailLine(ctx, row, 'already-present', { reason: 'present-slug-title' })
            continue
          }
          if (ctx.categoryId === undefined) ctx.categoryId = await findOrCreateCategory(ctx, categorySlug)
          await writeOne(ctx, row, c, slug.slug)
          ctx.claimedSlugs.add(slug.slug)
          report.created++
          if (slug.renamed) report.slugRenamed++
          if (slug.reserved) report.slugRenamedReserved++
          bumpTally(report.confidence, c.confidence)
          if (c.media.length) {
            report.withMedia++
            report.mediaRefs += c.media.length
          }
          consecutiveFailures = 0
          detailLine(ctx, row, opts.apply ? 'created' : 'would-create', { slugRenamed: slug.renamed })
          if (report.created % 100 === 0) opts.progress?.(`archive import: ${report.created} drafts`)
        } catch (err) {
          const code = err instanceof ArchiveImportError ? err.code : failureCode(err)
          bumpTally(report.failed, code)
          detailLine(ctx, row, 'failed', { reason: code, detail: safeErrorSummary(err) })
          if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw new ArchiveImportError('ARCHIVE_TOO_MANY_FAILURES')
        }
      }
    } finally {
      rl.close()
    }
    endStatus = report.stopped ? 'stopped' : 'complete'
    return report
  } finally {
    manifest?.append({ type: 'end', at: new Date().toISOString(), status: endStatus })
    manifest?.close()
    if (detail !== undefined) fs.closeSync(detail)
  }
}

export function formatArchiveReport(r: ArchiveImportReport): string {
  const t = (x: Tally) => (Object.keys(x).length ? Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}=${n}`).join(' ') : 'none')
  return [
    `Archive candidate import (${r.mode}) batch ${r.batch}${r.stopped ? ' [stopped early]' : ''}`,
    `  lines read: ${r.lines} (blank ${r.blank})`,
    `  invalid: ${sum(r.invalid)} (${t(r.invalid)})`,
    `  duplicate in file: ${sum(r.duplicateInFile)} (${t(r.duplicateInFile)})`,
    `  already in the CMS: ${sum(r.alreadyPresent)} (${t(r.alreadyPresent)})`,
    `  ${r.mode === 'apply' ? 'drafts created' : 'drafts that would be created'}: ${r.created} (slug renamed ${r.slugRenamed}, of which reserved ${r.slugRenamedReserved})`,
    `  by confidence: ${t(r.confidence)}`,
    `  categories ${r.mode === 'apply' ? 'created' : 'to create'}: ${r.categoryCreated}`,
    `  media references (validated, not imported): ${r.mediaRefs} in ${r.withMedia} candidates`,
    `  failed: ${sum(r.failed)} (${t(r.failed)})`,
    `  per-row detail file: ${r.detailFile ? 'written (private path)' : 'not written (no --manifest dir)'}`,
    `  rollback manifest: ${r.manifestFile ? 'written (private path)' : r.mode === 'apply' ? 'MISSING' : 'none (dry run)'}`,
  ].join('\n')
}
