/**
 * `npm run search:reindex [-- --batch 200]` (runs `payload run src/scripts/reindexSearch.ts`).
 * Rebuilds the public search projection (`article_search`) from the published articles. Idempotent and batched; run it after
 * the archive import and after the first deploy of the search migration. Prints counts only, never article text.
 */
import config from '@payload-config'
import { getPayload } from 'payload'

import { reindexArticleSearch } from '../lib/articleSearch'
import { cliFailureMessage } from '../lib/safeLog'

const args = process.argv.slice(2)
const i = args.indexOf('--batch')
const batchSize = i >= 0 ? Number(args[i + 1]) : 200

async function main(): Promise<void> {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('--batch must be a positive integer')
  const payload = await getPayload({ config })
  const result = await reindexArticleSearch(payload, {
    batchSize,
    onBatch: (r) => console.log(`search:reindex indexed ${r.indexed} so far`),
  })
  console.log(`search:reindex done: scanned ${result.scanned}, indexed ${result.indexed}, removed stale ${result.removedStale}`)
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`search:reindex failed: ${cliFailureMessage(err)}`)
    process.exit(1)
  },
)
