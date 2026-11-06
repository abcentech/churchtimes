import type { PayloadRequest } from 'payload'

import { writeAuditLog } from '../audit'

/**
 * NDPA erasure for one donation: blanks the giver's `email` and `name` and NOTHING else. Reference, amount, currency,
 * status, dates, cause, channel and the provider reference stay, because the books need them (docs/w12/giving.md section
 * 4). Idempotent: a row that is already blank is left untouched and not audited again. Every real change writes an audit
 * row that names the donation reference only (never the removed details). The collection itself refuses updates over
 * REST; this is the only path, used by the admin endpoint and the CLI.
 */
export type RedactResult = { found: false } | { found: true; reference: string; changed: boolean }

export async function redactDonation(
  req: PayloadRequest,
  where: { id: number | string } | { reference: string },
  via: 'admin' | 'cli',
): Promise<RedactResult> {
  const found =
    'id' in where
      ? await req.payload.findByID({ collection: 'donations' as never, id: where.id, depth: 0, overrideAccess: true, disableErrors: true })
      : ((await req.payload.find({ collection: 'donations' as never, where: { reference: { equals: where.reference } }, limit: 1, depth: 0, overrideAccess: true })).docs[0] ?? null)
  const doc = found as unknown as { id: number | string; reference: string; email?: string | null; name?: string | null } | null
  if (!doc) return { found: false }
  if (!doc.email && !doc.name) return { found: true, reference: doc.reference, changed: false }
  await req.payload.update({
    collection: 'donations' as never,
    id: doc.id,
    data: { email: null, name: null } as never,
    overrideAccess: true,
    depth: 0,
    req,
  })
  await writeAuditLog(req, {
    action: 'donation.redact',
    collection: 'donations',
    docId: doc.id,
    ...(via === 'cli' ? { actor: null, actorRole: 'cli' } : {}),
    summary: `Personal details (email, name) removed from donation ${doc.reference} (${via})`,
  })
  return { found: true, reference: doc.reference, changed: true }
}
