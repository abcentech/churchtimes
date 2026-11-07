import path from 'node:path'

import { stripShortcodes } from '../lib/legacyContent'
import { isInsideRepo } from './safePaths'
import { readWxrFile, WxrError, type WxrRecord } from './wxr'

/**
 * Read-only sizing of a WXR export: `npm run import:inspect -- --file <path>`.
 * No database, no network, no writes. COUNTS ONLY: the only strings taken from the file are shortcode tag names
 * (lowercase identifiers, top 20); authors and categories are counted, never named.
 */

const POST_STATUSES = ['publish', 'draft', 'private', 'pending', 'future', 'trash', 'auto-draft', 'inherit'] as const
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,30})\b[^<>]{0,8192}?(\/?)>/g

/** Deepest element nesting in an HTML string (lenient: unmatched closing tags are ignored). */
export function maxHtmlDepth(html: string): number {
  let depth = 0
  let max = 0
  for (const m of html.matchAll(TAG_RE)) {
    if (m[2] === undefined) continue // comment
    const name = m[2].toLowerCase()
    if (m[1]) depth = Math.max(0, depth - 1)
    else if (!VOID.has(name) && !m[3]) {
      depth += 1
      if (depth > max) max = depth
    }
  }
  return max
}

export type InspectReport = {
  items: number
  postsByStatus: Record<string, number>
  publishedPasswordProtected: number
  categories: { channelTerms: number; distinctUsedByPosts: number; postsWithMoreThanOne: number }
  /** Published posts only, counts only. */
  tags: { postsWithTags: number; distinctTags: number; uncategorisedPostsWithTags: number }
  yoast: {
    title: number
    description: number
    titleWithVariables: number
    descriptionWithVariables: number
    canonical: number
    noindex: number
    social: number
    primaryCategory: number
    /** Primary category ids that are a category of the export. */
    primaryCategoryResolves: number
    /** Published posts with no WordPress category, and how many of them the Yoast primary category would place. */
    uncategorisedPosts: number
    uncategorisedWithResolvablePrimary: number
    uncategorisedWithTagsOrPrimary: number
  }
  distinctAuthors: number
  commentsByStatus: Record<string, number>
  attachments: number
  shortcodeTags: [string, number][]
  largestPost: { bytes: number }
  maxHtmlNestingDepth: number
}

const commentStatus = (approved: string): string =>
  approved === '1' ? 'approved' : approved === '0' ? 'pending' : approved === 'spam' ? 'spam' : approved === 'trash' ? 'trash' : 'other'

export async function inspectWxr(records: AsyncIterable<WxrRecord>): Promise<InspectReport> {
  const status = new Map<string, number>()
  const comments = new Map<string, number>()
  const tags = new Map<string, number>()
  const authors = new Set<string>()
  const cats = new Set<string>()
  let channelTerms = 0
  const termIds = new Set<number>()
  const tagSlugs = new Set<string>()
  const y = { title: 0, description: 0, titleWithVariables: 0, descriptionWithVariables: 0, canonical: 0, noindex: 0, social: 0, primaryCategory: 0, primaryCategoryResolves: 0, uncategorisedPosts: 0, uncategorisedWithResolvablePrimary: 0, uncategorisedWithTagsOrPrimary: 0 }
  let postsWithTags = 0
  let uncatWithTags = 0
  let items = 0
  let password = 0
  let attachments = 0
  let multi = 0
  let largest = 0
  let depth = 0
  for await (const rec of records) {
    if (rec.record === 'category') {
      channelTerms += 1
      if (rec.category.termId !== null) termIds.add(rec.category.termId)
    }
    if (rec.record !== 'item') continue
    const it = rec.item
    items += 1
    if (it.kind === 'attachment') attachments += 1
    for (const c of it.comments) comments.set(commentStatus(c.approved), (comments.get(commentStatus(c.approved)) ?? 0) + 1)
    if (it.kind !== 'post') continue
    const s = (POST_STATUSES as readonly string[]).includes(it.status) ? it.status : 'other'
    status.set(s, (status.get(s) ?? 0) + 1)
    if (it.status === 'publish' && it.hasPassword) password += 1
    if (it.author) authors.add(it.author.toLowerCase())
    const named = new Set(it.categories.map((c) => c.nicename).filter(Boolean))
    for (const n of named) cats.add(n)
    if (named.size > 1) multi += 1
    if (it.status === 'publish') {
      const tagged = it.tags.some((t) => t.nicename)
      if (tagged) postsWithTags += 1
      for (const t of it.tags) if (t.nicename) tagSlugs.add(t.nicename)
      const sx = it.seo
      if (sx.yoastTitle) {
        y.title += 1
        if (/%%/.test(sx.yoastTitle)) y.titleWithVariables += 1
      }
      if (sx.yoastDescription) {
        y.description += 1
        if (/%%/.test(sx.yoastDescription)) y.descriptionWithVariables += 1
      }
      if (sx.yoastCanonical) y.canonical += 1
      if (sx.yoastNoindex === '1') y.noindex += 1
      if (sx.yoastSocialTitle || sx.yoastSocialDescription) y.social += 1
      const primaryOk = !!sx.yoastPrimaryCategory && /^[0-9]{1,10}$/.test(sx.yoastPrimaryCategory.trim()) && termIds.has(Number(sx.yoastPrimaryCategory.trim()))
      if (sx.yoastPrimaryCategory) {
        y.primaryCategory += 1
        if (primaryOk) y.primaryCategoryResolves += 1
      }
      if (named.size === 0) {
        y.uncategorisedPosts += 1
        if (primaryOk) y.uncategorisedWithResolvablePrimary += 1
        if (tagged) uncatWithTags += 1
        if (tagged || sx.yoastPrimaryCategory) y.uncategorisedWithTagsOrPrimary += 1
      }
    }
    largest = Math.max(largest, Buffer.byteLength(it.contentHtml, 'utf8'))
    depth = Math.max(depth, maxHtmlDepth(it.contentHtml))
    for (const rem of stripShortcodes(it.contentHtml).removals) {
      const k = /^[a-z][a-z0-9_-]{0,31}$/.test(rem.tag) ? rem.tag : '(other)'
      tags.set(k, (tags.get(k) ?? 0) + 1)
    }
  }
  const statusObj: Record<string, number> = {}
  for (const k of POST_STATUSES) statusObj[k] = status.get(k) ?? 0
  if (status.has('other')) statusObj.other = status.get('other') as number
  const commentObj: Record<string, number> = {}
  for (const k of ['approved', 'pending', 'spam', 'trash', 'other']) commentObj[k] = comments.get(k) ?? 0
  return {
    items,
    postsByStatus: statusObj,
    publishedPasswordProtected: password,
    categories: { channelTerms, distinctUsedByPosts: cats.size, postsWithMoreThanOne: multi },
    tags: { postsWithTags, distinctTags: tagSlugs.size, uncategorisedPostsWithTags: uncatWithTags },
    yoast: y,
    distinctAuthors: authors.size,
    commentsByStatus: commentObj,
    attachments,
    shortcodeTags: [...tags.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 20),
    largestPost: { bytes: largest },
    maxHtmlNestingDepth: depth,
  }
}

export function formatInspectReport(r: InspectReport): string {
  const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `  ${k}: ${v}`)
  return [
    'WXR inspect (read-only, counts only)',
    `items: ${r.items}`,
    'posts by status:', ...kv(r.postsByStatus),
    `published password-protected: ${r.publishedPasswordProtected}`,
    `categories: ${r.categories.channelTerms} in the file, ${r.categories.distinctUsedByPosts} used by posts, ${r.categories.postsWithMoreThanOne} posts with more than one`,
    `tags (published posts): ${r.tags.postsWithTags} posts have tags, ${r.tags.distinctTags} distinct tags, ${r.tags.uncategorisedPostsWithTags} of the posts without a category have tags`,
    `yoast (published posts): title ${r.yoast.title} (${r.yoast.titleWithVariables} with variables), description ${r.yoast.description} (${r.yoast.descriptionWithVariables} with variables), canonical ${r.yoast.canonical}, noindex ${r.yoast.noindex}, social ${r.yoast.social}`,
    `yoast primary category: ${r.yoast.primaryCategory} posts, ${r.yoast.primaryCategoryResolves} resolve to a category of the file`,
    `posts without a category: ${r.yoast.uncategorisedPosts}, of which ${r.yoast.uncategorisedWithResolvablePrimary} have a resolvable Yoast primary category and ${r.yoast.uncategorisedWithTagsOrPrimary} have tags or a primary category`,
    `distinct authors: ${r.distinctAuthors}`,
    'comments by status:', ...kv(r.commentsByStatus),
    `attachments: ${r.attachments}`,
    'top shortcode tags:', ...(r.shortcodeTags.length ? r.shortcodeTags.map(([k, v]) => `  ${k}: ${v}`) : ['  (none)']),
    `largest post content: ${r.largestPost.bytes} bytes`,
    `max HTML nesting depth in post content: ${r.maxHtmlNestingDepth}`,
  ].join('\n')
}

export type CliIo = { out: (line: string) => void; err: (line: string) => void }

/** Returns the process exit code. Errors print one short code, never data. */
export async function runInspectCli(argv: readonly string[], io: CliIo, cwd: string = process.cwd()): Promise<number> {
  const i = argv.indexOf('--file')
  const file = i >= 0 ? argv[i + 1] : undefined
  if (!file || file.startsWith('--')) {
    io.err('INSPECT_USAGE')
    return 2
  }
  const abs = path.resolve(cwd, file)
  if (isInsideRepo(file, cwd) || isInsideRepo(abs, cwd)) {
    io.err('INSPECT_FILE_INSIDE_REPO')
    return 2
  }
  try {
    io.out(formatInspectReport(await inspectWxr(readWxrFile(abs))))
    return 0
  } catch (err) {
    io.err(err instanceof WxrError ? err.code : 'INSPECT_FAILED')
    return 1
  }
}
