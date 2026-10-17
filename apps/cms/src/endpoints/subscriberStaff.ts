import type { Endpoint, PayloadRequest } from 'payload'

import { isAdmin, type UserLike } from '../access/roles'
import { writeAuditLog } from '../lib/audit'
import { hashSubscriberEmail, toCsv } from '../lib/newsletter'
import { safeErrorFields } from '../lib/safeLog'

const err = (status: number, message: string) =>
  Response.json({ ok: false, errors: [{ message }] }, { status, headers: { 'Cache-Control': 'no-store' } })

/** Database failures here would otherwise reach Payload's own error logging, whose message can carry the query parameters (addresses). */
const guarded =
  (name: string, fn: (req: PayloadRequest) => Promise<Response>): Endpoint['handler'] =>
  async (req) => {
    try {
      return await fn(req)
    } catch (e) {
      req.payload.logger.error(safeErrorFields(e), `${name} failed`)
      return err(500, 'Something went wrong. Please try again.')
    }
  }

/** Statuses an export may ask for. `erased` rows hold only a hash and are never exported. */
const EXPORTABLE = ['pending', 'confirmed', 'unsubscribed', 'bounced'] as const

/**
 * GET /api/subscribers/export?status=confirmed (default confirmed). CSV, `admin` only, audited, never cached.
 * Spreadsheet formula injection is blocked in lib/newsletter.ts csvCell.
 */
export const exportSubscribersEndpoint: Endpoint = {
  path: '/export',
  method: 'get',
  handler: guarded('subscriber export', async (req: PayloadRequest) => {
    const user = req.user as UserLike | null
    if (!user) return err(401, 'Authentication required.')
    if (!isAdmin(user)) return err(403, 'Only an admin can export subscribers.')

    const status = req.searchParams.get('status') ?? 'confirmed'
    if (!(EXPORTABLE as readonly string[]).includes(status)) {
      return err(400, `status must be one of: ${EXPORTABLE.join(', ')}.`)
    }

    const rows: Array<Record<string, unknown>> = []
    for (let page = 1; ; page++) {
      const batch = await req.payload.find({
        collection: 'subscribers',
        where: { status: { equals: status } },
        sort: 'id',
        limit: 500,
        page,
        depth: 0,
        overrideAccess: true,
        req,
      })
      rows.push(...(batch.docs as unknown as Array<Record<string, unknown>>))
      if (!batch.hasNextPage) break
    }

    await writeAuditLog(req, {
      action: 'subscriber.export',
      collection: 'subscribers',
      docId: 'export',
      summary: `Exported ${rows.length} ${status} subscriber(s)`,
      details: { status, rows: rows.length },
    })

    const stamp = new Date().toISOString().slice(0, 10)
    return new Response(toCsv(rows), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="subscribers-${status}-${stamp}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }),
}

/**
 * POST /api/subscribers/:id/erase (admin only). Replaces the address with its salted hash, clears the name,
 * the IP hash and any pending token, and sets `erased`. The row stays as a suppression record: it proves the
 * person asked to be forgotten (the importer will not bring the address back) without keeping the address.
 */
export const eraseSubscriberEndpoint: Endpoint = {
  path: '/:id/erase',
  method: 'post',
  handler: guarded('subscriber erase', async (req: PayloadRequest) => {
    const user = req.user as UserLike | null
    if (!user) return err(401, 'Authentication required.')
    if (!isAdmin(user)) return err(403, 'Only an admin can erase a subscriber.')

    const id = String(req.routeParams?.id ?? '')
    if (!/^[0-9]{1,18}$/.test(id)) return err(404, 'Subscriber not found.')

    const doc = (await req.payload
      .findByID({ collection: 'subscribers', id, depth: 0, overrideAccess: true, req })
      .catch(() => null)) as { id: number; email: string; status: string } | null
    if (!doc) return err(404, 'Subscriber not found.')
    if (doc.status === 'erased') return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })

    const tombstone = hashSubscriberEmail(doc.email)
    const existing = await req.payload.find({
      collection: 'subscribers',
      where: { email: { equals: tombstone } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
      req,
    })
    if (existing.docs.length > 0) {
      // This person was erased before and signed up again: the older suppression record already covers the
      // address, so the newer row is removed instead of duplicating it (email is unique).
      await req.payload.delete({ collection: 'subscribers', id: doc.id, overrideAccess: true, req })
    } else {
      await req.payload.update({
        collection: 'subscribers',
        id: doc.id,
        data: {
          email: tombstone,
          name: null,
          ipHash: null,
          status: 'erased',
          confirmTokenHash: null,
          confirmTokenExpiresAt: null,
        } as never,
        overrideAccess: true,
        context: { subscriberSystemWrite: true },
        req,
      })
    }
    await writeAuditLog(req, {
      action: 'subscriber.erase',
      collection: 'subscribers',
      docId: doc.id,
      fromStatus: doc.status,
      toStatus: 'erased',
      summary: `Subscriber ${doc.id} erased`,
    })
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  }),
}
