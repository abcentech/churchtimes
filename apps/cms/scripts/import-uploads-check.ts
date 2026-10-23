/**
 * `npm run import:uploads-check -- --uploads <dir> --wxr <export.xml> [--out <detail file>]`
 * Read-only: no database, no network, nothing executed. Prints counts only. See docs/import.md and docs/uploads-download.md.
 */
import { runUploadsCheckCli } from '../src/import/uploadsCheck'

const code = await runUploadsCheckCli(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
process.exit(code)
