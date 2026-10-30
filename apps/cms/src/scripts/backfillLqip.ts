/**
 * `npm run media:lqip-backfill [-- --dry-run] [-- --batch 200]` (runs `payload run src/scripts/backfillLqip.ts`).
 * Adds the blur placeholder (`media.lqip`, waves 1-2) to images uploaded before it existed. Idempotent; prints counts only.
 * Run it once after deploying the waves 1-2 migration (with the media folder mounted), and again after an archive import.
 */
import config from '@payload-config'
import { getPayload } from 'payload'

import { backfillLqip } from '../lib/lqipBackfill'
import { cliFailureMessage } from '../lib/safeLog'

const args = process.argv.slice(2)
const i = args.indexOf('--batch')
const batchSize = i >= 0 ? Number(args[i + 1]) : 200
const dryRun = args.includes('--dry-run')

async function main(): Promise<void> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('--batch must be an integer from 1 to 1000')
  const payload = await getPayload({ config })
  const r = await backfillLqip(payload, { dryRun, batchSize, onBatch: (s) => console.log(`media:lqip-backfill scanned ${s.scanned} so far`) })
  console.log(`media:lqip-backfill ${dryRun ? 'DRY RUN ' : ''}done: scanned ${r.scanned}, ${dryRun ? 'would update' : 'updated'} ${r.updated}, file missing ${r.missingFile}, unreadable ${r.failed}`)
}

// `payload run` exits when the module finishes evaluating: the work must be awaited at the top level.
try {
  await main()
  process.exit(0)
} catch (err) {
  console.error(`media:lqip-backfill failed: ${cliFailureMessage(err)}`)
  process.exit(1)
}
