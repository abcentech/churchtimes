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
