import { normalizePath } from '../lib/redirectPaths'
import {
  classifyHref,
  KNOWN_LEGACY_HOSTS,
  LinkContextBuilder,
  NON_SITE_TYPES,
  type Classified,
  type LinkContext,
  type LinkContextOptions,
  type LinkType,
} from './linkClassify'
import { decodeEntities } from './mapping'
import type { WxrRecord } from './wxr'

/**
 * Read-only link audit over a WXR export: classifies every `<a href>` in the body of every published, unprotected post
 * and derives the exact-match 301 rules the old addresses need. COUNTS go to the caller's screen; the per-link rows (which
 * hold addresses) are returned separately for a private file. Nothing here touches a database.
 */

export type TypeCount = { total: number; resolved: number; unresolved: number; resolvedBefore: number }
export type Tally = Record<string, number>

export type RuleDrop = 'invalid' | 'identical' | 'covered-by-article-rule' | 'is-article-address' | 'conflict' | 'loop'

export type LinkAudit = {
  posts: number
  postsWithLinks: number
  links: number
  siteLinks: number
  byType: Partial<Record<LinkType, TypeCount>>
  /** Site links by where they were written. */
  byHost: Tally
  unresolvedByReason: Tally
  /** Shape of unresolved `other-path` links (segment count only, never text). */
  otherPathShapes: Tally
  /** Anchors that wrap an image (a lightbox link to the full-size file), by type: the converter keeps the image, so these are not body links. */
  imageWrapped: Tally
  resolvedTotal: number
  unresolvedTotal: number
  resolvedBeforeTotal: number
  redirects: { rules: number; dropped: Partial<Record<RuleDrop, number>>; flattened: number }
}

export type AuditRow = { postId: number; type: LinkType; host: string; resolved: boolean; reason: string; href: string; to: string | null }
export type RedirectRule = { from: string; to: string; status: 301 }

const A_TAG = /<a\b([^>]*)>/gi
const HREF_ATTR = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i

/** Every `href` of an `<a>` in the HTML, entity-decoded; `imageWrapped` when the anchor starts with an image (the converter keeps the image, not the link). */
export function extractLinks(html: string): { href: string; imageWrapped: boolean }[] {
  const out: { href: string; imageWrapped: boolean }[] = []
  const re = new RegExp(A_TAG.source, 'gi')
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const h = HREF_ATTR.exec(` ${m[1]}`)
    if (!h) continue
    out.push({ href: decodeEntities(h[1] ?? h[2] ?? h[3] ?? ''), imageWrapped: /^\s{0,40}<img\b/i.test(html.slice(re.lastIndex, re.lastIndex + 60)) })
  }
  return out
}

/** Links that already worked before the improved rewriter: a plain article or home address on the site. */
const resolvedBefore = (c: Classified): boolean =>
  c.resolved && (c.host === 'primary' || c.host === 'relative') && (c.type === 'article' || c.type === 'home')

export type RuleCandidates = { from: string; to: string }[]

/**
 * Turn candidate old -> new paths into rules that are safe to import: canonical, not identical, not already an article
 * rule or an article address, one target per address, chains flattened, loops dropped. 410 is never invented.
 */
export function finalizeRedirects(
  candidates: RuleCandidates,
  guards: { articlePaths?: ReadonlySet<string>; derivedFrom?: ReadonlySet<string> } = {},
): { rules: RedirectRule[]; dropped: Partial<Record<RuleDrop, number>>; flattened: number } {
  const dropped: Partial<Record<RuleDrop, number>> = {}
  const drop = (k: RuleDrop) => {
    dropped[k] = (dropped[k] ?? 0) + 1
  }
  const map = new Map<string, string>()
  const conflicted = new Set<string>()
  for (const c of candidates) {
    const f = normalizePath(c.from)
    const t = normalizePath(c.to)
    if (!f.ok || !t.ok || f.path === '/') {
      drop('invalid')
      continue
    }
    if (f.path === t.path) {
      drop('identical')
      continue
    }
    if (guards.derivedFrom?.has(f.path)) {
      drop('covered-by-article-rule')
      continue
    }
    if (guards.articlePaths?.has(f.path)) {
      drop('is-article-address')
      continue
    }
    const had = map.get(f.path)
    if (had === undefined) map.set(f.path, t.path)
    else if (had !== t.path) {
      conflicted.add(f.path)
      drop('conflict')
    }
  }
  for (const f of conflicted) map.delete(f)
  // Flatten chains; drop everything on a loop.
  let flattened = 0
  const out: RedirectRule[] = []
  for (const [from, to0] of [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let to = to0
    const seen = new Set<string>([from])
    let loop = false
    let hops = 0
    while (map.has(to)) {
      if (seen.has(to)) {
        loop = true
        break
      }
      seen.add(to)
      to = map.get(to) as string
      hops++
    }
    if (loop || to === from) {
      drop('loop')
      continue
    }
    if (hops > 0) flattened++
    out.push({ from, to, status: 301 })
  }
  return { rules: out, dropped, flattened }
}

/** `from,to,status` exactly as `npm run import:redirects -- --file` reads it. */
export const redirectsCsv = (rules: readonly RedirectRule[]): string =>
  `from,to,status\n${rules.map((r) => `${r.from},${r.to},${r.status}`).join('\n')}${rules.length ? '\n' : ''}`

export type AuditOptions = LinkContextOptions & { onRow?: (row: AuditRow) => void }

export async function auditLinks(
  open: () => AsyncIterable<WxrRecord>,
  options: AuditOptions,
): Promise<{ audit: LinkAudit; rules: RedirectRule[]; ctx: LinkContext }> {
  const builder = new LinkContextBuilder()
  for await (const rec of open()) builder.add(rec)
  const ctx = builder.build({ ...options, extraHosts: [...KNOWN_LEGACY_HOSTS, ...(options.extraHosts ?? [])] })

  const audit: LinkAudit = {
    posts: 0,
    postsWithLinks: 0,
    links: 0,
    siteLinks: 0,
    byType: {},
    byHost: {},
    unresolvedByReason: {},
    otherPathShapes: {},
    imageWrapped: {},
    resolvedTotal: 0,
    unresolvedTotal: 0,
    resolvedBeforeTotal: 0,
    redirects: { rules: 0, dropped: {}, flattened: 0 },
  }
  const candidates: RuleCandidates = []
  for await (const rec of open()) {
    if (rec.record !== 'item' || rec.item.kind !== 'post' || rec.item.status !== 'publish' || rec.item.hasPassword) continue
    const item = rec.item
    audit.posts++
    const hrefs = extractLinks(item.contentHtml)
    if (hrefs.length > 0) audit.postsWithLinks++
    for (const { href, imageWrapped } of hrefs) {
      const c = classifyHref(href, ctx)
      if (imageWrapped) audit.imageWrapped[c.type] = (audit.imageWrapped[c.type] ?? 0) + 1
      audit.links++
      const t = (audit.byType[c.type] ??= { total: 0, resolved: 0, unresolved: 0, resolvedBefore: 0 })
      t.total++
      if (!NON_SITE_TYPES.has(c.type)) {
        audit.siteLinks++
        audit.byHost[c.host] = (audit.byHost[c.host] ?? 0) + 1
        if (c.resolved) {
          t.resolved++
          audit.resolvedTotal++
        } else {
          t.unresolved++
          audit.unresolvedTotal++
          audit.unresolvedByReason[c.reason] = (audit.unresolvedByReason[c.reason] ?? 0) + 1
          if (c.type === 'other-path') {
            const n = href.replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0].split('/').filter(Boolean).length
            const k = `${Math.min(n, 5)}${n > 4 ? '+' : ''}-segments`
            audit.otherPathShapes[k] = (audit.otherPathShapes[k] ?? 0) + 1
          }
        }
        if (resolvedBefore(c)) {
          t.resolvedBefore++
          audit.resolvedBeforeTotal++
        }
      }
      if (c.redirect) candidates.push(c.redirect)
      options.onRow?.({ postId: item.wpId ?? -1, type: c.type, host: c.host, resolved: c.resolved, reason: c.reason, href, to: c.to })
    }
  }
  // Every nested category on the old site (/category/parent/child/) also gets its rule, linked or not.
  for (const nicename of ctx.usedCategories) {
    const chain: string[] = [nicename]
    const seen = new Set(chain)
    let parent = ctx.allCategories.get(nicename)?.parent ?? ''
    while (parent && !seen.has(parent)) {
      chain.unshift(parent)
      seen.add(parent)
      parent = ctx.allCategories.get(parent)?.parent ?? ''
    }
    if (chain.length > 1) candidates.push({ from: `/category/${chain.map(encodeURIComponent).join('/')}/`, to: ctx.categoryPath(nicename) })
  }
  const fin = finalizeRedirects(candidates, { articlePaths: ctx.articlePaths, derivedFrom: ctx.legacyPaths })
  audit.redirects = { rules: fin.rules.length, dropped: fin.dropped, flattened: fin.flattened }
  return { audit, rules: fin.rules, ctx }
}

export function formatLinkAudit(a: LinkAudit): string {
  const lines: string[] = ['Link audit of published posts (counts only)']
  lines.push(`posts audited: ${a.posts} (with at least one link: ${a.postsWithLinks})`)
  lines.push(`links: ${a.links}`)
  lines.push(`site links (internal and old hosts): ${a.siteLinks}, resolved now: ${a.resolvedTotal}, unresolved: ${a.unresolvedTotal}, resolved before this change: ${a.resolvedBeforeTotal}`)
  const types = Object.entries(a.byType).sort((x, y) => (y[1]?.total ?? 0) - (x[1]?.total ?? 0) || (x[0] < y[0] ? -1 : 1))
  lines.push('by type (total / resolved / unresolved / resolved before):')
  for (const [k, v] of types) {
    if (!v) continue
    lines.push(NON_SITE_TYPES.has(k as LinkType) ? `  ${k}: ${v.total} (not a site link)` : `  ${k}: ${v.total} / ${v.resolved} / ${v.unresolved} / ${v.resolvedBefore}`)
  }
  const tally = (name: string, t: Tally) => {
    const e = Object.entries(t).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
    lines.push(`${name}: ${e.reduce((n, [, v]) => n + v, 0)}`)
    for (const [k, v] of e) lines.push(`  ${k}: ${v}`)
  }
  tally('site links by host', a.byHost)
  tally('unresolved by reason', a.unresolvedByReason)
  tally('unresolved other-path shapes', a.otherPathShapes)
  tally('anchors wrapping an image, by type (included above)', a.imageWrapped)
  lines.push(`redirect rules emitted: ${a.redirects.rules} (chains flattened: ${a.redirects.flattened})`)
  tally('redirect candidates dropped', a.redirects.dropped as Tally)
  return lines.join('\n')
}
