import fs from 'node:fs'
import path from 'node:path'

import type { Payload } from 'payload'

import { makeLqip } from '../collections/Media'

export type LqipBackfillResult = { scanned: number; updated: number; missingFile: number; failed: number }

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp']

/**
 * Waves 1-2: give media uploaded before `lqip` existed (the archive import, older uploads) their blur placeholder. Reads each
 * original from the media folder, computes the same 16 px WebP data URI as an upload does, and writes ONLY `lqip` through
 * the database adapter (no hooks: nothing else changes, no audit noise, no live-update re-delivery). Idempotent: rows that
 * already have a placeholder are skipped. A file outside the media folder is never read. Counts only, never names.
 */
export async function backfillLqip(
  payload: Payload,
  { dryRun = false, batchSize = 200, onBatch }: { dryRun?: boolean; batchSize?: number; onBatch?: (r: LqipBackfillResult) => void } = {},
): Promise<LqipBackfillResult> {
  const upload = payload.collections.media.config.upload as { staticDir?: string } | false
  const staticDir = upload && upload.staticDir ? path.resolve(upload.staticDir) : path.resolve('media')
  const root = fs.existsSync(staticDir) ? fs.realpathSync.native(staticDir) : staticDir
  const result: LqipBackfillResult = { scanned: 0, updated: 0, missingFile: 0, failed: 0 }
  let lastId = 0
  for (;;) {
    const batch = await payload.find({
      collection: 'media',
      where: { and: [{ id: { greater_than: lastId } }, { mimeType: { in: IMAGE_MIME } }, { or: [{ lqip: { exists: false } }, { lqip: { equals: '' } }] }] },
      sort: 'id',
      limit: batchSize,
      depth: 0,
      pagination: false,
      overrideAccess: true,
      select: { filename: true },
    })
    const docs = batch.docs as unknown as Array<{ id: number; filename?: string | null }>
    if (docs.length === 0) break
    for (const doc of docs) {
      lastId = doc.id
      result.scanned++
      const name = typeof doc.filename === 'string' ? doc.filename : ''
      const file = path.resolve(root, name)
      if (!name || path.dirname(file) !== root || !fs.existsSync(file)) {
        result.missingFile++
        continue
      }
      const lqip = await makeLqip(fs.readFileSync(file))
      if (!lqip) {
        result.failed++
        continue
      }
      if (!dryRun) await payload.db.updateOne({ collection: 'media', id: doc.id, data: { lqip }, returning: false } as never)
      result.updated++
    }
    onBatch?.(result)
  }
  return result
}
