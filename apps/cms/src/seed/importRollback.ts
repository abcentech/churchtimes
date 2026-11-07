/**
 * `npm run import:rollback -- --manifest <path> [--apply] [--force] [--allow-incomplete]`
 * (runs `payload run src/seed/importRollback.ts`). Dry run unless `--apply`. See docs/import.md, "Rollback".
 */
import config from '@payload-config'
import { getPayload } from 'payload'

import { runRollbackCli } from '../import/rollbackCli'

const payload = await getPayload({ config })
const code = await runRollbackCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) }, payload)
process.exit(code)
