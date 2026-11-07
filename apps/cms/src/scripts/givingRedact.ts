/**
 * `npm run giving:redact -- CTG-<32 hex>` (runs `payload run src/scripts/givingRedact.ts`): NDPA erasure of one donation's
 * e-mail and name, for an operator with server access. Same code path as `POST /api/donations/:id/redact`; audited with
 * actorRole `cli`. Prints the reference and whether anything changed, never the removed details.
 */
import config from '@payload-config'
import { getPayload, type PayloadRequest } from 'payload'

import { redactDonation } from '../lib/giving/redact'
import { isDonationReference } from '../lib/giving/reference'
import { safeErrorSummary } from '../lib/safeLog'

const reference = process.argv.slice(2).find((a) => a !== '--') ?? ''
if (!isDonationReference(reference)) {
  console.error('Usage: npm run giving:redact -- CTG-<32 lowercase hex characters>')
  process.exit(1)
}
const payload = await getPayload({ config })
try {
  const result = await redactDonation({ payload, user: null, context: {} } as unknown as PayloadRequest, { reference }, 'cli')
  if (!result.found) {
    console.error(`No donation with reference ${reference}.`)
    process.exit(1)
  }
  console.log(result.changed ? `Removed e-mail and name from ${result.reference}.` : `${result.reference} already had no e-mail or name.`)
  process.exit(0)
} catch (err) {
  console.error(`Redaction failed: ${safeErrorSummary(err)}`)
  process.exit(1)
}
