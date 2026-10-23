import { articlePath as buildArticlePath, resolveArticlePathTemplate } from '../lib/redirectPaths'
import { extractYoutubeId, HtmlConversionError, htmlToLexical, type ConversionReport } from './htmlToLexical'
import { KNOWN_LEGACY_HOSTS, LinkContextBuilder, linkClassifyHook } from './linkClassify'
import type { WxrRecord } from './wxr'

/**
 * Conversion-only statistics over every published post of a WXR export (rehearsal against a real export).
 * COUNTS ONLY: the report holds numbers and shortcode / element / block tag names (lowercase identifiers, bounded);
 * legacy ids go to a separate list the caller writes to a private file. No titles, slugs, URLs or article text.
 */

export type Tally = Record<string, number>

export type ConvertStats = {
  publishedPosts: number
  /** Password-protected published posts are not imported and not converted. */
  passwordProtectedSkipped: number
  converted: number
  failedByCode: Tally
  shortcodesRemovedByTag: Tally
  unknownElements: Tally
  unknownBlocks: Tally
  droppedElements: Tally
  tablesKept: number
  tablesFlattened: number
  embedsLinked: number
  embedsDropped: number
  youtubeBlocks: number
  imagesResolved: number
  imagesUnresolved: number
  linksRewritten: number
  linksUnmapped: number
  /** Fixed reason vocabulary of the link rewriter, never a URL. */
  linksUnmappedByReason: Tally
  linksConvertedToTextByReason: Tally
  postsWithDeepNestingFlattened: number
  deepNestingFlattened: number
  listsFlattened: number
  inputOverCapPosts: number
  postsWithWarnings: number
  /** Posts whose text (non-space characters) shrank by more than 20 percent against the source HTML text. */
  textShrinkOver20Pct: number
  postsWithEmptyOutput: number
  slowestPostMs: number
  postsOver1s: number
}

export type ConvertDetail = {
  textShrink: number[]
  failed: { id: number; code: string }[]
  emptyOutput: number[]
  inputOverCap: number[]
  maxDepthHit: number[]
}

const BARE_NAME = /^[a-z][a-z0-9_-]{0,31}$/
const bump = (t: Tally, key: string, by = 1) => {
  const k = BARE_NAME.test(key) ? key : '(other)'
  t[k] = (t[k] ?? 0) + by
}
const addAll = (t: Tally, rec: Record<string, number>) => {
  for (const [k, v] of Object.entries(rec)) bump(t, k, v)
}

/** Reasons are fixed sentences from the converter; anything unexpected is bucketed. */
const reason = (t: Tally, r: string, by = 1) => {
  const k = r.replace(/\s*\(.*$/, '').slice(0, 60)
  t[k] = (t[k] ?? 0) + by
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Non-space characters of the visible text of source HTML (tags, comments, scripts, styles and shortcode markers removed). */
export function sourceTextLength(html: string): number {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|iframe|video|audio|object|embed)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_m, n: string) => {
      if (n[0] === '#') {
        const cp = n[1].toLowerCase() === 'x' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10)
        return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ' '
      }
      return ENT[n.toLowerCase()] ?? 'x'
    })
    .replace(/https?:\/\/[^\s<>"']+/gi, (u) => (extractYoutubeId(u) ? ' ' : u))
    .replace(/\[\/?[a-z][a-z0-9_-]*(?:\s[^\]]*)?\]/gi, ' ')
  return text.replace(/\s+/g, '').length
}

/** Non-space characters in the text nodes of a serialized Lexical tree. */
export function lexicalTextLength(node: unknown): number {
  let total = 0
  const stack: unknown[] = [node]
  while (stack.length) {
    const n = stack.pop() as { type?: string; text?: unknown; children?: unknown[] } | null
    if (!n || typeof n !== 'object') continue
    if (n.type === 'text' && typeof n.text === 'string') total += n.text.replace(/\s+/g, '').length
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c)
  }
  return total
}

export function emptyStats(): ConvertStats {
  return {
    publishedPosts: 0, passwordProtectedSkipped: 0, converted: 0, failedByCode: {}, shortcodesRemovedByTag: {}, unknownElements: {}, unknownBlocks: {},
    droppedElements: {}, tablesKept: 0, tablesFlattened: 0, embedsLinked: 0, embedsDropped: 0, youtubeBlocks: 0, imagesResolved: 0, imagesUnresolved: 0,
    linksRewritten: 0, linksUnmapped: 0, linksUnmappedByReason: {}, linksConvertedToTextByReason: {}, postsWithDeepNestingFlattened: 0, deepNestingFlattened: 0, listsFlattened: 0, inputOverCapPosts: 0,
    postsWithWarnings: 0, textShrinkOver20Pct: 0, postsWithEmptyOutput: 0, slowestPostMs: 0, postsOver1s: 0,
  }
}

function fold(stats: ConvertStats, r: ConversionReport) {
  addAll(stats.shortcodesRemovedByTag, r.shortcodesRemoved)
  for (const [k, v] of Object.entries(r.unknownElements)) reason(stats.unknownElements, k.replace(/ .*$/, ''), v)
  addAll(stats.unknownBlocks, r.unknownBlocks)
  addAll(stats.droppedElements, r.droppedElements)
  stats.tablesKept += r.tables.kept
  stats.tablesFlattened += r.tables.flattened.length
  stats.embedsLinked += r.embeds.linked.length
  stats.embedsDropped += r.embeds.dropped.length
  stats.youtubeBlocks += r.youtube
  stats.imagesResolved += r.images.resolved
  stats.imagesUnresolved += r.images.unresolved.length
  stats.linksRewritten += r.links.rewritten
  stats.linksUnmapped += r.links.unmapped.length
  for (const u of r.links.unmapped) reason(stats.linksUnmappedByReason, u.reason)
  for (const u of r.links.converted) reason(stats.linksConvertedToTextByReason, u.reason)
  stats.deepNestingFlattened += r.deepNestingFlattened
  if (r.deepNestingFlattened > 0) stats.postsWithDeepNestingFlattened++
  stats.listsFlattened += r.listsFlattened
  if (r.warnings.length > 0) stats.postsWithWarnings++
}

export type ConvertOptions = {
  oldHosts?: readonly string[]
  /** true: every image counts as resolved, so only the other losses show. Default: all unresolved (no uploads folder). */
  assumeImages?: boolean
}

/**
 * Two passes over `open()`: the first builds the old-slug map (identity for published, unprotected posts), the second
 * converts every published post. `open` must return a fresh record stream each call.
 */
export async function convertWxrStats(open: () => AsyncIterable<WxrRecord>, options: ConvertOptions = {}): Promise<{ stats: ConvertStats; detail: ConvertDetail }> {
  const stats = emptyStats()
  const detail: ConvertDetail = { textShrink: [], failed: [], emptyOutput: [], inputOverCap: [], maxDepthHit: [] }
  const slugMap: Record<string, string> = {}
  const builder = new LinkContextBuilder()
  const hosts = new Set<string>([...KNOWN_LEGACY_HOSTS, ...(options.oldHosts ?? [])].map((h) => h.toLowerCase()))
  for await (const rec of open()) {
    builder.add(rec)
    if (rec.record === 'site') {
      for (const u of [rec.site.baseSiteUrl, rec.site.baseBlogUrl]) {
        try {
          hosts.add(new URL(u).hostname.toLowerCase())
        } catch {
          // not an address
        }
      }
    } else if (rec.record === 'item' && rec.item.kind === 'post' && rec.item.status === 'publish' && !rec.item.hasPassword && rec.item.slug) {
      slugMap[rec.item.slug] = rec.item.slug
    }
  }
  const template = resolveArticlePathTemplate(process.env)
  const articlePath = (slug: string) => buildArticlePath(template, slug)
  const classify = linkClassifyHook(builder.build({ articlePath, slugMap, extraHosts: [...hosts] }))
  for await (const rec of open()) {
    if (rec.record !== 'item' || rec.item.kind !== 'post' || rec.item.status !== 'publish') continue
    const item = rec.item
    stats.publishedPosts++
    if (item.hasPassword) {
      stats.passwordProtectedSkipped++
      continue
    }
    const id = item.wpId ?? -1
    const t0 = process.hrtime.bigint()
    try {
      const result = htmlToLexical(item.contentHtml, {
        oldHosts: [...hosts],
        slugMap,
        articlePath,
        classify,
        resolveImage: options.assumeImages ? () => ({ mediaId: 1 }) : () => null,
      })
      stats.converted++
      fold(stats, result.report)
      if (result.report.deepNestingFlattened > 0) detail.maxDepthHit.push(id)
      const src = sourceTextLength(item.contentHtml)
      const out = lexicalTextLength(result.content.root)
      if (src >= 50 && out < src * 0.8) {
        stats.textShrinkOver20Pct++
        detail.textShrink.push(id)
      }
      if (src > 0 && out === 0) {
        stats.postsWithEmptyOutput++
        detail.emptyOutput.push(id)
      }
    } catch (err) {
      const code = err instanceof HtmlConversionError ? err.code : 'unexpected-error'
      bump(stats.failedByCode, code)
      detail.failed.push({ id, code })
      if (code === 'input-too-large') {
        stats.inputOverCapPosts++
        detail.inputOverCap.push(id)
      }
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    stats.slowestPostMs = Math.max(stats.slowestPostMs, Math.round(ms))
    if (ms > 1000) stats.postsOver1s++
  }
  return { stats, detail }
}

export function formatConvertStats(s: ConvertStats): string {
  const tally = (name: string, t: Tally) => {
    const e = Object.entries(t).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    return [`${name}: ${e.reduce((n, [, v]) => n + v, 0)}`, ...e.slice(0, 40).map(([k, v]) => `  ${k}: ${v}`)]
  }
  return [
    'Conversion of published posts (counts only)',
    `published posts: ${s.publishedPosts} (password-protected, not converted: ${s.passwordProtectedSkipped})`,
    `converted: ${s.converted}`,
    ...tally('conversion failures by code', s.failedByCode),
    ...tally('shortcodes removed by tag', s.shortcodesRemovedByTag),
    ...tally('unknown elements flattened', s.unknownElements),
    ...tally('unknown blocks', s.unknownBlocks),
    ...tally('elements dropped with contents', s.droppedElements),
    `tables kept: ${s.tablesKept}, flattened: ${s.tablesFlattened}`,
    `embeds linked: ${s.embedsLinked}, dropped: ${s.embedsDropped}, youtube blocks written: ${s.youtubeBlocks}`,
    `images resolved: ${s.imagesResolved}, unresolved: ${s.imagesUnresolved}`,
    `links rewritten: ${s.linksRewritten}`,
    ...tally('links kept unmapped', s.linksUnmappedByReason),
    ...tally('links turned into text', s.linksConvertedToTextByReason),
    `deep nesting flattened: ${s.deepNestingFlattened} in ${s.postsWithDeepNestingFlattened} posts, lists flattened: ${s.listsFlattened}`,
    `posts over the input cap: ${s.inputOverCapPosts}`,
    `posts with converter warnings: ${s.postsWithWarnings}`,
    `posts whose text shrank by more than 20%: ${s.textShrinkOver20Pct}`,
    `posts with text in the source and none in the output: ${s.postsWithEmptyOutput}`,
    `slowest post: ${s.slowestPostMs} ms, posts over 1 s: ${s.postsOver1s}`,
  ].join('\n')
}
