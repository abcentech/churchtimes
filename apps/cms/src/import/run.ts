import fs from 'node:fs'
import path from 'node:path'

import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { writeAuditLog } from '../lib/audit'
import { articlePath as buildArticlePath, resolveArticlePathTemplate } from '../lib/redirectPaths'
import { avKindFromPath } from '../lib/avMedia'
import { legacyPathFromUrl } from '../lib/legacyMediaPath'
import { cleanText, SLUG_RE, slugify } from '../lib/sanitize'
import { isReservedSlug } from '../lib/reservedSlugs'
import { SEO_DESCRIPTION_MAX, SEO_TITLE_MAX } from '../lib/seoFields'
import { safeErrorSummary } from '../lib/safeLog'
import { classify, compileRules, EraIndex, parseCategoryRules, textForClassification, type Classification, type CompiledRules } from './categoryRules'
import { DEFAULT_CATEGORY_RULES } from './categoryRulesDefault'
import { bylineFor, chooseCategoryChain, chooseSecondaryCategories, cleanLegacyUrl, isCategorySlug, parseCategoryMap, resolveSeoText, validCanonical, type CategoryLookups, type SeoOutcome } from './mapping'
import { cleanDisplayName, prepareComments, writeComments } from './comments'
import { HtmlConversionError, htmlToLexical, type ConversionReport } from './htmlToLexical'
import { LinkContextBuilder, linkClassifyHook } from './linkClassify'
import { createLinkFixer, LinkFixesError, readLinkFixesFile, type LinkFixer } from './linkFixes'
import { resolveSiteHosts } from './linkSiteHosts'
import { openManifest, type ManifestSink } from './manifest'
import { createMediaResolver, isSafeRelativeUploadPath, type MediaResolver } from './media'
import { bumpTally, newReport, statusKey, type ImportReport } from './qa'
import { isInsideRepo } from './safePaths'
import { csvRow } from '../lib/csvSafe'
import { readWxrFile, type WxrAttachment, type WxrItem, type WxrTerm } from './wxr'

/**
 * WordPress archive loader: parse (WXR) -> convert (HTML to Lexical) -> write (Local API). See docs/import.md.
 *
 * - Its OWN context flag, `req.context.import`, not `seed`: the Articles validators (embeds, body images, SEO fields,
 *   slug rules) stay ON; only the editorial workflow is skipped (Articles.enforceWorkflow).
 * - Idempotent: an article is matched by `legacyId` (unique in the database). Default: an existing one is left alone
 *   (comments are still completed). `update` rewrites the converted fields of an existing article, but not one that an
 *   editor changed after its import unless `forceUpdate`.
 * - Each post (article, media, category, comments, audit rows) is written in ONE database transaction: a failure
 *   leaves nothing of that post behind.
 * - Dry run: reads the file and the database, writes NOTHING and reports what would happen.
 * - An `import.article` audit row per article created or updated (actorRole `import`), and a crash-safe append-only
 *   rollback manifest (ids only) outside the repository, mode 0o600 (see manifest.ts).
 * - Only published, not password-protected posts are imported. Everything else is counted in the report.
 */

export class ImportError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'ImportError'
  }
}

/** A post that must be skipped, with a fixed reason code for the report. */
class PostSkip extends Error {
  constructor(public readonly reason: string) {
    super(reason)
    this.name = 'PostSkip'
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
  /** With `update`: also rewrite articles that were edited in the CMS after their import. */
  forceUpdate?: boolean
  /** Extra old-site host names (the hosts in the export's own site header are always used). */
  oldHosts?: readonly string[]
  /** A link-fixes file (CSV or JSON, outside the repository): old path or slug -> new path | remove-link | keep-text, for links that cannot be resolved. */
  linkFixesFile?: string
  /** Stop after this many posts (trial runs). */
  limit?: number
  /** Checked between posts; the CLI sets it from SIGINT and SIGTERM. The run then ends cleanly. */
  signal?: { readonly stopped: boolean }
  /** Abort after this many failed posts in a row (default 50). */
  maxConsecutiveFailures?: number
  /** Called with a short progress line (counts only). */
  progress?: (line: string) => void
  /** Working directory for the repository checks. */
  cwd?: string
  /** JSON file (outside the repository) of allowed tag slug -> category slug. Only existing or exported categories are ever used. */
  categoryMapFile?: string
  /** Category for posts the chain cannot place (default News / news). */
  fallbackCategory?: { slug: string; title: string }
  /**
   * strict (default, the behaviour before rules existed): WordPress category, Yoast primary, tag map, generic, fallback.
   * rules: the rule classifier (categoryRules.ts) also runs for posts the earlier steps could not place; a confident answer
   * is used, anything less goes to the fallback category and into the review file.
   */
  categoryMode?: 'strict' | 'rules'
  /** JSON file (outside the repository) replacing the built-in rules (parseCategoryRules). Rules mode only. */
  categoryRulesFile?: string
  /** CSV (outside the repository, must not exist) of posts left in the fallback with a suggestion: legacy id, category, score, runner-up. */
  categoryReviewFile?: string
}

export const DEFAULT_FALLBACK_CATEGORY = { slug: 'news', title: 'News' }
const GENERIC_CATEGORY = { slug: 'uncategorised', title: 'Uncategorised' }
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 50
/** Past this many posts, more than half failing aborts the run. */
const FAILURE_RATIO_MIN_POSTS = 20

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

/** Importable here: published and not password-protected, with an id. */
const importable = (it: WxrItem): boolean => it.kind === 'post' && it.status === 'publish' && !it.hasPassword && it.wpId !== null

type Ctx = {
  payload: Payload
  req: PayloadRequest
  opts: ImportOptions
  report: ImportReport
  manifest: ManifestSink | undefined
  media: MediaResolver
  categories: Map<string, number>
  /** Dry run only: category slugs already counted as "would create" (nothing is cached in a dry run, and a skipped post must not recount). */
  dryCreated: Set<string>
  lookups: CategoryLookups
  /** Rules mode: the compiled rules, the neighbour evidence, and a cache so a post is classified once. */
  rules: { compiled: CompiledRules; era: EraIndex; cache: Map<number, Classification> } | undefined
  /** Rules mode: posts left in the fallback with a suggestion (for the review file). */
  review: { legacyId: number; cls: Classification }[]
  /** Hosts of the export's own site header (for judging a Yoast canonical address). */
  siteHosts: string[]
  /** Distinct `dc:creator` keys seen, and whether each got a byline (for the report only; never printed). */
  authorKeys: Map<string, boolean>
  /** Media ids created for the post being written (to find their `upload` audit rows). */
  postMedia: number[]
  /** Link resolver (slug, ?p=N, category, old hosts) built from pass 1 with the FINAL slugs. */
  classify: (url: string) => { to: string | null; reason: string; remove?: boolean }
  fixer?: LinkFixer
  articlePath: (slug: string) => string
}

type ExistingArticle = { id: number; slug?: string; updatedAt?: string }

/** The article with this legacy id: none, one, or (a corrupt database) a refusal. Never silently the first of several. */
async function findByLegacyId(payload: Payload, req: PayloadRequest, legacyId: number): Promise<ExistingArticle | undefined> {
  const found = await payload.find({
    collection: 'articles',
    where: { legacyId: { equals: legacyId } },
    limit: 2,
    depth: 0,
    pagination: false,
    overrideAccess: true,
    select: { slug: true, updatedAt: true },
    req,
  })
  if (found.docs.length > 1) throw new PostSkip('duplicate-legacy-id')
  return found.docs[0] as ExistingArticle | undefined
}

async function slugTaken(payload: Payload, req: PayloadRequest, slug: string): Promise<boolean> {
  const hit = await payload.find({
    collection: 'articles',
    where: { slug: { equals: slug } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    select: { slug: true },
    req,
  })
  return hit.docs.length > 0
}

/** The slug the article has (existing) or will get: the WordPress one, else with the post id, else numbered; each candidate is checked. */
async function decideSlug(
  payload: Payload,
  req: PayloadRequest,
  claimed: Set<string>,
  item: WxrItem,
  report: ImportReport,
): Promise<string> {
  const existing = await findByLegacyId(payload, req, item.wpId as number)
  if (existing?.slug) {
    claimed.add(existing.slug)
    return existing.slug
  }
  const base = articleSlug(item)
  const fit = (s: string) => s.slice(0, 160).replace(/-+$/, '')
  // Under /{slug}/ a slug equal to a real route (admin, search, ...) is never used; the post gets the numbered form instead.
  const blockReserved = resolveArticlePathTemplate() === '/{slug}/'
  let reservedHit = false
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? base : fit(`${base.slice(0, 140)}-${item.wpId}${attempt > 1 ? `-${attempt}` : ''}`)
    if (blockReserved && isReservedSlug(candidate)) {
      if (attempt === 0) reservedHit = true
      continue
    }
    if (!claimed.has(candidate) && !(await slugTaken(payload, req, candidate))) {
      if (reservedHit) report.articles.slugRenamedReserved++
      claimed.add(candidate)
      return candidate
    }
  }
  throw new PostSkip('slug-unavailable')
}

type Pass1 = {
  attachments: Map<number, WxrAttachment>
  authors: Map<string, string>
  siteHosts: string[]
  /** Channel categories by term id and by nicename (for the Yoast primary category and tag map). */
  catByTermId: Map<number, WxrTerm>
  catByNicename: Map<string, WxrTerm>
  /** Old slug -> the FINAL slug the article has or will get (after collision handling). */
  slugMap: Record<string, string>
  links: LinkContextBuilder
  /** wp id -> final slug, or the reason the post cannot be given one. */
  slugs: Map<number, string | { skip: string }>
  /** Rules mode: dates and categories of the importable posts, to build the neighbour evidence once the channel categories are known. */
  eraSources: { dateGmt: string | null; categories: WxrTerm[]; primaryCategory: string | null }[]
}

async function pass1(file: string, payload: Payload, req: PayloadRequest, report: ImportReport, collectEra: boolean): Promise<Pass1> {
  const out: Pass1 = { attachments: new Map(), authors: new Map(), siteHosts: [], catByTermId: new Map(), catByNicename: new Map(), slugMap: {}, links: new LinkContextBuilder(), slugs: new Map(), eraSources: [] }
  const claimed = new Set<string>()
  for await (const rec of readWxrFile(file)) {
    out.links.add(rec)
    if (rec.record === 'site') out.siteHosts = hostsOf(rec.site.baseSiteUrl, rec.site.baseBlogUrl)
    else if (rec.record === 'category') {
      const c = rec.category
      if (c.nicename) {
        const term: WxrTerm = { name: c.name, nicename: c.nicename }
        out.catByNicename.set(c.nicename, term)
        if (c.termId !== null) out.catByTermId.set(c.termId, term)
      }
    } else if (rec.record === 'author') {
      if (rec.author.login) out.authors.set(rec.author.login, rec.author.displayName)
    } else if (rec.record === 'item') {
      const it = rec.item
      bumpTally(report.source.items, it.kind)
      if (it.kind === 'attachment') {
        report.source.attachments++
        if (it.wpId !== null && it.attachment) out.attachments.set(it.wpId, it.attachment)
      }
      if (it.kind === 'post') {
        bumpTally(report.source.postsByStatus, statusKey(it.status))
        if (it.status === 'publish') {
          report.source.publishedPosts++
          for (const c of it.comments) {
            if (c.approved === '1' && (c.type === 'comment' || c.type === '')) report.source.approvedCommentsOnPublishedPosts++
          }
        }
        if (importable(it)) {
          if (collectEra) out.eraSources.push({ dateGmt: it.dateGmt, categories: it.categories, primaryCategory: it.seo.yoastPrimaryCategory })
          try {
            const slug = await decideSlug(payload, req, claimed, it, report)
            out.slugs.set(it.wpId as number, slug)
            if (it.slug) out.slugMap[it.slug] = slug
          } catch (err) {
            if (!(err instanceof PostSkip)) throw err
            out.slugs.set(it.wpId as number, { skip: err.reason })
          }
        }
      }
    }
  }
  return out
}

/** Byline text for the post (never an account) and the distinct-author counts. Called once per written article. */
function noteAuthor(ctx: Ctx, item: WxrItem, authors: Map<string, string>): string {
  const display = authors.get(item.author)
  const a = bylineFor(item.author, display ? plain(display, 120) : undefined, (s) => cleanDisplayName(plain(s, 120)))
  const rep = ctx.report.authors
  if (!a) {
    rep.postsWithoutByline++
    return ''
  }
  const has = a.byline !== ''
  if (!ctx.authorKeys.has(a.key)) {
    ctx.authorKeys.set(a.key, has)
    rep.distinct++
    if (has) rep.withByline++
    else rep.unmapped++
  }
  if (!has) rep.postsWithoutByline++
  return a.byline
}

function loadCategoryMap(cwd: string, file: string | undefined): Record<string, string> {
  if (!file) return {}
  const abs = path.resolve(cwd, file)
  if (isInsideRepo(abs, cwd)) throw new ImportError('IMPORT_CATEGORY_MAP_INSIDE_REPO')
  let text: string
  try {
    if (fs.statSync(abs).size > 1_000_000) throw new Error('too big')
    text = fs.readFileSync(abs, 'utf8')
  } catch {
    throw new ImportError('IMPORT_CATEGORY_MAP_UNREADABLE')
  }
  const map = parseCategoryMap(text.replace(/^\uFEFF/, ''))
  if (!map) throw new ImportError('IMPORT_CATEGORY_MAP_INVALID')
  return map
}

function loadCategoryRules(cwd: string, file: string | undefined): CompiledRules {
  if (!file) return compileRules(DEFAULT_CATEGORY_RULES)
  const abs = path.resolve(cwd, file)
  if (isInsideRepo(abs, cwd)) throw new ImportError('IMPORT_CATEGORY_RULES_INSIDE_REPO')
  let text: string
  try {
    text = fs.readFileSync(abs, 'utf8')
  } catch {
    throw new ImportError('IMPORT_CATEGORY_RULES_UNREADABLE')
  }
  const set = parseCategoryRules(text.replace(/^\uFEFF/, ''))
  if (!set) throw new ImportError('IMPORT_CATEGORY_RULES_INVALID')
  return compileRules(set)
}

/** The neighbour evidence: categories of the posts that the WordPress or Yoast steps place (these are the "already categorised" ones). */
function buildEra(first: Pass1, lookups: CategoryLookups): EraIndex {
  const era = new EraIndex()
  for (const s of first.eraSources) {
    const c = chooseCategoryChain({ categories: s.categories, tags: [], primaryCategory: s.primaryCategory }, lookups)
    if ((c.step === 'wordpress' || c.step === 'yoast-primary') && c.term) era.add(s.dateGmt, c.term.nicename)
  }
  return era
}

function classifyItem(ctx: Ctx, item: WxrItem): Classification {
  const r = ctx.rules as NonNullable<Ctx['rules']>
  const key = item.wpId as number
  const hit = r.cache.get(key)
  if (hit) return hit
  const cls = classify(
    { title: plain(item.title, 240), excerpt: textForClassification(item.excerptHtml), body: textForClassification(item.contentHtml), dateGmt: item.dateGmt },
    r.compiled,
    r.era,
  )
  r.cache.set(key, cls)
  return cls
}

function pass1Lookups(first: Pass1, tagMap: Record<string, string>): CategoryLookups {
  return { byTermId: first.catByTermId, byNicename: first.catByNicename, tagMap }
}

/** Dry run: a category counted as "would create" earlier in this run exists for the rest of it (id 0, nothing is written). */
async function findCategory(ctx: Ctx, slug: string): Promise<number | undefined> {
  if (ctx.opts.dryRun && ctx.dryCreated.has(slug)) return 0
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
  const id = (found.docs[0] as { id?: number } | undefined)?.id
  if (id !== undefined) ctx.categories.set(slug, id)
  return id
}

/**
 * The category for a NEW article, by the chain in mapping.ts (WordPress, Yoast primary, tag map, generic, fallback). A category
 * is created only from an exported WordPress category or the configured fallback, never from a tag's free text.
 */
async function categoryFor(ctx: Ctx, item: WxrItem): Promise<{ primary: number; secondary: number[] }> {
  const rep = ctx.report.categories
  const fallback = ctx.opts.fallbackCategory ?? DEFAULT_FALLBACK_CATEGORY
  let choice = chooseCategoryChain(
    { categories: item.categories, tags: item.tags, primaryCategory: item.seo.yoastPrimaryCategory, classify: ctx.rules ? () => classifyItem(ctx, item) : undefined },
    ctx.lookups,
  )
  if (choice.dropped > 0) rep.postsWithExtraCategories++
  if (choice.primaryUnresolved) rep.yoastPrimaryUnresolved++
  let term = choice.term
  let slug: string
  if (choice.step === 'fallback') {
    slug = fallback.slug
  } else {
    slug = slugify(term!.nicename, 100, choice.step === 'generic' ? GENERIC_CATEGORY.slug : fallback.slug)
    if (choice.mustExist && (await findCategory(ctx, slug)) === undefined) {
      // A tag-map (or rules) target that is neither exported nor already present: never created from a tag or a rule. The post gets the fallback (or its generic category).
      rep.tagMapTargetMissing++
      const generic = chooseCategoryChain({ categories: item.categories, tags: [], primaryCategory: null }, ctx.lookups)
      choice = { ...generic, step: generic.step === 'generic' ? 'generic' : 'fallback', ...(choice.rule ? { rule: choice.rule } : {}) }
      term = choice.term
      slug = choice.step === 'generic' ? slugify(term!.nicename, 100, GENERIC_CATEGORY.slug) : fallback.slug
    }
  }
  const title =
    choice.step === 'fallback' ? fallback.title : plain(term!.name || term!.nicename, 120) || slug
  if (choice.step === 'wordpress') rep.bySource.wordpress++
  else if (choice.step === 'yoast-primary') rep.bySource.yoastPrimary++
  else if (choice.step === 'tag-map') rep.bySource.tagMap++
  else if (choice.step === 'rules') rep.bySource.rules++
  else if (choice.step === 'generic') rep.bySource.generic++
  else rep.bySource.fallback++
  if (choice.step === 'generic' || choice.step === 'fallback') rep.fallbackUsed++
  if (ctx.rules && choice.rule && choice.step !== 'rules' && choice.rule.category) {
    rep.rulesLowConfidence++
    ctx.review.push({ legacyId: item.wpId as number, cls: choice.rule })
  }
  ctx.manifest?.append({
    type: 'category',
    legacyId: item.wpId as number,
    step: choice.step,
    category: slug,
    ...(choice.rule?.category
      ? { rule: { id: choice.rule.ruleId ?? '', category: choice.rule.category ?? '', score: choice.rule.score, runnerUp: choice.rule.runnerUp ?? null, runnerUpScore: choice.rule.runnerUpScore, confident: choice.rule.confident } }
      : {}),
  })
  const primary = await ensureCategory(ctx, slug, title)
  // The post's other WordPress categories are kept too, as `categories` (created like the primary, from the export only).
  const extra = chooseSecondaryCategories(item.categories, slug, (t) => slugify(t.nicename, 100, fallback.slug))
  const secondary: number[] = []
  for (const t of extra.terms) {
    const s = slugify(t.nicename, 100, fallback.slug)
    secondary.push(await ensureCategory(ctx, s, plain(t.name || t.nicename, 120) || s))
  }
  if (secondary.length > 0) {
    rep.postsWithSecondaryCategories++
    rep.secondaryCategoriesKept += secondary.length
  }
  if (extra.overCap > 0) {
    rep.postsOverSecondaryCap++
    rep.extraCategoriesDropped += extra.overCap
  }
  return { primary, secondary }
}

/** The id of the category with this slug, created (and recorded in the manifest) when it does not exist. Dry run: counted only (id 0). */
async function ensureCategory(ctx: Ctx, slug: string, title: string): Promise<number> {
  let id = await findCategory(ctx, slug)
  if (id === undefined) {
    ctx.report.categories.created++
    if (ctx.opts.dryRun) {
      ctx.dryCreated.add(slug)
      id = 0
    } else {
      const doc = (await ctx.payload.create({
        collection: 'categories',
        data: { title, slug } as never,
        overrideAccess: true,
        req: ctx.req,
      })) as { id: number }
      id = doc.id
      ctx.manifest?.id('categories', 'created', id)
    }
  }
  ctx.categories.set(slug, id)
  return id
}

/**
 * Identifier-only detail of a failed write, for the progress line: the invalid field paths of a Payload validation
 * error and the constraint / column / table names of a PostgreSQL error. Never a message, value or query.
 */
function failureFields(err: unknown): string {
  const ident = /^[-A-Za-z0-9_.]{1,80}$/
  const names: string[] = []
  const data = (err as { data?: { errors?: unknown } } | null)?.data
  if (Array.isArray(data?.errors)) {
    for (const e of data.errors as { path?: unknown }[]) if (typeof e?.path === 'string' && ident.test(e.path)) names.push(e.path)
  }
  for (const holder of [err, (err as { cause?: unknown } | null)?.cause]) {
    for (const key of ['constraint', 'column', 'table'] as const) {
      const v = (holder as Record<string, unknown> | null)?.[key]
      if (typeof v === 'string' && ident.test(v)) names.push(`${key}=${v}`)
    }
  }
  return names.length > 0 ? ` fields=${[...new Set(names)].slice(0, 6).join(',')}` : ''
}

/** True for a body with no children, or only paragraphs without text (what the editor treats as empty). */
export function isEmptyBody(root: unknown): boolean {
  const kids = (root as { children?: unknown[] } | null)?.children
  if (!Array.isArray(kids) || kids.length === 0) return true
  return kids.every((k) => {
    const n = k as { type?: string; children?: { type?: string; text?: string }[] }
    return n.type === 'paragraph' && (n.children ?? []).every((c) => c.type === 'text' && !c.text)
  })
}

/** The primary host and the old host names (`LEGACY_SITE_HOSTS`): every one of them is this site. */
const knownSiteHosts = (): string[] => {
  const h = resolveSiteHosts(process.env)
  return [h.primary, ...h.legacy]
}

type Converted = { content: { root: unknown }; report: ConversionReport }

/** Two passes: the first collects image addresses, they are resolved (async), the second builds the body. */
async function convert(ctx: Ctx, item: WxrItem, oldHosts: readonly string[], slugMap: Record<string, string>): Promise<Converted> {
  const wanted = new Map<string, { alt: string; caption: string }>()
  const wantedMedia = new Map<string, { title: string; caption: string }>()
  const options = {
    oldHosts: [...new Set([...oldHosts, ...knownSiteHosts()])],
    slugMap,
    articleTitle: plain(item.title, 240),
    articlePath: ctx.articlePath,
    classify: ctx.classify,
  }
  ctx.fixer?.counting(false)
  htmlToLexical(item.contentHtml, {
    ...options,
    resolveImage: (src, c) => {
      if (!wanted.has(src)) wanted.set(src, { alt: c.alt, caption: c.caption })
      return { mediaId: 1 }
    },
    resolveMedia: (src, c) => {
      if (!wantedMedia.has(src)) wantedMedia.set(src, { title: c.title, caption: c.caption })
      return { mediaId: 1 }
    },
  })
  ctx.fixer?.counting(true)
  const resolved = new Map<string, number>()
  const resolvedMedia = new Map<string, number>()
  for (const [src, meta] of wanted) {
    const r = await ctx.media.resolveUrl(src, { ...meta, articleTitle: options.articleTitle })
    if (r.ok) resolved.set(src, r.mediaId)
  }
  for (const [src, meta] of wantedMedia) {
    const r = await ctx.media.resolveUrl(src, { alt: meta.title, caption: meta.caption, articleTitle: options.articleTitle })
    if (r.ok) resolvedMedia.set(src, r.mediaId)
  }
  const result = htmlToLexical(item.contentHtml, {
    ...options,
    resolveImage: (src) => {
      const id = resolved.get(src)
      return id === undefined ? null : { mediaId: id }
    },
    resolveMedia: (src) => {
      const id = resolvedMedia.get(src)
      return id === undefined ? null : { mediaId: id }
    },
  })
  return { content: result.content, report: result.report }
}

async function featuredImageFor(ctx: Ctx, item: WxrItem, attachments: Map<number, WxrAttachment>): Promise<number | undefined> {
  if (item.thumbnailId === null) return undefined
  const att = attachments.get(item.thumbnailId)
  // `_wp_attached_file` is normally relative to the uploads folder, but can be an absolute server path: then the address is used.
  const rel = att
    ? att.attachedFile && isSafeRelativeUploadPath(att.attachedFile)
      ? att.attachedFile
      : (legacyPathFromUrl(att.url) ?? legacyPathFromUrl(att.attachedFile))
    : null
  // Audio/video is never a featured image (the Articles rule would refuse it): count it as missing, like any unusable attachment.
  const r = rel && avKindFromPath(rel) === null
    ? await ctx.media.resolvePath(rel, { alt: att?.altText ?? '', articleTitle: plain(item.title, 240) })
    : { ok: false as const, reason: 'no-attachment' }
  if (!r.ok) {
    ctx.report.content.featuredImageMissing++
    if (r.reason === 'rejected-unsafe' || r.reason === 'rejected-by-media-rules') ctx.report.content.featuredImageRejected++
    return undefined
  }
  ctx.report.content.featuredImageResolved++
  return r.mediaId
}

/**
 * Articles.seoTitle / seoDescription for one post. An explicit Rank Math value wins, else Yoast, else empty. Variables are
 * resolved (see resolveSeoText); a value that cannot be resolved is dropped and the next source is tried. Yoast canonical,
 * noindex and social text have no field in the schema, so they are only counted.
 */
function seoFor(ctx: Ctx, item: WxrItem, title: string): { seoTitle: string | undefined; seoDescription: string | undefined } {
  const rep = ctx.report.seo
  const chain = chooseCategoryChain({ categories: item.categories, tags: [], primaryCategory: item.seo.yoastPrimaryCategory }, ctx.lookups)
  const seoCtx = {
    title,
    categoryName: chain.term ? plain(chain.term.name || chain.term.nicename, 120) : undefined,
    dateGmt: item.dateGmt,
    excerpt: plain(item.excerptHtml, 300),
  }
  const pick = (
    rankMath: string | null,
    yoast: string | null,
    max: number,
    from: { rankMath: number; yoast: number; none: number },
  ): string | undefined => {
    const note = (o: SeoOutcome) => {
      if (o.hadVariables && o.status === 'ok') rep.variablesResolved++
      if (o.status === 'dropped') rep.droppedUnresolved++
      if (o.truncated) rep.truncated++
    }
    const rm = resolveSeoText(rankMath, 'rankmath', seoCtx, max)
    note(rm)
    if (rm.value !== undefined) {
      from.rankMath++
      return rm.value
    }
    const y = resolveSeoText(yoast, 'yoast', seoCtx, max)
    note(y)
    if (y.value !== undefined) {
      from.yoast++
      return y.value
    }
    from.none++
    return undefined
  }
  const seoTitle = pick(item.seo.rankMathTitle, item.seo.yoastTitle, SEO_TITLE_MAX, rep.titleFrom)
  const seoDescription = pick(item.seo.rankMathDescription, item.seo.yoastDescription, SEO_DESCRIPTION_MAX, rep.descriptionFrom)
  if (item.seo.yoastCanonical) {
    if (validCanonical(item.seo.yoastCanonical, ctx.siteHosts)) rep.yoastCanonicalValid++
    else rep.yoastCanonicalInvalid++
  }
  if (item.seo.yoastNoindex === '1') rep.yoastNoindex++
  if (item.seo.yoastSocialTitle || item.seo.yoastSocialDescription) rep.yoastSocial++
  return { seoTitle, seoDescription }
}

function addConversionStats(rep: ImportReport, c: ConversionReport): void {
  rep.content.imagesResolved += c.images.resolved
  rep.content.imagesUnresolved += c.images.unresolved.length
  rep.content.linksUnmapped += c.links.unmapped.length
  rep.content.youtube += c.youtube
  rep.content.avResolved += c.audioVideo.resolved
  rep.content.avUnresolvedMedia += c.audioVideo.unresolvedMedia
  rep.content.avUnsupported += c.audioVideo.unsupported
  rep.content.tablesFlattened += c.tables.flattened.length
  rep.content.embedsDropped += c.embeds.dropped.length
}

function assertReadable(file: string): void {
  try {
    fs.accessSync(file, fs.constants.R_OK)
    if (!fs.statSync(file).isFile()) throw new Error('not a file')
  } catch {
    throw new ImportError('IMPORT_FILE_UNREADABLE')
  }
}

export async function runImport(payload: Payload, opts: ImportOptions): Promise<ImportReport> {
  const cwd = opts.cwd ?? process.cwd()
  const file = path.resolve(cwd, opts.file)
  if (isInsideRepo(file, cwd)) throw new ImportError('IMPORT_FILE_INSIDE_REPO')
  const uploadsRoot = opts.uploadsRoot ? path.resolve(cwd, opts.uploadsRoot) : undefined
  if (uploadsRoot && isInsideRepo(uploadsRoot, cwd)) throw new ImportError('IMPORT_UPLOADS_INSIDE_REPO')
  let manifestPath: string | undefined
  if (!opts.dryRun) {
    if (!opts.manifestPath) throw new ImportError('IMPORT_MANIFEST_REQUIRED')
    manifestPath = path.resolve(cwd, opts.manifestPath)
    if (isInsideRepo(manifestPath, cwd)) throw new ImportError('IMPORT_MANIFEST_INSIDE_REPO')
  }
  const tagMap = loadCategoryMap(cwd, opts.categoryMapFile)
  const rulesMode = opts.categoryMode === 'rules'
  if (opts.categoryMode !== undefined && opts.categoryMode !== 'strict' && !rulesMode) throw new ImportError('IMPORT_CATEGORY_MODE_INVALID')
  if (opts.categoryRulesFile && !rulesMode) throw new ImportError('IMPORT_CATEGORY_RULES_NEED_RULES_MODE')
  const compiledRules = rulesMode ? loadCategoryRules(cwd, opts.categoryRulesFile) : undefined
  let reviewPath: string | undefined
  if (opts.categoryReviewFile) {
    if (!rulesMode) throw new ImportError('IMPORT_CATEGORY_REVIEW_NEEDS_RULES_MODE')
    reviewPath = path.resolve(cwd, opts.categoryReviewFile)
    if (isInsideRepo(reviewPath, cwd)) throw new ImportError('IMPORT_CATEGORY_REVIEW_INSIDE_REPO')
    if (fs.existsSync(reviewPath)) throw new ImportError('IMPORT_CATEGORY_REVIEW_EXISTS')
  }
  if (opts.fallbackCategory && !isCategorySlug(opts.fallbackCategory.slug)) throw new ImportError('IMPORT_FALLBACK_CATEGORY_INVALID')
  // The export must open before a manifest file is created, so a bad path does not leave an empty manifest behind.
  assertReadable(file)
  let manifest: ManifestSink | undefined
  if (manifestPath) {
    try {
      manifest = openManifest(manifestPath)
    } catch {
      throw new ImportError('IMPORT_MANIFEST_UNWRITABLE')
    }
  }

  const report = newReport(opts.dryRun ? 'dry-run' : 'apply', opts.update === true)
  report.categories.mode = rulesMode ? 'rules' : 'strict'
  let endStatus: 'complete' | 'failed' | 'stopped' = 'failed'
  try {
    const req = await createLocalReq({ context: { import: true } }, payload)
    const first = await pass1(file, payload, req, report, rulesMode)
    const oldHosts = [...new Set([...(opts.oldHosts ?? []).map((h) => h.toLowerCase()), ...first.siteHosts])]
    const postMedia: number[] = []
    const media = createMediaResolver({
      payload,
      req,
      uploadsRoot,
      oldHosts,
      dryRun: opts.dryRun,
      onCreated: (id) => {
        manifest?.id('media', 'created', id)
        postMedia.push(id)
      },
    })
    const template = resolveArticlePathTemplate(process.env)
    const articlePath = (slug: string) => buildArticlePath(template, slug)
    const hostCfg = resolveSiteHosts(process.env)
    const linkCtx = first.links.build({ articlePath, slugMap: first.slugMap, extraHosts: oldHosts, primaryHost: hostCfg.primary, legacyHosts: hostCfg.legacy })
    let fixer: LinkFixer | undefined
    if (opts.linkFixesFile) {
      try {
        fixer = createLinkFixer(readLinkFixesFile(opts.linkFixesFile, { articleTemplate: template, siteHosts: linkCtx.hosts }), linkCtx)
      } catch (e) {
        if (e instanceof LinkFixesError) throw new ImportError(e.code)
        throw e
      }
    }
    const classify = linkClassifyHook(linkCtx, fixer)
    const lookups = pass1Lookups(first, tagMap)
    const ctx: Ctx = {
      payload,
      req,
      opts,
      report,
      manifest,
      media,
      categories: new Map(),
      dryCreated: new Set(),
      lookups,
      rules: compiledRules ? { compiled: compiledRules, era: buildEra(first, lookups), cache: new Map() } : undefined,
      review: [],
      siteHosts: first.siteHosts,
      authorKeys: new Map(),
      postMedia,
      classify,
      fixer,
      articlePath,
    }

    const seenLegacyIds: number[] = []
    const seenArticleIds: number[] = []
    const maxConsecutive = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES
    let processed = 0
    let failures = 0
    let consecutiveFailures = 0
    let stopped = false
    for await (const rec of readWxrFile(file)) {
      if (rec.record !== 'item' || rec.item.kind !== 'post') continue
      const item = rec.item
      const skip = (reason: string) => bumpTally(report.articles.skipped, reason)
      if (item.status !== 'publish') {
        skip(`status-${statusKey(item.status)}`)
        if (item.wpId !== null && (await payload.count({ collection: 'articles', where: { legacyId: { equals: item.wpId } }, overrideAccess: true, req })).totalDocs > 0) {
          report.articles.previouslyImportedNowNotPublished++
        }
        continue
      }
      if (item.hasPassword) {
        report.articles.passwordProtected++
        continue
      }
      if (opts.signal?.stopped) {
        stopped = true
        break
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
        if (err instanceof PostSkip) skip(err.reason)
        else if (err instanceof HtmlConversionError) skip(`conversion-${err.code}`)
        else {
          // Only a failed write counts towards the abort limits (a database or disk problem is systemic).
          skip('write-failed')
          opts.progress?.(`article failed: ${safeErrorSummary(err)}${failureFields(err)} id=${item.wpId}`)
          failures++
          consecutiveFailures++
          if (consecutiveFailures >= maxConsecutive || (processed >= FAILURE_RATIO_MIN_POSTS && failures * 2 > processed)) {
            throw new ImportError('IMPORT_TOO_MANY_FAILURES')
          }
        }
      }
      if (processed % 100 === 0) opts.progress?.(`${processed} posts processed`)
    }

    if (reviewPath) writeCategoryReview(reviewPath, ctx.review)
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
    if (fixer) report.linkFixes = fixer.summary()
    if (stopped) report.notes.push('stopped-early-by-signal')
    endStatus = stopped ? 'stopped' : 'complete'
    return report
  } finally {
    if (manifest) {
      try {
        manifest.append({ type: 'end', at: new Date().toISOString(), status: endStatus })
      } finally {
        manifest.close()
      }
    }
  }
}

/** A category slug for the review file: only a well-formed slug is written, anything else is marked, never passed on as text. */
const reviewSlug = (v: string | null | undefined): string => (v ? (SLUG_RE.test(v) && v.length <= 100 ? v : 'invalid-slug') : '')

/** The review file: legacy id, suggested category, score, runner-up. Owner-only, outside the repository, created exclusively. */
function writeCategoryReview(file: string, rows: { legacyId: number; cls: Classification }[]): void {
  const lines = ['legacy_id,suggested_category,score,runner_up,runner_up_score']
  for (const r of [...rows].sort((a, b) => a.legacyId - b.legacyId)) lines.push(csvRow([r.legacyId, reviewSlug(r.cls.category), r.cls.score, reviewSlug(r.cls.runnerUp), r.cls.runnerUpScore]))
  try {
    fs.writeFileSync(file, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  } catch {
    throw new ImportError('IMPORT_CATEGORY_REVIEW_UNWRITABLE')
  }
}

/** Did an editor change the article after the loader last wrote it? (No import audit row counts as edited.) */
async function editedSinceImport(ctx: Ctx, article: ExistingArticle): Promise<boolean> {
  const last = await ctx.payload.find({
    collection: 'audit-logs',
    where: { and: [{ collection: { equals: 'articles' } }, { docId: { equals: String(article.id) } }, { action: { equals: 'import.article' } }] },
    sort: '-createdAt',
    limit: 1,
    depth: 0,
    overrideAccess: true,
    req: ctx.req,
  })
  const at = (last.docs[0] as { createdAt?: string } | undefined)?.createdAt
  if (!at || !article.updatedAt) return true
  return new Date(article.updatedAt).getTime() > new Date(at).getTime()
}

async function importOne(
  ctx: Ctx,
  item: WxrItem,
  title: string,
  first: Pass1,
  oldHosts: readonly string[],
  seenArticleIds: number[],
): Promise<void> {
  const { payload, opts, report, manifest } = ctx
  const legacyId = item.wpId as number
  const snapshot = structuredClone(report)
  const authorKeysSnapshot = new Map(ctx.authorKeys)
  const dryCreatedSnapshot = new Set(ctx.dryCreated)
  const reviewLength = ctx.review.length
  const baseReq = ctx.req

  // One transaction per post (not in a dry run, which writes nothing).
  const req = await createLocalReq({ context: { import: true } }, payload)
  let txId: number | string | null = null
  if (!opts.dryRun) {
    txId = (await payload.db.beginTransaction()) as number | string | null
    if (txId) req.transactionID = txId
  }
  ctx.req = req
  ctx.media.setReq(req)
  manifest?.append({ type: 'intent', legacyId })
  ctx.postMedia.length = 0
  let createdArticle: number | undefined
  try {
    await importPost(ctx, item, title, first, oldHosts, seenArticleIds, (id) => {
      createdArticle = id
    })
    if (txId) await payload.db.commitTransaction(txId)
    manifest?.append({ type: 'commit', legacyId })
  } catch (err) {
    if (txId) {
      try {
        await payload.db.rollbackTransaction(txId)
      } catch {
        // already ended
      }
    }
    manifest?.append({ type: 'abort', legacyId })
    // The rolled-back rows no longer exist: forget what was cached about them.
    Object.assign(report, snapshot)
    // Apply: the rolled-back category rows no longer exist, forget them. Dry run: nothing was written, so only the counted names are restored.
    ctx.categories.clear()
    ctx.dryCreated = dryCreatedSnapshot
    ctx.review.length = reviewLength
    ctx.authorKeys = authorKeysSnapshot
    ctx.media.reset()
    throw err
  } finally {
    ctx.req = baseReq
    ctx.media.setReq(baseReq)
  }

  // Audit rows written by the collections' own hooks (Articles `create`, Media `upload`): add their ids to the manifest.
  if (manifest && createdArticle !== undefined) {
    const audits = await payload.find({
      collection: 'audit-logs',
      where: { and: [{ collection: { equals: 'articles' } }, { docId: { equals: String(createdArticle) } }, { action: { equals: 'create' } }] },
      limit: 5,
      depth: 0,
      pagination: false,
      overrideAccess: true,
      req: baseReq,
    })
    for (const a of audits.docs as { id: number }[]) manifest.id('audit-logs', 'created', a.id)
  }
  if (manifest && ctx.postMedia.length > 0) {
    const uploads = await payload.find({
      collection: 'audit-logs',
      where: { and: [{ collection: { equals: 'media' } }, { docId: { in: ctx.postMedia.map(String) } }, { action: { equals: 'upload' } }] },
      limit: 200,
      depth: 0,
      pagination: false,
      overrideAccess: true,
      req: baseReq,
    })
    for (const a of uploads.docs as { id: number }[]) manifest.id('audit-logs', 'created', a.id)
  }
}

async function importPost(
  ctx: Ctx,
  item: WxrItem,
  title: string,
  first: Pass1,
  oldHosts: readonly string[],
  seenArticleIds: number[],
  onCreatedArticle: (id: number) => void,
): Promise<void> {
  const { payload, req, opts, report, manifest } = ctx
  const legacyId = item.wpId as number
  const planned = first.slugs.get(legacyId)
  if (planned !== undefined && typeof planned !== 'string') throw new PostSkip(planned.skip)
  const existing = await findByLegacyId(payload, req, legacyId)

  let articleId = existing?.id ?? 0
  let skipArticleWrite = false
  if (existing && !opts.update) {
    report.articles.unchanged++
    skipArticleWrite = true
  } else if (existing && !opts.forceUpdate && (await editedSinceImport(ctx, existing))) {
    bumpTally(report.articles.skipped, 'edited-since-import')
    skipArticleWrite = true
  }
  if (!skipArticleWrite) {
    const converted = await convert(ctx, item, oldHosts, first.slugMap)
    // The editor refuses a body with no text, image or block (`required`); a post like that is reported, not written.
    if (isEmptyBody(converted.content.root)) throw new PostSkip('empty-body')
    addConversionStats(report, converted.report)
    const featuredImage = await featuredImageFor(ctx, item, first.attachments)
    const excerpt = plain(item.excerptHtml, 600, true)
    const byline = noteAuthor(ctx, item, first.authors)
    const fields = {
      title,
      excerpt: excerpt || undefined,
      content: converted.content,
      featuredImage,
      bylineName: byline || undefined,
      ...seoFor(ctx, item, title),
      legacyUrl: cleanLegacyUrl(item.link),
      legacyId,
    }
    if (existing) {
      if (!opts.dryRun) {
        const doc = (await payload.update({ collection: 'articles', id: existing.id, data: fields as never, overrideAccess: true, depth: 0, req })) as { id: number; status?: string }
        manifest?.id('articles', 'updated', existing.id)
        await audit(ctx, existing.id, legacyId, 'updated', doc.status)
      }
      report.articles.updated++
    } else {
      const { primary: category, secondary: categories } = await categoryFor(ctx, item)
      const slug = planned as string
      if (!opts.dryRun) {
        const doc = (await payload.create({
          collection: 'articles',
          data: { ...fields, slug, category, ...(categories.length > 0 ? { categories } : {}), status: 'published', publishedAt: item.dateGmt } as never,
          overrideAccess: true,
          depth: 0,
          req,
        })) as { id: number; status?: string }
        articleId = doc.id
        onCreatedArticle(doc.id)
        manifest?.id('articles', 'created', doc.id)
        await audit(ctx, doc.id, legacyId, 'created', doc.status)
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
    const written = await writeComments(payload, req, prepared.rows, opts.dryRun, (id) => manifest?.id('legacy-comments', 'created', id))
    report.comments.created += opts.dryRun ? written.wouldCreate : written.created.length
    report.comments.existing += written.existing
  } else {
    report.comments.created += prepared.rows.length
  }
  if (articleId) seenArticleIds.push(articleId)
}

async function audit(ctx: Ctx, articleId: number, legacyId: number, outcome: 'created' | 'updated', status: string | undefined): Promise<void> {
  const row = (await writeAuditLog(ctx.req, {
    action: 'import.article',
    collection: 'articles',
    docId: articleId,
    toStatus: status ?? 'published',
    actorRole: 'import',
    summary: `Imported legacy article ${legacyId} (${outcome})`,
    details: { legacyId, outcome },
  })) as { id: number }
  ctx.manifest?.id('audit-logs', 'created', row.id)
}
