/**
 * Archive-candidate provenance on articles (group `provenance`, see docs/archive-candidate-schema.md).
 *
 * An article carrying an `importBatch` came from the archive-candidate importer. It is draft-only until an editor sets
 * `provenance.reviewStatus` to `reviewed`: no status of `published` or `scheduled` is accepted before that, whoever asks
 * (REST, admin, scheduler, seed or importer). Server-side, in the Articles `beforeChange` hook.
 */
export const PROVENANCE_CONFIDENCE = ['partial', 'citation-only', 'missing'] as const
export type ProvenanceConfidence = (typeof PROVENANCE_CONFIDENCE)[number]
export const PROVENANCE_REVIEW_STATUSES = ['pending', 'reviewed', 'rejected'] as const
export type ProvenanceReviewStatus = (typeof PROVENANCE_REVIEW_STATUSES)[number]

type Prov = { importBatch?: unknown; reviewStatus?: unknown } | null | undefined

const asProv = (v: unknown): Prov => (v && typeof v === 'object' ? (v as Prov) : undefined)

/**
 * True when the write would leave an imported, unreviewed article in a publishing status. `data` is the incoming
 * partial data (may omit `provenance` and `status`), `orig` the stored document (undefined on create).
 */
export function publishBlockedByProvenance(data: Record<string, unknown>, orig: Record<string, unknown> | undefined): boolean {
  const status = (data.status ?? orig?.status) as unknown
  if (status !== 'published' && status !== 'scheduled') return false
  const incoming = asProv(data.provenance)
  const stored = asProv(orig?.provenance)
  const importBatch = incoming && 'importBatch' in incoming ? incoming.importBatch : stored?.importBatch
  if (typeof importBatch !== 'string' || importBatch.length === 0) return false
  const reviewStatus = incoming && 'reviewStatus' in incoming ? incoming.reviewStatus : stored?.reviewStatus
  return reviewStatus !== 'reviewed'
}

const REVIEW_AND_PUBLISH = new Set(['published', 'scheduled'])

/**
 * True when one write both approves a recovered archive article (reviewStatus becomes "reviewed") and puts it into a
 * publishing status (published or scheduled). Approving and publishing are two decisions: by default they must be two
 * requests (so the approval is audited as its own `archive.review` row before anything goes live). `data` is the incoming
 * partial data, `orig` the stored document (undefined on create).
 */
export function reviewAndPublishInOneWrite(data: Record<string, unknown>, orig: Record<string, unknown> | undefined): boolean {
  const incoming = asProv(data.provenance)
  if (!incoming || !('reviewStatus' in incoming) || incoming.reviewStatus !== 'reviewed') return false
  const stored = asProv(orig?.provenance)
  if (stored?.reviewStatus === 'reviewed') return false
  const importBatch = 'importBatch' in incoming ? incoming.importBatch : stored?.importBatch
  if (typeof importBatch !== 'string' || importBatch.length === 0) return false
  const status = (data.status ?? orig?.status) as unknown
  const prevStatus = orig?.status as unknown
  return typeof status === 'string' && REVIEW_AND_PUBLISH.has(status) && status !== prevStatus
}

/** Four-eyes rule (owner decision): the person who approved a recovered article must not be the one who publishes or schedules it. */
export const FOUR_EYES_MESSAGE = 'A different editor must publish a recovered article you approved.'

const relId = (v: unknown): string | undefined => {
  if (v === null || v === undefined || v === '') return undefined
  if (typeof v === 'object') return relId((v as { id?: unknown }).id)
  return String(v)
}

/**
 * Server-owned review stamp. Returns the `reviewedBy` / `reviewedAt` the document must carry after this write: set to the
 * acting user when reviewStatus changes to "reviewed", cleared when it changes away from it. `undefined` means the review
 * status does not change: the caller must then drop any reviewedBy / reviewedAt the write carries (a client or a restored
 * snapshot may have sent them) so the stored values stay.
 */
export const storedReviewedBy = (orig: Record<string, unknown> | undefined): string | undefined =>
  relId((asProv(orig?.provenance) as Record<string, unknown> | undefined)?.reviewedBy)

export function reviewStamp(
  data: Record<string, unknown>,
  orig: Record<string, unknown> | undefined,
  actor: { id?: string | number; name?: unknown } | null | undefined,
  now: Date,
): { reviewedBy: string | number | null; reviewedByName: string | null; reviewedAt: string | null } | undefined {
  const incoming = asProv(data.provenance) as Record<string, unknown> | undefined
  const stored = asProv(orig?.provenance) as Record<string, unknown> | undefined
  const prevStatus = stored?.reviewStatus ?? null
  const nextStatus = incoming && 'reviewStatus' in incoming && incoming.reviewStatus !== undefined ? incoming.reviewStatus : prevStatus
  if (nextStatus === prevStatus) return undefined
  if (nextStatus === 'reviewed') {
    const name = typeof actor?.name === 'string' && actor.name ? actor.name.slice(0, 200) : null
    return { reviewedBy: actor?.id ?? null, reviewedByName: name, reviewedAt: now.toISOString() }
  }
  return { reviewedBy: null, reviewedByName: null, reviewedAt: null }
}

/**
 * True when a non-admin approver would be the one to publish or schedule a recovered article: the write leaves it
 * published/scheduled and either moves it into that status or changes the schedule. `reviewedById` is the id after
 * `reviewStamp`. Writes with no user (scheduler, importer, seed) are never blocked here: scheduling is checked when it happens.
 */
export function fourEyesBlocked(args: {
  data: Record<string, unknown>
  orig: Record<string, unknown> | undefined
  actor: { id?: string | number; role?: string | null } | null | undefined
  reviewedById: string | number | null | undefined
}): boolean {
  const { data, orig, actor } = args
  const reviewedById = args.reviewedById
  if (!actor || actor.role === 'admin') return false
  if (reviewedById === null || reviewedById === undefined || String(reviewedById) !== String(actor.id)) return false
  const incoming = asProv(data.provenance)
  const stored = asProv(orig?.provenance)
  const batch = incoming && 'importBatch' in incoming ? incoming.importBatch : stored?.importBatch
  if (typeof batch !== 'string' || batch.length === 0) return false
  const prevStatus = orig?.status as unknown
  const status = (data.status ?? prevStatus) as unknown
  if (status !== 'published' && status !== 'scheduled') return false
  if (status !== prevStatus) return true
  if (status === 'scheduled' && data.scheduledFor !== undefined) {
    return new Date(data.scheduledFor as string).getTime() !== new Date(orig?.scheduledFor as string).getTime()
  }
  return false
}
