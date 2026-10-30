/**
 * Waves 1-2 newsroom fields (docs/w12/schema-contract.md): limits, option lists and pure validators shared by the
 * collections (Articles, Authors, Topics), the Lexical blocks (pull quote, gallery) and the public endpoints. Pure: no
 * Payload imports, so unit tests and the newsroom app's mirror can check the same rules.
 */

export const KICKER_MAX = 60
export const KEY_POINTS_MAX = 5
export const KEY_POINT_MAX = 200
export const CONTENT_TYPES = ['news', 'analysis', 'opinion', 'sponsored', 'explainer', 'factcheck'] as const
export type ContentType = (typeof CONTENT_TYPES)[number]
export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  news: 'News',
  analysis: 'Analysis',
  opinion: 'Opinion',
  sponsored: 'Sponsored',
  explainer: 'Explainer',
  factcheck: 'Fact-check',
}
export const DEFAULT_CONTENT_TYPE: ContentType = 'news'
/** Legacy rows (null) and unknown values read as `news`. */
export const contentTypeOf = (value: unknown): ContentType =>
  (CONTENT_TYPES as readonly unknown[]).includes(value) ? (value as ContentType) : DEFAULT_CONTENT_TYPE

export const TOPICS_PER_ARTICLE_MAX = 10

export const AUTHOR_NAME_MAX = 120
export const AUTHOR_ROLE_MAX = 120
export const AUTHOR_BIO_MAX = 600
export const AUTHOR_SOCIALS_MAX = 6
export const AUTHOR_SOCIAL_KINDS = ['x', 'facebook', 'instagram', 'linkedin', 'website'] as const
export const SOCIAL_URL_MAX = 300

export const TOPIC_NAME_MAX = 80
export const TOPIC_DESCRIPTION_MAX = 400
export const TOPIC_KINDS = ['topic', 'denomination', 'series', 'ministry'] as const

export const SLUG_MAX = 80
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const PULL_QUOTE_BLOCK_SLUG = 'pullQuote'
export const PULL_QUOTE_MAX = 400
export const PULL_QUOTE_ATTRIBUTION_MAX = 120
export const GALLERY_BLOCK_SLUG = 'gallery'
export const GALLERY_IMAGES_MAX = 12
export const GALLERY_CAPTION_MAX = 300

export const LQIP_MAX = 1500

/** `lastSubstantiveUpdate` may be at most this far in the future (clock skew between the editor's device and the server). */
export const UPDATE_STAMP_FUTURE_SKEW_MS = 10 * 60 * 1000

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/
// eslint-disable-next-line no-control-regex
const CONTROL_SINGLE_LINE_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/

/**
 * A message when a plain-text value is unacceptable, else null. Empty and absent are fine unless `required`.
 * Plain text means no `<` / `>` (markup) and no control characters (newlines only when `multiline`).
 */
export function plainTextProblem(
  value: unknown,
  label: string,
  max: number,
  { required = false, multiline = false }: { required?: boolean; multiline?: boolean } = {},
): string | null {
  if (value === undefined || value === null || value === '') return required ? `${label} is required.` : null
  if (typeof value !== 'string') return `${label} must be plain text.`
  if (required && value.trim() === '') return `${label} is required.`
  if (value.length > max) return `${label} must be at most ${max} characters.`
  if (/[<>]/.test(value) || (multiline ? CONTROL_RE : CONTROL_SINGLE_LINE_RE).test(value)) {
    return `${label} must be plain text (no markup or control characters).`
  }
  return null
}

/** Payload field validator built from `plainTextProblem`. */
export const plainTextValidator =
  (label: string, max: number, opts: { required?: boolean; multiline?: boolean } = {}) =>
  (value: unknown): true | string =>
    plainTextProblem(value, label, max, opts) ?? true

export const slugValidator = (value: unknown): true | string => {
  if (typeof value !== 'string' || value === '') return 'Slug is required.'
  if (value.length > SLUG_MAX) return `Slug must be at most ${SLUG_MAX} characters.`
  return SLUG_RE.test(value) ? true : 'Slug must be lowercase letters, numbers and single hyphens.'
}

/** https (or http) address without credentials, whitespace or quotes; at most SOCIAL_URL_MAX characters. */
export function isSafeProfileUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value === '' || value.length > SOCIAL_URL_MAX) return false
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001F\u007F-\u009F<>"'\\`]/.test(value)) return false
  try {
    const u = new URL(value)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && u.hostname.includes('.')
  } catch {
    return false
  }
}

/** Key points: at most 5 rows, each 1-200 characters of single-line plain text. Returns a message or null. */
export function keyPointsProblem(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) return 'Key points must be a list.'
  if (value.length > KEY_POINTS_MAX) return `At most ${KEY_POINTS_MAX} key points.`
  for (const row of value) {
    const text = row && typeof row === 'object' ? (row as { text?: unknown }).text : undefined
    const p = plainTextProblem(text, 'Each key point', KEY_POINT_MAX, { required: true })
    if (p) return p
  }
  return null
}

/** The comparable value of key points: the texts in order (row ids are irrelevant). */
export const keyPointTexts = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((r) => String((r as { text?: unknown } | null)?.text ?? '')) : []

/** `lastSubstantiveUpdate`: a real date, not in the future (beyond a small skew). Empty is fine. */
export function updateStampProblem(value: unknown, now = Date.now()): string | null {
  if (value === undefined || value === null || value === '') return null
  const t = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(t)) return 'The "Updated" date must be a valid date.'
  if (t > now + UPDATE_STAMP_FUTURE_SKEW_MS) return 'The "Updated" date cannot be in the future.'
  return null
}

/** A tiny blur placeholder: a base64 `data:image/(webp|png|jpeg)` URI of at most LQIP_MAX characters. */
export function isValidLqip(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length <= LQIP_MAX &&
    /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
}

/** Reading time the public layer shows (not stored): words / 220, at least 1 minute. */
export const readingMinutes = (words: number): number => Math.max(1, Math.round((Number.isFinite(words) ? words : 0) / 220))
