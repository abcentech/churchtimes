/**
 * Re-permission mail for imported subscribers with no proof of opt-in:
 *   npm run newsletter:reconfirm -- --dry-run|--apply [--limit N] [--deadline YYYY-MM-DD] [--throttle-ms N]
 * DRY RUN by default. Server-side only. Sends ONE mail per eligible row (pending, imported without OPTIN_TIME, never mailed),
 * throttled and resumable. Output and the audit row are counts only: no address and no token is ever printed or logged.
 */
import config from '@payload-config'
import { getPayload } from 'payload'

import { cliFailureMessage } from '../lib/safeLog'
import { formatReconfirmReport, parseCommandArgs, runReconfirm } from '../lib/subscriberReconfirm'

try {
  const args = parseCommandArgs(process.argv.slice(2))
  const payload = await getPayload({ config })
  const counts = await runReconfirm(payload, args)
  console.log(formatReconfirmReport(counts, args.apply))
  process.exit(counts.stoppedEarly ? 3 : 0)
} catch (err) {
  console.error(cliFailureMessage(err))
  process.exit(1)
}
