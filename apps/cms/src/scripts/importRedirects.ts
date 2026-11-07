/**
 * `npm run import:redirects -- <flags>` (runs `payload run src/scripts/importRedirects.ts -- <flags>`).
 * See lib/redirectCli.ts and docs/api-contracts.md "Go-live C7: redirects". Prints counts only, never an address.
 */
import config from '@payload-config'
import { getPayload } from 'payload'

import { runImport } from '../lib/redirectCli'

const payload = await getPayload({ config })
const code = await runImport(payload, process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
process.exit(code)
