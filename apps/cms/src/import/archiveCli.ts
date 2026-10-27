import type { Payload } from 'payload'

import { safeErrorSummary } from '../lib/safeLog'
import { ArchiveImportError, formatArchiveReport, runArchiveImport, type ArchiveImportOptions } from './archiveCandidates'
import type { CliIo } from './cli'

/**
 * `npm run import:archive-candidates -- --file <candidates.jsonl> [--apply] [--manifest <dir>] [--category <slug>] [--batch <label>]`
 *
 * DRY RUN by default. `--apply` needs `--manifest <existing directory outside every repository>` (rollback manifest and
 * per-row detail file are created there, mode 0600). Output is counts only; errors print one short code.
 */
export function parseArchiveArgs(argv: readonly string[]): ArchiveImportOptions | null {
  const known = new Set(['--file', '--apply', '--manifest', '--category', '--batch'])
  const valued = ['--file', '--manifest', '--category', '--batch']
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    const v = i >= 0 ? argv[i + 1] : undefined
    return v !== undefined && v.startsWith('--') ? undefined : v
  }
  for (const a of argv) if (a.startsWith('--') && !known.has(a)) return null
  for (const n of valued) if (argv.includes(n) && !value(n)) return null
  const file = value('--file')
  if (!file) return null
  return { file, apply: argv.includes('--apply'), manifestDir: value('--manifest'), category: value('--category'), batch: value('--batch') }
}

/** Returns the process exit code. */
export async function runArchiveCli(argv: readonly string[], io: CliIo, payload: Payload): Promise<number> {
  const opts = parseArchiveArgs(argv)
  if (!opts) {
    io.err('ARCHIVE_USAGE')
    return 2
  }
  const signal = { stopped: false }
  const stop = () => {
    signal.stopped = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const report = await runArchiveImport(payload, { ...opts, signal, progress: (l) => io.err(l) })
    io.out(formatArchiveReport(report))
    if (signal.stopped) return 1
    return Object.keys(report.failed).length > 0 ? 1 : 0
  } catch (err) {
    io.err(err instanceof ArchiveImportError ? err.code : `ARCHIVE_FAILED ${safeErrorSummary(err)}`)
    return err instanceof ArchiveImportError && err.code !== 'ARCHIVE_TOO_MANY_FAILURES' ? 2 : 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
