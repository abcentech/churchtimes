/**
 * `npm run import:inspect -- --file <path-to-wxr>`
 * Read-only: no database, no network, no writes. Prints counts only. See docs/import.md.
 */
import { runInspectCli } from '../import/inspect'

const code = await runInspectCli(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
process.exit(code)
