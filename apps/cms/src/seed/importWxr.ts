/**
 * `npm run import:wxr -- --file <export.xml> [--apply] ...` (runs `payload run src/seed/importWxr.ts`).
 * Dry run unless `--apply`. See docs/import.md, "Loader".
 */
import config from '@payload-config'
import { getPayload } from 'payload'

import { runImportCli } from '../import/cli'

const payload = await getPayload({ config })
const code = await runImportCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) }, payload)
process.exit(code)
