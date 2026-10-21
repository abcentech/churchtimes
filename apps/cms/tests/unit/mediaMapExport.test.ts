import { describe, expect, it } from 'vitest'

import {
  MEDIA_MAP_VERSION,
  buildMediaMap,
  hashContent,
  normaliseMapPath,
  publicFilePath,
  serialiseMediaMap,
  verifyMediaMapBody,
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
const build = (docs: MediaDocLike[], ids: number[], extra: Record<string, unknown> = {}) =>
  buildMediaMap(docs, { anonymousIds: new Set(ids), generatedAt: at, ...extra })

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
    const map = build(docs, [1])
    expect(map.entries.map((e) => e.path)).toEqual(['2023/a.jpg'])
    expect(map.counts.excluded.notAnonymous).toBe(3)
  })
  it('has no staff-only or identifying fields', () => {
    const map = build([doc(1, '2023/a.jpg', { alt: 'secret alt', uploadedBy: 9, caption: 'c' } as never)], [1])
    expect(map.entries[0]).toEqual({ path: '2023/a.jpg', file: '/api/media/file/file-1.jpg', mime: 'image/jpeg', size: 1001 })
    const text = serialiseMediaMap(map)
    for (const word of ['secret', 'uploadedBy', 'caption', '"id"', '"alt"']) expect(text).not.toContain(word)
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
    const map = build(docs, [1, 2, 3, 4, 5, 6])
    expect(map.entries.map((e) => e.path)).toEqual(['2023/fine.jpg'])
    expect(map.counts.excluded).toMatchObject({ noLegacyPath: 1, invalidPath: 1, noFile: 2, unsupportedMime: 1 })
  })
  it('drops both documents when two claim the same path (NFC collision included)', () => {
    const map = build([doc(1, '2023/café.jpg'), doc(2, '2023/café.jpg'), doc(3, '2023/z.jpg')], [1, 2, 3])
    expect(map.entries.map((e) => e.path)).toEqual(['2023/z.jpg'])
    expect(map.counts.excluded.duplicatePath).toBe(2)
  })
  it('is deterministic: sorted, input order does not matter, hash ignores generatedAt', () => {
    const docs = [doc(3, '2023/c.jpg'), doc(1, '2023/a.jpg'), doc(2, '2022/b.jpg')]
    const a = build(docs, [1, 2, 3])
    const b = buildMediaMap([...docs].reverse(), { anonymousIds: new Set([3, 2, 1]), generatedAt: new Date('2030-01-01') })
    expect(a.entries.map((e) => e.path)).toEqual(['2022/b.jpg', '2023/a.jpg', '2023/c.jpg'])
    expect(b.entries).toEqual(a.entries)
    expect(b.sha256).toBe(a.sha256)
    expect(serialiseMediaMap(build(docs, [1, 2, 3]))).toBe(serialiseMediaMap(a))
    expect(a.version).toBe(MEDIA_MAP_VERSION)
    expect(a.generatedAt).toBe('2026-10-21T10:00:00.000Z')
    expect(a.counts).toMatchObject({ entries: 3, aliases: 0 })
  })
  it('hash covers content and verifies; tampering is detected', () => {
    const map = build([doc(1, '2023/a.jpg')], [1])
    expect(map.sha256).toBe(hashContent(map.entries, map.aliases))
    const body = serialiseMediaMap(map)
    expect(verifyMediaMapBody(body)).toEqual({ ok: true })
    expect(verifyMediaMapBody(body.replace('2023/a.jpg', '2023/b.jpg')).ok).toBe(false)
    expect(verifyMediaMapBody('nope').ok).toBe(false)
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
  })
  it('rejects aliases that do not match the target, point at unexported media, or shadow an exact path', () => {
    const map = build(docs, [1, 2], {
      aliases: [
        { alias: '2023/10/other-300x200.jpg', path: '2023/10/photo.jpg' },
        { alias: '2023/10/photo-300x200.png', path: '2023/10/photo.jpg' },
        { alias: '2023/10/gone-300x200.jpg', path: '2023/10/gone.jpg' },
        { alias: '2023/10/banner-1920x1080.jpg', path: '2023/10/banner.jpg' },
        { alias: '2023/10/photo-abc.jpg', path: '2023/10/photo.jpg' },
      ],
    })
    expect(map.aliases).toEqual([])
    expect(map.counts.excluded.badAlias).toBe(5)
  })
  it('an alias to media that is not anonymously readable is dropped', () => {
    const map = build(docs, [2], { aliases: [{ alias: '2023/10/photo-300x200.jpg', path: '2023/10/photo.jpg' }] })
    expect(map.aliases).toEqual([])
  })
  it('conflicting recorded aliases are both dropped and the table is sorted', () => {
    const two = [doc(3, 'b/q.jpg'), doc(4, 'a/r.jpg'), doc(5, 'b/q2.jpg')]
    const map = build(two, [3, 4, 5], {
      aliases: [
        { alias: 'b/q-9x9.jpg', path: 'b/q.jpg' },
        { alias: 'a/r-2x2.jpg', path: 'a/r.jpg' },
        { alias: 'a/r-2x2.jpg', path: 'a/r.jpg' },
      ],
    })
    expect(map.aliases.map((a) => a.alias)).toEqual(['a/r-2x2.jpg', 'b/q-9x9.jpg'])
  })
})
