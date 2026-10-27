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
  'categories',
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
  const statusDecision = checkStatusFilters(pathname, new URLSearchParams(rawSearch))
  if (!statusDecision.ok) return statusDecision
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

/**
 * Every value any `select` field called `status` can hold, across all collections (articles, submissions, contact messages, live
 * events and updates, legacy comments, subscribers, ad campaigns). tests/security checks this list against payload.config so a
 * new status value cannot be refused here by mistake. PostgreSQL rejects an unknown enum literal, which Payload turns into a
 * generic 500 for an anonymous `?where[status][equals]=bogus`.
 */
export const STATUS_FILTER_VALUES: ReadonlySet<string> = new Set([
  'draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'published', 'archived',
  'new', 'under_review', 'accepted', 'rejected', 'converted',
  'read', 'replied', 'spam',
  'live', 'ended',
  'pending', 'hidden',
  'confirmed', 'unsubscribed', 'bounced', 'erased',
  'pending_approval', 'paused', 'cancelled',
])

const STATUS_KEY = /\[(?:[A-Za-z]+\.)*status\]\[(equals|not_equals|in|not_in)\](?:\[\d{1,4}\])?$/

/** `where[...status][equals|not_equals|in|not_in]` values must be real status values (400 otherwise). */
export function checkStatusFilters(pathname: string, searchParams: URLSearchParams): ShapeDecision {
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return { ok: true }
  for (const [key, value] of searchParams) {
    if (!key.startsWith('where')) continue
    const m = STATUS_KEY.exec(key)
    if (!m) continue
    const values = m[1] === 'in' || m[1] === 'not_in' ? value.split(',') : [value]
    for (const v of values) {
      if (!STATUS_FILTER_VALUES.has(v.trim())) {
        return { ok: false, status: 400, message: 'Filter on "status" uses an unknown value.' }
      }
    }
  }
  return { ok: true }
}

/**
 * A NUL byte (or other control character) in a multipart part header (file name) makes busboy throw "Malformed part header",
 * which Payload reports as a generic 500. Scans only the Content-Disposition header lines of a buffered body.
 */
export function multipartHeadersAreClean(body: Uint8Array): boolean {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  let from = 0
  for (;;) {
    const at = buf.indexOf('ontent-Disposition', from, 'latin1')
    if (at < 0) return true
    const end = buf.indexOf('\r\n\r\n', at, 'latin1')
    const stop = end < 0 ? Math.min(buf.length, at + 2048) : Math.min(end, at + 2048)
    for (let i = at; i < stop; i++) if (buf[i] === 0) return false
    from = at + 1
  }
}

/** How much of a multipart body is inspected for control characters in part headers. */
export const MULTIPART_SCAN_BYTES = 64 * 1024

/**
 * Reads at most MULTIPART_SCAN_BYTES (plus the chunk that crossed the limit) from `stream` and cancels it, then checks the part
 * headers inside that prefix. A form puts its small parts (`_payload`, the file part header) first, so the file name is within
 * the prefix; the rest of an upload is never read by this scan. Returns how many bytes were consumed (for tests).
 */
export async function scanMultipartPrefix(
  stream: ReadableStream<Uint8Array> | null,
  limit = MULTIPART_SCAN_BYTES,
): Promise<{ clean: boolean; bytesRead: number }> {
  if (!stream) return { clean: true, bytesRead: 0 }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    // Not awaited: on a tee()d request clone the cancel promise only settles when BOTH branches are cancelled.
    void reader.cancel().catch(() => undefined)
  }
  return { clean: multipartHeadersAreClean(Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))), bytesRead: total }
}
