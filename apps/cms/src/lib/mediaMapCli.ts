import { randomBytes } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Payload } from 'payload'

import { loadAnonymousMediaIds, loadMediaWithLegacyPath } from './mediaMapData'
import { type RecordedAlias, buildMediaMapDetailed, serialiseMediaMap, sha256OfBytes } from './mediaMapExport'
import { type Log, isInsideRepo, parseFlags } from './redirectCli'

/**
 * `npm run export:media-map -- [--out <file outside the repo>] [--aliases <json file>] [--detail-file <path outside the repo>]`.
 * Without `--out` it is a dry run: counts and digests only. Never prints a path or file name.
 * `--aliases` is a JSON array of `{ "alias": "2023/10/photo-300x200.jpg", "path": "2023/10/photo.jpg" }` recorded by the owner.
 * `--out` also writes `<out>.sha256` (sha256sum format) with the digest of the exact bytes of the map: that is the
 * provisioning check. `--detail-file` lists ambiguities and rejected aliases (it names paths and ids).
 * Mode 0600 has no effect on Windows: protect the folder with its permissions there.
 */

export const ALIASES_MAX_BYTES = 5 * 1024 * 1024

/**
 * True when `file` would land inside the repository or the current directory tree, also through a symlink or junction:
 * the nearest existing parent is resolved with `realpath` before comparing.
 */
export function isInsideRepoReal(file: string, cwd: string = process.cwd()): boolean {
  if (isInsideRepo(file, cwd)) return true
  const target = path.resolve(file)
  let existing = target
  const rest: string[] = []
  while (!existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) return false
    rest.unshift(path.basename(existing))
    existing = parent
  }
  try {
    const real = path.join(realpathSync(existing), ...rest)
    return isInsideRepo(real, realpathSync(cwd))
  } catch {
    return true // cannot resolve: refuse rather than guess
  }
}

/** Temp file in the target directory, mode 0600, then rename over the target (atomic on one volume). */
export async function writeMapAtomically(file: string, body: string): Promise<void> {
  const target = path.resolve(file)
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(tmp, target)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export async function runMediaMapExport(payload: Payload, argv: readonly string[], log: Log): Promise<number> {
  const flags = parseFlags(argv)
  const usage =
    'Usage: npm run export:media-map -- [--out <file outside the repository>] [--aliases <json>] [--detail-file <path outside the repository>]   (dry run without --out)'
  const out = flags.out
  if (out !== undefined && (typeof out !== 'string' || out === '')) {
    log.err(usage)
    return 2
  }
  if (typeof out === 'string' && isInsideRepoReal(out)) {
    log.err('--out must be a path outside the repository (the map lists every public legacy upload path and must never be committed).')
    return 2
  }
  const detail = flags['detail-file']
  if (detail !== undefined && (typeof detail !== 'string' || detail === '' || isInsideRepoReal(detail))) {
    log.err('--detail-file must be a path outside the repository (details name legacy paths and media ids).')
    return 2
  }
  let aliases: RecordedAlias[] = []
  if (flags.aliases !== undefined) {
    if (typeof flags.aliases !== 'string') {
      log.err('--aliases needs a JSON file path.')
      return 2
    }
    try {
      if ((await stat(flags.aliases)).size > ALIASES_MAX_BYTES) {
        log.err(`The --aliases file is larger than ${ALIASES_MAX_BYTES} bytes.`)
        return 2
      }
      const parsed: unknown = JSON.parse(await readFile(flags.aliases, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('not-array')
      aliases = parsed as RecordedAlias[]
    } catch {
      log.err('Could not read --aliases as a JSON array of {alias, path}.')
      return 2
    }
  }
  try {
    const [anonymousIds, docs] = await Promise.all([loadAnonymousMediaIds(payload), loadMediaWithLegacyPath(payload)])
    const { map, excluded, details } = buildMediaMapDetailed(docs, { anonymousIds, aliases })
    const body = serialiseMediaMap(map)
    const fileSha256 = sha256OfBytes(body)
    const summary =
      `entries=${map.counts.entries} aliases=${map.counts.aliases} excluded=${JSON.stringify(excluded)} ` +
      `bytes=${Buffer.byteLength(body)} version=${map.version} file-sha256=${fileSha256} content-sha256=${map.contentSha256}`
    if (typeof detail === 'string') {
      await writeMapAtomically(detail, `${details.join('\n')}${details.length ? '\n' : ''}`)
      log.out(`Details (${details.length} lines, they name paths and media ids) written to the detail file.`)
    }
    if (typeof out !== 'string') {
      log.out(`Dry run (no --out): nothing written. ${summary}`)
      return 0
    }
    await writeMapAtomically(out, body)
    await writeMapAtomically(`${out}.sha256`, `${fileSha256}  ${path.basename(out)}\n`)
    log.out(`Wrote the media map and its .sha256 file (mode 0600; no effect on Windows). ${summary}`)
    log.out('The output file is a generated private artifact: do not commit it. Provision the map together with its .sha256 and verify with sha256sum -c.')
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    const code = /^media-map-[a-z-]+/.exec(message)?.[0] ?? (err instanceof Error ? err.name : 'error')
    log.err(`export:media-map failed, nothing written. error=${code}`)
    return 1
  }
}
