/**
 * Erase imported subscribers who never re-confirmed, after the deadline:
 *   npm run newsletter:purge-unconfirmed -- --deadline YYYY-MM-DD --dry-run|--apply [--limit N] [--include-unsent]
 * DRY RUN by default; refuses while the deadline is still in the future. The address is reduced to its salted hash
 * (suppression record), audited with counts only.
 */
import config from '@payload-config'
import { getPayload } from 'payload'

import { CliUsageError, cliFailureMessage } from '../lib/safeLog'
import { formatPurgeReport, parseCommandArgs, runPurgeUnconfirmed } from '../lib/subscriberReconfirm'

try {
  const args = parseCommandArgs(process.argv.slice(2))
  if (!args.deadline) throw new CliUsageError('--deadline YYYY-MM-DD is required (the date given in the re-permission mail).')
  const payload = await getPayload({ config })
  const counts = await runPurgeUnconfirmed(payload, { ...args, deadline: args.deadline })
  console.log(formatPurgeReport(counts, args.apply))
  process.exit(0)
} catch (err) {
  console.error(cliFailureMessage(err))
  process.exit(1)
}
