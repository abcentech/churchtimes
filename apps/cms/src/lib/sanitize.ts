/**
 * Plain-text sanitising helpers. Output is always plain text (never rendered as HTML by this
 * service), so we strip markup rather than escape it, and decode no entities.
 */

export type CleanTextOptions = {
  /** Maximum length. Longer values are truncated. Use `exceedsMax` to report instead. */
  max?: number
  /** Keep \n and \t (and collapse >2 blank lines). Default false: everything becomes one line. */
  multiline?: boolean
}

// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g
// eslint-disable-next-line no-control-regex
const CONTROL_KEEP_NL_TAB = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g

/** Remove script/style/etc. elements with their contents, comments, then any remaining tags. */
export function stripHtml(input: string): string {
  let out = input
  // Repeat until stable so nested payloads like "<scr<script></script>ipt>" cannot reassemble.
  for (let i = 0; i < 5; i++) {
    const before = out
    out = out
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
      .replace(/<\/?[a-zA-Z!?][^>]*(?:>|$)/g, '')
    if (out === before) break
  }
  return out
}

export function cleanText(value: unknown, options: CleanTextOptions = {}): string {
  if (typeof value !== 'string') return ''
  const { max, multiline = false } = options

  let out = stripHtml(value.normalize('NFC')).replace(/\r\n?/g, '\n')

  if (multiline) {
    out = out.replace(CONTROL_KEEP_NL_TAB, '')
    out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  } else {
    out = out.replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ')
  }
  out = out.trim()

  if (typeof max === 'number' && max >= 0 && out.length > max) out = out.slice(0, max).trim()
  return out
}

/** True when the cleaned (untruncated) text is longer than max. */
export function exceedsMax(value: unknown, max: number, multiline = false): boolean {
  return cleanText(value, { multiline }).length > max
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

export function isValidEmail(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.length > 254) return false
  const [local] = value.split('@')
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || value.includes('..')) {
    return false
  }
  return EMAIL_RE.test(value)
}

/** ASCII slug matching ^[a-z0-9]+(?:-[a-z0-9]+)*$ (never empty: falls back to `fallback`). */
export function slugify(title: string, maxLen = 150, fallback = 'item'): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '')
  return base || fallback
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
