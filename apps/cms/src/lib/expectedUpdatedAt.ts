import { APIError } from 'payload'
import type { CollectionBeforeChangeHook, CollectionBeforeOperationHook, PayloadRequest } from 'payload'

import { lockedUpdatedAt } from './dbTransaction'

/** "Approve what you saw" (review finding L2). The message the newsroom shows verbatim. */
export const STALE_MESSAGE = 'This item changed after you opened it. Reload and review it again.'

type Ctx = { expectedUpdatedAt?: { id: string; at: number } }

/**
 * Parses the optional `expectedUpdatedAt` of a PATCH: absent / null -> undefined, a valid ISO date string -> epoch
 * milliseconds, anything else -> 400.
 */
export function parseExpectedUpdatedAt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  const at = typeof raw === 'string' && raw.length <= 64 ? Date.parse(raw) : Number.NaN
  if (Number.isNaN(at)) throw new APIError('expectedUpdatedAt must be an ISO 8601 date string.', 400)
  return at
}

/** True when the stored timestamp is the one the client saw (compared as instants, not as strings). */
export const matchesExpected = (current: unknown, expectedAt: number): boolean => {
  const at = current instanceof Date ? current.getTime() : typeof current === 'string' ? Date.parse(current) : Number.NaN
  return !Number.isNaN(at) && at === expectedAt
}

/**
 * beforeOperation (update): lift `expectedUpdatedAt` out of the request body so it can never be stored or reach the
 * field pipeline, and remember it (with the target id) in the server-only `req.context` for the beforeChange check.
 * Bulk updates (no id) cannot honour it and are refused when it is sent.
 */
export const captureExpectedUpdatedAt: CollectionBeforeOperationHook = ({ args, operation }) => {
  if (operation !== 'update') return args
  const a = args as { data?: Record<string, unknown>; id?: number | string; req: PayloadRequest }
  const data = a.data
  if (!data || typeof data !== 'object' || !('expectedUpdatedAt' in data)) return args
  const raw = data.expectedUpdatedAt
  delete data.expectedUpdatedAt
  const at = parseExpectedUpdatedAt(raw)
  if (at === undefined) return args
  if (a.id === undefined || a.id === null) throw new APIError('expectedUpdatedAt is not supported for bulk updates.', 400)
  ;(a.req.context as Ctx).expectedUpdatedAt = { id: String(a.id), at }
  return args
}

/**
 * beforeChange (update), first in the chain: when the client sent `expectedUpdatedAt`, the document must still be at
 * that version. The check re-reads `updated_at` with `SELECT ... FOR UPDATE` inside the update's own transaction (see
 * `lockedUpdatedAt`): a concurrent writer holds the row lock until it commits, so two editors acting on the same
 * version cannot both pass (the second sees the first one's newer `updated_at` and gets 409), and a failed check rolls
 * the whole operation back (nothing is written, no audit entry, no counter is stamped).
 */
export const assertExpectedUpdatedAt =
  (table: 'articles' | 'live_updates'): CollectionBeforeChangeHook =>
  async ({ data, originalDoc, operation, req }) => {
    if (operation !== 'update') return data
    const ctx = (req.context ?? {}) as Ctx
    const expected = ctx.expectedUpdatedAt
    if (!expected) return data
    delete ctx.expectedUpdatedAt
    const id = originalDoc?.id
    if (id === undefined || String(id) !== expected.id) return data
    const current = await lockedUpdatedAt(req, table, Number(id))
    if (!matchesExpected(current ?? originalDoc?.updatedAt, expected.at)) throw new APIError(STALE_MESSAGE, 409)
    return data
  }
