import { cleanText } from './sanitize'

/**
 * Legacy comments archive (go-live contract C6): pure helpers shared by the collection hooks, the public endpoint and
 * the importer. Nothing here touches the database.
 *
 * Data minimisation: the output of `toLegacyCommentData` is an allowlist (article, authorName, content, commentedAt,
 * legacyId, parentLegacyId, status). A commenter email, website or IP in the parsed WXR comment is never copied, never
 * logged and never returned, not even in a "skipped" result.
 */

export const COMMENT_NAME_MAX = 120
export const COMMENT_CONTENT_MAX = 5000
export const ANONYMOUS_NAME = 'Anonymous'
export const EMAIL_REDACTED = '[email removed]'

/** A comment as the WXR parser (importer) hands it over. Every field is untrusted and may be missing. */
export type WxrComment = {
  /** `wp:comment_id` */
  id?: unknown
  /** `wp:comment_author` */
  author?: unknown
  /** `wp:comment_content` (may contain HTML and entities) */
  content?: unknown
  /** `wp:comment_date_gmt` (preferred) */
  dateGmt?: unknown
  /** `wp:comment_date` (site-local time; used only when the GMT value is missing or zero) */
  date?: unknown
  /** `wp:comment_approved`: `1`, `0`, `spam`, `trash` */
  approved?: unknown
  /** `wp:comment_type`: empty or `comment` for a real comment; `pingback`, `trackback`, ... */
  type?: unknown
  /** `wp:comment_parent` (0 = top level) */
  parent?: unknown
  // Present in an export but deliberately ignored (never copied): authorEmail, authorUrl, authorIp.
  authorEmail?: unknown
  authorUrl?: unknown
  authorIp?: unknown
  [key: string]: unknown
}

export type LegacyCommentData = {
  article: number | string
  authorName: string
  content: string
  commentedAt: string
  legacyId: number
  parentLegacyId: number | null
  status: 'approved'
}

export type SkipReason =
  | 'unapproved'
  | 'spam'
  | 'trash'
  | 'pingback'
  | 'trackback'
  | 'other-type'
  | 'bad-id'
  | 'bad-date'
  | 'empty'

export type LegacyCommentResult =
  | { ok: true; data: LegacyCommentData; truncated: boolean; dateFromLocal: boolean }
  | { ok: false; reason: SkipReason }

const EMAIL_RE = /[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[^\s@<>()[\]\\,;:"']+/g
const URL_RE = /^(?:https?:\/\/|www\.)\S+$/i

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", nbsp: ' ' }

/**
 * Decode the entities WordPress commonly leaves in comment text. `&lt;` and `&gt;` are deliberately NOT decoded, and
 * numeric references to `<` and `>` are left as written, so the result can never contain markup that a careless
 * consumer might render as HTML.
 */
function decodeEntities(input: string): string {
  return input.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (whole, dec, hex, name) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole
    const cp = dec ? Number(dec) : parseInt(hex, 16)
    if (!Number.isFinite(cp) || cp < 0x20 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0x3c || cp === 0x3e) {
      return whole
    }
    return String.fromCodePoint(cp)
  })
}

/**
 * Remove lone surrogates (which break JSON consumers and PostgreSQL), the Unicode noncharacters, and the invisible
 * bidirectional controls (U+200B zero-width space, U+200E-200F direction marks, U+202A-202E embeddings and overrides, U+2060-2069
 * and U+FEFF), which can be used to make a name or a text read differently from what it is.
 */
function wellFormed(input: string): string {
  return input
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[\u{FDD0}-\u{FDEF}\u{FFFE}\u{FFFF}\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2069}\u{FEFF}]/gu, '')
}

/** Cut at a code-point boundary (never in the middle of a surrogate pair). */
function cutAt(input: string, max: number): string {
  if (input.length <= max) return input
  let end = max
  const code = input.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return input.slice(0, end).trim()
}

const RAW_BOUND = 200_000

export type CleanedContent = { text: string; truncated: boolean }

/** Plain text only: no HTML, entities decoded (except angle brackets), emails redacted, at most 5,000 characters. */
export function cleanCommentContent(value: unknown): CleanedContent {
  if (typeof value !== 'string') return { text: '', truncated: false }
  // Bound the work done on a hostile value before any regex runs; the real cap is applied after cleaning.
  const bounded = value.length > RAW_BOUND ? value.slice(0, RAW_BOUND) : value
  const stripped = cleanText(wellFormed(bounded), { multiline: true })
  const decoded = wellFormed(decodeEntities(stripped))
  const redacted = decoded.replace(EMAIL_RE, EMAIL_REDACTED)
  const text = cutAt(redacted, COMMENT_CONTENT_MAX)
  return { text, truncated: redacted.length > COMMENT_CONTENT_MAX || value.length > bounded.length }
}

/**
 * Plain text for output when the stored value was already cleaned at write time: strips markup, control characters
 * and bad unicode, and caps the length, but does not decode entities a second time.
 */
export function plainTextForOutput(value: unknown): string {
  if (typeof value !== 'string') return ''
  const bounded = value.length > RAW_BOUND ? value.slice(0, RAW_BOUND) : value
  return cutAt(wellFormed(cleanText(wellFormed(bounded), { multiline: true })), COMMENT_CONTENT_MAX)
}

/**
 * One line, at most 120 characters. A name that is an email address or a web address is replaced (an anonymous
 * commenter's address must not become public through the name field); an empty name becomes "Anonymous".
 */
export function cleanCommentAuthorName(value: unknown): string {
  if (typeof value !== 'string') return ANONYMOUS_NAME
  const bounded = value.length > 2000 ? value.slice(0, 2000) : value
  const name = cutAt(wellFormed(decodeEntities(cleanText(wellFormed(bounded)))), COMMENT_NAME_MAX)
  if (name === '' || URL_RE.test(name) || name.includes('@')) return ANONYMOUS_NAME
  return name
}

/** `2019-03-04 10:11:12` (WordPress, no zone, read as UTC) or ISO-8601. Returns an ISO string or null. */
function parseWpDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (v === '' || v.startsWith('0000-00-00')) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(v)
  if (!m && !/^\d{4}-\d{2}-\d{2}T/.test(v)) return null
  const t = new Date(m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : v)
  if (Number.isNaN(t.getTime())) return null
  const year = t.getUTCFullYear()
  if (year < 1990 || year > 2100) return null
  return t.toISOString()
}

const positiveInt = (value: unknown): number | null => {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,12}$/.test(value.trim()) ? Number(value) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

const lower = (v: unknown): string =>
  typeof v === 'string' ? v.trim().toLowerCase() : v === undefined || v === null ? '' : String(v).toLowerCase()

/**
 * Turn one parsed WXR comment into `legacy-comments` data, or say why it is skipped. Only approved, ordinary comments
 * are kept. `articleId` is the CMS id of the already imported article (the importer resolves it; a comment whose article
 * was not imported is skipped and reported by the importer, not here). Emails, websites and IPs are dropped.
 */
export function toLegacyCommentData(comment: WxrComment, articleId: number | string): LegacyCommentResult {
  const approved = lower(comment.approved)
  if (approved === 'spam') return { ok: false, reason: 'spam' }
  if (approved === 'trash') return { ok: false, reason: 'trash' }
  if (approved !== '1' && approved !== 'true') return { ok: false, reason: 'unapproved' }

  const type = lower(comment.type)
  if (type === 'pingback') return { ok: false, reason: 'pingback' }
  if (type === 'trackback') return { ok: false, reason: 'trackback' }
  if (type !== '' && type !== 'comment') return { ok: false, reason: 'other-type' }

  const legacyId = positiveInt(comment.id)
  if (legacyId === null) return { ok: false, reason: 'bad-id' }

  const gmt = parseWpDate(comment.dateGmt)
  const commentedAt = gmt ?? parseWpDate(comment.date)
  if (commentedAt === null) return { ok: false, reason: 'bad-date' }

  const content = cleanCommentContent(comment.content)
  if (content.text === '') return { ok: false, reason: 'empty' }

  const parent = positiveInt(comment.parent)
  return {
    ok: true,
    truncated: content.truncated,
    dateFromLocal: gmt === null,
    data: {
      article: articleId,
      authorName: cleanCommentAuthorName(comment.author),
      content: content.text,
      commentedAt,
      legacyId,
      parentLegacyId: parent !== null && parent !== legacyId ? parent : null,
      status: 'approved',
    },
  }
}

/** The only shape ever sent to anonymous callers. */
export type PublicComment = {
  id: number
  legacyId: number | null
  parentLegacyId: number | null
  authorName: string
  commentedAt: string | null
  content: string
}

export function toPublicComment(doc: Record<string, unknown>): PublicComment {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    id: Number(doc.id),
    legacyId: num(doc.legacyId),
    parentLegacyId: num(doc.parentLegacyId),
    authorName: typeof doc.authorName === 'string' ? doc.authorName : ANONYMOUS_NAME,
    commentedAt: typeof doc.commentedAt === 'string' ? doc.commentedAt : null,
    content: plainTextForOutput(doc.content),
  }
}
