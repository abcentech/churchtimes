/**
 * Helpers for the staff-only `media.legacyPath` field (go-live contract C1.2): the original WordPress upload
 * path (for example `2023/10/photo.jpg`), kept so old `/wp-content/uploads/...` addresses can be mapped.
 * Pure: no I/O.
 */

export const LEGACY_PATH_MAX = 500
export const ALT_MAX = 300

const UPLOADS_MARKER = '/wp-content/uploads/'

// eslint-disable-next-line no-control-regex
const BAD_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\\?#]/

/**
 * Normalise a path after the uploads folder: percent-decoded once, duplicate slashes collapsed, no leading or
 * trailing slash. `null` for an empty result, a `..`/`.` segment, a control character, a backslash, `?` or `#`.
 */
function normalisePath(raw: string): string | null {
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // keep the raw text; the checks below still apply
  }
  if (BAD_CHARS_RE.test(decoded)) return null
  const segments = decoded.split('/').filter((s) => s !== '')
  if (segments.length === 0) return null
  if (segments.some((s) => s === '.' || s === '..')) return null
  const path = segments.join('/')
  return path.length > LEGACY_PATH_MAX ? null : path
}

/**
 * The path after `/wp-content/uploads/` of an absolute, protocol-relative or root-relative URL (query and
 * fragment dropped), or `null` when the URL has no uploads folder or the remainder is unusable.
 * `https://old.example.test/wp-content/uploads/2023/10/photo-300x200.jpg?x=1` -> `2023/10/photo-300x200.jpg`.
 */
export function legacyPathFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  if (trimmed === '') return null
  const withoutQuery = trimmed.split('#')[0].split('?')[0]
  const at = withoutQuery.toLowerCase().indexOf(UPLOADS_MARKER)
  if (at === -1) return null
  return normalisePath(withoutQuery.slice(at + UPLOADS_MARKER.length))
}

const SIZE_SUFFIX_RE = /^(.+)-\d{1,5}x\d{1,5}(\.[A-Za-z0-9]+)$/

/**
 * Remove a WordPress thumbnail size suffix (`-300x200`) that sits directly before the extension of the file name.
 * Never touches other names: `photo-2020.jpg`, `300x200.jpg` and `photo-300x200` (no extension) stay as they are.
 */
export function stripSizeSuffix(path: string): string {
  const slash = path.lastIndexOf('/')
  const dir = path.slice(0, slash + 1)
  const name = path.slice(slash + 1)
  const m = SIZE_SUFFIX_RE.exec(name)
  return m ? `${dir}${m[1]}${m[2]}` : path
}

/** True for a value acceptable in `media.legacyPath`: already normalised and relative to the uploads folder. */
export function isValidLegacyPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    normalisePath(value) === value &&
    !value.toLowerCase().startsWith('wp-content/')
  )
}

export type AltSource = 'alt' | 'caption' | 'title'

const oneLine = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/**
 * Alt text for a legacy image: its own alt, else its caption, else `<article title> photo`, trimmed to 300
 * characters. `source` lets the importer flag the substituted ones in the QA report.
 */
export function resolveAlt(input: { alt?: unknown; caption?: unknown; articleTitle?: unknown }): {
  alt: string
  source: AltSource
} {
  const alt = oneLine(input.alt)
  if (alt) return { alt: alt.slice(0, ALT_MAX).trim(), source: 'alt' }
  const caption = oneLine(input.caption)
  if (caption) return { alt: caption.slice(0, ALT_MAX).trim(), source: 'caption' }
  const title = oneLine(input.articleTitle)
  return { alt: (title ? `${title} photo` : 'Photo').slice(0, ALT_MAX).trim(), source: 'title' }
}

export const altFallback = (input: { alt?: unknown; caption?: unknown; articleTitle?: unknown }): string =>
  resolveAlt(input).alt
