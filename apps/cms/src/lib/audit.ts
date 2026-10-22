import type { PayloadRequest } from 'payload'

export type AuditEntry = {
  action: string
  /** Target collection slug (stored in the `collection` field of audit-logs). */
  collection: string
  docId: string | number
  actor?: number | string | null
  actorRole?: string | null
  fromStatus?: string | null
  toStatus?: string | null
  summary?: string | null
  details?: Record<string, unknown> | null
}

/**
 * Write an immutable audit-log row. Always bypasses access control and joins the request's
 * transaction (so a rolled-back change leaves no audit row).
 */
export async function writeAuditLog(req: PayloadRequest, entry: AuditEntry) {
  const user = req.user as { id?: number | string; role?: string } | null | undefined
  const { actor, actorRole, summary, ...rest } = entry
  return req.payload.create({
    collection: 'audit-logs',
    data: {
      ...rest,
      docId: String(entry.docId),
      summary: summary ? summary.slice(0, 1000) : undefined,
      actor: actor ?? user?.id ?? undefined,
      actorRole: actorRole ?? user?.role ?? ((req.context as { import?: boolean } | undefined)?.import === true ? 'import' : undefined),
    } as never,
    overrideAccess: true,
    req,
  })
}

/** Audit row for a server-side CLI run (no request): counts and checksums only, never an address or a token. */
export async function writeSystemAuditLog(payload: import('payload').Payload, entry: AuditEntry) {
  return payload.create({
    collection: 'audit-logs',
    data: {
      ...entry,
      docId: String(entry.docId),
      summary: entry.summary ? entry.summary.slice(0, 1000) : undefined,
      actorRole: entry.actorRole ?? 'import',
    } as never,
    overrideAccess: true,
  })
}
