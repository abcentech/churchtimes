/**
 * Canonical redirect paths (go-live contract C7.1). THE single normalisation contract for the redirect list.
 *
 * Pure, dependency-free and deliberately small so that the CMS and the public host apply the SAME function (the public
 * host copies or imports it and runs `normalizeRequestPath` on the raw request target before the lookup). Test vectors
 * for both sides are in `tests/fixtures/redirect-normalisation.json`. The canonical form of a path is:
 *
 * - a leading `/`, and a trailing `/` for directory-style paths (last segment without a file extension);
 * - each segment is decoded from UTF-8 (percent escapes and raw characters alike), Unicode NFC-normalised, and
 *   re-encoded: every character other than the RFC 3986 "unreserved" set (`A-Z a-z 0-9 - . _ ~`) and the `/`
 *   separator becomes UTF-8 percent-encoding with UPPER-case hex. So `/café/`, `/cafe%CC%81/`, `/caf%c3%a9/` and
 *   `/caf%C3%A9/` are one key, and `%41` becomes `A`;
 * - no dot segments, no empty segments (`//`), no query string, no fragment;
 * - case is preserved (paths are case-sensitive keys).
 *
 * Rejected, never repaired (these are exactly the addresses the public host treats as junk, so no rule can be emitted
 * that the host would reject): a scheme or host, a `//` prefix, backslash, raw whitespace, control characters (raw or
 * encoded, including the C1 range and U+2028/U+2029), the encoded characters `%2F` `%5C` `%25` `%23`, bytes that are not
 * valid UTF-8 (`/%C3/`), a segment that starts with a scheme-like prefix (`tel:`, `mailto:`, `javascript:`, `data:`,
 * `http(s):`, and any `name:` first segment), `*` (wildcards are pattern rules of the public host), `?` and `#`, and a
 * canonical path longer than {@link PATH_MAX}.
 */

export type EnvLike = Readonly<Record<string, string | undefined>>

export const PATH_MAX = 300
const INPUT_MAX = 2048

export type PathResult = { ok: true; path: string } | { ok: false; reason: string }

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

const HEX = /^[0-9A-Fa-f]{2}$/
const isUnreservedByte = (b: number): boolean =>
  (b >= 0x30 && b <= 0x39) || // 0-9
  (b >= 0x41 && b <= 0x5a) || // A-Z
  (b >= 0x61 && b <= 0x7a) || // a-z
  b === 0x2d || // -
  b === 0x2e || // .
  b === 0x5f || // _
  b === 0x7e // ~

const encodeByte = (b: number): string =>
  isUnreservedByte(b) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`

// Line and paragraph separators are written as code units so that no tool can turn them into a literal line break.
const LS_PS = String.fromCharCode(0x2028, 0x2029)
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${LS_PS}]`)
const DECODED_CONTROL = new RegExp(`[\\u0080-\\u009f${LS_PS}]`)
const EXTENSION = /\.[A-Za-z0-9]{1,10}$/
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const JUNK_SCHEME = /^(?:tel|mailto|javascript|data|https?):/i
// encoded "/" "\" "%" "#"
const FORBIDDEN_ENCODED = new Set([0x2f, 0x5c, 0x25, 0x23])

/** Normalise a path to the canonical form, or say why it cannot be. */
export function normalizePath(input: unknown): PathResult {
  if (typeof input !== 'string') return fail('must be text')
  const raw = input.trim()
  if (raw === '') return fail('is empty')
  if (raw.length > INPUT_MAX) return fail('is too long')
  if (CONTROL.test(raw)) return fail('contains control characters')
  if (/\s/u.test(raw)) return fail('contains whitespace')
  if (raw.includes('\\')) return fail('contains a backslash')
  if (raw[0] !== '/') {
    return fail(SCHEME.test(raw) || raw.startsWith('//') ? 'must be a path, not a URL' : 'must start with "/"')
  }
  if (raw.startsWith('//')) return fail('must not start with "//"')
  if (raw.includes('?') || raw.includes('#')) return fail('must not contain a query string or fragment')
  if (raw.includes('*')) return fail('must not contain "*" (wildcards are pattern rules of the public host)')

  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  // One byte array per segment (raw characters as UTF-8, percent escapes as the byte they name).
  const byteSegments: number[][] = [[]]
  const chars = Array.from(raw)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch === '/') {
      byteSegments.push([])
      continue
    }
    const current = byteSegments[byteSegments.length - 1]
    if (ch === '%') {
      const hex = `${chars[i + 1] ?? ''}${chars[i + 2] ?? ''}`
      if (!HEX.test(hex)) return fail('contains a "%" that is not followed by two hex digits')
      const byte = Number.parseInt(hex, 16)
      if (byte < 0x20 || byte === 0x7f) return fail('contains an encoded control character')
      if (FORBIDDEN_ENCODED.has(byte)) return fail('contains an encoded "/", "\\", "%" or "#"')
      current.push(byte)
      i += 2
      continue
    }
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0xd800 && code <= 0xdfff) return fail('contains an invalid character')
    current.push(...encoder.encode(ch))
  }

  const segments: string[] = []
  for (let s = 0; s < byteSegments.length; s++) {
    let text: string
    try {
      text = decoder.decode(Uint8Array.from(byteSegments[s])).normalize('NFC')
    } catch {
      return fail('contains bytes that are not valid UTF-8')
    }
    if (DECODED_CONTROL.test(text)) return fail('contains an encoded control character')
    if (text !== '' && (JUNK_SCHEME.test(text) || (s === 1 && SCHEME.test(text)))) {
      return fail('has a segment that starts like a URL scheme (for example "tel:" or "data:")')
    }
    let encoded = ''
    for (const byte of encoder.encode(text)) encoded += encodeByte(byte)
    segments.push(encoded)
  }

  const trailing = segments[segments.length - 1] === ''
  const inner = segments.slice(1, trailing ? -1 : undefined)
  if (inner.length === 0) return { ok: true, path: '/' }
  for (const seg of inner) {
    if (seg === '') return fail('contains an empty segment ("//")')
    if (seg === '.' || seg === '..') return fail('contains a dot segment')
  }
  const last = inner[inner.length - 1]
  const directory = trailing || !EXTENSION.test(last)
  const path = `/${inner.join('/')}${directory ? '/' : ''}`
  if (path.length > PATH_MAX) return fail(`is longer than ${PATH_MAX} characters`)
  return { ok: true, path }
}

/**
 * Normalise a request address as the public host sees it (`/Old-Slug?utm=1#top`): the query string and fragment are
 * removed first, then the path is normalised. Returns `null` when the path cannot be normalised (answer 404).
 */
export function normalizeRequestPath(requestTarget: string): string | null {
  const cut = requestTarget.search(/[?#]/)
  const result = normalizePath(cut === -1 ? requestTarget : requestTarget.slice(0, cut))
  return result.ok ? result.path : null
}

// ---------------------------------------------------------------------------------------------------------------
// Targets (`to`)
// ---------------------------------------------------------------------------------------------------------------

export class RedirectConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RedirectConfigError'
  }
}

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

/**
 * `REDIRECT_ALLOWED_HOSTS`: comma list of bare host names (ASCII, no scheme, port or path; use punycode for
 * international names). Unset or empty means no absolute `to` is accepted. A malformed entry fails loudly.
 */
export function parseAllowedHosts(env: EnvLike = process.env): string[] {
  const hosts = (env.REDIRECT_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  for (const host of hosts) {
    if (!HOST_RE.test(host) || host.length > 253) {
      throw new RedirectConfigError(
        'REDIRECT_ALLOWED_HOSTS must be a comma list of bare host names (no scheme, port or path), for example "www.example.test".',
      )
    }
  }
  return [...new Set(hosts)]
}

export const DEFAULT_LEGACY_HOSTS = ['churchtimesnigeria.net', 'www.churchtimesnigeria.net'] as const

/**
 * `LEGACY_SITE_HOSTS`: comma list of the host names the old WordPress addresses (`legacyUrl`) may carry. A `legacyUrl`
 * on any other host is skipped (and counted), never turned into a rule. Unset or empty means the default list.
 */
export function parseLegacyHosts(env: EnvLike = process.env): string[] {
  const configured = (env.LEGACY_SITE_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (configured.length === 0) return [...DEFAULT_LEGACY_HOSTS]
  for (const host of configured) {
    if (!HOST_RE.test(host) || host.length > 253) {
      throw new RedirectConfigError('LEGACY_SITE_HOSTS must be a comma list of bare host names (no scheme, port or path).')
    }
  }
  return [...new Set(configured)]
}

export type TargetResult = { ok: true; to: string; external: boolean } | { ok: false; reason: string }

/**
 * Normalise a redirect target: a canonical path, or an absolute `https:` URL whose host is in `allowedHosts`
 * (no credentials, port, query string or fragment). The canonical absolute form is `https://<lower-case host><path>`.
 */
export function normalizeTarget(input: unknown, allowedHosts: readonly string[]): TargetResult {
  if (typeof input !== 'string') return fail('must be text')
  const raw = input.trim()
  if (raw === '') return fail('is empty')
  if (raw.startsWith('/')) {
    const path = normalizePath(raw)
    return path.ok ? { ok: true, to: path.path, external: false } : path
  }
  if (raw.length > INPUT_MAX) return fail('is too long')
  if (CONTROL.test(raw) || /\s/u.test(raw)) return fail('contains control characters or whitespace')
  if (raw.includes('\\')) return fail('contains a backslash')
  if (/^http:\/\//i.test(raw)) return fail('must use https, not http')
  const match = /^https:\/\/([^/?#]*)(.*)$/i.exec(raw)
  if (!match) return fail('must be a path starting with "/" or an absolute https URL')
  const host = match[1].toLowerCase()
  if (!HOST_RE.test(host)) return fail('has a host that is not a plain host name (credentials, ports and IP literals are not allowed)')
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host)) return fail('has a host that is not in REDIRECT_ALLOWED_HOSTS')
  const rest = match[2] === '' ? '/' : match[2]
  const path = normalizePath(rest)
  if (!path.ok) return path
  const to = `https://${host}${path.path}`
  return to.length > INPUT_MAX ? fail('is too long') : { ok: true, to, external: true }
}

/**
 * The path a canonical target points at: the target itself for an internal path, the path after the host for an absolute
 * URL. The public host treats an absolute target on its own origin as that path, so chain checks use this for both.
 */
export function targetPathOf(to: string): string {
  if (to.startsWith('/')) return to
  const rest = /^https:\/\/[^/]+(\/.*)$/.exec(to)
  return rest ? rest[1] : '/'
}

/** True for an internal (path) target. External targets are never the `from` of another rule. */
export const isInternalTarget = (to: string | null | undefined): to is string =>
  typeof to === 'string' && to.startsWith('/')

// ---------------------------------------------------------------------------------------------------------------
// Public article path template (shared with the public host through the same environment value)
// ---------------------------------------------------------------------------------------------------------------

export const ARTICLE_PATH_TEMPLATES = ['/{slug}/', '/reports/{slug}/'] as const
export type ArticlePathTemplate = (typeof ARTICLE_PATH_TEMPLATES)[number]
export const DEFAULT_ARTICLE_PATH_TEMPLATE: ArticlePathTemplate = '/{slug}/'

/**
 * `PUBLIC_ARTICLE_PATH_TEMPLATE`: unset or empty is the default `/{slug}/` (owner decision D1: articles live at the site root, as on WordPress).
 * Only the two accepted values exist; anything else throws so that a typo is never turned into wrong redirects.
 */
export function resolveArticlePathTemplate(env: EnvLike = process.env): ArticlePathTemplate {
  const value = (env.PUBLIC_ARTICLE_PATH_TEMPLATE ?? '').trim()
  if (value === '') return DEFAULT_ARTICLE_PATH_TEMPLATE
  if ((ARTICLE_PATH_TEMPLATES as readonly string[]).includes(value)) return value as ArticlePathTemplate
  throw new RedirectConfigError(
    `PUBLIC_ARTICLE_PATH_TEMPLATE must be one of ${ARTICLE_PATH_TEMPLATES.map((t) => `"${t}"`).join(' or ')} (got "${value.slice(0, 80)}").`,
  )
}

/** The current public path of an article with this slug. */
export function articlePath(template: ArticlePathTemplate, slug: string): string {
  const path = normalizePath(template.replace('{slug}', slug))
  if (!path.ok) throw new RedirectConfigError(`Article slug "${slug.slice(0, 80)}" does not make a valid public path: ${path.reason}.`)
  return path.path
}

/** The article slug behind a current public path, or null when the path is not an article path for this template. */
export function slugFromArticlePath(template: ArticlePathTemplate, path: string): string | null {
  const prefix = template === '/{slug}/' ? '/' : '/reports/'
  if (!path.startsWith(prefix) || !path.endsWith('/')) return null
  const slug = path.slice(prefix.length, -1)
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null
}
