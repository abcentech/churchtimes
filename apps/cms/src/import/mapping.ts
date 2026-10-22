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
