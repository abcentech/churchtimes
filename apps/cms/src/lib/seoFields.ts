import { cleanText } from './sanitize'

/**
 * Optional search-engine fields on articles (go-live contract C2).
 *
 * Both are plain text. Markup and control characters are stripped on write; an empty result is stored as
 * `null` so "unset" has one representation. Template variables such as `%title%` or `%sitename%` (Rank Math's
 * placeholders) are refused: the public site builds its own title pattern, so a stored variable would be shown
 * to searchers literally.
 */

export const SEO_TITLE_MAX = 70
export const SEO_DESCRIPTION_MAX = 200

export const SEO_FIELDS = {
  seoTitle: { label: 'SEO title', max: SEO_TITLE_MAX },
  seoDescription: { label: 'SEO description', max: SEO_DESCRIPTION_MAX },
} as const

export type SeoFieldKey = keyof typeof SEO_FIELDS
export const SEO_FIELD_KEYS = Object.keys(SEO_FIELDS) as SeoFieldKey[]

const TEMPLATE_VARIABLE_RE = /%[a-z0-9_]+(?:\([^%)]*\))?%/i

/** True when the text contains a `%variable%` placeholder (used by the validator and by the importer). */
export const hasTemplateVariable = (text: string): boolean => TEMPLATE_VARIABLE_RE.test(text)

/**
 * Clean one SEO value from client input.
 * - `undefined`, `null`, empty or whitespace/markup-only -> `null`
 * - a string -> single-line plain text
 * - anything else (number, object, array) -> `'invalid'`, so the caller can answer 400
 */
export function cleanSeoValue(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return 'invalid'
  const cleaned = cleanText(value)
  return cleaned === '' ? null : cleaned
}

/** Field-level message, or `true` when the value is acceptable. Used as the Payload field `validate`. */
export function seoFieldValidator(key: SeoFieldKey) {
  const { label, max } = SEO_FIELDS[key]
  return (value: unknown): true | string => {
    if (value === undefined || value === null || value === '') return true
    if (typeof value !== 'string') return `${label} must be plain text.`
    if (value.length > max) return `${label} must be at most ${max} characters.`
    if (hasTemplateVariable(value)) {
      return `${label} cannot contain template variables such as %title% or %sitename%.`
    }
    return true
  }
}
