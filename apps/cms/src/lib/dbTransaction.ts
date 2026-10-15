import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'

/**
 * Raw-SQL access that joins the request's database transaction.
 *
 * VERIFIED against @payloadcms/drizzle 3.90.2: `beginTransaction()` stores the drizzle `tx` handle in
 * `adapter.sessions[transactionID].db`, and `getTransaction(adapter, req)` (internal, not exported)
 * returns it, falling back to `adapter.drizzle` when the session is gone (already committed or
 * rolled back). We mirror that so raw statements are part of the same transaction as the
 * `payload.create/update(..., { req })` calls around them.
 */

type Executor = { execute: (query: unknown) => Promise<{ rows?: unknown[]; rowCount?: number | null }> }
type Adapter = { drizzle: Executor; sessions?: Record<string, { db: Executor } | undefined> }

async function executor(req: PayloadRequest): Promise<{ db: Executor; inTransaction: boolean }> {
  const adapter = req.payload.db as unknown as Adapter
  const id = req.transactionID ? await req.transactionID : undefined
  const session = id ? adapter.sessions?.[String(id)] : undefined
  return session ? { db: session.db, inTransaction: true } : { db: adapter.drizzle, inTransaction: false }
}

/**
 * Serialise concurrent requests on `key` until the current transaction ends
 * (`pg_advisory_xact_lock`). A no-op outside a transaction, because the lock would be released
 * immediately; returns whether the lock was taken.
 */
export async function advisoryTransactionLock(req: PayloadRequest, key: string): Promise<boolean> {
  const { db, inTransaction } = await executor(req)
  if (!inTransaction) return false
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`)
  return true
}

/**
 * Atomically flip a submission to `converted`, only if it is not converted yet. Returns true for the
 * single caller that won. A concurrent second caller blocks on the row lock until the first
 * transaction ends, then re-evaluates the WHERE clause (PostgreSQL READ COMMITTED) and matches no row.
 */
export async function claimSubmissionForConversion(req: PayloadRequest, id: number): Promise<boolean> {
  const { db } = await executor(req)
  const res = await db.execute(
    sql`update "submissions" set "status" = 'converted', "updated_at" = now() where "id" = ${id} and "status" <> 'converted' returning "id"`,
  )
  return (res.rowCount ?? res.rows?.length ?? 0) > 0
}

/**
 * The current `updated_at` of one row, read with `FOR UPDATE` so it joins the request's transaction and takes the row
 * lock the following UPDATE needs anyway. Under READ COMMITTED a second transaction that blocked on the lock re-reads
 * the row after the first commit, so it sees the newer value. Returns null when the row does not exist. Outside a
 * transaction it is a plain read. `table` is restricted to a fixed allow-list (it is interpolated as an identifier).
 */
export async function lockedUpdatedAt(
  req: PayloadRequest,
  table: 'articles' | 'live_updates',
  id: number,
): Promise<Date | null> {
  const { db } = await executor(req)
  const tableName = sql.raw(`"${table === 'articles' ? 'articles' : 'live_updates'}"`)
  const res = await db.execute(sql`select "updated_at" from ${tableName} where "id" = ${id} for update`)
  const value = (res.rows?.[0] as { updated_at?: Date | string } | undefined)?.updated_at
  if (value === undefined || value === null) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}
