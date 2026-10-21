import path from 'node:path'

import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { writeAuditLog } from '../lib/audit'
import { legacyPathFromUrl } from '../lib/legacyMediaPath'
import { cleanText, slugify } from '../lib/sanitize'
import { hasTemplateVariable, SEO_DESCRIPTION_MAX, SEO_TITLE_MAX } from '../lib/seoFields'
import { safeErrorSummary } from '../lib/safeLog'
import { prepareComments, writeComments } from './comments'
import { HtmlConversionError, htmlToLexical, type ConversionReport } from './htmlToLexical'
import { newManifest, openManifest, type Manifest, type ManifestSink } from './manifest'
import { createMediaResolver, type MediaResolver } from './media'
import { bumpTally, newReport, type ImportReport } from './qa'
import { isInsideRepo } from './safePaths'
import { readWxrFile, type WxrAttachment, type WxrItem } from './wxr'

/**
 * WordPress archive loader: parse (WXR) -> convert (HTML to Lexical) -> write (Local API). See docs/import.md.
 *
 * - Its OWN context flag, `req.context.import`, not `seed`: the Articles validators (embeds, body images, SEO fields,
 *   slug rules) stay ON; only the editorial workflow is skipped (Articles.enforceWorkflow).
 * - Idempotent: an article is matched by `legacyId`. Default: an existing one is left alone (comments are still
 *   completed, skipping ids that exist). `update: true` rewrites the converted fields of an existing article.
 * - Dry run: reads the file and the database, writes NOTHING (no media, categories, articles, comments, audit rows or
 *   manifest) and reports what would happen.
 * - Writes an `import.article` audit row per created or updated article, and a rollback manifest (ids only) to a path
 *   outside the repository, mode 0o600.
 * - Only published, not password-protected posts are imported. Everything else is counted in the report.
 */

export class ImportError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'ImportError'
  }
}

export type ImportOptions = {
  /** The WXR export. Must be outside the repository. */
  file: string
  /** The copied `wp-content/uploads` folder. Outside the repository. Without it only existing media is matched. */
  uploadsRoot?: string
  /** Rollback manifest path (outside the repository, must not exist). Required unless `dryRun`. */
  manifestPath?: string
  dryRun: boolean
  /** Rewrite the converted fields of an article that was imported before. */
  update?: boolean
  /** Extra old-site host names (the hosts in the export's own site header are always used). */
  oldHosts?: readonly string[]
  /** Stop after this many posts (trial runs). */
  limit?: number
  /** Called with a short progress line (counts only). */
  progress?: (line: string) => void
  /** Working directory for the repository checks. */
  cwd?: string
}

const FALLBACK_CATEGORY = { slug: 'uncategorised', title: 'Uncategorised' }
const MAX_CONSECUTIVE_FAILURES = 50

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#038': '&' }
/** Decode the entities WordPress leaves in titles and excerpts. `&lt;` and `&gt;` are deliberately left as written. */
const decode = (s: string): string => s.replace(/&(amp|quot|apos|nbsp|#39|#038);/g, (_m, n: string) => ENTITIES[n] ?? _m)

const plain = (html: string, max: number, multiline = false): string => cleanText(decode(cleanText(html, { multiline })), { max, multiline })

function hostsOf(...urls: string[]): string[] {
  const out: string[] = []
  for (const u of urls) {
    try {
      out.push(new URL(u).hostname.toLowerCase())
    } catch {
      // not an address
    }
  }
  return out
}

const articleSlug = (it: WxrItem): string => slugify(it.slug || it.title, 150, `post-${it.wpId}`)

type Pass1 = {
  attachments: Map<number, WxrAttachment>
  authors: Map<string, string>
  siteHosts: string[]
  slugMap: Record<string, string>
}

async function pass1(file: string, report: ImportReport): Promise<Pass1> {
  const out: Pass1 = { attachments: new Map(), authors: new Map(), siteHosts: [], slugMap: {} }
  for await (const rec of readWxrFile(file)) {
    if (rec.record === 'site') out.siteHosts = hostsOf(rec.site.baseSiteUrl, rec.site.baseBlogUrl)
    else if (rec.record === 'author') {
      if (rec.author.login) out.authors.set(rec.author.login, rec.author.displayName)
    } else if (rec.record === 'item') {
      const it = rec.item
      bumpTally(report.source.items, it.kind)
      if (it.kind === 'attachment') {
        report.source.attachments++
        if (it.wpId !== null && it.attachment) out.attachments.set(it.wpId, it.attachment)
      }
      if (it.kind === 'post') {
        bumpTally(report.source.postsByStatus, it.status || 'unknown')
        if (it.status === 'publish') {
          report.source.publishedPosts++
          for (const c of it.comments) {
            if (c.approved === '1' && (c.type === 'comment' || c.type === '')) report.source.approvedCommentsOnPublishedPosts++
          }
          if (it.slug && it.wpId !== null) out.slugMap[it.slug] = articleSlug(it)
        }
      }
    }
  }
  return out
}

type Ctx = {
  payload: Payload
  req: PayloadRequest
  opts: ImportOptions
  report: ImportReport
  manifest: Manifest
  media: MediaResolver
  categories: Map<string, number>
  claimedSlugs: Set<string>
}

async function categoryFor(ctx: Ctx, item: WxrItem): Promise<number> {
  const first = item.categories.find((c) => c.nicename)
  const slug = first ? slugify(first.nicename, 100, FALLBACK_CATEGORY.slug) : FALLBACK_CATEGORY.slug
  const title = first ? plain(first.name || first.nicename, 120) || slug : FALLBACK_CATEGORY.title
  if (!first) ctx.report.categories.fallbackUsed++
  const known = ctx.categories.get(slug)
  if (known !== undefined) return known
  const found = await ctx.payload.find({
    collection: 'categories',
    where: { slug: { equals: slug } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    req: ctx.req,
  })
  let id = (found.docs[0] as { id?: number } | undefined)?.id
  if (id === undefined) {
    ctx.report.categories.created++
    if (ctx.opts.dryRun) id = 0
    else {
      const doc = (await ctx.payload.create({
        collection: 'categories',
        data: { title, slug } as never,
        overrideAccess: true,
        req: ctx.req,
      })) as { id: number }
      id = doc.id
      ctx.manifest.categories.push(id)
    }
  }
  ctx.categories.set(slug, id)
  return id
}

async function uniqueSlug(ctx: Ctx, item: WxrItem, existingId: number | undefined): Promise<string> {
  const base = articleSlug(item)
  const taken = async (slug: string): Promise<boolean> => {
    if (ctx.claimedSlugs.has(slug)) return true
    const hit = await ctx.payload.find({
      collection: 'articles',
      where: { slug: { equals: slug } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
      select: { legacyId: true },
      req: ctx.req,
    })
    const doc = hit.docs[0] as { id: number; legacyId?: number } | undefined
    return doc !== undefined && doc.id !== existingId
  }
  let slug = base
  if (await taken(slug)) {
    const suffix = `-${item.wpId}`
    slug = `${base.slice(0, 160 - suffix.length).replace(/-+$/, '')}${suffix}`
  }
  ctx.claimedSlugs.add(slug)
  return slug
}

type Converted = { content: { root: unknown }; report: ConversionReport; unresolvedImages: number }

/** Two passes: the first collects image addresses, they are resolved (async), the second builds the body. */
async function convert(ctx: Ctx, item: WxrItem, oldHosts: readonly string[], slugMap: Record<string, string>): Promise<Converted> {
  const wanted = new Map<string, { alt: string; caption: string }>()
  const options = { oldHosts, slugMap, articleTitle: plain(item.title, 240) }
  htmlToLexical(item.contentHtml, {
    ...options,
    resolveImage: (src, c) => {
      if (!wanted.has(src)) wanted.set(src, { alt: c.alt, caption: c.caption })
      return { mediaId: 1 }
    },
  })
  const resolved = new Map<string, number>()
  for (const [src, meta] of wanted) {
    const r = await ctx.media.resolveUrl(src, { ...meta, articleTitle: options.articleTitle })
    if (r.ok) resolved.set(src, r.mediaId)
  }
  const result = htmlToLexical(item.contentHtml, {
    ...options,
    resolveImage: (src) => {
      const id = resolved.get(src)
      return id === undefined ? null : { mediaId: id }
    },
  })
  return { content: result.content, report: result.report, unresolvedImages: result.report.images.unresolved.length }
}

async function featuredImageFor(ctx: Ctx, item: WxrItem, attachments: Map<number, WxrAttachment>): Promise<number | undefined> {
  if (item.thumbnailId === null) return undefined
  const att = attachments.get(item.thumbnailId)
  const rel = att ? (att.attachedFile && !att.attachedFile.includes('..') ? att.attachedFile : legacyPathFromUrl(att.url)) : null
  const r = rel
    ? await ctx.media.resolvePath(rel, { alt: att?.altText ?? '', articleTitle: plain(item.title, 240) })
    : { ok: false as const, reason: 'no-attachment' }
  if (!r.ok) {
    ctx.report.content.featuredImageMissing++
    return undefined
  }
  return r.mediaId
}

function seoValue(raw: string | null | undefined, max: number): string | undefined {
  if (!raw) return undefined
  const v = plain(raw, 2000)
  if (v === '' || v.length > max || hasTemplateVariable(v)) return undefined
  return v
}

function addConversionStats(rep: ImportReport, c: ConversionReport): void {
  rep.content.imagesResolved += c.images.resolved
  rep.content.imagesUnresolved += c.images.unresolved.length
  rep.content.linksUnmapped += c.links.unmapped.length
  rep.content.youtube += c.youtube
  rep.content.tablesFlattened += c.tables.flattened.length
  rep.content.embedsDropped += c.embeds.dropped.length
}

export async function runImport(payload: Payload, opts: ImportOptions): Promise<ImportReport> {
  const cwd = opts.cwd ?? process.cwd()
  const file = path.resolve(cwd, opts.file)
  if (isInsideRepo(file, cwd)) throw new ImportError('IMPORT_FILE_INSIDE_REPO')
  const uploadsRoot = opts.uploadsRoot ? path.resolve(cwd, opts.uploadsRoot) : undefined
  if (uploadsRoot && isInsideRepo(uploadsRoot, cwd)) throw new ImportError('IMPORT_UPLOADS_INSIDE_REPO')
  let sink: ManifestSink | undefined
  const manifest = newManifest()
  if (!opts.dryRun) {
    if (!opts.manifestPath) throw new ImportError('IMPORT_MANIFEST_REQUIRED')
    const manifestPath = path.resolve(cwd, opts.manifestPath)
    if (isInsideRepo(manifestPath, cwd)) throw new ImportError('IMPORT_MANIFEST_INSIDE_REPO')
    try {
      sink = openManifest(manifestPath)
    } catch {
      throw new ImportError('IMPORT_MANIFEST_UNWRITABLE')
    }
  }

  const report = newReport(opts.dryRun ? 'dry-run' : 'apply', opts.update === true)
  try {
    const req = await createLocalReq({ context: { import: true } }, payload)
    const first = await pass1(file, report)
    const oldHosts = [...new Set([...(opts.oldHosts ?? []).map((h) => h.toLowerCase()), ...first.siteHosts])]
    const media = createMediaResolver({
      payload,
      req,
      uploadsRoot,
      oldHosts,
      dryRun: opts.dryRun,
      onCreated: (id) => manifest.media.push(id),
    })
    const ctx: Ctx = { payload, req, opts, report, manifest, media, categories: new Map(), claimedSlugs: new Set() }

    const seenLegacyIds: number[] = []
    const seenArticleIds: number[] = []
    let processed = 0
    let consecutiveFailures = 0
    for await (const rec of readWxrFile(file)) {
      if (rec.record !== 'item' || rec.item.kind !== 'post') continue
      const item = rec.item
      const skip = (reason: string) => bumpTally(report.articles.skipped, reason)
      if (item.status !== 'publish') {
        skip(`status-${item.status || 'unknown'}`)
        continue
      }
      if (item.hasPassword) {
        report.articles.passwordProtected++
        continue
      }
      if (opts.limit !== undefined && processed >= opts.limit) break
      processed++
      if (item.wpId === null) {
        skip('bad-id')
        continue
      }
      if (item.dateGmt === null) {
        skip('no-date')
        continue
      }
      const title = plain(item.title, 240)
      if (title === '') {
        skip('no-title')
        continue
      }
      try {
        await importOne(ctx, item, title, first, oldHosts, seenArticleIds)
        seenLegacyIds.push(item.wpId)
        consecutiveFailures = 0
      } catch (err) {
        if (err instanceof HtmlConversionError) skip(`conversion-${err.code}`)
        else {
          skip('write-failed')
          opts.progress?.(`article failed: ${safeErrorSummary(err)}`)
        }
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw new ImportError('IMPORT_TOO_MANY_FAILURES')
      }
      if (processed % 100 === 0) opts.progress?.(`${processed} posts processed`)
      sink?.write(manifest)
    }

    report.media.reused = media.stats.reused
    report.media.created = media.stats.created
    report.media.unresolved = { ...media.stats.unresolved }

    if (!opts.dryRun) {
      let articlesInDatabase = 0
      for (let i = 0; i < seenLegacyIds.length; i += 500) {
        articlesInDatabase += (
          await payload.count({ collection: 'articles', where: { legacyId: { in: seenLegacyIds.slice(i, i + 500) } }, overrideAccess: true, req })
        ).totalDocs
      }
      let commentsInDatabase = 0
      for (let i = 0; i < seenArticleIds.length; i += 500) {
        commentsInDatabase += (
          await payload.count({ collection: 'legacy-comments', where: { article: { in: seenArticleIds.slice(i, i + 500) } }, overrideAccess: true, req })
        ).totalDocs
      }
      report.verified = { articlesInDatabase, commentsInDatabase }
      report.notes.push('manifest-written')
    } else {
      report.notes.push('dry-run-nothing-written')
    }
    return report
  } finally {
    if (sink) {
      manifest.finishedAt = new Date().toISOString()
      try {
        sink.write(manifest)
      } finally {
        sink.close()
      }
    }
  }
}

async function importOne(
  ctx: Ctx,
  item: WxrItem,
  title: string,
  first: Pass1,
  oldHosts: readonly string[],
  seenArticleIds: number[],
): Promise<void> {
  const { payload, req, opts, report, manifest } = ctx
  const legacyId = item.wpId as number
  const found = await payload.find({
    collection: 'articles',
    where: { legacyId: { equals: legacyId } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    select: { slug: true },
    req,
  })
  const existing = found.docs[0] as { id: number } | undefined

  let articleId = existing?.id ?? 0
  if (existing && !opts.update) {
    report.articles.unchanged++
  } else {
    const converted = await convert(ctx, item, oldHosts, first.slugMap)
    addConversionStats(report, converted.report)
    const featuredImage = await featuredImageFor(ctx, item, first.attachments)
    const excerpt = plain(item.excerptHtml, 600, true)
    const byline = item.author ? plain(first.authors.get(item.author) ?? '', 120) : ''
    const fields = {
      title,
      excerpt: excerpt || undefined,
      content: converted.content,
      featuredImage,
      bylineName: byline || undefined,
      seoTitle: seoValue(item.seo.rankMathTitle ?? item.seo.yoastTitle, SEO_TITLE_MAX),
      seoDescription: seoValue(item.seo.rankMathDescription ?? item.seo.yoastDescription, SEO_DESCRIPTION_MAX),
      legacyUrl: /^https?:\/\//i.test(item.link) ? item.link.slice(0, 1000) : undefined,
      legacyId,
    }
    if (existing) {
      if (!opts.dryRun) {
        await payload.update({ collection: 'articles', id: existing.id, data: fields as never, overrideAccess: true, depth: 0, req })
        manifest.articles.updated.push(existing.id)
        await audit(ctx, existing.id, legacyId, 'updated')
      }
      report.articles.updated++
    } else {
      const category = await categoryFor(ctx, item)
      const slug = await uniqueSlug(ctx, item, undefined)
      if (!opts.dryRun) {
        const doc = (await payload.create({
          collection: 'articles',
          data: { ...fields, slug, category, status: 'published', publishedAt: item.dateGmt } as never,
          overrideAccess: true,
          depth: 0,
          req,
        })) as { id: number }
        articleId = doc.id
        manifest.articles.created.push(doc.id)
        await audit(ctx, doc.id, legacyId, 'created')
      }
      report.articles.created++
    }
  }

  // Comments (also for an article that already existed, so an interrupted run is completed).
  const prepared = prepareComments(item.comments, articleId)
  for (const [reason, n] of Object.entries(prepared.skipped)) bumpTally(report.comments.skipped, reason, n ?? 0)
  report.comments.orphanedParents += prepared.orphanedParents
  report.comments.truncated += prepared.truncated
  if (existing || !opts.dryRun) {
    const written = await writeComments(payload, req, prepared.rows, opts.dryRun)
    report.comments.created += opts.dryRun ? written.wouldCreate : written.created.length
    report.comments.existing += written.existing
    manifest.comments.push(...written.created)
  } else {
    report.comments.created += prepared.rows.length
  }
  if (articleId) seenArticleIds.push(articleId)
}

async function audit(ctx: Ctx, articleId: number, legacyId: number, outcome: 'created' | 'updated'): Promise<void> {
  const row = (await writeAuditLog(ctx.req, {
    action: 'import.article',
    collection: 'articles',
    docId: articleId,
    toStatus: 'published',
    summary: `Imported legacy article ${legacyId} (${outcome})`,
    details: { legacyId, outcome },
  })) as { id: number }
  ctx.manifest.audits.push(row.id)
}
