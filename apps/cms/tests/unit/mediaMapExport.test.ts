import { describe, expect, it } from 'vitest'

import {
  MEDIA_MAP_MAX_BYTES,
  MEDIA_MAP_MAX_ENTRIES,
  MEDIA_MAP_VERSION,
  buildMediaMap,
  buildMediaMapDetailed,
  hashContent,
  normaliseMapPath,
  publicFilePath,
  serialiseMediaMap,
  sha256OfBytes,
  validateMediaMapBody,
  type MediaDocLike,
} from '../../src/lib/mediaMapExport'

const doc = (id: number, legacyPath: unknown, extra: Partial<MediaDocLike> = {}): MediaDocLike => ({
  id,
  legacyPath,
  filename: `file-${id}.jpg`,
  mimeType: 'image/jpeg',
  filesize: 1000 + id,
  ...extra,
})
const at = new Date('2026-10-21T10:00:00.000Z')
const opts = (ids: number[], extra: Record<string, unknown> = {}) => ({ anonymousIds: new Set(ids), generatedAt: at, ...extra })
const build = (docs: MediaDocLike[], ids: number[], extra: Record<string, unknown> = {}) => buildMediaMap(docs, opts(ids, extra))
const detailed = (docs: MediaDocLike[], ids: number[], extra: Record<string, unknown> = {}) =>
  buildMediaMapDetailed(docs, opts(ids, extra))

describe('normaliseMapPath', () => {
  it('applies NFC and the legacyPath rules', () => {
    expect(normaliseMapPath('2023/10/café.jpg')).toBe('2023/10/café.jpg')
    expect(normaliseMapPath('2023/10/photo.jpg')).toBe('2023/10/photo.jpg')
  })
  it('rejects slashes, traversal, encoded forms, queries and non-strings', () => {
    for (const bad of ['/2023/a.jpg', '2023//a.jpg', '2023/../a.jpg', '2023/a%20b.jpg', 'a.jpg?x=1', 'a\\b.jpg', 'wp-content/uploads/a.jpg', '', 5, null]) {
      expect(normaliseMapPath(bad)).toBeNull()
    }
  })
})

describe('publicFilePath', () => {
  it('only plain file names under the prefix', () => {
    expect(publicFilePath('a-1.jpg')).toBe('/api/media/file/a-1.jpg')
    for (const bad of ['../a.jpg', 'a/b.jpg', 'a b.jpg', '.hidden', '', undefined, 'a..jpg']) expect(publicFilePath(bad)).toBeNull()
  })
})

describe('buildMediaMap', () => {
  it('exports only anonymously readable media (unapproved, draft-article, private and withdrawn are not in the id set)', () => {
    const docs = [doc(1, '2023/a.jpg'), doc(2, '2023/draft.jpg'), doc(3, '2023/private.jpg'), doc(4, '2023/withdrawn.jpg')]
    const { map, excluded } = detailed(docs, [1])
    expect(map.entries.map((e) => e.path)).toEqual(['2023/a.jpg'])
    expect(excluded.notAnonymous).toBe(3)
  })
  it('has no staff-only or identifying fields and no private-media count', () => {
    const map = build([doc(1, '2023/a.jpg', { alt: 'secret alt', uploadedBy: 9, caption: 'c' } as never), doc(2, '2023/b.jpg')], [1])
    expect(map.entries[0]).toEqual({ path: '2023/a.jpg', file: '/api/media/file/file-1.jpg', mime: 'image/jpeg', size: 1001 })
    const text = serialiseMediaMap(map)
    for (const word of ['secret', 'uploadedBy', 'caption', '"id"', '"alt"', 'notAnonymous', 'excluded']) expect(text).not.toContain(word)
    expect(Object.keys(map.counts).sort()).toEqual(['aliases', 'entries'])
  })
  it('counts every other exclusion and never exports an unusable record', () => {
    const docs = [
      doc(1, undefined),
      doc(2, '../x.jpg'),
      doc(3, '2023/ok.jpg', { filename: '../evil' }),
      doc(4, '2023/pdf.pdf', { mimeType: 'application/pdf' }),
      doc(5, '2023/neg.jpg', { filesize: -1 }),
      doc(6, '2023/fine.jpg'),
    ]
    const { map, excluded } = detailed(docs, [1, 2, 3, 4, 5, 6])
    expect(map.entries.map((e) => e.path)).toEqual(['2023/fine.jpg'])
    expect(excluded).toMatchObject({ noLegacyPath: 1, invalidPath: 1, noFile: 2, unsupportedMime: 1 })
  })
  it('drops both documents when two claim the same path (NFC collision included) and itemises it', () => {
    const { map, excluded, details } = detailed([doc(1, '2023/café.jpg'), doc(2, '2023/café.jpg'), doc(3, '2023/z.jpg')], [1, 2, 3])
    expect(map.entries.map((e) => e.path)).toEqual(['2023/z.jpg'])
    expect(excluded.duplicatePath).toBe(2)
    expect(details.filter((d) => d.startsWith('ambiguous-path')).length).toBe(2)
  })
  it('a private or draft media claiming the same path makes it ambiguous: the public one is dropped too', () => {
    const { map, excluded } = detailed([doc(1, '2023/a.jpg'), doc(2, '2023/a.jpg')], [1])
    expect(map.entries).toEqual([])
    expect(excluded.duplicatePath).toBe(1)
  })
  it('is deterministic: sorted, input order does not matter, content id ignores generatedAt', () => {
    const docs = [doc(3, '2023/c.jpg'), doc(1, '2023/a.jpg'), doc(2, '2022/b.jpg')]
    const a = build(docs, [1, 2, 3])
    const b = buildMediaMap([...docs].reverse(), { anonymousIds: new Set([3, 2, 1]), generatedAt: new Date('2030-01-01') })
    expect(a.entries.map((e) => e.path)).toEqual(['2022/b.jpg', '2023/a.jpg', '2023/c.jpg'])
    expect(b.entries).toEqual(a.entries)
    expect(b.contentSha256).toBe(a.contentSha256)
    expect(serialiseMediaMap(build(docs, [1, 2, 3]))).toBe(serialiseMediaMap(a))
    expect(a.version).toBe(MEDIA_MAP_VERSION)
    expect(a.generatedAt).toBe('2026-10-21T10:00:00.000Z')
    expect(a.counts).toEqual({ entries: 3, aliases: 0 })
  })
  it('validates strictly; tampering and rule violations are detected', () => {
    const map = build([doc(1, '2023/a.jpg'), doc(2, '2023/b.jpg')], [1, 2])
    expect(map.contentSha256).toBe(hashContent(map.entries, map.aliases))
    const body = serialiseMediaMap(map)
    expect(validateMediaMapBody(body)).toEqual({ ok: true })
    expect(validateMediaMapBody(body.replace('2023/a.jpg', '2023/a2.jpg')).reason).toBe('content-sha256')
    expect(validateMediaMapBody('nope').ok).toBe(false)
    const mutate = (fn: (m: any) => void) => {
      const m = JSON.parse(body)
      fn(m)
      return validateMediaMapBody(JSON.stringify(m)).reason
    }
    expect(mutate((m) => (m.entries[0].file = '/api/media/file/../x.jpg'))).toBe('entry-file')
    expect(mutate((m) => (m.entries[0].file = 'https://evil.test/a.jpg'))).toBe('entry-file')
    expect(mutate((m) => (m.entries[0].mime = 'text/html'))).toBe('entry-mime')
    expect(mutate((m) => (m.entries[0].path = '../a.jpg'))).toBe('entry-path')
    expect(mutate((m) => m.entries.reverse())).toBe('entries-order')
    expect(mutate((m) => (m.entries[1].path = m.entries[0].path))).toBe('entries-order')
    expect(mutate((m) => (m.entries[0].extra = 1))).toBe('entry-shape')
    expect(mutate((m) => (m.entries[0].size = 1.5))).toBe('entry-size')
    expect(mutate((m) => m.aliases.push({ alias: '2023/a-1x1.jpg', path: '2023/zzz.jpg' }))).toBe('alias-target')
    expect(mutate((m) => (m.version = 'x'))).toBe('version')
  })
  it('hash of the exact bytes differs from the content id and changes with any byte', () => {
    const body = serialiseMediaMap(build([doc(1, '2023/a.jpg')], [1]))
    expect(sha256OfBytes(body)).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256OfBytes(body)).not.toBe(sha256OfBytes(`${body} `))
  })
})

describe('limits', () => {
  it('refuses more than 50,000 entries (60,000 refused)', () => {
    const docs = Array.from({ length: 60_000 }, (_, i) => doc(i + 1, `2023/p${i}.jpg`))
    expect(MEDIA_MAP_MAX_ENTRIES).toBe(50_000)
    expect(() => build(docs, docs.map((d) => d.id as number))).toThrow(/media-map-too-many-entries/)
  })
  it('accepts exactly 50,000 entries counting aliases together', () => {
    const docs = Array.from({ length: 50_000 }, (_, i) => doc(i + 1, `2023/p${i}.jpg`))
    expect(build(docs, docs.map((d) => d.id as number)).counts.entries).toBe(50_000)
    const aliases = [{ alias: '2023/p1-1x1.jpg', path: '2023/p1.jpg' }]
    expect(() => build(docs, docs.map((d) => d.id as number), { aliases })).toThrow(/too-many-entries/)
  })
  it('refuses a serialised map over 8 MiB', () => {
    const long = 'd'.repeat(400)
    const docs = Array.from({ length: 30_000 }, (_, i) => doc(i + 1, `${long}/${i}.jpg`))
    const map = build(docs, docs.map((d) => d.id as number))
    expect(map.counts.entries).toBe(30_000)
    expect(() => serialiseMediaMap(map)).toThrow(/media-map-too-large/)
    expect(MEDIA_MAP_MAX_BYTES).toBe(8 * 1024 * 1024)
  })
})

describe('size-suffix aliases', () => {
  const docs = [doc(1, '2023/10/photo.jpg'), doc(2, '2023/10/banner-1920x1080.jpg')]
  it('are never guessed: no recorded alias, no alias entry', () => {
    expect(build(docs, [1, 2]).aliases).toEqual([])
  })
  it('exports a recorded exact alias of an exported original', () => {
    const map = build(docs, [1, 2], { aliases: [{ alias: '2023/10/photo-300x200.jpg', path: '2023/10/photo.jpg' }] })
    expect(map.aliases).toEqual([{ alias: '2023/10/photo-300x200.jpg', path: '2023/10/photo.jpg' }])
    expect(validateMediaMapBody(serialiseMediaMap(map))).toEqual({ ok: true })
  })
  it('exact wins: an alias is rejected when an exported media owns that exact path', () => {
    // Both photo.jpg and photo-300x200.jpg are real exported media; the recorded alias must not shadow the second.
    const both = [doc(1, '2023/10/photo.jpg'), doc(2, '2023/10/photo-300x200.jpg')]
    const { map, excluded, details } = detailed(both, [1, 2], { aliases: [{ alias: '2023/10/photo-300x200.jpg', path: '2023/10/photo.jpg' }] })
    expect(map.entries.map((e) => e.path)).toEqual(['2023/10/photo-300x200.jpg', '2023/10/photo.jpg'])
    expect(map.aliases).toEqual([])
    expect(excluded.badAlias).toBe(1)
    expect(details.some((d) => d.includes('shadows-exact-path'))).toBe(true)
  })
  it('an alias also never shadows a path claimed by a private media', () => {
    const both = [doc(1, '2023/10/photo.jpg'), doc(2, '2023/10/photo-300x200.jpg')]
    const map = build(both, [1], { aliases: [{ alias: '2023/10/photo-300x200.jpg', path: '2023/10/photo.jpg' }] })
    expect(map.aliases).toEqual([])
  })
  it('rejects aliases that do not match the target, point at unexported media, or are not size suffixes', () => {
    const map = build(docs, [1, 2], {
      aliases: [
        { alias: '2023/10/other-300x200.jpg', path: '2023/10/photo.jpg' },
        { alias: '2023/10/photo-300x200.png', path: '2023/10/photo.jpg' },
        { alias: '2023/10/gone-300x200.jpg', path: '2023/10/gone.jpg' },
        { alias: '2023/10/photo-abc.jpg', path: '2023/10/photo.jpg' },
      ],
    })
    expect(map.aliases).toEqual([])
  })
  it('an alias to media that is not anonymously readable is dropped', () => {
    const map = build(docs, [2], { aliases: [{ alias: '2023/10/photo-300x200.jpg', path: '2023/10/photo.jpg' }] })
    expect(map.aliases).toEqual([])
  })
  it('duplicates of one recorded alias collapse and the table is sorted', () => {
    const two = [doc(3, 'b/q.jpg'), doc(4, 'a/r.jpg')]
    const map = build(two, [3, 4], {
      aliases: [
        { alias: 'b/q-9x9.jpg', path: 'b/q.jpg' },
        { alias: 'a/r-2x2.jpg', path: 'a/r.jpg' },
        { alias: 'a/r-2x2.jpg', path: 'a/r.jpg' },
      ],
    })
    expect(map.aliases.map((a) => a.alias)).toEqual(['a/r-2x2.jpg', 'b/q-9x9.jpg'])
  })
})
