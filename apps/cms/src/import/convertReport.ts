import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { isInsideRepo, type Log, parseFlags } from '../lib/redirectCli'
import { type ConversionReport, DEFAULT_MAX_INPUT_BYTES, HtmlConversionError, htmlToLexical } from './htmlToLexical'
import { PrivateOutError, writePrivateOut } from './privateOut'

/**
 * `npm run import:convert -- --in <folder of .html files> [--old-host a.test,b.test] [--slug-map map.json]
 * [--assume-images] [--detail-file <path outside the repository>]`
 *
 * Convert-only QA run: every `.html` file in the folder goes through `htmlToLexical`, nothing is written to the
 * database and no network is used. Images count as unresolved unless `--assume-images` (then every image counts as
 * resolved, so only the other losses show). The summary printed holds counts only; per-file details (which name files
 * and old addresses) go to `--detail-file`, which must be outside the repository.
 */

export const CONVERT_MAX_FILES = 50_000

type Totals = Record<string, number>
const add = (t: Totals, key: string, n = 1) => {
  t[key] = (t[key] ?? 0) + n
}
const addMap = (t: Totals, prefix: string, rec: Record<string, number>) => {
  for (const [k, v] of Object.entries(rec)) add(t, `${prefix}.${k}`, v)
}

export function summarise(reports: readonly ConversionReport[]): Totals {
  const t: Totals = {}
  for (const r of reports) {
    add(t, 'inputBytes', r.inputBytes)
    add(t, 'nodes', r.nodeCount)
    add(t, 'entitiesDecoded', r.entitiesDecoded)
    addMap(t, 'shortcodeRemoved', r.shortcodesRemoved)
    addMap(t, 'unknownElement', r.unknownElements)
    addMap(t, 'unknownBlock', r.unknownBlocks)
    addMap(t, 'droppedElement', r.droppedElements)
    add(t, 'links.rewritten', r.links.rewritten)
    add(t, 'links.unmapped', r.links.unmapped.length)
    add(t, 'links.convertedToText', r.links.converted.length)
    add(t, 'images.resolved', r.images.resolved)
    add(t, 'images.unresolved', r.images.unresolved.length)
    add(t, 'youtube', r.youtube)
    add(t, 'audioVideo.resolved', r.audioVideo.resolved)
    add(t, 'audioVideo.unresolved-media', r.audioVideo.unresolvedMedia)
    add(t, 'audioVideo.unsupported', r.audioVideo.unsupported)
    add(t, 'embeds.linked', r.embeds.linked.length)
    add(t, 'embeds.dropped', r.embeds.dropped.length)
    add(t, 'tables.kept', r.tables.kept)
    add(t, 'tables.flattened', r.tables.flattened.length)
    add(t, 'headingsNormalised', r.headingsNormalised)
    add(t, 'emptyBlocksDropped', r.emptyBlocksDropped)
    add(t, 'horizontalRulesDropped', r.horizontalRulesDropped)
    add(t, 'moreMarkers', r.moreMarkers)
    add(t, 'commentsDropped', r.commentsDropped)
    add(t, 'deepNestingFlattened', r.deepNestingFlattened)
    add(t, 'listsFlattened', r.listsFlattened)
    add(t, 'warnings', r.warnings.length)
  }
  return t
}

export async function runConvertReport(argv: readonly string[], log: Log): Promise<number> {
  const flags = parseFlags(argv)
  const dir = typeof flags.in === 'string' ? flags.in : null
  if (!dir) {
    log.err(
      'Usage: npm run import:convert -- --in <folder of .html files> [--old-host a.test,b.test] [--slug-map map.json] [--assume-images] [--detail-file <path outside the repo>]',
    )
    return 2
  }
  const detailFlag = flags['detail-file']
  if (detailFlag !== undefined && (typeof detailFlag !== 'string' || detailFlag === '' || isInsideRepo(detailFlag))) {
    log.err('--detail-file must be a path outside the repository (details name files and old addresses).')
    return 2
  }
  const oldHosts = typeof flags['old-host'] === 'string' ? flags['old-host'].split(',').map((h) => h.trim()).filter(Boolean) : []
  let slugMap: Record<string, string> = {}
  if (typeof flags['slug-map'] === 'string') {
    try {
      const parsed = JSON.parse(await readFile(flags['slug-map'], 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      slugMap = Object.fromEntries(Object.entries(parsed as object).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    } catch {
      log.err('--slug-map must be a JSON object of old slug to new slug.')
      return 2
    }
  }
  const assume = flags['assume-images'] === true

  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.html')).sort()
  } catch {
    log.err('The --in folder cannot be read.')
    return 2
  }
  if (names.length > CONVERT_MAX_FILES) {
    log.err(`More than ${CONVERT_MAX_FILES} files; split the folder.`)
    return 2
  }

  const reports: ConversionReport[] = []
  const details: Record<string, unknown> = {}
  const failures: Totals = {}
  let converted = 0
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const info = await stat(file)
      if (!info.isFile()) continue
      if (info.size > DEFAULT_MAX_INPUT_BYTES) throw new HtmlConversionError('input-too-large', 'file larger than the input limit')
      const html = await readFile(file, 'utf8')
      const result = htmlToLexical(html, {
        oldHosts,
        slugMap,
        articleTitle: name.replace(/\.html$/i, ''),
        resolveImage: assume ? () => ({ mediaId: 1 }) : () => null,
        resolveMedia: assume ? () => ({ mediaId: 1 }) : () => null,
      })
      converted++
      reports.push(result.report)
      details[name] = result.report
    } catch (err) {
      const code = err instanceof HtmlConversionError ? err.code : 'unexpected-error'
      add(failures, code)
      details[name] = { failed: code, message: err instanceof Error ? err.message : String(err) }
    }
  }

  const totals = summarise(reports)
  log.out(`files: ${names.length}`)
  log.out(`converted: ${converted}`)
  for (const [code, n] of Object.entries(failures).sort()) log.out(`failed.${code}: ${n}`)
  for (const [key, n] of Object.entries(totals).sort(([a], [b]) => a.localeCompare(b))) if (n > 0) log.out(`${key}: ${n}`)
  if (typeof detailFlag === 'string') {
    try {
      writePrivateOut(path.resolve(detailFlag), `${JSON.stringify(details, null, 2)}\n`, { notInside: [dir] })
    } catch (err) {
      log.err(`The detail file was not written (${err instanceof PrivateOutError ? err.code : 'OUT_FAILED'}); it must be a new file outside the --in folder.`)
      return 2
    }
    log.out('Details (they name files and old addresses) written to the detail file.')
  }
  return Object.keys(failures).length > 0 ? 1 : 0
}
