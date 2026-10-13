import type { CollectionBeforeOperationHook } from 'payload'

export const MAX_LIMIT = 100
export const DEFAULT_LIMIT = 10

/**
 * Bound client-driven list queries. Payload 3 has no collection-level `maxLimit`, and
 * `?pagination=false` (or `?limit=0`) turns a list into "return every row".
 *
 * VERIFIED against payload@3.90.2: `find` and `findVersions` both run `beforeOperation` hooks with
 * `operation: 'read'` and the REST query already parsed into `args` (`limit`, `page`, `pagination`,
 * `where`, ...); the operation destructures `args` again *after* the hooks, so mutations here take
 * effect. `findByID` / `findVersionByID` also report `'read'` but carry an `id` and no paging keys.
 *
 * Only untrusted calls are touched (`overrideAccess` false: REST requests and local calls that opt in
 * to access control). Trusted server code (scheduler, seed, hooks) can still fetch everything.
 *
 * Rules: `pagination` is always on; `limit` is clamped into 1..MAX_LIMIT, 0 / negative / non-numeric
 * becomes DEFAULT_LIMIT, and a missing limit is left to Payload's own default (10).
 */
export const clampLimit: CollectionBeforeOperationHook = ({ args, operation }) => {
  if (operation !== 'read' || !args || typeof args !== 'object') return args
  const a = args as { id?: unknown; overrideAccess?: boolean; limit?: unknown; pagination?: unknown }
  if (a.overrideAccess || a.id !== undefined) return args

  if (a.pagination === false) a.pagination = true

  if (a.limit !== undefined && a.limit !== null) {
    const n = typeof a.limit === 'number' ? a.limit : Number(a.limit)
    a.limit = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_LIMIT) : DEFAULT_LIMIT
  }
  return args
}
