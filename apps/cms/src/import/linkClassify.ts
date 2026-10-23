import { resolveSlugCollisions } from '../lib/legacyContent'
import { normalizePath } from '../lib/redirectPaths'
import { chooseCategory } from './mapping'
import type { WxrRecord } from './wxr'

/**
 * Classification of every link found in an imported article body (the link audit and the link rewriter share it, so
 * the audit counts exactly what the converter does). Pure: no database, no network. A classification carries only
 * fixed type and reason codes plus, for a resolved link, the NEW root-relative path: a rewrite never leaves the site.
 */

/** Old site hosts the owner told us about besides the export's own base URL (`.net` is the primary host). */
export const KNOWN_LEGACY_HOSTS: readonly string[] = ['churchtimesnigeria.net', 'churchtimesnigeria.org', 'churchtimesnigeria.com']
const ALT_HOSTS: ReadonlySet<string> = new Set(['churchtimesnigeria.org', 'churchtimesnigeria.com'])

export type LinkType =
  | 'mailto'
  | 'tel'
  | 'other-scheme'
  | 'anchor'
  | 'external'
  | 'relative-no-slash'
  | 'empty'
  | 'home'
  | 'article'
  | 'article-draft'
  | 'article-unknown'
  | 'dated-permalink'
  | 'post-id'
  | 'page-id'
  | 'page'
  | 'attachment'
  | 'category'
  | 'tag'
  | 'author'
  | 'date-archive'
  | 'feed'
  | 'uploads'
  | 'wp-admin'
  | 'search'
  | 'other-path'

/** Types that are not a site link at all: counted, never "resolved" or "unresolved". */
export const NON_SITE_TYPES: ReadonlySet<LinkType> = new Set<LinkType>([
  'mailto',
  'tel',
  'other-scheme',
  'anchor',
  'external',
  'empty',
  'relative-no-slash',
])

/** Where a site link was written: the primary host, another old host (.org / .com), or a root-relative path. */
export type HostKind = 'primary' | 'legacy' | 'relative' | 'none'

export type Classified = {
  type: LinkType
  host: HostKind
  resolved: boolean
  /** New root-relative path (with the fragment) when the link can be rewritten; null otherwise. */
  to: string | null
  /** Fixed sentence, never an address. */
  reason: string
  /** Old path -> new path for an exact 301 rule (category, tag and dated permalinks), already canonical. */
  redirect: { from: string; to: string } | null
  /** The wp id behind a `?p=N` or `?page_id=N` link (private detail only). */
  postId?: number
}

export const REASON = {
  ok: 'resolved',
  draft: 'article is not published or not imported',
  unknownSlug: 'slug is not in the slug map',
  page: 'page (no pages collection yet)',
  attachment: 'attachment page',
  categoryMissing: 'category not created by the import',
  tag: 'tag archive (no tag pages in the CMS)',
  author: 'author archive (no author pages)',
  dateArchive: 'date archive',
  feed: 'feed',
  uploads: 'uploaded file (not in the media map yet)',
  wpAdmin: 'WordPress admin or system path',
  search: 'search page',
  postIdMissing: 'post id is not in the export',
  other: 'not a single-segment article address',
} as const

export type LinkContext = {
  /** Lower-case host names (no `www.`) of the old site. */
  hosts: ReadonlySet<string>
  /** Old slug -> final slug of every article that will exist. */
  published: ReadonlyMap<string, string>
  /** Slugs of posts in the export that will not exist (draft, private, pending, trash, password-protected, not imported). */
  unpublishedSlugs: ReadonlySet<string>
  /** wp id -> final article slug / ids of posts that will not exist. */
  publishedIds: ReadonlyMap<number, string>
  unpublishedIds: ReadonlySet<number>
  pageIds: ReadonlyMap<number, string>
  pageSlugs: ReadonlySet<string>
  attachmentIds: ReadonlySet<number>
  attachmentSlugs: ReadonlySet<string>
  /** Nicenames of categories the import creates (chosen as an article's category) and every channel category. */
  usedCategories: ReadonlySet<string>
  allCategories: ReadonlyMap<string, { parent: string }>
  categoryTermIds: ReadonlyMap<number, string>
  tags: ReadonlySet<string>
  /** Canonical paths of the permalinks of published posts (already served by derived redirect rules). */
  legacyPaths: ReadonlySet<string>
  /** Canonical new article paths (a root-relative link that already points at one is resolved, so a re-run changes nothing). */
  articlePaths: ReadonlySet<string>
  articlePath: (slug: string) => string
  categoryPath: (slug: string) => string
  /** null: no tag pages exist. */
  tagPath: ((slug: string) => string) | null
  /** null: no pages collection. */
  pagePath: ((slug: string) => string) | null
  /** Relative path under wp-content/uploads -> new path, or null while the media map cannot carry it. */
  uploadPath: ((relative: string) => string | null) | null
}

export type LinkContextOptions = {
  extraHosts?: readonly string[]
  articlePath: (slug: string) => string
  categoryPath?: (slug: string) => string
  tagPath?: ((slug: string) => string) | null
  pagePath?: ((slug: string) => string) | null
  uploadPath?: ((relative: string) => string | null) | null
  /** The importer's slug map (old -> final). When given, only these posts exist; other published posts count as not imported. */
  slugMap?: Readonly<Record<string, string>>
}

export const hostKey = (h: string): string => h.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '')

const hostsOf = (...urls: string[]): string[] => {
  const out: string[] = []
  for (const u of urls) {
    try {
      out.push(hostKey(new URL(u).hostname))
    } catch {
      // not an address
    }
  }
  return out
}

function safePath(link: string): string {
  try {
    return new URL(link).pathname
  } catch {
    return link.startsWith('/') ? link.split(/[?#]/)[0] : ''
  }
}

/** Collects what the classifier needs from a WXR record stream (one pass). */
export class LinkContextBuilder {
  private siteHosts = new Set<string>()
  private publishedList: { slug: string; id: number | null }[] = []
  private unpublishedSlugs = new Set<string>()
  private unpublishedIds = new Set<number>()
  private pageIds = new Map<number, string>()
  private pageSlugs = new Set<string>()
  private attachmentIds = new Set<number>()
  private attachmentSlugs = new Set<string>()
  private usedCategories = new Set<string>()
  private allCategories = new Map<string, { parent: string }>()
  private categoryTermIds = new Map<number, string>()
  private tags = new Set<string>()
  private legacyPaths = new Set<string>()

  add(rec: WxrRecord): void {
    if (rec.record === 'site') {
      for (const h of hostsOf(rec.site.baseSiteUrl, rec.site.baseBlogUrl)) this.siteHosts.add(h)
    } else if (rec.record === 'category') {
      const c = rec.category
      if (!c.nicename) return
      this.allCategories.set(c.nicename, { parent: c.parentNicename })
      if (c.termId !== null) this.categoryTermIds.set(c.termId, c.nicename)
    } else if (rec.record === 'item') {
      const it = rec.item
      if (it.kind === 'post') {
        if (it.slug && it.status === 'publish' && !it.hasPassword) {
          this.publishedList.push({ slug: it.slug, id: it.wpId })
          const primary = chooseCategory(it.categories).primary
          if (primary) this.usedCategories.add(primary.nicename)
          const path = normalizePath(safePath(it.link))
          if (path.ok && path.path !== '/') this.legacyPaths.add(path.path)
        } else {
          if (it.slug) this.unpublishedSlugs.add(it.slug)
          if (it.wpId !== null) this.unpublishedIds.add(it.wpId)
        }
        if (it.status === 'publish') for (const t of it.tags) if (t.nicename) this.tags.add(t.nicename)
      } else if (it.kind === 'page') {
        if (it.slug) this.pageSlugs.add(it.slug)
        if (it.wpId !== null && it.slug) this.pageIds.set(it.wpId, it.slug)
      } else if (it.kind === 'attachment') {
        if (it.slug) this.attachmentSlugs.add(it.slug)
        if (it.wpId !== null) this.attachmentIds.add(it.wpId)
      }
    }
  }

  build(opts: LinkContextOptions): LinkContext {
    const published = new Map<string, string>()
    const publishedIds = new Map<number, string>()
    const unpublishedSlugs = new Set(this.unpublishedSlugs)
    const unpublishedIds = new Set(this.unpublishedIds)
    const slugMap = opts.slugMap
    // Without the importer's map, simulate its slug handling (valid slugs kept, duplicates renamed) so the audit agrees with it.
    const simulated = slugMap ? null : resolveSlugCollisions(this.publishedList.map((p) => ({ slug: p.slug }))).items
    this.publishedList.forEach((p, i) => {
      const final = simulated ? simulated[i].slug : slugMap && Object.prototype.hasOwnProperty.call(slugMap, p.slug) ? slugMap[p.slug] : undefined
      if (final === undefined) {
        unpublishedSlugs.add(p.slug)
        if (p.id !== null) unpublishedIds.add(p.id)
        return
      }
      if (!published.has(p.slug)) published.set(p.slug, final)
      if (p.id !== null) publishedIds.set(p.id, final)
    })
    const articlePaths = new Set<string>()
    for (const final of published.values()) {
      try {
        const n = normalizePath(opts.articlePath(final))
        if (n.ok) articlePaths.add(n.path)
      } catch {
        // an invalid slug has no path
      }
    }
    const hosts = new Set<string>([...this.siteHosts, ...(opts.extraHosts ?? []).map(hostKey)])
    return {
      hosts,
      published,
      unpublishedSlugs,
      publishedIds,
      unpublishedIds,
      pageIds: this.pageIds,
      pageSlugs: this.pageSlugs,
      attachmentIds: this.attachmentIds,
      attachmentSlugs: this.attachmentSlugs,
      usedCategories: this.usedCategories,
      allCategories: this.allCategories,
      categoryTermIds: this.categoryTermIds,
      tags: this.tags,
      legacyPaths: this.legacyPaths,
      articlePaths,
      articlePath: opts.articlePath,
      categoryPath: opts.categoryPath ?? ((s) => `/category/${s}/`),
      tagPath: opts.tagPath ?? null,
      pagePath: opts.pagePath ?? null,
      uploadPath: opts.uploadPath ?? null,
    }
  }
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const SYSTEM_FIRST = new Set(['wp-admin', 'wp-login.php', 'wp-json', 'wp-includes', 'xmlrpc.php', 'wp-cron.php', 'wp-signup.php', 'robots.txt', 'sitemap.xml'])
const FEED_SEGMENTS = new Set(['feed', 'rss', 'rss2', 'atom', 'rdf'])
const INT = /^\d{1,12}$/

const none = (type: LinkType): Classified => ({ type, host: 'none', resolved: false, to: null, reason: '', redirect: null })

const UNSAFE = new RegExp('[\\u0000-\\u0020\\u007f-\\u009f\\\\]')
const pathOk = (p: string): boolean => p.startsWith('/') && !p.startsWith('//') && !UNSAFE.test(p)

function fromCanonical(segments: string[]): string | null {
  const n = normalizePath(`/${segments.map(encodeURIComponent).join('/')}/`)
  return n.ok ? n.path : null
}

function toRule(from: string | null, to: string): { from: string; to: string } | null {
  if (from === null) return null
  const f = normalizePath(from)
  const t = normalizePath(to.split('#')[0])
  if (!f.ok || !t.ok || f.path === t.path || f.path === '/') return null
  return { from: f.path, to: t.path }
}

/** Classify one `href` exactly as written in the source HTML. */
export function classifyHref(raw: string, ctx: LinkContext): Classified {
  const url = raw.trim()
  if (url === '') return none('empty')
  if (url.startsWith('#')) return none('anchor')
  if (url.startsWith('//')) return none('other-scheme')
  if (/^mailto:/i.test(url)) return none('mailto')
  if (/^tel:/i.test(url)) return none('tel')
  let parsed: URL
  let host: HostKind
  if (url.startsWith('/')) {
    try {
      parsed = new URL(url, 'https://site.invalid')
    } catch {
      return none('other-scheme')
    }
    host = 'relative'
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:/i.test(url)) return none('other-scheme')
    try {
      parsed = new URL(url)
    } catch {
      return none('relative-no-slash')
    }
    if (parsed.username || parsed.password) return none('other-scheme')
    const key = hostKey(parsed.hostname)
    if (!ctx.hosts.has(key)) return none('external')
    host = ALT_HOSTS.has(key) ? 'legacy' : 'primary'
  }
  return classifySite(parsed, host, ctx)
}

function classifySite(parsed: URL, host: HostKind, ctx: LinkContext): Classified {
  const hash = parsed.hash && pathOk(`/${parsed.hash}`) ? parsed.hash : ''
  const q = parsed.searchParams
  const ap = (s: string): string => {
    try {
      return ctx.articlePath(s)
    } catch {
      return ''
    }
  }
  const result = (type: LinkType, rest: Partial<Classified> & { reason: string }): Classified => ({
    type,
    host,
    resolved: false,
    to: null,
    redirect: null,
    ...rest,
  })
  const article = (type: LinkType, slugKey: string, from?: string | null): Classified => {
    const final = ctx.published.get(slugKey) ?? ctx.published.get(slugKey.toLowerCase())
    if (final !== undefined) {
      const path = ap(final)
      if (!pathOk(path)) return result(type, { reason: REASON.other })
      return result(type, { resolved: true, to: `${path}${hash}`, reason: REASON.ok, redirect: from ? toRule(from, path) : null })
    }
    if (ctx.unpublishedSlugs.has(slugKey) || ctx.unpublishedSlugs.has(slugKey.toLowerCase())) {
      return result(type === 'article' ? 'article-draft' : type, { reason: REASON.draft })
    }
    return result(type === 'article' ? 'article-unknown' : type, { reason: REASON.unknownSlug })
  }
  const page = (slug: string | undefined): Classified => {
    if (slug !== undefined && ctx.pagePath) {
      const path = ctx.pagePath(slug)
      if (pathOk(path)) return result('page', { resolved: true, to: `${path}${hash}`, reason: REASON.ok })
    }
    return result('page', { reason: REASON.page })
  }
  const category = (nicename: string, from: string | null): Classified => {
    if (!ctx.usedCategories.has(nicename)) return result('category', { reason: REASON.categoryMissing })
    const path = ctx.categoryPath(nicename)
    if (!pathOk(path)) return result('category', { reason: REASON.categoryMissing })
    return result('category', { resolved: true, to: `${path}${hash}`, reason: REASON.ok, redirect: toRule(from, path) })
  }
  const tagLink = (slug: string, from: string | null): Classified => {
    if (ctx.tagPath && ctx.tags.has(slug)) {
      const path = ctx.tagPath(slug)
      if (pathOk(path)) return result('tag', { resolved: true, to: `${path}${hash}`, reason: REASON.ok, redirect: toRule(from, path) })
    }
    return result('tag', { reason: REASON.tag })
  }
  const byId = (type: 'post-id' | 'page-id', id: number): Classified => {
    const slug = ctx.publishedIds.get(id)
    if (slug !== undefined) {
      const path = ap(slug)
      return pathOk(path)
        ? result(type, { resolved: true, to: `${path}${hash}`, reason: REASON.ok, postId: id })
        : result(type, { reason: REASON.other, postId: id })
    }
    if (ctx.pageIds.has(id)) return { ...page(ctx.pageIds.get(id)), type, postId: id }
    if (ctx.unpublishedIds.has(id)) return result(type, { reason: REASON.draft, postId: id })
    return result(type, { reason: REASON.postIdMissing, postId: id })
  }
  const known = (slug: string | undefined): boolean =>
    slug !== undefined && (ctx.published.has(slug) || ctx.published.has(slug.toLowerCase()) || ctx.unpublishedSlugs.has(slug))

  const segs = parsed.pathname.split('/').filter((s) => s !== '').map(decode)
  const canonicalFrom = (): string | null => {
    const n = normalizePath(parsed.pathname)
    return n.ok ? n.path : null
  }

  // Query-addressed links (WordPress "plain" permalinks).
  const p = q.get('p')
  const pageId = q.get('page_id')
  if (segs.length === 0) {
    if (p !== null && INT.test(p)) return byId('post-id', Number(p))
    if (pageId !== null && INT.test(pageId)) return byId('page-id', Number(pageId))
  }
  if (q.get('attachment_id') !== null) return result('attachment', { reason: REASON.attachment })
  if (q.get('s') !== null) return result('search', { reason: REASON.search })
  if (q.get('feed') !== null) return result('feed', { reason: REASON.feed })
  if (q.get('author') !== null || q.get('author_name') !== null) return result('author', { reason: REASON.author })
  if (q.get('m') !== null || (q.get('year') !== null && segs.length === 0)) return result('date-archive', { reason: REASON.dateArchive })
  const cat = q.get('cat')
  if (cat !== null && segs.length === 0) {
    const nicename = INT.test(cat) ? ctx.categoryTermIds.get(Number(cat)) : undefined
    return nicename ? category(nicename, null) : result('category', { reason: REASON.categoryMissing })
  }
  const tagQ = q.get('tag')
  if (tagQ !== null && segs.length === 0) return tagLink(tagQ, null)

  if (host === 'relative') {
    const own = canonicalFrom()
    if (own !== null && ctx.articlePaths.has(own)) return result('article', { resolved: true, to: `${own}${hash}`, reason: REASON.ok })
  }
  if (segs.length === 0) return result('home', { resolved: true, to: `/${hash}`, reason: REASON.ok })
  if (segs.some((s) => FEED_SEGMENTS.has(s.toLowerCase())) || /\.(xml|rss)$/i.test(segs[segs.length - 1])) {
    return result('feed', { reason: REASON.feed })
  }

  const first = segs[0].toLowerCase()
  if (first === 'wp-content') {
    if (segs[1]?.toLowerCase() === 'uploads' && segs.length > 2) {
      const to = ctx.uploadPath ? ctx.uploadPath(segs.slice(2).join('/')) : null
      return to && pathOk(to) ? result('uploads', { resolved: true, to: `${to}${hash}`, reason: REASON.ok }) : result('uploads', { reason: REASON.uploads })
    }
    return result('wp-admin', { reason: REASON.wpAdmin })
  }
  if (SYSTEM_FIRST.has(first)) return result('wp-admin', { reason: REASON.wpAdmin })
  if (first === 'category' || first === 'categories') {
    const parts = segs.slice(1)
    const pageAt = parts.lastIndexOf('page')
    const trimmed = pageAt >= 0 && parts.slice(pageAt + 1).every((s) => INT.test(s)) ? parts.slice(0, pageAt) : parts
    if (trimmed.length === 0) return result('category', { reason: REASON.categoryMissing })
    return category(trimmed[trimmed.length - 1], fromCanonical(['category', ...trimmed]))
  }
  if (first === 'tag' || first === 'tags') {
    const parts = segs.slice(1)
    const pageAt = parts.indexOf('page')
    const trimmed = pageAt >= 0 ? parts.slice(0, pageAt) : parts
    if (trimmed.length === 0) return result('tag', { reason: REASON.tag })
    return tagLink(trimmed[0], fromCanonical(['tag', ...trimmed]))
  }
  if (first === 'author') return result('author', { reason: REASON.author })
  if (first === 'search') return result('search', { reason: REASON.search })
  if (first === 'page' && segs.length <= 2) return result('other-path', { reason: REASON.other })
  if (/^\d{4}$/.test(first) && segs.length <= 3 && segs.slice(1).every((s) => INT.test(s))) {
    return result('date-archive', { reason: REASON.dateArchive })
  }
  if (/^\d{4}$/.test(first) && /^\d{1,2}$/.test(segs[1] ?? '')) {
    const rest = segs.slice(2)
    const afterDay = rest.length > 0 && /^\d{1,2}$/.test(rest[0]) && rest.length > 1 ? rest.slice(1) : rest
    if (afterDay.length === 1 || (afterDay.length === 2 && INT.test(afterDay[1]))) return article('dated-permalink', afterDay[0], canonicalFrom())
  }
  if (segs.length === 1) {
    const slug = segs[0]
    if (known(slug)) return article('article', slug)
    if (ctx.pageSlugs.has(slug)) return page(slug)
    if (ctx.attachmentSlugs.has(slug)) return result('attachment', { reason: REASON.attachment })
    return result('article-unknown', { reason: REASON.unknownSlug })
  }
  if (segs.length === 2 && INT.test(segs[1]) && known(segs[0])) return article('article', segs[0])
  if (segs.length >= 2 && (known(segs[0]) || ctx.pageSlugs.has(segs[0])) && (segs[1] === 'attachment' || ctx.attachmentSlugs.has(segs[1]))) {
    return result('attachment', { reason: REASON.attachment })
  }
  const last = segs[segs.length - 1]
  if (segs.length >= 2 && ctx.pageSlugs.has(last) && !known(last)) return page(last)
  return result('other-path', { reason: REASON.other })
}

/** The `LinkOptions.classify` hook of `sanitizeLegacyLinks`: the new path for a link, or why it stays. */
export function linkClassifyHook(ctx: LinkContext): (url: string) => { to: string | null; reason: string } {
  return (url) => {
    const c = classifyHref(url, ctx)
    return { to: c.resolved ? c.to : null, reason: c.reason || REASON.other }
  }
}
