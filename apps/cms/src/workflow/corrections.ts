/**
 * Corrections are an append-only public record of changes to a published article.
 *
 * `reconcileCorrections(existing, incoming)` decides what a PATCH may do to the `corrections` array:
 *
 * - The incoming list must start with every existing entry unchanged (same `id`, `note` and
 *   `correctedAt`, same order). Anything after them is a new entry.
 * - New entries are rebuilt from the note only: `correctedAt` is the server clock (a client value is
 *   ignored, so entries cannot be back-dated) and the client's `id` is dropped (Payload assigns one).
 * - Otherwise (an entry rewritten, reordered or removed) the change is refused, unless the caller may
 *   amend history (admin / editor-in-chief). Amendments are allowed but flagged so they can be audited
 *   as `correction.amend`.
 *
 * Pure so it can be unit tested without Payload.
 */

export type CorrectionRow = Record<string, unknown>

export type CorrectionsResult =
  | { ok: true; rows: CorrectionRow[]; added: number; amended: boolean; changed: boolean }
  | { ok: false; message: string }

const asRows = (v: unknown): CorrectionRow[] | null => {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) return null
  return v.every((r) => r && typeof r === 'object' && !Array.isArray(r)) ? (v as CorrectionRow[]) : null
}

const time = (v: unknown): number => (typeof v === 'string' || v instanceof Date ? new Date(v).getTime() : Number.NaN)

const sameEntry = (a: CorrectionRow, b: CorrectionRow): boolean =>
  a.id !== undefined &&
  a.id !== null &&
  b.id !== undefined &&
  b.id !== null &&
  String(a.id) === String(b.id) &&
  a.note === b.note &&
  Number.isFinite(time(a.correctedAt)) &&
  time(a.correctedAt) === time(b.correctedAt)

const fresh = (row: CorrectionRow, now: Date): CorrectionRow => ({ note: row.note, correctedAt: now.toISOString() })

export function reconcileCorrections(
  existingValue: unknown,
  incomingValue: unknown,
  opts: { now: Date; canAmend: boolean },
): CorrectionsResult {
  const existing = asRows(existingValue) ?? []
  const incoming = asRows(incomingValue)
  if (!incoming) return { ok: false, message: 'corrections must be a list of { note } entries.' }

  const isPrefix = incoming.length >= existing.length && existing.every((row, i) => sameEntry(row, incoming[i]!))
  if (isPrefix) {
    const rows = [...incoming.slice(0, existing.length), ...incoming.slice(existing.length).map((r) => fresh(r, opts.now))]
    const added = incoming.length - existing.length
    return { ok: true, rows, added, amended: false, changed: added > 0 }
  }

  if (!opts.canAmend) {
    return {
      ok: false,
      message:
        'Corrections are append-only: existing entries cannot be changed, reordered or removed. ' +
        'Add a new entry instead (only an editor-in-chief or admin can amend the history).',
    }
  }
  const known = new Set(existing.map((r) => String(r.id)))
  const rows = incoming.map((r) => (r.id !== undefined && known.has(String(r.id)) ? r : fresh(r, opts.now)))
  const added = rows.filter((r, i) => r !== incoming[i]).length
  return { ok: true, rows, added, amended: true, changed: true }
}
