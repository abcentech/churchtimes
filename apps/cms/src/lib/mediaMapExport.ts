import { createHash } from 'node:crypto'

import { isValidLegacyPath, stripSizeSuffix } from './legacyMediaPath'

/**
 * Offline legacy media map (A12). Pure: no I/O. Turns media documents into a versioned JSON map that the public host
 * loads from a private location, so `/wp-content/uploads/<legacy path>` can be served from an approved anonymous CMS
 * media file WITHOUT any anonymous media scan and WITHOUT a staff credential on the public host.
 *
 * Privacy: this module cannot decide what is public by itself. The caller passes `anonymousIds`, the ids that the
 * existing media read access (`Media.readAccess`) returned to an ANONYMOUS reader (see `mediaMapData.ts`); every
 * other document is dropped. Only these fields ever leave: exact path, public file URL path, mime, size, and the
 * alias table. Never ids, alt text, captions, credit, uploader, or any staff-only field.
 */

export const MEDIA_MAP_VERSION = 'media-map/1'
export const MEDIA_MAP_MAX_ENTRIES = 200_000
export const DEFAULT_FILE_PREFIX = '/api/media/file/'
export const MEDIA_MAP_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const

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
  counts: { entries: number; aliases: number; excluded: MediaMapExcluded }
  /** sha256 (hex) of `canonicalContent(entries, aliases)`; independent of `generatedAt`. */
  sha256: string
  entries: MediaMapEntry[]
  aliases: MediaMapAlias[]
}

export type BuildOptions = {
  anonymousIds: ReadonlySet<string | number>
  aliases?: readonly RecordedAlias[]
  generatedAt?: Date
  filePrefix?: string
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

/** The text hashed into `sha256`: version plus both tables, in their sorted order. No timestamp. */
export function canonicalContent(entries: readonly MediaMapEntry[], aliases: readonly MediaMapAlias[]): string {
  return JSON.stringify({ version: MEDIA_MAP_VERSION, entries, aliases })
}

export const hashContent = (entries: readonly MediaMapEntry[], aliases: readonly MediaMapAlias[]): string =>
  createHash('sha256').update(canonicalContent(entries, aliases), 'utf8').digest('hex')

export function buildMediaMap(docs: readonly MediaDocLike[], options: BuildOptions): MediaMap {
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
  const candidates = new Map<string, MediaMapEntry[]>()
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
      continue
    }
    const file = publicFilePath(doc.filename, prefix)
    const size = doc.filesize
    if (file === null || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      excluded.noFile++
      continue
    }
    const mime = typeof doc.mimeType === 'string' ? doc.mimeType.toLowerCase() : ''
    if (!(MEDIA_MAP_MIMES as readonly string[]).includes(mime)) {
      excluded.unsupportedMime++
      continue
    }
    const list = candidates.get(path) ?? []
    list.push({ path, file, mime, size })
    candidates.set(path, list)
  }

  // Two documents claiming one path are ambiguous: neither is exported (never pick one).
  const entries: MediaMapEntry[] = []
  for (const list of candidates.values()) {
    if (list.length > 1) {
      excluded.duplicatePath += list.length
      continue
    }
    entries.push(list[0])
  }
  entries.sort((a, b) => byCodeUnit(a.path, b.path))
  if (entries.length > MEDIA_MAP_MAX_ENTRIES) throw new Error('media-map-too-large')

  const exact = new Set(entries.map((e) => e.path))
  const aliasMap = new Map<string, string>()
  const conflicting = new Set<string>()
  for (const rec of options.aliases ?? []) {
    const alias = normaliseMapPath(rec?.alias)
    const target = normaliseMapPath(rec?.path)
    // Recorded, not guessed: the alias must be exactly `<target without extension>-<W>x<H>.<ext>`, the target must be
    // an exported entry, and an alias never shadows an exact path (exact wins).
    if (
      alias === null ||
      target === null ||
      alias === target ||
      stripSizeSuffix(alias) !== target ||
      !exact.has(target) ||
      exact.has(alias)
    ) {
      excluded.badAlias++
      continue
    }
    const prior = aliasMap.get(alias)
    if (prior !== undefined && prior !== target) conflicting.add(alias)
    aliasMap.set(alias, target)
  }
  for (const alias of conflicting) {
    aliasMap.delete(alias)
    excluded.badAlias++
  }
  const aliases: MediaMapAlias[] = [...aliasMap]
    .map(([alias, path]) => ({ alias, path }))
    .sort((a, b) => byCodeUnit(a.alias, b.alias))

  return {
    version: MEDIA_MAP_VERSION,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    counts: { entries: entries.length, aliases: aliases.length, excluded },
    sha256: hashContent(entries, aliases),
    entries,
    aliases,
  }
}

/** Serialised file body: stable key order, one trailing newline. */
export const serialiseMediaMap = (map: MediaMap): string => `${JSON.stringify(map, null, 2)}\n`

/** Recompute the hash of a serialised map (for the public host's loader and for tests). */
export function verifyMediaMapBody(body: string): { ok: boolean; reason?: string } {
  let map: MediaMap
  try {
    map = JSON.parse(body) as MediaMap
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  if (map.version !== MEDIA_MAP_VERSION) return { ok: false, reason: 'version' }
  if (!Array.isArray(map.entries) || !Array.isArray(map.aliases)) return { ok: false, reason: 'shape' }
  return hashContent(map.entries, map.aliases) === map.sha256 ? { ok: true } : { ok: false, reason: 'sha256' }
}
