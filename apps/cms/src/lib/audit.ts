import type { PayloadRequest } from 'payload'

export type AuditEntry = {
  action: string
  collection: string
  docId: string | number
  actor?: number | string | null
  actorRole?: string | null
  fromStatus?: string | null
  toStatus?: string | null
  summary?: string | null
}

/** Write an immutable audit-log row. Always bypasses access control. */
export async function writeAuditLog(req: PayloadRequest, entry: AuditEntry) {
  return req.payload.create({
    collection: 'audit-logs',
    data: {
      ...entry,
      docId: String(entry.docId),
      actor: entry.actor ?? (req.user?.id as number | string | undefined),
      actorRole: entry.actorRole ?? (req.user as { role?: string } | null)?.role,
    } as never,
    overrideAccess: true,
    req,
  })
}
