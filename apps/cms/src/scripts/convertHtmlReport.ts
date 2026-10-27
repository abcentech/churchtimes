/**
 * `npm run import:convert -- <flags>`: convert-only QA report for the WordPress HTML to Lexical converter.
 * No database, no network. See import/convertReport.ts and docs/import.md. Prints counts only.
 */
import { runConvertReport } from '../import/convertReport'

const code = await runConvertReport(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
})
process.exit(code)
