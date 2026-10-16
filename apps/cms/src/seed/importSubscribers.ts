/**
 * Mailchimp subscriber import: `npm run import:subscribers -- --file <path-to-csv> [--apply] [--assume-subscribed]`
 * (runs `payload run src/seed/importSubscribers.ts`). Server-side CLI only; there is no endpoint.
 *
 * - DRY RUN by default: reads the file and the database, writes nothing. `--apply` writes.
 * - Output is counts only. No address is printed or logged.
 * - The export is owner-supplied personal data and must stay OUTSIDE the repository; a path inside it is refused.
 * - Only rows Mailchimp marks as subscribed are imported (as `confirmed`, importedFrom `mailchimp-import`, consentAt = the
 *   Mailchimp opt-in time when present). Everything else is skipped. See docs/api-contracts.md "Go-live C4: newsletter".
 * - `--assume-subscribed`: only for Mailchimp's "Subscribed" segment export, which has no Status column.
 */
import fs from 'node:fs'
import path from 'node:path'

import config from '@payload-config'
import { getPayload } from 'payload'

import { formatImportReport, runSubscriberImport } from '../lib/subscriberImport'

const MAX_BYTES = 50 * 1024 * 1024

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const value = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

/** Walk up from `start` looking for a `.git` entry. */
function repoRoot(start: string): string | undefined {
  let dir = start
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

async function main() {
  const file = value('--file')
  if (!file) throw new Error('Usage: npm run import:subscribers -- --file <path-to-csv> [--apply] [--assume-subscribed]')
  const abs = path.resolve(file)
  const root = repoRoot(process.cwd())
  if (root && (abs === root || abs.startsWith(root + path.sep))) {
    throw new Error('Refusing to read a file inside the repository. Keep the Mailchimp export outside it (it is personal data).')
  }
  const stat = fs.statSync(abs)
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('The file must be a regular file of at most 50 MB.')

  const apply = flag('--apply')
  const payload = await getPayload({ config })
  const counts = await runSubscriberImport(payload, fs.readFileSync(abs, 'utf8'), {
    apply,
    assumeSubscribed: flag('--assume-subscribed'),
  })
  console.log(formatImportReport(counts, apply))
  if (counts.refused) process.exitCode = 2
}

try {
  await main()
  process.exit(process.exitCode ?? 0)
} catch (err) {
  console.error(err instanceof Error ? err.message : 'import failed')
  process.exit(1)
}
