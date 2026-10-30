import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'

import type { DonationCurrency } from './currency'
import type { ProviderName } from './provider'
import type { DonationCause } from './settings'

/**
 * Persistence for donations, behind an interface so the money logic can be tested without a database. The Payload
 * implementation uses the `donations` collection (owned by the schema author, see docs/w12/schema-contract.md) and ONE
 * conditional UPDATE for every state change, so concurrent webhooks and status polls cannot both win a transition or
 * both send a receipt (PostgreSQL READ COMMITTED: the loser blocks on the row lock, re-evaluates the WHERE and matches
 * nothing).
 */

export const DONATION_STATUSES = ['pending', 'succeeded', 'failed', 'abandoned'] as const
export type DonationStatus = (typeof DONATION_STATUSES)[number]

export type DonationRow = {
  id: number | string
  reference: string
  provider: ProviderName
  amountMinor: number
  currency: DonationCurrency
  status: DonationStatus
  cause: DonationCause
  email: string | null
  name: string | null
  anonymous: boolean
  channel: string | null
  consentAt: string | null
  receiptSentAt: string | null
  providerRef: string | null
  paidAt: string | null
  createdAt: string
}

export type NewDonation = Pick<DonationRow, 'reference' | 'provider' | 'amountMinor' | 'currency' | 'cause' | 'email' | 'name' | 'anonymous' | 'consentAt'>

export type TransitionFields = { paidAt?: string; channel?: string; providerRef?: string }

export interface DonationStore {
  create(data: NewDonation): Promise<DonationRow>
  findByReference(reference: string): Promise<DonationRow | null>
  /** Set `to` only while the current status is one of `from`. True for the single caller that changed the row. */
  transition(reference: string, from: DonationStatus[], to: DonationStatus, fields?: TransitionFields): Promise<boolean>
  /** Stamp `receiptSentAt` only while it is empty and the donation has succeeded. True for the single winner. */
  claimReceipt(reference: string): Promise<boolean>
  /** Undo a claim after the mail could not be sent, so a later webhook retry or status check sends it. */
  releaseReceipt(reference: string): Promise<void>
  /** Rows created in [from, to] (reconciliation, read-only). */
  listCreatedBetween(from: Date, to: Date): Promise<DonationRow[]>
}

const isStatus = (s: string): s is DonationStatus => (DONATION_STATUSES as readonly string[]).includes(s)
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Map a Payload document to a row. Unknown shapes become nulls, never guesses. */
export function toDonationRow(doc: Record<string, unknown>): DonationRow {
  return {
    id: doc.id as number | string,
    reference: String(doc.reference),
    provider: (doc.provider as ProviderName) ?? 'paystack',
    amountMinor: Number(doc.amountMinor),
    currency: doc.currency as DonationCurrency,
    status: (typeof doc.status === 'string' && isStatus(doc.status) ? doc.status : 'pending') as DonationStatus,
    cause: (doc.cause as DonationCause) ?? 'general',
    email: typeof doc.email === 'string' && doc.email ? doc.email : null,
    name: typeof doc.name === 'string' && doc.name ? doc.name : null,
    anonymous: doc.anonymous === true,
    channel: typeof doc.channel === 'string' && doc.channel ? doc.channel : null,
    consentAt: iso(doc.consentAt),
    receiptSentAt: iso(doc.receiptSentAt),
    providerRef: typeof doc.providerRef === 'string' && doc.providerRef ? doc.providerRef : null,
    paidAt: iso(doc.paidAt),
    createdAt: iso(doc.createdAt) ?? new Date(0).toISOString(),
  }
}

type Executor = { execute: (query: unknown) => Promise<{ rows?: unknown[]; rowCount?: number | null }> }
const COLLECTION = 'donations' as never

/** Literal SQL for a status: only values from the fixed list ever reach `sql.raw`. */
const statusLiteral = (s: DonationStatus) => {
  if (!isStatus(s)) throw new Error('invalid donation status')
  return sql.raw(`'${s}'`)
}

export function payloadDonationStore(payload: Payload): DonationStore {
  const db = () => (payload.db as unknown as { drizzle: Executor }).drizzle
  const changed = (res: { rows?: unknown[]; rowCount?: number | null }) => (res.rowCount ?? res.rows?.length ?? 0) > 0
  return {
    async create(data) {
      const doc = await payload.create({ collection: COLLECTION, data: { ...data, status: 'pending' } as never, overrideAccess: true, depth: 0 })
      return toDonationRow(doc as unknown as Record<string, unknown>)
    },
    async findByReference(reference) {
      const res = await payload.find({
        collection: COLLECTION,
        where: { reference: { equals: reference } },
        limit: 1,
        depth: 0,
        pagination: false,
        overrideAccess: true,
      })
      const doc = res.docs[0] as unknown as Record<string, unknown> | undefined
      return doc ? toDonationRow(doc) : null
    },
    async transition(reference, from, to, fields = {}) {
      const fromList = sql.join(from.map(statusLiteral), sql`, `)
      const res = await db().execute(sql`update "donations" set
          "status" = ${statusLiteral(to)},
          "paid_at" = coalesce(${fields.paidAt ?? null}::timestamptz, "paid_at"),
          "channel" = coalesce(${fields.channel ?? null}, "channel"),
          "provider_ref" = coalesce(${fields.providerRef ?? null}, "provider_ref"),
          "updated_at" = now()
        where "reference" = ${reference} and "status"::text in (${fromList})
        returning "id"`)
      return changed(res)
    },
    async claimReceipt(reference) {
      const res = await db().execute(sql`update "donations" set "receipt_sent_at" = now(), "updated_at" = now()
        where "reference" = ${reference} and "receipt_sent_at" is null and "status"::text = 'succeeded'
        returning "id"`)
      return changed(res)
    },
    async releaseReceipt(reference) {
      await db().execute(sql`update "donations" set "receipt_sent_at" = null, "updated_at" = now() where "reference" = ${reference}`)
    },
    async listCreatedBetween(from, to) {
      const out: DonationRow[] = []
      for (let page = 1; page <= 200; page++) {
        const res = await payload.find({
          collection: COLLECTION,
          where: { and: [{ createdAt: { greater_than_equal: from.toISOString() } }, { createdAt: { less_than_equal: to.toISOString() } }] },
          limit: 500,
          page,
          depth: 0,
          sort: 'createdAt',
          overrideAccess: true,
        })
        out.push(...res.docs.map((d) => toDonationRow(d as unknown as Record<string, unknown>)))
        if (!res.hasNextPage) break
      }
      return out
    },
  }
}
