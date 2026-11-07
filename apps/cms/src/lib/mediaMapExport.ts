import { createHash } from 'node:crypto'

import { isValidLegacyPath, stripSizeSuffix } from './legacyMediaPath'

/**
 * Offline legacy media map (A12). Pure: no I/O. Turns media documents into a versioned JSON map that the public host
 * loads from a private location, so `/wp-content/uploads/<legacy path>` can be served from an approved anonymous CMS
 * media file WITHOUT any anonymous media scan and WITHOUT a staff credential on the public host.
 *
 * Privacy: this module cannot decide what is public by itself. The caller passes ALL media that have a legacy path
 * plus `anonymousIds`, the ids that the existing media read access (`Media.readAccess`) returned to an ANONYMOUS reader
 * (see `mediaMapData.ts`). Only anonymous ones are exported, but path collisions and alias shadowing are checked
 * against every document, so a private or draft media claiming the same path still makes the path ambiguous.
 * Only these fields ever leave: exact path, public file URL path, mime, size, and the alias table. Never ids, alt text,
 * captions, credit, uploader, or any staff-only field, and no count of private media (that is only returned to the CLI).
 *
 * Limits follow the A12 design (PR #58): 50,000 entries (map entries plus aliases) and 8 MiB of serialised bytes.
 * The format (`entries[{path,file,mime,size}]` plus an `aliases[{alias,path}]` table) differs from the flat
 * `legacyPath/mediaPath/mimeType` proposal in #58; #58 must be updated to this contract (or the host must adapt).
 */

export const MEDIA_MAP_VERSION = 'media-map/1'
export const MEDIA_MAP_MAX_ENTRIES = 50_000
export const MEDIA_MAP_MAX_BYTES = 8 * 1024 * 1024
export const DEFAULT_FILE_PREFIX = '/api/media/file/'
export const MEDIA_MAP_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const
const FILE_RE = /^\/api\/media\/file\/[A-Za-z0-9][A-Za-z0-9._-]*$/

export type MediaDocLike = {
  id: string | number
  legacyPath?: unknown
  filename?: unknown
  mimeType?: unknown
  filesize?: unknown
}

/** A recorded size-suffix alias: the exact old address of a thumbnail and the legacy path of the original it came from. */
export type RecordedAlias = { alias: string; path: string }

export type MediaMapEntry = { path: string; file: string; mime: string; size: number }
export type MediaMapAlias = { alias: string; path: string }

/** Counters for the CLI only. NEVER part of the file (notAnonymous would reveal how much private media exists). */
export type MediaMapExcluded = {
  notAnonymous: number
  noLegacyPath: number
  invalidPath: number
  duplicatePath: number
  noFile: number
  unsupportedMime: number
  badAlias: number
}

export type MediaMap = {
  version: typeof MEDIA_MAP_VERSION
  generatedAt: string
  counts: { entries: number; aliases: number }
  /**
   * sha256 (hex) of `canonicalContent(entries, aliases)`: a stable content id, independent of `generatedAt` and of
   * formatting. It is NOT the provisioning check: that is the sha256 of the exact file bytes (`<out>.sha256`).
   */
  contentSha256: string
  entries: MediaMapEntry[]
  aliases: MediaMapAlias[]
}

export type BuildOptions = {
  anonymousIds: ReadonlySet<string | number>
  aliases?: readonly RecordedAlias[]
  generatedAt?: Date
  filePrefix?: string
}

export type BuildResult = {
  map: MediaMap
  excluded: MediaMapExcluded
  /** One line per ambiguity or rejected alias. Names paths and ids: staff eyes only, via a detail file outside the repo. */
  details: string[]
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** NFC, then the same rules as `media.legacyPath`; null when unusable. Exact and case-sensitive afterwards. */
export function normaliseMapPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const nfc = value.normalize('NFC')
  return isValidLegacyPath(nfc) ? nfc : null
}

/** The public file URL path of a stored file name; null for a name that is not a plain safe file name. */
export function publicFilePath(filename: unknown, prefix: string = DEFAULT_FILE_PREFIX): string | null {
  if (typeof filename !== 'string' || filename === '' || filename.length > 255) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) || filename.includes('..')) return null
  return `${prefix}${filename}`
}

/** The text hashed into `contentSha256`: version plus both tables, in their sorted order. No timestamp. */
export function canonicalContent(entries: readonly MediaMapEntry[], aliases: readonly MediaMapAlias[]): string {
  return JSON.stringify({ version: MEDIA_MAP_VERSION, entries, aliases })
}

export const hashContent = (entries: readonly MediaMapEntry[], aliases: readonly MediaMapAlias[]): string =>
  createHash('sha256').update(canonicalContent(entries, aliases), 'utf8').digest('hex')

/** sha256 (hex) of exact bytes: the digest to provision next to the file. */
export const sha256OfBytes = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export function buildMediaMapDetailed(docs: readonly MediaDocLike[], options: BuildOptions): BuildResult {
  const prefix = options.filePrefix ?? DEFAULT_FILE_PREFIX
  const excluded: MediaMapExcluded = {
    notAnonymous: 0,
    noLegacyPath: 0,
    invalidPath: 0,
    duplicatePath: 0,
    noFile: 0,
    unsupportedMime: 0,
    badAlias: 0,
  }
  const details: string[] = []

  // Every document that claims a path counts for collisions, whoever may read it.
  const claims = new Map<string, Array<string | number>>()
  for (const doc of docs) {
    if (doc.legacyPath === undefined || doc.legacyPath === null || doc.legacyPath === '') continue
    const path = normaliseMapPath(doc.legacyPath)
    if (path === null) continue
    const list = claims.get(path) ?? []
    list.push(doc.id)
    claims.set(path, list)
  }

  const candidates: MediaMapEntry[] = []
  for (const doc of docs) {
    if (!options.anonymousIds.has(doc.id)) {
      excluded.notAnonymous++
      continue
    }
    if (doc.legacyPath === undefined || doc.legacyPath === null || doc.legacyPath === '') {
      excluded.noLegacyPath++
      continue
    }
    const path = normaliseMapPath(doc.legacyPath)
    if (path === null) {
      excluded.invalidPath++
      details.push(`invalid-path media=${doc.id}`)
      continue
    }
    const ids = claims.get(path) ?? []
    if (ids.length > 1) {
      excluded.duplicatePath++
      details.push(`ambiguous-path path=${path} media=${doc.id} claimed-by=${ids.join(',')}`)
      continue
    }
    const file = publicFilePath(doc.filename, prefix)
    const size = doc.filesize
    if (file === null || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      excluded.noFile++
      details.push(`no-usable-file path=${path} media=${doc.id}`)
      continue
    }
    const mime = typeof doc.mimeType === 'string' ? doc.mimeType.toLowerCase() : ''
    if (!(MEDIA_MAP_MIMES as readonly string[]).includes(mime)) {
      excluded.unsupportedMime++
      details.push(`unsupported-mime path=${path} media=${doc.id}`)
      continue
    }
    candidates.push({ path, file, mime, size })
  }
  const entries = candidates.sort((a, b) => byCodeUnit(a.path, b.path))
  const exported = new Set(entries.map((e) => e.path))

  const aliasMap = new Map<string, string>()
  for (const rec of options.aliases ?? []) {
    const alias = normaliseMapPath(rec?.alias)
    const target = normaliseMapPath(rec?.path)
    // Recorded, not guessed: the alias must be exactly `<target without extension>-<W>x<H>.<ext>`, the target must be
    // an exported entry, and an alias never shadows a path ANY media claims (exact wins, even over a private media).
    // An alias therefore determines its target (`stripSizeSuffix`), so two different targets cannot compete for one.
    let reason: string | null = null
    if (alias === null || target === null) reason = 'invalid'
    else if (alias === target || stripSizeSuffix(alias) !== target) reason = 'not-a-size-variant-of-target'
    else if (!exported.has(target)) reason = 'target-not-exported'
    else if (claims.has(alias)) reason = 'shadows-exact-path'
    if (reason !== null) {
      excluded.badAlias++
      details.push(`bad-alias reason=${reason} alias=${String(rec?.alias)} path=${String(rec?.path)}`)
      continue
    }
    aliasMap.set(alias as string, target as string)
  }
  const aliases: MediaMapAlias[] = [...aliasMap]
    .map(([alias, path]) => ({ alias, path }))
    .sort((a, b) => byCodeUnit(a.alias, b.alias))

  if (entries.length + aliases.length > MEDIA_MAP_MAX_ENTRIES) {
    throw new Error(`media-map-too-many-entries: ${entries.length + aliases.length} exceeds ${MEDIA_MAP_MAX_ENTRIES}`)
  }
  details.sort()
  return {
    map: {
      version: MEDIA_MAP_VERSION,
      generatedAt: (options.generatedAt ?? new Date()).toISOString(),
      counts: { entries: entries.length, aliases: aliases.length },
      contentSha256: hashContent(entries, aliases),
      entries,
      aliases,
    },
    excluded,
    details,
  }
}

export const buildMediaMap = (docs: readonly MediaDocLike[], options: BuildOptions): MediaMap =>
  buildMediaMapDetailed(docs, options).map

/** Serialised file body: stable key order, one trailing newline. Refuses a map over the 8 MiB cap. */
export function serialiseMediaMap(map: MediaMap): string {
  const body = `${JSON.stringify(map, null, 2)}\n`
  if (Buffer.byteLength(body) > MEDIA_MAP_MAX_BYTES) {
    throw new Error(`media-map-too-large: over ${MEDIA_MAP_MAX_BYTES} bytes`)
  }
  return body
}

/**
 * Strict validation of a serialised map, for tests and as a reference for the public host's loader (the host must do
 * its own equivalent validation of EVERY entry at load; this does not replace that). Checks the byte cap, the entry
 * cap, path rules, file path shape, mime allowlist, sizes, strict sort order and uniqueness, alias shape and targets,
 * no alias that is also an entry, and the content hash.
 */
export function validateMediaMapBody(body: string): { ok: boolean; reason?: string } {
  if (Buffer.byteLength(body) > MEDIA_MAP_MAX_BYTES) return { ok: false, reason: 'too-large' }
  let map: Partial<MediaMap>
  try {
    map = JSON.parse(body) as Partial<MediaMap>
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  if (map === null || typeof map !== 'object' || map.version !== MEDIA_MAP_VERSION) return { ok: false, reason: 'version' }
  const { entries, aliases } = map
  if (!Array.isArray(entries) || !Array.isArray(aliases)) return { ok: false, reason: 'shape' }
  if (entries.length + aliases.length > MEDIA_MAP_MAX_ENTRIES) return { ok: false, reason: 'too-many-entries' }
  const paths = new Set<string>()
  let prev: string | null = null
  for (const e of entries) {
    if (e === null || typeof e !== 'object' || Object.keys(e).sort().join() !== 'file,mime,path,size') return { ok: false, reason: 'entry-shape' }
    if (typeof e.path !== 'string' || normaliseMapPath(e.path) !== e.path) return { ok: false, reason: 'entry-path' }
    if (typeof e.file !== 'string' || !FILE_RE.test(e.file) || e.file.includes('..')) return { ok: false, reason: 'entry-file' }
    if (!(MEDIA_MAP_MIMES as readonly string[]).includes(e.mime)) return { ok: false, reason: 'entry-mime' }
    if (!Number.isSafeInteger(e.size) || e.size < 0) return { ok: false, reason: 'entry-size' }
    if (prev !== null && byCodeUnit(prev, e.path) >= 0) return { ok: false, reason: 'entries-order' }
    prev = e.path
    paths.add(e.path)
  }
  prev = null
  for (const a of aliases) {
    if (a === null || typeof a !== 'object' || Object.keys(a).sort().join() !== 'alias,path') return { ok: false, reason: 'alias-shape' }
    if (typeof a.alias !== 'string' || normaliseMapPath(a.alias) !== a.alias) return { ok: false, reason: 'alias-path' }
    if (typeof a.path !== 'string' || !paths.has(a.path)) return { ok: false, reason: 'alias-target' }
    if (a.alias === a.path || stripSizeSuffix(a.alias) !== a.path) return { ok: false, reason: 'alias-not-variant' }
    if (paths.has(a.alias)) return { ok: false, reason: 'alias-shadows-entry' }
    if (prev !== null && byCodeUnit(prev, a.alias) >= 0) return { ok: false, reason: 'aliases-order' }
    prev = a.alias
  }
  return hashContent(entries as MediaMapEntry[], aliases as MediaMapAlias[]) === map.contentSha256
    ? { ok: true }
    : { ok: false, reason: 'content-sha256' }
}
