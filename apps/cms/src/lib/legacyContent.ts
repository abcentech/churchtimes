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
 * Keep each WordPress `post_name` when it is a valid slug and not yet taken (by `existingSlugs` or by an earlier
 * item of the batch); otherwise rename it `-2`, `-3`, ... (an invalid slug is first normalised). Items are handled in
 * the order given, so the earliest keeps the plain slug. Returns the items (same order, `slug` replaced) and the
 * list of `{ old, new }` pairs for the QA report and the redirect map. Inputs are not mutated.
 */
export function resolveSlugCollisions<T extends SlugItem>(
  items: readonly T[],
  existingSlugs: Iterable<string> = [],
): { items: T[]; renamed: SlugRename[] } {
  const taken = new Set<string>(existingSlugs)
  const renamed: SlugRename[] = []
  const out: T[] = []

  for (const item of items) {
    const original = typeof item.slug === 'string' ? item.slug : ''
    let chosen: string
    if (isValidSlug(original) && !taken.has(original)) {
      chosen = original
    } else {
      const base = (isValidSlug(original) ? original : slugifyText(original) || slugifyText(item.title ?? '')) || 'article'
      chosen = base
      // A normalised invalid slug that is free keeps its normalised form; otherwise -2, -3, ...
      for (let n = 2; taken.has(chosen); n++) {
        const suffix = `-${n}`
        chosen = base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '') + suffix
      }
      renamed.push({ old: original, new: chosen })
    }
    taken.add(chosen)
    out.push({ ...item, slug: chosen })
  }
  return { items: out, renamed }
}

// ---------------------------------------------------------------------------------------------
// C1.3 shortcodes
// ---------------------------------------------------------------------------------------------

/** Bare shortcodes WordPress core and common form/gallery plugins register; a bare lowercase word in brackets is
 * otherwise left alone because editors use `[sic]` and `[laughs]` in real copy. */
const COMMON_BARE_SHORTCODES = new Set([
  'gallery',
  'caption',
  'audio',
  'video',
  'playlist',
  'embed',
  'wpforms',
  'contact-form-7',
  'gravityform',
  'ninja_form',
  'mailchimp',
  'newsletter',
  'form',
])

// `[tag attrs]`, `[tag attrs /]`, `[/tag]`. Tag names follow the WordPress convention (a letter first).
const SHORTCODE_RE = /\[(\/?)([A-Za-z][A-Za-z0-9_-]*)((?:\s[^\[\]]*)?)\/?\]/g

export type ShortcodeReport = { text: string; removed: string[]; count: number }

/**
 * Remove WordPress shortcodes (`[tag ...]` and `[/tag]`) from plain text and report the distinct tag names that
 * were removed (first-seen order) plus the number of removed markers. A shortcode is removed when it is a closing
 * tag, has attributes (`[caption id="x"]`), has a plugin-style name (contains `_`, `-` or a digit, e.g.
 * `[penci_slider]`), or is one of the well-known bare tags (`[gallery]`) or one of `options.knownTags`. A bare
 * lowercase word such as `[sic]` or `[laughs]`, an `[Editor's note]` and a bare footnote `[1]` stay: they are
 * editorial text, not code. A form shortcode is never rendered or executed; removing it is all that is done.
 */
export function stripShortcodes(text: string, options: { knownTags?: readonly string[] } = {}): ShortcodeReport {
  if (typeof text !== 'string' || text.indexOf('[') === -1) return { text: typeof text === 'string' ? text : '', removed: [], count: 0 }
  const known = new Set([...COMMON_BARE_SHORTCODES, ...(options.knownTags ?? []).map((t) => t.toLowerCase())])
  const removed: string[] = []
  let count = 0
  const stripped = text.replace(SHORTCODE_RE, (match, closing: string, name: string, attrs: string) => {
    const lower = name.toLowerCase()
    const isCode =
      closing === '/' ||
      /[A-Za-z0-9_-]+\s*=/.test(attrs) ||
      (name === lower && /[_\d-]/.test(name)) ||
      known.has(lower)
    if (!isCode) return match
    count++
    if (!removed.includes(lower)) removed.push(lower)
    return ''
  })
  if (count === 0) return { text, removed, count }
  return { text: stripped.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim(), removed, count }
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
  /** Host names of the old site (`old.example.test`); matching ignores case and a leading `www.`. */
  oldHosts: readonly string[]
  /** Old WordPress slug -> new slug. */
  slugMap: ReadonlyMap<string, string> | Readonly<Record<string, string>>
  /** The new root-relative path of an article, e.g. `(slug) => '/article/' + slug`. Must return a path starting `/`. */
  articlePath: (slug: string) => string
}

export type LinkReport = {
  rewritten: number
  /** Links to the old host whose target is not in the slug map (media, unknown posts); kept as written. */
  unmapped: string[]
  /** Links turned into plain text, with the reason. */
  converted: { url: string; reason: string }[]
}

const MAX_DEPTH = 64
const hostKey = (h: string) => h.toLowerCase().replace(/^www\./, '')

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

type Decision = { action: 'keep' } | { action: 'rewrite'; url: string } | { action: 'text'; reason: string }

function lookupSlug(map: LinkOptions['slugMap'], key: string): string | undefined {
  if (map instanceof Map) return map.get(key)
  return Object.prototype.hasOwnProperty.call(map, key) ? (map as Record<string, string>)[key] : undefined
}

// eslint-disable-next-line no-control-regex
const UNSAFE_URL_CHARS_RE = /[\u0000- \u007F-\u009F\\]/

function decide(raw: string, opts: LinkOptions, report: LinkReport): Decision {
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

  // A link to the old site: rewrite to the new article path through the slug map.
  let segments: string[] = []
  try {
    segments = parsed.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase())
  } catch {
    segments = []
  }
  if (segments.length === 0) {
    return { action: 'rewrite', url: `/${parsed.hash && !UNSAFE_URL_CHARS_RE.test(parsed.hash) ? parsed.hash : ''}` }
  }
  if (segments[0] === 'wp-content') {
    report.unmapped.push(url)
    return { action: 'keep' }
  }
  const mapped = lookupSlug(opts.slugMap, segments[segments.length - 1])
  if (mapped === undefined) {
    report.unmapped.push(url)
    return { action: 'keep' }
  }
  const path = opts.articlePath(mapped)
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || UNSAFE_URL_CHARS_RE.test(path)) {
    report.unmapped.push(url)
    return { action: 'keep' }
  }
  const hash = parsed.hash && !UNSAFE_URL_CHARS_RE.test(parsed.hash) ? parsed.hash : ''
  return { action: 'rewrite', url: `${path}${hash}` }
}

/**
 * Walk a serialized Lexical tree (`{ root }` or the root node itself) and make every link safe (contract C1.5):
 * only `http:`, `https:`, `mailto:` and root-relative links survive; absolute links to the old hosts are rewritten
 * through the slug map to the new root-relative article path; everything else (`javascript:`, `data:`, relative
 * without a slash, protocol-relative `//x`, credentials in the URL, empty) is replaced by the link's plain text
 * children. Other nodes are never touched, and the input is not mutated (a deep copy is returned). Internal
 * (document) links carry no URL and are left as they are.
 */
export function sanitizeLegacyLinks<T>(root: T, opts: LinkOptions): { root: T; report: LinkReport } {
  const report: LinkReport = { rewritten: 0, unmapped: [], converted: [] }
  const copy = structuredClone(root)

  const walkChildren = (children: unknown[], depth: number): unknown[] => {
    const out: unknown[] = []
    for (const child of children) {
      if (!isObj(child) || depth > MAX_DEPTH) {
        out.push(child)
        continue
      }
      const isLink = child.type === 'link' || child.type === 'autolink'
      if (Array.isArray(child.children)) child.children = walkChildren(child.children, depth + 1)
      if (!isLink) {
        out.push(child)
        continue
      }
      const fields = isObj(child.fields) ? child.fields : undefined
      const rawUrl = typeof fields?.url === 'string' ? fields.url : typeof child.url === 'string' ? child.url : undefined
      if (rawUrl === undefined) {
        if (fields?.linkType === 'internal') {
          out.push(child)
        } else {
          report.converted.push({ url: '', reason: 'link without a URL' })
          if (Array.isArray(child.children)) out.push(...child.children)
        }
        continue
      }
      const decision = decide(rawUrl, opts, report)
      if (decision.action === 'keep') {
        out.push(child)
      } else if (decision.action === 'rewrite') {
        if (fields && typeof fields.url === 'string') fields.url = decision.url
        if (typeof child.url === 'string') child.url = decision.url
        report.rewritten++
        out.push(child)
      } else {
        report.converted.push({ url: rawUrl, reason: decision.reason })
        if (Array.isArray(child.children)) out.push(...child.children)
      }
    }
    return out
  }

  const top = isObj(copy) && isObj((copy as Json).root) ? ((copy as Json).root as Json) : copy
  if (isObj(top) && Array.isArray(top.children)) top.children = walkChildren(top.children, 0)
  return { root: copy, report }
}
