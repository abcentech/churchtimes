import type { Payload } from 'payload'

import { safeErrorSummary } from '../lib/safeLog'
import type { CliIo } from './cli'
import { formatRollbackReport, RollbackError, rollbackHadFailures, runRollback, type RollbackOptions } from './rollback'

/**
 * `npm run import:rollback -- --manifest <path> [--apply] [--force] [--allow-incomplete]`
 *
 * DRY RUN unless `--apply`. Output is counts only; errors print one short code. Exit codes: 0 clean, 1 some item
 * failed, 2 usage or refusal (missing, unreadable or incomplete manifest).
 */
export function parseRollbackArgs(argv: readonly string[], env: Record<string, string | undefined>): RollbackOptions | null {
  const known = new Set(['--manifest', '--apply', '--force', '--allow-incomplete'])
  for (const a of argv) if (a.startsWith('--') && !known.has(a)) return null
  const i = argv.indexOf('--manifest')
  const v = i >= 0 ? argv[i + 1] : undefined
  if (i >= 0 && (v === undefined || v.startsWith('--'))) return null
  // An apply names its manifest explicitly on the command line: no environment fallback for a destructive run.
  if (argv.includes('--apply') && i < 0) return null
  const manifestPath = v ?? env.IMPORT_MANIFEST_PATH
  if (!manifestPath) return null
  return {
    manifestPath,
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
    allowIncomplete: argv.includes('--allow-incomplete'),
  }
}

/** Returns the process exit code. */
export async function runRollbackCli(
  argv: readonly string[],
  io: CliIo,
  payload: Payload,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const opts = parseRollbackArgs(argv, env)
  if (!opts) {
    io.err('ROLLBACK_USAGE')
    return 2
  }
  try {
    const report = await runRollback(payload, { ...opts, progress: (l) => io.err(l) })
    io.out(formatRollbackReport(report))
    return rollbackHadFailures(report) ? 1 : 0
  } catch (err) {
    io.err(err instanceof RollbackError ? err.code : `ROLLBACK_FAILED ${safeErrorSummary(err)}`)
    return err instanceof RollbackError ? 2 : 1
  }
}
