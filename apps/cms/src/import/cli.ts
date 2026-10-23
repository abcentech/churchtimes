import type { Payload } from 'payload'

import { safeErrorSummary } from '../lib/safeLog'
import { formatImportReport } from './qa'
import { isCategorySlug } from './mapping'
import { DEFAULT_FALLBACK_CATEGORY, ImportError, runImport, type ImportOptions } from './run'
import { WxrError } from './wxr'

/**
 * `npm run import:wxr -- --file <export.xml> [--uploads <folder>] [--manifest <path>] [--apply] [--update]
 *  [--old-host a.test,b.test] [--limit N] [--category-map <tag-map.json outside the repo>]
 *  [--fallback-category <slug>] [--fallback-category-name <name>]`
 *
 * DRY RUN by default (nothing is written). `--apply` writes and needs a rollback manifest path, given by `--manifest`
 * or the `IMPORT_MANIFEST_PATH` environment variable; it must be outside the repository and must not exist yet.
 * Output is counts only. Errors print one short code, never data.
 */
export type CliIo = { out: (line: string) => void; err: (line: string) => void }

export function parseImportArgs(argv: readonly string[], env: Record<string, string | undefined>): ImportOptions | null {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    const v = i >= 0 ? argv[i + 1] : undefined
    // `--file --apply` must not read `--apply` as the file name.
    return v !== undefined && v.startsWith('--') ? undefined : v
  }
  const file = value('--file')
  if (!file) return null
  for (const name of ['--uploads', '--manifest', '--old-host', '--limit', '--category-map', '--fallback-category', '--fallback-category-name']) {
    if (argv.includes(name) && !value(name)) return null
  }
  const limitRaw = value('--limit')
  let limit: number | undefined
  if (limitRaw !== undefined) {
    if (!/^\d{1,7}$/.test(limitRaw) || Number(limitRaw) < 1) return null
    limit = Number(limitRaw)
  }
  const fallbackSlug = value('--fallback-category') ?? env.IMPORT_FALLBACK_CATEGORY
  const fallbackName = value('--fallback-category-name') ?? env.IMPORT_FALLBACK_CATEGORY_NAME
  let fallbackCategory: ImportOptions['fallbackCategory']
  if (fallbackSlug || fallbackName) {
    const slug = (fallbackSlug ?? DEFAULT_FALLBACK_CATEGORY.slug).trim()
    const title = (fallbackName ?? (fallbackSlug ? '' : DEFAULT_FALLBACK_CATEGORY.title)).trim() || slug
    if (!isCategorySlug(slug) || title.length > 120) return null
    fallbackCategory = { slug, title }
  }
  return {
    file,
    uploadsRoot: value('--uploads'),
    manifestPath: value('--manifest') ?? env.IMPORT_MANIFEST_PATH,
    dryRun: !argv.includes('--apply'),
    update: argv.includes('--update') || argv.includes('--force-update'),
    forceUpdate: argv.includes('--force-update'),
    oldHosts: (value('--old-host') ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    limit,
    categoryMapFile: value('--category-map') ?? env.IMPORT_CATEGORY_MAP,
    fallbackCategory,
  }
}

/** Returns the process exit code. */
export async function runImportCli(
  argv: readonly string[],
  io: CliIo,
  payload: Payload,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const opts = parseImportArgs(argv, env)
  if (!opts) {
    io.err('IMPORT_USAGE')
    return 2
  }
  // SIGINT / SIGTERM: finish the post being written, then end cleanly (manifest closed, report printed).
  const signal = { stopped: false }
  const stop = () => {
    signal.stopped = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    const report = await runImport(payload, { ...opts, signal, progress: (l) => io.err(l) })
    io.out(formatImportReport(report))
    if (signal.stopped) return 1
    return Object.keys(report.articles.skipped).some((k) => k === 'write-failed' || k.startsWith('conversion-')) ? 1 : 0
  } catch (err) {
    io.err(err instanceof ImportError ? err.code : err instanceof WxrError ? err.code : `IMPORT_FAILED ${safeErrorSummary(err)}`)
    return err instanceof ImportError && err.code !== 'IMPORT_TOO_MANY_FAILURES' ? 2 : 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}
