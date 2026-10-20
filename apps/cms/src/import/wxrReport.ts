import fs from 'node:fs'
import path from 'node:path'

import { stripShortcodes } from '../lib/legacyContent'
import { hasTemplateVariable } from '../lib/seoFields'
import { isInsideRepo } from './safePaths'
import { readWxrFile, WxrError, type WxrItem, type WxrRecord } from './wxr'

/**
 * Parse-only report for a WXR export: `npm run import:wxr-report -- --file <path> [--detail-file <path>]`.
 * No database, no network. The default output is COUNTS ONLY: no title, slug, URL, name or content is printed.
 * Per-item rows go to `--detail-file` only, and only to a path outside the repository.
 */

const EXPECTED_PUBLISHED = 4346
const STATUSES = ['publish', 'draft', 'private', 'pending', 'future', 'trash', 'auto-draft', 'inherit'] as const

type Tally = Map<string, number>
const bump = (m: Tally, key: string, n = 1) => m.set(key, (m.get(key) ?? 0) + n)
const top = (m: Tally, n: number) =>
  [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n)

// (shortcodes are found with stripShortcodes from lib/legacyContent: conservative rules, so [John Smith] is not one)
// Bounded so that hostile input (for example 640 KB of "<iframe ") cannot make it quadratic.
const IFRAME_SRC_RE = /<iframe\b[^<>]{0,4096}?\ssrc\s*=\s*["']?([^"'\s>]{1,2048})/gi
/** Tally keys that come from the file are capped so a hostile export cannot flood the output. */
const key20 = (s: string) => s.slice(0, 20)
const YOUTUBE_RE = /youtube\.com|youtu\.be|youtube-nocookie\.com/i

function hostOf(src: string): string {
  try {
    const url = new URL(src.startsWith('//') ? `https:${src}` : src)
    return url.hostname.toLowerCase().slice(0, 100) || '(none)'
  } catch {
    return '(unparseable)'
  }
}

export type WxrReport = {
  items: number
  channelCategories: number
  channelAuthors: number
  byKind: Record<string, number>
  postsByStatus: Record<string, number>
  publishedPosts: number
  expectedPublished: number
  publishedWithoutSlug: number
  publishedDuplicateSlugGroups: number
  publishedPasswordProtected: number
  publishedWithoutGmtDate: number
  publishedWithLocalTimeFallback: number
  itemsWithoutDateAtAll: number
  categoriesPerPublishedPost: Record<string, number>
  shortcodes: { postsWith: number; tags: [string, number][] }
  iframes: { postsWith: number; hosts: [string, number][] }
  tables: { postsWith: number; total: number }
  images: { postsWith: number; total: number }
  gutenberg: { blockPosts: number; classicPosts: number }
  youtube: { postsWith: number }
  comments: { total: number; byApprovedAndType: [string, number][]; approvedOnPublishedPosts: number }
  attachments: { total: number; withUrl: number; withAltText: number; withAttachedFile: number }
  seo: {
    rankMathTitle: number
    rankMathTitleWithVariables: number
    rankMathDescription: number
    rankMathDescriptionWithVariables: number
    yoastTitle: number
    yoastDescription: number
  }
}

/** Build the counts. Consumes the record stream once; keeps only counters and a slug tally. */
export async function buildWxrReport(
  records: AsyncIterable<WxrRecord>,
  onItem?: (item: WxrItem, flags: { shortcodes: number; iframes: number; tables: number; images: number; gutenberg: boolean }) => void,
): Promise<WxrReport> {
  const r = {
    items: 0, cats: 0, authors: 0,
    kind: new Map<string, number>(), status: new Map<string, number>(),
    published: 0, noSlug: 0, noGmt: 0, localFallback: 0, noDate: 0, password: 0,
    catDist: new Map<string, number>(),
    slugs: new Map<string, number>(),
    shortcodePosts: 0, shortcodeTags: new Map<string, number>(),
    iframePosts: 0, iframeHosts: new Map<string, number>(),
    tablePosts: 0, tableTotal: 0, imgPosts: 0, imgTotal: 0,
    blockPosts: 0, classicPosts: 0, youtubePosts: 0,
    comments: 0, commentKinds: new Map<string, number>(), approvedOnPublished: 0,
    att: 0, attUrl: 0, attAlt: 0, attFile: 0,
    rmT: 0, rmTv: 0, rmD: 0, rmDv: 0, yT: 0, yD: 0,
  }

  for await (const rec of records) {
    if (rec.record === 'category') r.cats += 1
    else if (rec.record === 'author') r.authors += 1
    if (rec.record !== 'item') continue
    const it = rec.item
    r.items += 1
    bump(r.kind, it.kind)
    if (it.kind === 'post') bump(r.status, it.status || '(none)')
    if (it.dateIssue === 'missing') r.noDate += 1
    for (const c of it.comments) {
      bump(r.commentKinds, `approved=${key20(c.approved) || '(none)'} type=${key20(c.type)}`)
      r.comments += 1
      if (it.kind === 'post' && it.status === 'publish' && c.approved === '1' && c.type === 'comment') r.approvedOnPublished += 1
    }
    if (it.kind === 'attachment') {
      r.att += 1
      if (it.attachment?.url) r.attUrl += 1
      if (it.attachment?.altText) r.attAlt += 1
      if (it.attachment?.attachedFile) r.attFile += 1
    }
    const isPublished = it.kind === 'post' && it.status === 'publish'
    let flags = { shortcodes: 0, iframes: 0, tables: 0, images: 0, gutenberg: false }
    if (isPublished) {
      r.published += 1
      if (it.slug === '') r.noSlug += 1
      else bump(r.slugs, it.slug)
      if (it.hasPassword) r.password += 1
      if (it.dateIssue !== null) r.noGmt += 1
      if (it.dateIssue === 'localTime') r.localFallback += 1
      bump(r.catDist, it.categories.length >= 5 ? '5+' : String(it.categories.length))

      const html = it.contentHtml
      let sc = 0
      for (const rem of stripShortcodes(html).removals) {
        sc += 1
        // Real shortcode names are lowercase identifiers; anything else is bucketed so names cannot leak.
        bump(r.shortcodeTags, /^[a-z][a-z0-9_-]{0,31}$/.test(rem.tag) ? rem.tag : '(other)')
      }
      if (sc) r.shortcodePosts += 1
      let ifr = 0
      for (const m of html.matchAll(IFRAME_SRC_RE)) {
        ifr += 1
        bump(r.iframeHosts, hostOf(m[1]))
      }
      if (ifr) r.iframePosts += 1
      const tables = (html.match(/<table\b/gi) ?? []).length
      const images = (html.match(/<img\b/gi) ?? []).length
      if (tables) r.tablePosts += 1
      if (images) r.imgPosts += 1
      r.tableTotal += tables
      r.imgTotal += images
      const gutenberg = html.includes('<!-- wp:')
      if (gutenberg) r.blockPosts += 1
      else r.classicPosts += 1
      if (YOUTUBE_RE.test(html)) r.youtubePosts += 1
      flags = { shortcodes: sc, iframes: ifr, tables, images, gutenberg }

      const { rankMathTitle: rt, rankMathDescription: rd, yoastTitle: yt, yoastDescription: yd } = it.seo
      if (rt) { r.rmT += 1; if (hasTemplateVariable(rt)) r.rmTv += 1 }
      if (rd) { r.rmD += 1; if (hasTemplateVariable(rd)) r.rmDv += 1 }
      if (yt) r.yT += 1
      if (yd) r.yD += 1
    }
    onItem?.(it, flags)
  }

  const obj = (m: Tally) => Object.fromEntries([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
  const statusObj: Record<string, number> = {}
  for (const s of STATUSES) statusObj[s] = r.status.get(s) ?? 0
  for (const [k, v] of r.status) if (!(k in statusObj)) statusObj[`other:${k.slice(0, 20)}`] = v
  return {
    items: r.items,
    channelCategories: r.cats,
    channelAuthors: r.authors,
    byKind: obj(r.kind),
    postsByStatus: statusObj,
    publishedPosts: r.published,
    expectedPublished: EXPECTED_PUBLISHED,
    publishedWithoutSlug: r.noSlug,
    publishedDuplicateSlugGroups: [...r.slugs.values()].filter((n) => n > 1).length,
    publishedPasswordProtected: r.password,
    publishedWithoutGmtDate: r.noGmt,
    publishedWithLocalTimeFallback: r.localFallback,
    itemsWithoutDateAtAll: r.noDate,
    categoriesPerPublishedPost: obj(r.catDist),
    shortcodes: { postsWith: r.shortcodePosts, tags: top(r.shortcodeTags, 30) },
    iframes: { postsWith: r.iframePosts, hosts: top(r.iframeHosts, 30) },
    tables: { postsWith: r.tablePosts, total: r.tableTotal },
    images: { postsWith: r.imgPosts, total: r.imgTotal },
    gutenberg: { blockPosts: r.blockPosts, classicPosts: r.classicPosts },
    youtube: { postsWith: r.youtubePosts },
    comments: { total: r.comments, byApprovedAndType: top(r.commentKinds, 30), approvedOnPublishedPosts: r.approvedOnPublished },
    attachments: { total: r.att, withUrl: r.attUrl, withAltText: r.attAlt, withAttachedFile: r.attFile },
    seo: {
      rankMathTitle: r.rmT,
      rankMathTitleWithVariables: r.rmTv,
      rankMathDescription: r.rmD,
      rankMathDescriptionWithVariables: r.rmDv,
      yoastTitle: r.yT,
      yoastDescription: r.yD,
    },
  }
}

const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `  ${k}: ${v}`)
const pairs = (p: [string, number][]) => (p.length ? p.map(([k, v]) => `  ${k}: ${v}`) : ['  (none)'])

/** Counts-only text. Shortcode tag names and iframe hosts are the only strings taken from the file. */
export function formatWxrReport(rep: WxrReport): string {
  const diff = rep.publishedPosts - rep.expectedPublished
  return [
    'WXR parse-only report (counts only, no database, no network)',
    `items: ${rep.items} | channel categories: ${rep.channelCategories} | channel authors: ${rep.channelAuthors}`,
    'items by kind:', ...kv(rep.byKind),
    'posts by status:', ...kv(rep.postsByStatus),
    `published posts: ${rep.publishedPosts} (owner expects ${rep.expectedPublished}; difference ${diff >= 0 ? '+' : ''}${diff})`,
    `published without slug: ${rep.publishedWithoutSlug}`,
    `published duplicate-slug groups: ${rep.publishedDuplicateSlugGroups}`,
    `published password-protected: ${rep.publishedPasswordProtected}`,
    `published with GMT date missing: ${rep.publishedWithoutGmtDate} (of which local-time fallback: ${rep.publishedWithLocalTimeFallback})`,
    `items with no usable date at all: ${rep.itemsWithoutDateAtAll}`,
    'categories per published post:', ...kv(rep.categoriesPerPublishedPost),
    `published posts with shortcode-like tags: ${rep.shortcodes.postsWith}; top tag names:`, ...pairs(rep.shortcodes.tags),
    `published posts with iframes: ${rep.iframes.postsWith}; hosts:`, ...pairs(rep.iframes.hosts),
    `published posts with <table>: ${rep.tables.postsWith} (${rep.tables.total} tables)`,
    `published posts with <img>: ${rep.images.postsWith} (${rep.images.total} images)`,
    `published posts: Gutenberg blocks ${rep.gutenberg.blockPosts}, classic ${rep.gutenberg.classicPosts}`,
    `published posts with YouTube references: ${rep.youtube.postsWith}`,
    `comments: ${rep.comments.total}; approved comments on published posts: ${rep.comments.approvedOnPublishedPosts}; by approved/type:`,
    ...pairs(rep.comments.byApprovedAndType),
    `attachments: ${rep.attachments.total} (url ${rep.attachments.withUrl}, alt text ${rep.attachments.withAltText}, attached file ${rep.attachments.withAttachedFile})`,
    `Rank Math title present: ${rep.seo.rankMathTitle} (with %variables%: ${rep.seo.rankMathTitleWithVariables}); description present: ${rep.seo.rankMathDescription} (with %variables%: ${rep.seo.rankMathDescriptionWithVariables})`,
    `Yoast title present: ${rep.seo.yoastTitle}; description present: ${rep.seo.yoastDescription} (not read by the importer)`,
  ].join('\n')
}

export type CliIo = { out: (line: string) => void; err: (line: string) => void }

const USAGE = 'REPORT_USAGE'

/** Run the report CLI. Returns the process exit code. Errors print a short code only, never data. */
export async function runWxrReportCli(argv: readonly string[], io: CliIo, cwd: string = process.cwd()): Promise<number> {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const file = value('--file')
  const detail = value('--detail-file')
  if (!file || (argv.includes('--detail-file') && !detail)) {
    io.err(USAGE)
    return 2
  }
  const abs = path.resolve(cwd, file)
  if (isInsideRepo(abs, cwd)) {
    io.err('REPORT_FILE_INSIDE_REPO')
    return 2
  }
  let detailAbs: string | undefined
  if (detail) {
    detailAbs = path.resolve(cwd, detail)
    if (isInsideRepo(detailAbs, cwd)) {
      io.err('REPORT_DETAIL_INSIDE_REPO')
      return 2
    }
    if (fs.existsSync(detailAbs)) {
      io.err('REPORT_DETAIL_EXISTS')
      return 2
    }
  }
  let fd: number | undefined
  try {
    if (detailAbs) {
      try {
        fd = fs.openSync(detailAbs, 'wx', 0o600)
      } catch {
        io.err('REPORT_DETAIL_FAILED')
        return 1
      }
    }
    const out = fd
    const rep = await buildWxrReport(readWxrFile(abs), (it, flags) => {
      if (out === undefined) return
      fs.writeSync(
        out,
        JSON.stringify({
          wpId: it.wpId, kind: it.kind, status: it.status, slug: it.slug, title: it.title, dateGmt: it.dateGmt,
          dateIssue: it.dateIssue, categories: it.categories.map((c) => c.nicename), comments: it.comments.length,
          hasPassword: it.hasPassword, ...flags,
        }) + '\n',
      )
    })
    io.out(formatWxrReport(rep))
    return 0
  } catch (err) {
    io.err(err instanceof WxrError ? err.code : 'REPORT_FAILED')
    return 1
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
