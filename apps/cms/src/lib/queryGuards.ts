/**
 * Query guard for relationship filters, enforced by `src/proxy.ts` before a request reaches Payload.
 *
 * Every relationship in this schema points at a collection with a numeric primary key. Payload passes the
 * filter value straight to PostgreSQL, so `where[category][equals]=news` (a slug, which a frontend can
 * easily send by mistake) ends in "invalid input syntax for type integer" and a generic 500. A malformed
 * filter is a client error: answer 400 with the offending parameter instead. Nested paths such as
 * `where[category.slug][equals]=news` are not matched here (Payload joins on them and returns 200).
 *
 * Pure function (no Next imports) so it can be unit tested.
 */

/** Relationship / upload field names across all collections (all numeric IDs, none polymorphic). */
export const RELATION_FIELDS = [
  'category',
  'featuredImage',
  'image',
  'bodyMedia',
  'author',
  'event',
  'article',
  'actor',
  'approvedBy',
  'uploadedBy',
  'sections',
  'parent',
] as const

const FILTER_KEY = new RegExp(
  String.raw`\[(?:version\.)?(${RELATION_FIELDS.join('|')})\]\[(equals|not_equals|in|not_in|all)\](?:\[\d{1,4}\])?$`,
)
const ID = /^\d{1,15}$/

export type QueryGuardDecision = { ok: true } | { ok: false; status: 400; field: string; message: string }

export function checkRelationFilters(pathname: string, searchParams: URLSearchParams): QueryGuardDecision {
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return { ok: true }
  for (const [key, value] of searchParams) {
    if (!key.startsWith('where')) continue
    const m = FILTER_KEY.exec(key)
    if (!m) continue
    const op = m[2]!
    const values = op === 'in' || op === 'not_in' || op === 'all' ? value.split(',') : [value]
    const nullable = op === 'equals' || op === 'not_equals'
    for (const v of values) {
      const t = v.trim()
      if (ID.test(t) || (nullable && t === 'null')) continue
      return { ok: false, status: 400, field: key, message: `Filter on "${m[1]}" must use numeric IDs.` }
    }
  }
  return { ok: true }
}

/** Collections whose REST ids are numeric primary keys (every Payload collection in this schema). */
const NUMERIC_ID_COLLECTIONS = [
  'articles',
  'categories',
  'media',
  'submissions',
  'contact-messages',
  'subscribers',
  'live-events',
  'live-updates',
  'redirects',
  'advertisers',
  'ad-campaigns',
  'legacy-comments',
  'audit-logs',
  'users',
]
/** Single path segments after `/api/<collection>/` that are routes, not ids. */
const RESERVED_SEGMENTS = new Set([
  'count',
  'versions',
  'access',
  'login',
  'logout',
  'me',
  'init',
  'forgot-password',
  'reset-password',
  'unlock',
  'refresh-token',
  'first-register',
  'export',
  'preview-token',
])

export type ShapeDecision = { ok: true } | { ok: false; status: 400 | 404; message: string }

/**
 * Malformed requests that PostgreSQL would reject with a generic 500 (found by the security suite, tests/security):
 * - a NUL byte anywhere in the path or query ("invalid byte sequence for encoding UTF8: 0x00"),
 * - a non-numeric document id on a numeric-id collection (`/api/articles/not-a-number`),
 * and one route Payload registers but this schema cannot serve: e-mail verification (`auth.verify` is off, so
 * `POST /api/users/verify/:token` ends in a 500 about a missing `_verificationToken` field).
 */
export function checkRequestShape(pathname: string, rawSearch: string): ShapeDecision {
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return { ok: true }
  let decodedPath = pathname
  let decodedSearch = rawSearch
  try {
    decodedPath = decodeURIComponent(pathname)
    decodedSearch = decodeURIComponent(rawSearch)
  } catch {
    return { ok: false, status: 400, message: 'Malformed URL encoding.' }
  }
  if (decodedPath.includes('\u0000') || decodedSearch.includes('\u0000') || /%00/i.test(pathname + rawSearch)) {
    return { ok: false, status: 400, message: 'Invalid characters in the request URL.' }
  }
  const parts = pathname.split('/').filter(Boolean) // ['api', collection, seg, ...]
  if (parts[1] === 'users' && parts[2] === 'verify') {
    return { ok: false, status: 404, message: 'Not found.' }
  }
  if (parts.length === 3 && NUMERIC_ID_COLLECTIONS.includes(parts[1]!)) {
    const seg = parts[2]!
    if (!RESERVED_SEGMENTS.has(seg) && !/^\d{1,15}$/.test(seg)) {
      return { ok: false, status: 404, message: 'Not found.' }
    }
  }
  return { ok: true }
}
