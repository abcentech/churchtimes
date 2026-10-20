/**
 * `npm run import:wxr-report -- --file <path-to-wxr> [--detail-file <path-outside-repo>]`
 * Parse-only: no database, no network. Prints counts only. See docs/import.md.
 */
import { runWxrReportCli } from '../import/wxrReport'

const code = await runWxrReportCli(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
process.exit(code)
