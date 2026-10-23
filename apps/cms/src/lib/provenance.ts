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
