import type { CollectionAfterDeleteHook, PayloadRequest } from 'payload'

export type AuditEntry = {
  action: string
  /** Target collection slug (stored in the `collection` field of audit-logs). */
  collection: string
  docId: string | number
  /** Pass null to record no live actor FK (e.g. the actor was just deleted); the snapshot is still written. */
  actor?: number | string | null
  /** Immutable copy of the actor id; defaults to the actor / request user. Survives deletion of the user. */
  actorIdSnapshot?: string | null
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
  const { actor, actorRole, actorIdSnapshot, summary, ...rest } = entry
  const actorId = actor === undefined ? user?.id : actor
  const snapshot = actorIdSnapshot ?? (actorId ?? user?.id)
  return req.payload.create({
    collection: 'audit-logs',
    data: {
      ...rest,
      docId: String(entry.docId),
      summary: summary ? summary.slice(0, 1000) : undefined,
      actor: actorId ?? undefined,
      actorIdSnapshot: snapshot !== undefined && snapshot !== null ? String(snapshot) : undefined,
      actorRole: actorRole ?? user?.role ?? ((req.context as { import?: boolean } | undefined)?.import === true ? 'import' : undefined),
    } as never,
    overrideAccess: true,
    req,
  })
}

/**
 * afterDelete hook that audits a delete. The summary is built from non-personal fields only (never a name, e-mail
 * address or message text), so the row stays valid after an erasure request.
 */
export function auditDeleteHook(
  collection: string,
  describe?: (doc: Record<string, unknown>) => string | undefined,
): CollectionAfterDeleteHook {
  return async ({ doc, id, req }) => {
    if ((req.context as { seed?: boolean } | undefined)?.seed === true) return doc
    const detail = describe?.(doc as Record<string, unknown>)
    await writeAuditLog(req, {
      action: 'delete',
      collection,
      docId: id,
      summary: `${collection} #${id} deleted${detail ? ` (${detail})` : ''}`,
    })
    return doc
  }
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
