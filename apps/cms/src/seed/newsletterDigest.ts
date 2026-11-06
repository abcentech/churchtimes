/**
 * Daily digest from the command line (server-side, for the owner and staff):
 *   npm run newsletter:digest                         dry run: writes today's issue as a draft newsletter-issue, sends nothing
 *   npm run newsletter:digest -- --test-send <email>  sends today's issue, marked [TEST], to that address ONLY if it belongs
 *                                                     to a staff account; never to subscribers
 * Scheduled sending is not started here: it runs inside the CMS (docs/w12/growth.md). Output is counts only.
 */
import config from '@payload-config'
import { getPayload } from 'payload'

import { createDigestDraft, parseDigestCliArgs, sendTestDigest } from '../lib/newsletterDigestRunner'
import { cliFailureMessage } from '../lib/safeLog'

try {
  const args = parseDigestCliArgs(process.argv.slice(2))
  const payload = await getPayload({ config })
  if (args.mode === 'dry-run') {
    const r = await createDigestDraft(payload)
    console.log(r.outcome === 'draft' ? `Dry run: draft issue ${r.issueId} written with ${r.stories} stories. Nothing was sent.` : 'Dry run: no new published stories since the last issue. Nothing written.')
  } else {
    const staff = await payload.find({ collection: 'users', where: { email: { equals: args.to } }, limit: 1, depth: 0, overrideAccess: true })
    if (staff.docs.length === 0) {
      console.error('Refused: --test-send only mails the address of a staff account.')
      process.exit(2)
    }
    const r = await sendTestDigest(payload, args.to)
    console.log(r.outcome === 'sent' ? `Test send: 1 mail with ${r.stories} stories handed to the SMTP relay.` : 'Test send: no new published stories, nothing sent.')
  }
  process.exit(0)
} catch (err) {
  console.error(cliFailureMessage(err))
  process.exit(1)
}
