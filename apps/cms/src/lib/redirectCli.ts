import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { type Payload, createLocalReq } from 'payload'

import { writeAuditLog } from './audit'
import {
  generateRedirectMap,
  loadLivePaths,
  loadPublishedLegacyArticles,
  loadStoredRows,
} from './redirectData'
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, parseRedirectCsv, planRedirectImport } from './redirectImport'
import { checkAddresses, deriveRule } from './redirectMap'
import { parseAllowedHosts, resolveArticlePathTemplate } from './redirectPaths'

/**
 * The three redirect commands (`export:redirects`, `check:redirects`, `import:redirects`). The thin scripts in
 * `src/scripts` parse the process arguments and call these with a Payload instance; they return an exit code and write
 * only to the `log` they are given. NOTHING here prints an address from an input file: counts only.
 */

export type Log = { out: (line: string) => void; err: (line: string) => void }

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

export async function runExport(payload: Payload, argv: readonly string[], log: Log): Promise<number> {
  const out = needValue(parseFlags(argv), 'out')
  if (!out) {
    log.err('Usage: npm run export:redirects -- --out <file>')
    return 2
  }
  try {
    const { body, map, bytes, stats } = await generateRedirectMap(payload)
    await mkdir(path.dirname(path.resolve(out)), { recursive: true })
    await writeFile(out, body, 'utf8')
    log.out(
      `Wrote ${map.count} rules (${bytes} bytes, ${map.version}) to the output file. ` +
        `stored=${stats.stored} derived=${stats.derived} flattened=${stats.flattened} pointsToGone=${stats.pointsToGone} ` +
        `skipped=${JSON.stringify(stats.skipped)}`,
    )
    log.out('The output file is a generated artifact: do not commit it.')
    return 0
  } catch (err) {
    log.err(`export:redirects failed, nothing written: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

export async function runCheck(payload: Payload, argv: readonly string[], log: Log): Promise<number> {
  const file = needValue(parseFlags(argv), 'urls')
  if (!file) {
    log.err('Usage: npm run check:redirects -- --urls <file>   (one old address per line; the addresses are never printed)')
    return 2
  }
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    log.err('Could not read the --urls file.')
    return 2
  }
  try {
    const template = resolveArticlePathTemplate()
    const { map } = await generateRedirectMap(payload)
    const live = await loadLivePaths(payload, template)
    const summary = checkAddresses(text.split(/\r?\n/), map.rules, live)
    log.out(
      `Checked ${summary.total} addresses (${summary.ignored} blank or comment lines ignored): ` +
        `${summary.resolved} resolved, ${summary.unresolved} unresolved.`,
    )
    log.out(`Resolved by answer: 301=${summary.byStatus['301']} 302=${summary.byStatus['302']} 410=${summary.byStatus['410']} live-article=${summary.byStatus.live}`)
    log.out(
      `Unresolved by reason: no-rule=${summary.unresolvedBy.noRule} query-only=${summary.unresolvedBy.queryOnly} invalid=${summary.unresolvedBy.invalid}`,
    )
    log.out(`summary=${JSON.stringify(summary)}`)
    return summary.unresolved > 0 ? 1 : 0
  } catch (err) {
    log.err(`check:redirects failed: ${err instanceof Error ? err.message : String(err)}`)
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
    log.err(`The CSV has more than ${IMPORT_MAX_ROWS} rows; split it.`)
    return 2
  }

  try {
    const template = resolveArticlePathTemplate()
    const allowedHosts = parseAllowedHosts()
    const [existing, articles, live] = await Promise.all([
      loadStoredRows(payload),
      loadPublishedLegacyArticles(payload),
      loadLivePaths(payload, template),
    ])
    const derived = articles.flatMap((a) => {
      const d = deriveRule(a, template)
      return 'rule' in d ? [d.rule] : []
    })
    const plan = planRedirectImport({ rows: parsed.rows, existing, derived, livePaths: live, allowedHosts })
    const c = plan.counts
    log.out(
      `${apply ? 'Importing' : 'Dry run'}: ${c.rows} rows, ${c.accepted} ${apply ? 'to create' : 'would be created'}. ` +
        `Skipped: invalid-from=${c.invalid.from} invalid-to=${c.invalid.to} invalid-status=${c.invalid.status} ` +
        `pattern=${c.invalid.pattern} duplicate-in-file=${c.duplicateInFile} already-stored=${c.alreadyStored} ` +
        `owned-by-article-rule=${c.conflictsWithDerived} live-article-address=${c.shadowsArticle} loops=${c.loops}.`,
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
    log.err(`import:redirects failed: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
