/**
 * `npm run export:media-map -- <flags>` (runs `payload run src/scripts/exportMediaMap.ts -- <flags>`).
 * See lib/mediaMapCli.ts and docs/api-contracts.md "Legacy media map". Prints counts only, never a path.
 */
import config from '@payload-config'
import { getPayload } from 'payload'

import { runMediaMapExport } from '../lib/mediaMapCli'

const payload = await getPayload({ config })
const code = await runMediaMapExport(payload, process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
process.exit(code)
