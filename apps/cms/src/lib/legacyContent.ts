import { hasTemplateVariable } from './seoFields'

/**
 * Pure helpers for the WordPress archive import (go-live contract C1.3 and C1.5). No database, no I/O: the
 * importer calls them and records what they report in the editorial QA report.
 */

// ---------------------------------------------------------------------------------------------
// C1.3 slugs
// ---------------------------------------------------------------------------------------------

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SLUG_MAX = 160

/** Lowercase, ASCII-fold, hyphenate, max 160 characters. Same rule as the article slug generator. */
function slugifyText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '')
}

export const isValidSlug = (slug: unknown): slug is string =>
  typeof slug === 'string' && slug.length <= SLUG_MAX && SLUG_RE.test(slug)

export type SlugItem = { slug: string; title?: string }
export type SlugRename = { old: string; new: string }

/**
 * Keep each WordPress `post_name` when it is a valid slug, rename only what must change, and never let one post
 * take the slug another post already owns. Resolution is in passes, independent of item order:
 *
 * 1. every VALID original slug that is not in `existingSlugs` is reserved (the first item with that slug keeps it);
 * 2. every INVALID original (upper case, spaces, `%xx`, ...) claims its normalised form if that is still free;
 * 3. the rest (true duplicates, and normalised forms that collided) take `-2`, `-3`, ... avoiding every slug
 *    reserved so far, in item order.
 *
 * So `[a, a, a-2]` gives `a, a-3, a-2` (the real `a-2` is never stolen) and `My-Post` never beats a real `my-post`.
 * Returns the items (same order, `slug` replaced) and the `{ old, new }` pairs (item order) for the QA report and
 * the redirect map. Inputs are not mutated.
 */
export function resolveSlugCollisions<T extends SlugItem>(
  items: readonly T[],
  existingSlugs: Iterable<string> = [],
): { items: T[]; renamed: SlugRename[] } {
  const taken = new Set<string>(existingSlugs)
  const originals = items.map((item) => (typeof item.slug === 'string' ? item.slug : ''))
  const assigned: (string | undefined)[] = items.map(() => undefined)
  const baseOf = (i: number): string =>
    (isValidSlug(originals[i]) ? originals[i] : slugifyText(originals[i]) || slugifyText(items[i].title ?? '')) || 'article'

  // 1. valid originals keep their slug
  items.forEach((_, i) => {
    if (isValidSlug(originals[i]) && !taken.has(originals[i])) {
      assigned[i] = originals[i]
      taken.add(originals[i])
    }
  })
  // 2. invalid originals claim their normalised form when free
  items.forEach((_, i) => {
    if (assigned[i] !== undefined || isValidSlug(originals[i])) return
    const base = baseOf(i)
    if (!taken.has(base)) {
      assigned[i] = base
      taken.add(base)
    }
  })
  // 3. everything else gets a numeric suffix
  items.forEach((_, i) => {
    if (assigned[i] !== undefined) return
    const base = baseOf(i)
    let chosen = base
    for (let n = 2; taken.has(chosen); n++) {
      const suffix = `-${n}`
      chosen = base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '') + suffix
    }
    assigned[i] = chosen
    taken.add(chosen)
  })

  const renamed: SlugRename[] = []
  const out = items.map((item, i) => {
    if (assigned[i] !== originals[i]) renamed.push({ old: originals[i], new: assigned[i] as string })
    return { ...item, slug: assigned[i] as string }
  })
  return { items: out, renamed }
}

// ---------------------------------------------------------------------------------------------
// C1.3 shortcodes
// ---------------------------------------------------------------------------------------------

/**
 * Shortcode names removed by default. Matching is CASE-SENSITIVE and exact (WordPress registers lower case names),
 * so `[video]` goes but a bracketed `[Video]` in the copy stays; `penci-*` / `penci_*` are the theme's own.
 * Pass `knownTags` for more. Nothing else is removed unless it carries attributes or closes a removed opening tag.
 */
const DEFAULT_KNOWN_SHORTCODES: readonly string[] = [
  'gallery',
  'caption',
  'embed',
  'audio',
  'video',
  'playlist',
  'contact-form-7',
  'wpforms',
]
const PENCI_RE = /^penci[-_][a-z0-9_-]*$/

// `[tag attrs]`, `[tag attrs /]`, `[/tag]`. A tag name starts with a letter.
const SHORTCODE_RE = /\[(\/?)([A-Za-z][A-Za-z0-9_-]*)((?:\s[^\[\]]*)?)\/?\]/g

export type ShortcodeRemoval = { tag: string; reason: 'known' | 'attributes' | 'closing' }
export type ShortcodeReport = {
  text: string
  /** Distinct removed tag names, first-seen order (case as written). */
  removed: string[]
  /** Number of removed markers. */
  count: number
  /** Every removal, in order, with the rule that removed it. */
  removals: ShortcodeRemoval[]
}

/** `name=value`, or a first argument that is a quoted string or a URL. */
const hasAttributes = (attrs: string): boolean => {
  const a = attrs.trim()
  if (a === '') return false
  return /^[A-Za-z0-9_-]+\s*=\s*\S/.test(a) || /\s[A-Za-z0-9_-]+\s*=\s*\S/.test(` ${a}`) || /^["']/.test(a) || /^https?:\/\//i.test(a)
}

/**
 * Remove WordPress shortcodes from plain text, conservatively. A marker is removed only when it is
 * (a) a closing tag `[/tag]` that pairs with an opening tag removed earlier in the text,
 * (b) an opening or self-closing tag that carries attributes (`name=value`, or a first argument that is a quoted
 *     string or a URL), or
 * (c) a name in the case-sensitive known list (`DEFAULT_KNOWN_SHORTCODES`, `penci-*`, plus `options.knownTags`).
 * Everything else stays: `[sic]`, `[co-founder]`, `[covid-19]`, `[x1]`, `[Video]`, `[laughs]`, `[1]`, `[Smith 2020]`.
 * Only the whitespace touching a removed marker is tidied (one space where two meet, none left at a line edge);
 * the rest of the text is returned byte for byte. Every removal is reported. A form shortcode is never rendered or
 * executed; removing it is all that is done.
 */
export function stripShortcodes(text: string, options: { knownTags?: readonly string[] } = {}): ShortcodeReport {
  if (typeof text !== 'string') return { text: '', removed: [], count: 0, removals: [] }
  const empty: ShortcodeReport = { text, removed: [], count: 0, removals: [] }
  if (text.indexOf('[') === -1) return empty

  const known = new Set<string>([...DEFAULT_KNOWN_SHORTCODES, ...(options.knownTags ?? [])])
  const isKnown = (name: string) => known.has(name) || PENCI_RE.test(name)
  const open = new Map<string, number>() // removed opening tags still awaiting their closing tag
  const removals: ShortcodeRemoval[] = []
  let out = ''
  let last = 0

  const re = new RegExp(SHORTCODE_RE.source, 'g')
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const [marker, closing, name, attrs] = m
    let reason: ShortcodeRemoval['reason'] | null = null
    if (closing === '/') {
      if ((open.get(name) ?? 0) > 0) {
        open.set(name, (open.get(name) ?? 0) - 1)
        reason = 'closing'
      }
    } else if (hasAttributes(attrs)) {
      reason = 'attributes'
    } else if (isKnown(name)) {
      reason = 'known'
    }
    if (reason === null) continue

    const selfClosing = /\/\]$/.test(marker)
    if (closing !== '/' && !selfClosing) open.set(name, (open.get(name) ?? 0) + 1)
    removals.push({ tag: name, reason })

    out += text.slice(last, m.index)
    last = m.index + marker.length
    // Tidy only the whitespace touching this marker.
    const prevSpace = /[ \t]$/.test(out)
    const next = text[last]
    const nextSpace = next === ' ' || next === '\t'
    if (prevSpace && nextSpace) last += 1
    else if (prevSpace && (next === undefined || next === '\n' || next === '\r')) out = out.slice(0, -1)
    else if ((out === '' || /\n$/.test(out)) && nextSpace) last += 1
    re.lastIndex = last
  }
  if (removals.length === 0) return empty
  out += text.slice(last)
  const removed = [...new Set(removals.map((r) => r.tag))]
  return { text: out, removed, count: removals.length, removals }
}

// ---------------------------------------------------------------------------------------------
// C1.3 Rank Math values
// ---------------------------------------------------------------------------------------------

/**
 * A Rank Math title or description that still contains a `%variable%` placeholder cannot be shown to searchers
 * literally: it is dropped (`value` null, `dropped` true) so the public site falls back to the headline / excerpt.
 * Anything else comes back trimmed; non-strings and blanks are `null` without the dropped flag.
 */
export function dropTemplateVariableSeo(value: unknown): { value: string | null; dropped: boolean } {
  if (typeof value !== 'string') return { value: null, dropped: false }
  const trimmed = value.trim()
  if (trimmed === '') return { value: null, dropped: false }
  if (hasTemplateVariable(trimmed)) return { value: null, dropped: true }
  return { value: trimmed, dropped: false }
}

// ---------------------------------------------------------------------------------------------
// C1.5 links
// ---------------------------------------------------------------------------------------------

export type LinkOptions = {
  /** Host names of the old site (`old.example.test`); matching ignores case, a trailing dot and a leading `www.`. */
  oldHosts: readonly string[]
  /** Old WordPress slug -> new slug. */
  slugMap: ReadonlyMap<string, string> | Readonly<Record<string, string>>
  /** The new root-relative path of an article, e.g. `(slug) => '/article/' + slug`. Must return a path starting `/`. */
  articlePath: (slug: string) => string
}

export type LinkReport = {
  rewritten: number
  /** Links to the old host that were NOT rewritten (kept as written), with the reason. */
  unmapped: { url: string; reason: string }[]
  /** Links (or too-deep subtrees) turned into plain text, with the reason. */
  converted: { url: string; reason: string }[]
}

/** Deepest node level the link walk descends; a subtree below it is flattened to plain text (and reported). */
export const LINK_WALK_MAX_DEPTH = 64

/** First path segments WordPress itself serves; never an article slug even if one is in the map. */
const RESERVED_WP_PATHS = new Set([
  'category',
  'categories',
  'tag',
  'tags',
  'author',
  'page',
  'feed',
  'comments',
  'search',
  'attachment',
  'trackback',
  'embed',
  'amp',
  'wp-content',
  'wp-admin',
  'wp-json',
  'wp-includes',
  'wp-login.php',
  'xmlrpc.php',
  'robots.txt',
  'sitemap.xml',
])

const hostKey = (h: string) => h.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '')

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

type Decision = { action: 'keep' } | { action: 'rewrite'; url: string } | { action: 'text'; reason: string }

function lookupSlug(map: LinkOptions['slugMap'], key: string): string | undefined {
  if (map instanceof Map) return map.get(key)
  return Object.prototype.hasOwnProperty.call(map, key) ? (map as Record<string, string>)[key] : undefined
}

// eslint-disable-next-line no-control-regex
const UNSAFE_URL_CHARS_RE = /[\u0000- \u007F-\u009F\\]/

const safeHash = (hash: string): string => (hash && !UNSAFE_URL_CHARS_RE.test(hash) ? hash : '')

/**
 * A web address that WordPress let through with a space inside (a pasted title, a typo) is kept, but written the way a
 * browser sends it (`%20`): the editor's link validation rejects an address with a space, which would stop the whole
 * article from being saved. Tabs and line breaks inside an address are dropped, as the URL parser does.
 */
function decide(raw: string, opts: LinkOptions, report: LinkReport): Decision {
  const d = decideInner(raw, opts, report)
  if (d.action !== 'keep') return d
  const url = raw.trim()
  if (!/^(https?:\/\/|\/)/i.test(url) || !/[ \t\n\r]/.test(url)) return d
  const fixed = url.replace(/[ \t\n\r]/g, (c) => (c === ' ' ? '%20' : ''))
  return UNSAFE_URL_CHARS_RE.test(fixed) ? { action: 'text', reason: 'unsafe characters in link' } : { action: 'rewrite', url: fixed }
}

function decideInner(raw: string, opts: LinkOptions, report: LinkReport): Decision {
  const url = raw.trim()
  if (url === '') return { action: 'text', reason: 'empty link' }
  if (url.startsWith('//')) return { action: 'text', reason: 'protocol-relative link' }
  if (url.startsWith('/')) {
    return UNSAFE_URL_CHARS_RE.test(url) ? { action: 'text', reason: 'unsafe characters in link' } : { action: 'keep' }
  }
  if (/^mailto:/i.test(url)) {
    return /^mailto:[^\s<>]+$/i.test(url) ? { action: 'keep' } : { action: 'text', reason: 'malformed mailto link' }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { action: 'text', reason: 'relative link without a leading slash' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { action: 'text', reason: `${parsed.protocol.replace(/:$/, '')}: links are not accepted` }
  }
  if (parsed.username || parsed.password) return { action: 'text', reason: 'link carries credentials' }

  const old = new Set(opts.oldHosts.map(hostKey))
  if (!old.has(hostKey(parsed.hostname))) return { action: 'keep' }

  // A link to the old site. Only the plain article address /<slug>/ is rewritten; anything else stays as written.
  const keepUnmapped = (reason: string): Decision => {
    report.unmapped.push({ url, reason })
    return { action: 'keep' }
  }
  const hash = safeHash(parsed.hash)
  if (parsed.search) {
    return keepUnmapped('has a query string (for example ?p=ID, which the public host resolves through legacyId)')
  }
  if (parsed.pathname === '/' || parsed.pathname === '') return { action: 'rewrite', url: `/${hash}` }
  const m = /^\/([^/]+)\/?$/.exec(parsed.pathname)
  if (!m) return keepUnmapped('not a single-segment article address (/<slug>/)')
  let segment = m[1]
  try {
    segment = decodeURIComponent(segment)
  } catch {
    // keep the raw segment
  }
  if (segment.includes('/') || RESERVED_WP_PATHS.has(segment.toLowerCase())) {
    return keepUnmapped('reserved WordPress path, not an article')
  }
  const mapped = lookupSlug(opts.slugMap, segment) ?? lookupSlug(opts.slugMap, segment.toLowerCase())
  if (mapped === undefined) return keepUnmapped('slug is not in the slug map')
  const path = opts.articlePath(mapped)
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || UNSAFE_URL_CHARS_RE.test(path)) {
    return keepUnmapped('the article path mapper returned an unsafe path')
  }
  return { action: 'rewrite', url: `${path}${hash}` }
}

/** Plain text of a subtree (iterative, so a very deep tree cannot overflow the stack). */
function textOf(node: unknown): string {
  let out = ''
  const stack: unknown[] = [node]
  while (stack.length > 0) {
    const n = stack.pop()
    if (Array.isArray(n)) {
      for (let i = n.length - 1; i >= 0; i--) stack.push(n[i])
    } else if (isObj(n)) {
      if (typeof n.text === 'string') out += n.text
      if (Array.isArray(n.children)) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i])
    }
  }
  return out
}

const plainTextNode = (text: string) => ({ type: 'text', text, format: 0, detail: 0, mode: 'normal', style: '', version: 1 })

/**
 * Walk a serialized Lexical tree (`{ root }` or the root node itself) and make every link safe (contract C1.5):
 * only `http:`, `https:`, `mailto:` and root-relative links survive; an absolute link to the old hosts whose path is
 * a plain article address `/<slug>/` found in the slug map is rewritten to the new root-relative article path;
 * everything else (`javascript:`, `data:`, relative without a slash, protocol-relative `//x`, credentials in the URL,
 * empty) is replaced by the link's plain text children. Old-host links that are not a plain mapped article address
 * (`?p=ID`, `/category/news/`, dated permalinks, media, unknown slugs) stay as written and are listed in
 * `report.unmapped` with the reason.
 *
 * Every URL a link node carries is checked (`fields.url`, top-level `url` and `href`); one unsafe value converts the
 * node. A subtree nested deeper than `LINK_WALK_MAX_DEPTH` is flattened to plain text and reported in
 * `report.converted`, never passed through unchecked. Other nodes are never touched, and the input is not mutated
 * (a deep copy is returned). Internal (document) links carry no URL and are left as they are.
 */
export function sanitizeLegacyLinks<T>(root: T, opts: LinkOptions): { root: T; report: LinkReport } {
  const report: LinkReport = { rewritten: 0, unmapped: [], converted: [] }
  const copy = structuredClone(root)

  const walkChildren = (children: unknown[], depth: number): unknown[] => {
    const out: unknown[] = []
    for (const child of children) {
      if (!isObj(child)) {
        out.push(child)
        continue
      }
      if (depth > LINK_WALK_MAX_DEPTH && child.type !== 'text') {
        const text = textOf(child)
        report.converted.push({ url: '', reason: `nested deeper than ${LINK_WALK_MAX_DEPTH} levels; flattened to plain text` })
        if (text !== '') out.push(plainTextNode(text))
        continue
      }
      const isLink = child.type === 'link' || child.type === 'autolink'
      if (Array.isArray(child.children)) child.children = walkChildren(child.children, depth + 1)
      if (!isLink) {
        out.push(child)
        continue
      }

      const fields = isObj(child.fields) ? child.fields : undefined
      // Every place a URL can live on this node.
      const slots: { holder: Json; key: string }[] = []
      if (fields && fields.url !== undefined && fields.url !== null) slots.push({ holder: fields, key: 'url' })
      for (const key of ['url', 'href']) if (child[key] !== undefined && child[key] !== null) slots.push({ holder: child, key })

      if (slots.length === 0) {
        if (fields?.linkType === 'internal') {
          out.push(child)
        } else {
          report.converted.push({ url: '', reason: 'link without a URL' })
          if (Array.isArray(child.children)) out.push(...child.children)
        }
        continue
      }

      const decisions = slots.map((s) => {
        const value = s.holder[s.key]
        return typeof value === 'string'
          ? { slot: s, raw: value, decision: decide(value, opts, report) }
          : { slot: s, raw: '', decision: { action: 'text', reason: 'link URL is not a string' } as Decision }
      })
      const bad = decisions.find((d) => d.decision.action === 'text')
      if (bad) {
        report.converted.push({ url: bad.raw, reason: (bad.decision as { reason: string }).reason })
        if (Array.isArray(child.children)) out.push(...child.children)
        continue
      }
      let rewrote = false
      for (const d of decisions) {
        if (d.decision.action === 'rewrite') {
          d.slot.holder[d.slot.key] = d.decision.url
          rewrote = true
        }
      }
      if (rewrote) report.rewritten++
      out.push(child)
    }
    return out
  }

  const top = isObj(copy) && isObj((copy as Json).root) ? ((copy as Json).root as Json) : copy
  if (isObj(top) && Array.isArray(top.children)) top.children = walkChildren(top.children, 0)
  return { root: copy, report }
}
