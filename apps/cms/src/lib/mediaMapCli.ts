import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Payload } from 'payload'

import { loadAnonymousMediaIds, loadMediaWithLegacyPath } from './mediaMapData'
import { type RecordedAlias, buildMediaMap, serialiseMediaMap } from './mediaMapExport'
import { type Log, isInsideRepo, parseFlags } from './redirectCli'

/**
 * `npm run export:media-map -- [--out <file outside the repo>] [--aliases <json file>]`. Without `--out` it is a dry
 * run: counts and the content hash only. Never prints a path or file name.
 * `--aliases` is a JSON array of `{ "alias": "2023/10/photo-300x200.jpg", "path": "2023/10/photo.jpg" }` recorded by the owner.
 */

export const ALIASES_MAX_BYTES = 5 * 1024 * 1024

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
  const out = flags.out
  if (out !== undefined && (typeof out !== 'string' || out === '')) {
    log.err('Usage: npm run export:media-map -- [--out <file outside the repository>] [--aliases <json>]   (dry run without --out)')
    return 2
  }
  if (typeof out === 'string' && isInsideRepo(out)) {
    log.err('--out must be a path outside the repository (the map lists every public legacy upload path and must never be committed).')
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
    const map = buildMediaMap(docs, { anonymousIds, aliases })
    const body = serialiseMediaMap(map)
    const c = map.counts
    const summary =
      `entries=${c.entries} aliases=${c.aliases} excluded=${JSON.stringify(c.excluded)} ` +
      `bytes=${Buffer.byteLength(body)} version=${map.version} sha256=${map.sha256}`
    if (typeof out !== 'string') {
      log.out(`Dry run (no --out): nothing written. ${summary}`)
      return 0
    }
    await writeMapAtomically(out, body)
    log.out(`Wrote the media map to the output file (mode 0600). ${summary}`)
    log.out('The output file is a generated private artifact: do not commit it, copy it only to the public host provisioning path.')
    return 0
  } catch (err) {
    log.err(`export:media-map failed, nothing written. error=${err instanceof Error ? err.name : 'error'}`)
    return 1
  }
}
