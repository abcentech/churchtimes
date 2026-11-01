import type { Endpoint, PayloadRequest } from 'payload'

import { isAdmin, type UserLike } from '../access/roles'
import { redactDonation } from '../lib/giving/redact'
import { safeErrorFields } from '../lib/safeLog'

const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

/**
 * `POST /api/donations/:id/redact` (admin only): NDPA erasure of the giver's e-mail and name on one donation; the
 * amount, currency, reference, status and dates stay for book-keeping. Idempotent (`changed: false` when already blank).
 * Audited. Cookie sessions are subject to Payload's CSRF origin check like every other staff write.
 */
export const donationsRedactEndpoint: Endpoint = {
  path: '/:id/redact',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const user = req.user as UserLike | null
    if (!user) return reply(401, { ok: false, errors: [{ message: 'Authentication required.' }] })
    if (!isAdmin(user)) return reply(403, { ok: false, errors: [{ message: 'Only an admin can remove a giver\'s details.' }] })
    const id = String((req.routeParams as { id?: unknown } | undefined)?.id ?? '')
    if (!/^[0-9]{1,12}$/.test(id)) return reply(400, { ok: false, errors: [{ message: 'Invalid donation id.' }] })
    try {
      const result = await redactDonation(req, { id: Number(id) }, 'admin')
      if (!result.found) return reply(404, { ok: false, errors: [{ message: 'Donation not found.' }] })
      return reply(200, { ok: true, reference: result.reference, changed: result.changed })
    } catch (err) {
      req.payload.logger.error(safeErrorFields(err), '[giving] donation redact failed')
      return reply(500, { ok: false, errors: [{ message: 'Something went wrong. Please try again.' }] })
    }
  },
}
