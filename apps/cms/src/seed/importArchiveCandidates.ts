/**
 * `npm run import:archive-candidates -- --file <candidates.jsonl> [--apply] [--manifest <dir>] ...`
 * (runs `payload run src/seed/importArchiveCandidates.ts`). Dry run unless `--apply`. See docs/import.md, "Archive candidates".
 */
import config from '@payload-config'
import { getPayload } from 'payload'

import { runArchiveCli } from '../import/archiveCli'

const payload = await getPayload({ config })
const code = await runArchiveCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) }, payload)
process.exit(code)
