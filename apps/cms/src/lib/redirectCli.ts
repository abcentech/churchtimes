import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { type Payload, createLocalReq } from 'payload'

import { PrivateOutError, writePrivateOut } from '../import/privateOut'
import { writeAuditLog } from './audit'
import {
  generateRedirectMap,
  loadLivePaths,
  loadPublishedLegacyArticles,
  loadStoredRows,
} from './redirectData'
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, parseRedirectCsv, planRedirectImport } from './redirectImport'
import { checkAddresses, deriveRule, errorCode } from './redirectMap'
import { parseAllowedHosts, parseLegacyHosts, resolveArticlePathTemplate } from './redirectPaths'

/**
 * The three redirect commands (`export:redirects`, `check:redirects`, `import:redirects`). The thin scripts in
 * `src/scripts` parse the process arguments and call these with a Payload instance; they return an exit code and write
 * only to the `log` they are given. NOTHING here prints an address, a rule label or an error message that could carry
 * one: counts and error CODES only. Details (rule labels, error messages) go to `--detail-file <path>` when asked, and
 * that path must be outside the repository so a log or a commit never carries them.
 */

export type Log = { out: (line: string) => void; err: (line: string) => void }

/** The most `--urls` input the check command reads. */
export const CHECK_MAX_BYTES = 5 * 1024 * 1024
export const CHECK_MAX_LINES = 100_000

/** `--flag value`, `--flag=value` and bare `--flag`. */
export function parseFlags(argv: readonly string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--') || arg === '--') continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      flags[arg.slice(2)] = argv[++i]
    } else {
      flags[arg.slice(2)] = true
    }
  }
  return flags
}

const needValue = (flags: Record<string, string | true>, name: string): string | null =>
  typeof flags[name] === 'string' && flags[name] !== '' ? (flags[name] as string) : null

/** The git working tree that contains `from`, or null. */
function repoRootOf(from: string): string | null {
  let dir = path.resolve(from)
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** True when `file` would land inside the repository (or the current directory tree). */
export function isInsideRepo(file: string, cwd: string = process.cwd()): boolean {
  const target = path.resolve(file)
  const roots = [path.resolve(cwd), repoRootOf(cwd)].filter((r): r is string => r !== null)
  return roots.some((root) => {
    const rel = path.relative(root, target)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

/** `--detail-file`: validates the path (outside the repo) before anything is written. Null = not requested. */
function detailTarget(flags: Record<string, string | true>, log: Log): { file: string | null; refused: boolean } {
  const value = flags['detail-file']
  if (value === undefined) return { file: null, refused: false }
  if (typeof value !== 'string' || value === '') {
    log.err('--detail-file needs a path outside the repository.')
    return { file: null, refused: true }
  }
  if (isInsideRepo(value)) {
    log.err('--detail-file must be a path outside the repository (details name old addresses and must never be committed).')
    return { file: null, refused: true }
  }
  return { file: value, refused: false }
}

async function writeDetails(file: string | null, lines: readonly string[], log: Log): Promise<void> {
  if (!file) return
  try {
    // Exclusive create: a detail file never replaces (truncates) an existing file, such as an input.
    writePrivateOut(path.resolve(file), `${lines.join('\n')}\n`)
  } catch (err) {
    log.err(`The detail file was not written (${err instanceof PrivateOutError ? err.code : 'OUT_FAILED'}); it must be a new file.`)
    return
  }
  log.out(`Details (${lines.length} lines, they name addresses) written to the detail file.`)
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export async function runExport(payload: Payload, argv: readonly string[], log: Log): Promise<number> {
  const flags = parseFlags(argv)
  const out = needValue(flags, 'out')
  if (!out) {
    log.err('Usage: npm run export:redirects -- --out <file> [--detail-file <path outside the repo>]')
    return 2
  }
  const detail = detailTarget(flags, log)
  if (detail.refused) return 2
  try {
    const { body, map, bytes, stats, details } = await generateRedirectMap(payload)
    await mkdir(path.dirname(path.resolve(out)), { recursive: true })
    await writeFile(out, body, 'utf8')
    log.out(
      `Wrote ${map.count} rules (${bytes} bytes, ${map.version}) to the output file. ` +
        `stored=${stats.stored} derived=${stats.derived} overridden-derived=${stats.overriddenDerived} ` +
        `flattened=${stats.flattened} flattened-to-gone=${stats.flattenedToGone} dropped=${JSON.stringify(stats.dropped)} ` +
        `skipped=${JSON.stringify(stats.skipped)}`,
    )
    log.out('The output file is a generated artifact: do not commit it.')
    await writeDetails(detail.file, details, log)
    return 0
  } catch (err) {
    log.err(`export:redirects failed, nothing written. error=${errorCode(err)}`)
    await writeDetails(detail.file, [errorText(err)], log).catch(() => undefined)
    return 1
  }
}

export async function runCheck(payload: Payload, argv: readonly string[], log: Log): Promise<number> {
  const flags = parseFlags(argv)
  const file = needValue(flags, 'urls')
  if (!file) {
    log.err(
      'Usage: npm run check:redirects -- --urls <file> [--detail-file <path outside the repo>]   (one old address per line; addresses are never printed)',
    )
    return 2
  }
  const detail = detailTarget(flags, log)
  if (detail.refused) return 2
  let text: string
  try {
    if ((await stat(file)).size > CHECK_MAX_BYTES) {
      log.err(`The --urls file is larger than ${CHECK_MAX_BYTES} bytes.`)
      return 2
    }
    text = await readFile(file, 'utf8')
  } catch {
    log.err('Could not read the --urls file.')
    return 2
  }
  const lines = text.split(/\r?\n/)
  if (lines.length > CHECK_MAX_LINES + 1) {
    log.err(`The --urls file has more than ${CHECK_MAX_LINES} lines.`)
    return 2
  }
  try {
    const template = resolveArticlePathTemplate()
    const { map, details } = await generateRedirectMap(payload)
    const live = await loadLivePaths(payload, template)
    const summary = checkAddresses(lines, map.rules, live)
    log.out(
      `Checked ${summary.total} addresses (${summary.ignored} blank or comment lines ignored): ` +
        `${summary.resolved} resolved, ${summary.unresolved} unresolved.`,
    )
    log.out(`Resolved by answer: 301=${summary.byStatus['301']} 302=${summary.byStatus['302']} 410=${summary.byStatus['410']} live-article=${summary.byStatus.live}`)
    log.out(
      `Unresolved by reason: no-rule=${summary.unresolvedBy.noRule} query-only=${summary.unresolvedBy.queryOnly} invalid=${summary.unresolvedBy.invalid}`,
    )
    log.out(`summary=${JSON.stringify(summary)}`)
    await writeDetails(detail.file, details, log)
    return summary.unresolved > 0 ? 1 : 0
  } catch (err) {
    // Counts and a code only: an error message can carry rule labels, which are old addresses.
    log.err(`check:redirects failed. error=${errorCode(err)}`)
    await writeDetails(detail.file, [errorText(err)], log).catch(() => undefined)
    return 1
  }
}

export async function runImport(payload: Payload, argv: readonly string[], log: Log): Promise<number> {
  const flags = parseFlags(argv)
  const file = needValue(flags, 'file')
  const apply = flags.apply === true
  if (!file) {
    log.err('Usage: npm run import:redirects -- --file <csv> [--apply]   (CSV header: from,to,status; dry run unless --apply)')
    return 2
  }
  let text: string
  try {
    const info = await stat(file)
    if (info.size > IMPORT_MAX_BYTES) {
      log.err(`The CSV file is larger than ${IMPORT_MAX_BYTES} bytes.`)
      return 2
    }
    text = await readFile(file, 'utf8')
  } catch {
    log.err('Could not read the --file file.')
    return 2
  }
  const parsed = parseRedirectCsv(text)
  if ('error' in parsed) {
    log.err(parsed.error)
    return 2
  }
  if (parsed.rows.length > IMPORT_MAX_ROWS) {
    log.err(`The CSV has more than ${IMPORT_MAX_ROWS} rows (the redirect list cap); split it.`)
    return 2
  }

  try {
    const template = resolveArticlePathTemplate()
    const allowedHosts = parseAllowedHosts()
    const legacyHosts = parseLegacyHosts()
    const [existing, articles, live] = await Promise.all([
      loadStoredRows(payload),
      loadPublishedLegacyArticles(payload),
      loadLivePaths(payload, template),
    ])
    const derived = articles.flatMap((a) => {
      const d = deriveRule(a, template, legacyHosts)
      return 'rule' in d ? [d.rule] : []
    })
    const plan = planRedirectImport({ rows: parsed.rows, existing, derived, livePaths: live, allowedHosts })
    const c = plan.counts
    log.out(
      `${apply ? 'Importing' : 'Dry run'}: ${c.rows} rows, ${c.accepted} ${apply ? 'to create' : 'would be created'} ` +
        `(${c.convertedToGone} of them written as 410 because their target is gone). ` +
        `Skipped: invalid-from=${c.invalid.from} invalid-to=${c.invalid.to} invalid-status=${c.invalid.status} ` +
        `pattern=${c.invalid.pattern} duplicate-in-file=${c.duplicateInFile} already-stored=${c.alreadyStored} ` +
        `owned-by-article-rule=${c.conflictsWithDerived} live-article-address=${c.shadowsArticle} loops=${c.loops} ` +
        `absolute-target-is-a-rule=${c.absoluteChain}.`,
    )
    if (!apply) {
      log.out('Nothing was written. Re-run with --apply to create the rows.')
      return 0
    }

    let created = 0
    let failed = 0
    for (const row of plan.accepted) {
      try {
        await payload.create({
          collection: 'redirects',
          data: { from: row.from, to: row.to, status: row.status, source: 'rank-math' } as never,
          overrideAccess: true,
          context: { redirectImport: true },
        })
        created++
      } catch {
        failed++
      }
    }
    const req = await createLocalReq({}, payload)
    await writeAuditLog(req, {
      action: 'redirect.import',
      collection: 'redirects',
      docId: 'import',
      actorRole: 'system',
      summary: `Rank Math import: ${created} created, ${failed} failed, ${c.rows - c.accepted} skipped of ${c.rows} rows`,
      details: { counts: c, created, failed },
    })
    log.out(`Created ${created} rows${failed ? `, ${failed} failed to save` : ''}. Source is rank-math.`)
    return failed > 0 ? 1 : 0
  } catch (err) {
    log.err(`import:redirects failed. error=${errorCode(err)}`)
    return 1
  }
}
