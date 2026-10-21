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
 * Atomically confirm a newsletter subscriber with ONE conditional UPDATE: it matches only while the row still has the
 * observed status, the same token hash and an unexpired token, and it clears the token in the same statement. Of two
 * simultaneous confirms exactly one gets a row back (the other blocks on the row lock, re-evaluates the WHERE under
 * READ COMMITTED and matches nothing). Returns true for the single winner. A subscriber coming back from
 * `unsubscribed` or `bounced` also gets fresh consent (`consent_at`, `consent_text_version`); `unsubscribed_at` is cleared.
 */
export async function claimSubscriberConfirmation(
  req: PayloadRequest | { payload: PayloadRequest['payload'] },
  args: { id: number; tokenHash: string; fromStatus: string; consentTextVersion: string },
): Promise<boolean> {
  const adapter = req.payload.db as unknown as Adapter
  const db = adapter.drizzle
  const res = await db.execute(
    sql`update "subscribers" set
      "status" = 'confirmed',
      "confirmed_at" = now(),
      "unsubscribed_at" = null,
      "consent_at" = case when "status" <> 'pending' then now() else "consent_at" end,
      "consent_text_version" = case when "status" <> 'pending' then ${args.consentTextVersion} else "consent_text_version" end,
      "confirm_token_hash" = null,
      "confirm_token_expires_at" = null,
      "updated_at" = now()
      where "id" = ${args.id}
        and "confirm_token_hash" = ${args.tokenHash}
        and "status"::text = ${args.fromStatus}
        and "confirm_token_expires_at" > now()
      returning "id"`,
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
  table: 'articles' | 'live_updates' | 'ad_campaigns',
  id: number,
): Promise<Date | null> {
  const { db } = await executor(req)
  const tableName = sql.raw(`"${table === 'articles' ? 'articles' : table === 'ad_campaigns' ? 'ad_campaigns' : 'live_updates'}"`)
  const res = await db.execute(sql`select "updated_at" from ${tableName} where "id" = ${id} for update`)
  const value = (res.rows?.[0] as { updated_at?: Date | string } | undefined)?.updated_at
  if (value === undefined || value === null) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}
