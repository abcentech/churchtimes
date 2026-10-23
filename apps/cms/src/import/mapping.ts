import { cleanText } from '../lib/sanitize'
import { hasTemplateVariable } from '../lib/seoFields'
import type { Classification } from './categoryRules'
import type { WxrTerm } from './wxr'

/**
 * Pure mapping rules for the loader (no database, no network). Unit tested in tests/unit/importMapping.test.ts.
 */

const GENERIC_CATEGORY_SLUGS = new Set(['uncategorised', 'uncategorized'])

export type CategoryChoice = {
  /** The term that becomes `Articles.category` (undefined: none usable, the fallback category is used). */
  primary: WxrTerm | undefined
  /** WordPress categories on the post that the schema cannot hold (Articles.category is ONE required relationship). */
  dropped: number
}

/**
 * Articles has a single required `category`, so only one WordPress category can be kept. The primary is the first
 * listed category with a name, skipping WordPress's generic "Uncategorised" when a real one exists. The rest are counted.
 */
export function chooseCategory(terms: readonly WxrTerm[]): CategoryChoice {
  const usable = terms.filter((c) => c.nicename)
  const seen = new Set<string>()
  const distinct = usable.filter((c) => (seen.has(c.nicename) ? false : (seen.add(c.nicename), true)))
  const primary = distinct.find((c) => !GENERIC_CATEGORY_SLUGS.has(c.nicename.toLowerCase())) ?? distinct[0]
  return { primary, dropped: Math.max(0, distinct.length - (primary ? 1 : 0)) }
}

export type AuthorByline = { byline: string; /** Stable key for counting distinct authors (never printed). */ key: string }

/**
 * `wp:creator` to a byline TEXT only. No user account is ever created or matched. The channel display name is
 * preferred, the login is the fallback. A name that is (or contains) an email address becomes empty.
 */
export function bylineFor(creator: string, displayName: string | undefined, clean: (s: string) => string): AuthorByline | null {
  const key = creator.trim().toLowerCase()
  if (!key) return null
  const fromDisplay = clean(displayName ?? '')
  return { key, byline: fromDisplay || clean(creator) }
}

const MAX_LEGACY_URL = 1000
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000- \u007f\<>"'`]/

/**
 * The old WordPress permalink for `Articles.legacyUrl`: a same-site path ("/2024/05/story/") or an http(s) URL, with
 * the query string and fragment removed. Anything else (other schemes, protocol-relative, credentials, spaces,
 * control characters, or a bare root left after stripping `?p=123`) is refused: undefined.
 */
export function cleanLegacyUrl(link: string): string | undefined {
  const raw = link.trim()
  if (!raw || BAD_CHARS.test(raw)) return undefined
  const noQuery = raw.split('#')[0].split('?')[0]
  let out: string
  if (noQuery.startsWith('/')) {
    if (noQuery.startsWith('//')) return undefined
    out = noQuery
    if (out === '/') return undefined
  } else if (/^https?:\/\//i.test(noQuery)) {
    let url: URL
    try {
      url = new URL(noQuery)
    } catch {
      return undefined
    }
    if (url.username || url.password || !url.hostname) return undefined
    if (url.pathname === '/' || url.pathname === '') return undefined
    out = `${url.protocol}//${url.host}${url.pathname}`
  } else {
    return undefined
  }
  return out.length <= MAX_LEGACY_URL ? out : undefined
}

// ---------------------------------------------------------------------------------------------
// SEO text (Rank Math / Yoast) -> Articles.seoTitle / seoDescription (go-live contract C2)
// ---------------------------------------------------------------------------------------------

export const SEO_SITE_NAME = 'Church Times Nigeria'
export const SEO_SEPARATOR = '-'

const NAMED_ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"' }

/**
 * Decode the character references WordPress leaves in titles and meta values. `<`, `>` and control characters are never
 * produced (`&lt;`, `&#60;` stay as written), so decoding cannot create markup.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g, (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? m
    const cp = dec !== undefined ? Number(dec) : parseInt(hex as string, 16)
    if (!Number.isInteger(cp) || cp < 32 || cp === 60 || cp === 62 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (cp >= 0x7f && cp < 0xa0)) return m
    return String.fromCodePoint(cp)
  })
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function formatDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso ?? '')
  if (!m) return ''
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month} ${m[1]}` : ''
}

export type SeoContext = {
  /** Already plain text. */
  title: string
  categoryName?: string
  dateGmt?: string | null
  /** Already plain text. */
  excerpt?: string
}

export type SeoSyntax = 'yoast' | 'rankmath'
export type SeoOutcome = {
  value: string | undefined
  /** none: nothing there (or only variables that resolved to nothing); dropped: a variable could not be resolved; ok: usable. */
  status: 'none' | 'dropped' | 'ok'
  /** The raw value contained at least one variable (all substituted or removed). */
  hadVariables: boolean
  truncated: boolean
}

const YOAST_VAR_RE = /%%([A-Za-z0-9_]{1,40})%%/g
const RANKMATH_VAR_RE = /%([A-Za-z0-9_]{1,40})(?:\([^%)]{0,60}\))?%/g
const LEFTOVER_RE = /%%|%[A-Za-z0-9_]{1,40}(?:\([^%)]{0,60}\))?%/
const SEP_CHARS = '-\\u2013\\u2014|\\u00b7:'
const SEP_RUN_RE = new RegExp(`(?:\\s{0,3}[${SEP_CHARS}]\\s{1,3}){2,10}`, 'g')
const EDGE_SEP_RE = new RegExp(`^[\\s${SEP_CHARS}]{1,20}|[\\s${SEP_CHARS}]{1,20}$`, 'g')

/** Plain text from untrusted markup: tags stripped, entities decoded, one line. */
export function plainText(html: string, max: number, multiline = false): string {
  return cleanText(decodeEntities(cleanText(html, { multiline })), { max, multiline })
}

function substitute(raw: string, syntax: SeoSyntax, ctx: SeoContext): { text: string; had: boolean } {
  const vars: Record<string, string> = {
    title: ctx.title,
    sitename: SEO_SITE_NAME,
    sep: SEO_SEPARATOR,
    page: '',
    category: ctx.categoryName ?? '',
    primary_category: ctx.categoryName ?? '',
    date: formatDate(ctx.dateGmt),
    excerpt: ctx.excerpt ?? '',
    excerpt_only: ctx.excerpt ?? '',
  }
  let had = false
  const text = raw.replace(syntax === 'yoast' ? YOAST_VAR_RE : RANKMATH_VAR_RE, (_m, name: string) => {
    had = true
    return Object.hasOwn(vars, name.toLowerCase()) ? vars[name.toLowerCase()] : ''
  })
  return { text, had }
}

/**
 * One SEO value (never HTML) to what Articles can hold. Variables are substituted from the post and the site (unknown ones
 * are removed), separators left dangling by a removal are tidied, and a value that still contains a `%%var%%` or `%var%` is
 * dropped. A value over `max` first loses a trailing "- Church Times Nigeria" (the public site adds its own), then is cut at a
 * word boundary with an ellipsis.
 */
export function resolveSeoText(raw: string | null | undefined, syntax: SeoSyntax, ctx: SeoContext, max: number): SeoOutcome {
  if (!raw) return { value: undefined, status: 'none', hadVariables: false, truncated: false }
  if (raw.length > 20_000) return { value: undefined, status: 'dropped', hadVariables: false, truncated: false }
  const { text, had } = substitute(raw, syntax, ctx)
  let out = plainText(text, 4000)
  if (LEFTOVER_RE.test(out) || hasTemplateVariable(out)) return { value: undefined, status: 'dropped', hadVariables: had, truncated: false }
  if (had) out = out.replace(SEP_RUN_RE, ` ${SEO_SEPARATOR} `).replace(EDGE_SEP_RE, '').trim()
  if (out === '') return { value: undefined, status: 'none', hadVariables: had, truncated: false }
  let truncated = false
  if (out.length > max) {
    const suffix = ` ${SEO_SEPARATOR} ${SEO_SITE_NAME}`
    if (out.endsWith(suffix) && out.length - suffix.length > 0) out = out.slice(0, -suffix.length).trim()
  }
  if (out.length > max) {
    truncated = true
    const room = out.slice(0, max - 1)
    const cut = room.lastIndexOf(' ')
    out = `${(cut >= Math.floor(max * 0.6) ? room.slice(0, cut) : room).replace(/[\s,;:.-]{1,20}$/, '')}…`
  }
  return { value: out, status: 'ok', hadVariables: had, truncated }
}

/** A canonical address worth keeping: https, or the same site (a path, or a listed old host). Counted only, never stored. */
export function validCanonical(value: string | null | undefined, siteHosts: readonly string[]): boolean {
  const raw = (value ?? '').trim()
  if (!raw || raw.length > 1000 || BAD_CHARS.test(raw)) return false
  if (raw.startsWith('/')) return !raw.startsWith('//')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.username || url.password || !url.hostname) return false
  return url.protocol === 'https:' || (url.protocol === 'http:' && siteHosts.includes(url.hostname.toLowerCase()))
}

// ---------------------------------------------------------------------------------------------
// Category fallback chain
// ---------------------------------------------------------------------------------------------

export type CategoryStep = 'wordpress' | 'yoast-primary' | 'tag-map' | 'rules' | 'generic' | 'fallback'

export type CategoryChain = {
  step: CategoryStep
  /** The term to use (undefined for `fallback`). */
  term: WxrTerm | undefined
  /** A tag-map target that is not a category of the export: it may be used only if it already exists as a category. */
  mustExist: boolean
  dropped: number
  /** The post names a Yoast primary category that is not among the export's categories. */
  primaryUnresolved: boolean
  /** Rule classifier outcome (rules mode only): the provenance of a `rules` choice, or the low-confidence suggestion left in the fallback. */
  rule?: Classification
}

export type CategorySources = {
  categories: readonly WxrTerm[]
  tags: readonly WxrTerm[]
  /** `_yoast_wpseo_primary_category` (a term id as text). */
  primaryCategory: string | null
  /** Rules mode only: classifies the post's text (lazy, so the strict mode never pays for it). */
  classify?: () => Classification
}

export type CategoryLookups = {
  /** Channel (`wp:category`) term id -> term. */
  byTermId: ReadonlyMap<number, WxrTerm>
  /** Channel category nicename -> term. */
  byNicename: ReadonlyMap<string, WxrTerm>
  /** Allowed tag slug -> category slug, from `--category-map`. Empty when none was given. */
  tagMap: Readonly<Record<string, string>>
}

const isGeneric = (t: WxrTerm): boolean => GENERIC_CATEGORY_SLUGS.has(t.nicename.toLowerCase())

/**
 * Deterministic chain: (1) the post's WordPress categories (a real one; the generic "Uncategorised" only counts if nothing
 * later applies), (2) the Yoast primary category when its term id is a category of the export, (3) the first tag with an entry in
 * the supplied tag-to-category map, (4) only in rules mode: the rule classifier's category when it is confident, (5) the generic
 * category if the post had it, else the configured fallback category.
 */
export function chooseCategoryChain(src: CategorySources, lookups: CategoryLookups): CategoryChain {
  const wp = chooseCategory(src.categories)
  const base = { dropped: wp.dropped, mustExist: false }
  if (wp.primary && !isGeneric(wp.primary)) return { ...base, step: 'wordpress', term: wp.primary, primaryUnresolved: false }
  let primaryUnresolved = false
  const rawPrimary = src.primaryCategory?.trim() ?? ''
  if (rawPrimary) {
    const pid = /^\d{1,10}$/.test(rawPrimary) ? Number(rawPrimary) : null
    const term = pid === null ? undefined : lookups.byTermId.get(pid)
    if (term && term.nicename && !isGeneric(term)) return { ...base, step: 'yoast-primary', term, primaryUnresolved: false }
    if (!term) primaryUnresolved = true
  }
  for (const tag of src.tags) {
    if (!Object.hasOwn(lookups.tagMap, tag.nicename)) continue
    const target = lookups.tagMap[tag.nicename]
    const known = lookups.byNicename.get(target)
    if (known && !isGeneric(known)) return { ...base, step: 'tag-map', term: known, primaryUnresolved }
    return { ...base, step: 'tag-map', term: { nicename: target, name: target }, mustExist: true, primaryUnresolved }
  }
  const rule = src.classify?.()
  if (rule?.confident && rule.category && !GENERIC_CATEGORY_SLUGS.has(rule.category)) {
    const known = lookups.byNicename.get(rule.category)
    if (known && !isGeneric(known)) return { ...base, step: 'rules', term: known, primaryUnresolved, rule }
    return { ...base, step: 'rules', term: { nicename: rule.category, name: rule.category }, mustExist: true, primaryUnresolved, rule }
  }
  if (wp.primary) return { ...base, step: 'generic', term: wp.primary, primaryUnresolved, ...(rule ? { rule } : {}) }
  return { ...base, step: 'fallback', term: undefined, primaryUnresolved, ...(rule ? { rule } : {}) }
}

const CATEGORY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const isCategorySlug = (s: string): boolean => s.length <= 100 && CATEGORY_SLUG_RE.test(s)

/** `--category-map` content: a JSON object of tag slug -> category slug. Anything else is refused (undefined). */
export function parseCategoryMap(text: string): Record<string, string> | undefined {
  if (text.length > 1_000_000) return undefined
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const entries = Object.entries(data as Record<string, unknown>)
  if (entries.length > 10_000) return undefined
  const out: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || k.length > 200 || k === '__proto__' || !isCategorySlug(v)) return undefined
    out[k] = v
  }
  return out
}
