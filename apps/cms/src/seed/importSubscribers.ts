/**
 * Mailchimp subscriber import: `npm run import:subscribers -- --file <path-to-csv> [--apply] [--assume-subscribed]`
 * (runs `payload run src/seed/importSubscribers.ts`). Server-side CLI only; there is no endpoint.
 *
 * - DRY RUN by default: reads the file and the database, writes nothing. `--apply` writes.
 * - Output is counts only. No address is printed or logged, not even in an error: a failure prints only the error class
 *   and code (a database error message carries the query parameters, i.e. addresses).
 * - The export is owner-supplied personal data and must stay OUTSIDE the repository; a path inside it (after resolving
 *   symlinks, case-insensitively on Windows) is refused.
 * - Subscribed rows with an OPTIN_TIME become `confirmed` (consentAt = OPTIN_TIME, confirmedAt = CONFIRM_TIME only). A subscribed
 *   row with NO valid OPTIN_TIME becomes `pending` (importedFrom `mailchimp-import-no-optin-time`): it receives nothing until it
 *   re-confirms (npm run newsletter:reconfirm). Unsubscribed and cleaned rows (or files with UNSUB_TIME / CLEAN_TIME) are imported
 *   as blocking rows (unsubscribed / bounced). Times must be exactly YYYY-MM-DD HH:MM:SS (UTC). An --apply run writes an audit row
 *   (counts, file sha256, operator; no personal data).
 *   See docs/api-contracts.md "Go-live C4: newsletter".
 * - `--assume-subscribed`: only for Mailchimp's "Subscribed" segment export, which has no Status column.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import config from '@payload-config'
import { getPayload } from 'payload'

import { isPathInside } from '../lib/pathGuard'
import { CliUsageError, cliFailureMessage } from '../lib/safeLog'
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
  if (!file) throw new CliUsageError('Usage: npm run import:subscribers -- --file <path-to-csv> [--apply] [--assume-subscribed]')
  let abs: string
  try {
    abs = fs.realpathSync.native(path.resolve(file))
  } catch {
    throw new CliUsageError('The file does not exist or cannot be read.')
  }
  // Without a .git folder (a deployed copy) the app directory itself is the boundary.
  const cwd = fs.realpathSync.native(process.cwd())
  const root = fs.realpathSync.native(repoRoot(cwd) ?? cwd)
  if (isPathInside(abs, root)) {
    throw new CliUsageError(
      'Refusing to read a file inside the repository. Keep the Mailchimp export outside it (it is personal data).',
    )
  }
  const stat = fs.statSync(abs)
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new CliUsageError('The file must be a regular file of at most 50 MB.')

  const apply = flag('--apply')
  const payload = await getPayload({ config })
  const counts = await runSubscriberImport(payload, fs.readFileSync(abs, 'utf8'), {
    apply,
    assumeSubscribed: flag('--assume-subscribed'),
    operator: os.userInfo().username,
  })
  console.log(formatImportReport(counts, apply))
  if (counts.refused) process.exitCode = 2
}

try {
  await main()
  process.exit(process.exitCode ?? 0)
} catch (err) {
  console.error(cliFailureMessage(err))
  process.exit(1)
}
