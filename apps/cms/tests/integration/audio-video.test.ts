import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readManifest } from '../../src/import/manifest'
import { runRollback } from '../../src/import/rollback'
import { runImport } from '../../src/import/run'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'
import { api, lexical, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * The `audioVideo` article block (API contract v1.19) against a real database, with SYNTHETIC bytes only:
 * upload rules, block validation, the public projection, withdrawn/draft rules, and the importer with its rollback.
 */
const runId = newRunId()
// A legacy source address must be https on an allowed host (isSafeAvSourceUrl); the synthetic old site is this one.
process.env.LEGACY_SITE_HOSTS = 'old.example.test'
const base = 9_100_000 + (parseInt(runId.slice(1, 5), 16) % 60_000) * 10
let f: Fixtures
let dir: string

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const pad = (n: number) => new Array(n).fill(0)
const MP4 = Buffer.from([0, 0, 0, 24, ...ascii('ftypisom'), 0, 0, 2, 0, ...ascii('isomiso2'), ...pad(64)])
const M4A = Buffer.from([0, 0, 0, 24, ...ascii('ftypM4A '), 0, 0, 2, 0, ...ascii('M4A mp42'), ...pad(64)])
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, ...ascii('webm'), ...pad(64)])
const MP3 = Buffer.from([...ascii('ID3'), 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x00, ...pad(200)])
const OGG = Buffer.from([...ascii('OggS'), 0, 2, ...pad(8), ...pad(4), ...pad(4), ...pad(4), 1, 30, 1, ...ascii('vorbis'), ...pad(100)])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const HTML = Buffer.from('<html><script>alert(1)</script></html>')

beforeAll(async () => {
  f = await setupFixtures(runId)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-av-int-'))
})
afterAll(async () => {
  await f?.cleanup()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

type MediaDoc = { id: number; url: string; filename: string; mimeType: string }
const upload = (token: string, label: string, bytes: Buffer, mime: string, ext: string) => {
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt: `${runId} ${label}` }))
  form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), `${runId}-${label}.${ext}`)
  return api('POST', '/api/media', { token, body: form })
}
const must = async (label: string, bytes: Buffer, mime: string, ext: string): Promise<MediaDoc> => {
  const res = await upload(f.tokens.reporter, label, bytes, mime, ext)
  expect(res.status, res.text.slice(0, 200)).toBe(201)
  return res.json.doc as MediaDoc
}
const png = () => sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer()
const mustImage = async (label: string): Promise<MediaDoc> => must(label, await png(), 'image/png', 'png')

const avBlock = (fields: Record<string, unknown>) => ({
  type: 'block',
  version: 2,
  format: '',
  fields: { id: `b${Math.random().toString(16).slice(2, 10)}`, blockName: '', blockType: 'audioVideo', kind: 'video', title: 'A synthetic clip', ...fields },
})
const bodyWith = (...nodes: unknown[]) => {
  const doc = lexical() as { root: { children: unknown[] } }
  doc.root.children.push(...nodes)
  return doc
}
const post = (content: unknown, token = f.tokens.reporter) => f.createArticle(token, { content })

describe('audio/video uploads', () => {
  it('accepts mp4, m4a, webm, mp3 and ogg verified by their bytes', async () => {
    expect((await must('v-mp4', MP4, 'video/mp4', 'mp4')).mimeType).toBe('video/mp4')
    expect((await must('a-m4a', M4A, 'audio/mp4', 'm4a')).mimeType).toBe('audio/mp4')
    expect((await must('v-webm', WEBM, 'video/webm', 'webm')).mimeType).toBe('video/webm')
    expect((await must('a-mp3', MP3, 'audio/mpeg', 'mp3')).mimeType).toBe('audio/mpeg')
    expect((await must('a-ogg', OGG, 'audio/ogg', 'ogg')).mimeType).toBe('audio/ogg')
  })

  it('refuses svg, html, scripts and a type that does not match the bytes', async () => {
    expect((await upload(f.tokens.reporter, 'svg', SVG, 'image/svg+xml', 'svg')).status).toBe(400)
    expect((await upload(f.tokens.reporter, 'svg-as-mp4', SVG, 'video/mp4', 'mp4')).status).toBe(400)
    expect((await upload(f.tokens.reporter, 'html-as-mp3', HTML, 'audio/mpeg', 'mp3')).status).toBe(400)
    expect((await upload(f.tokens.reporter, 'mp3-as-mp4', MP3, 'video/mp4', 'mp4')).status).toBe(400)
    expect((await upload(f.tokens.reporter, 'mov', MP4, 'video/quicktime', 'mov')).status).toBe(400)
    expect((await upload(f.tokens.reporter, 'wav', Buffer.from([...ascii('RIFF'), ...pad(40)]), 'audio/wav', 'wav')).status).toBe(400)
  })

  it('enforces the configured size cap', async () => {
    const before = process.env.MEDIA_AV_MAX_MB
    process.env.MEDIA_AV_MAX_MB = '1'
    try {
      const big = Buffer.concat([MP4, Buffer.alloc(1024 * 1024 + 1)])
      const res = await upload(f.tokens.reporter, 'too-big', big, 'video/mp4', 'mp4')
      expect(res.status).toBe(413)
      expect((await upload(f.tokens.reporter, 'small', MP4, 'video/mp4', 'mp4')).status).toBe(201)
    } finally {
      if (before === undefined) delete process.env.MEDIA_AV_MAX_MB
      else process.env.MEDIA_AV_MAX_MB = before
    }
  })

  it('does not let audio/video be used as an image elsewhere', async () => {
    const v = await must('not-an-image', MP4, 'video/mp4', 'mp4')
    const res = await api('POST', '/api/articles', {
      token: f.tokens.reporter,
      body: { title: `${runId}-img`, slug: `${runId}-img`, category: 1, content: bodyWith({ type: 'upload', relationTo: 'media', value: v.id, fields: null, format: '', version: 3 }) },
    })
    expect(res.status).toBe(400)
  })
})

describe('featured image', () => {
  it('accepts an image and refuses audio/video, on create and update', async () => {
    const img = await mustImage('feat-img')
    const v = await must('feat-video', MP4, 'video/mp4', 'mp4')
    const ok = await f.createArticle(f.tokens.reporter, { featuredImage: img.id })
    expect(ok.status, ok.text.slice(0, 200)).toBe(201)
    const bad = await f.createArticle(f.tokens.reporter, { featuredImage: v.id })
    expect(bad.status).toBe(400)
    expect(bad.text).toMatch(/featured image must be a JPEG, PNG or WebP/)
    const upd = await api('PATCH', `/api/articles/${ok.id}`, { token: f.tokens.reporter, body: { featuredImage: v.id } })
    expect(upd.status).toBe(400)
    const cleared = await api('PATCH', `/api/articles/${ok.id}`, { token: f.tokens.reporter, body: { featuredImage: null } })
    expect(cleared.status).toBe(200)
  })
})

describe('audioVideo block: validation', () => {
  it('accepts a media block with a poster and records the files in bodyMedia', async () => {
    const v = await must('ok-video', MP4, 'video/mp4', 'mp4')
    const p = await mustImage('ok-poster')
    const r = await post(bodyWith(avBlock({ media: v.id, poster: p.id, caption: 'Caption', transcriptUrl: 'https://example.test/t', duration: 61 })))
    expect(r.status, r.text.slice(0, 300)).toBe(201)
    const row = (await f.payload.findByID({ collection: 'articles', id: r.id!, depth: 0, overrideAccess: true })) as unknown as { bodyMedia: Array<number | { id: number }> }
    expect(row.bodyMedia.map((m) => (typeof m === 'object' ? m.id : m)).sort()).toEqual([v.id, p.id].sort())
  })

  it('accepts a legacy-address block with no file', async () => {
    const r = await post(bodyWith(avBlock({ kind: 'audio', sourceUrl: 'https://old.example.test/wp-content/uploads/2020/gone.mp3' })))
    expect(r.status, r.text.slice(0, 300)).toBe(201)
  })

  it('refuses a wrong kind, an image as the file, a non-image poster, bad ids and extra fields', async () => {
    const v = await must('bad-v', MP4, 'video/mp4', 'mp4')
    const a = await must('bad-a', MP3, 'audio/mpeg', 'mp3')
    const img = await mustImage('bad-img')
    const bad = async (fields: Record<string, unknown>, pattern: RegExp) => {
      const r = await post(bodyWith(avBlock(fields)))
      expect(r.status, JSON.stringify(fields)).toBe(400)
      expect(r.text).toMatch(pattern)
    }
    await bad({ kind: 'audio', media: v.id }, /MP3, M4A or OGG/)
    await bad({ kind: 'video', media: a.id }, /MP4 or WebM/)
    await bad({ media: img.id }, /MP4 or WebM/)
    await bad({ media: v.id, poster: a.id }, /JPEG, PNG or WebP/)
    await bad({ media: 99999999 }, /does not exist|invalid media id/)
    await bad({ media: v.id, html: '<video>' }, /unexpected fields/)
    await bad({ media: undefined, sourceUrl: 'javascript:alert(1)' }, /source/)
    await bad({ media: undefined, sourceUrl: 'http://old.example.test/wp-content/uploads/a.mp3' }, /source/)
    await bad({ media: undefined, sourceUrl: 'https://evil.example.test/a.mp3' }, /source/)
    await bad({ media: undefined, sourceUrl: '/api/users/me' }, /source/)
    await bad({ media: v.id, title: '' }, /title/)
  })
})

describe('audioVideo block: public projection and visibility', () => {
  it('shows populated media (url, mime) and poster to anonymous readers of a published article only', async () => {
    const v = await must('pub-video', MP4, 'video/mp4', 'mp4')
    const p = await mustImage('pub-poster')
    const art = await f.seedArticle({ status: 'draft', content: bodyWith(avBlock({ media: v.id, poster: p.id, caption: 'Shown', duration: 30 })) })
    // seed bypasses hooks: derive bodyMedia the way a real write does, by saving through the API as an editor.
    const saved = await api('PATCH', `/api/articles/${art.id}`, { token: f.tokens.admin, body: { content: bodyWith(avBlock({ media: v.id, poster: p.id, caption: 'Shown', duration: 30 })) } })
    expect(saved.status, saved.text.slice(0, 200)).toBe(200)

    // draft: the article and both files are private
    expect((await api('GET', `/api/articles/${art.id}`)).status).not.toBe(200)
    expect((await api('GET', `/api/media/file/${v.filename}`)).status).toBe(403)
    expect((await api('GET', `/api/media/file/${p.filename}`)).status).toBe(403)

    await f.payload.update({ collection: 'articles', id: art.id, data: { status: 'published', publishedAt: new Date().toISOString() } as never, overrideAccess: true, context: { seed: true } })
    const anon = await api('GET', `/api/articles/${art.id}?depth=2`)
    expect(anon.status).toBe(200)
    const blocks: any[] = []
    const walk = (n: any) => {
      if (n && typeof n === 'object') {
        if (n.type === 'block' && n.fields?.blockType === 'audioVideo') blocks.push(n.fields)
        for (const c of Object.values(n)) walk(c)
      }
    }
    walk(anon.json.content)
    expect(blocks).toHaveLength(1)
    const fields = blocks[0]
    expect(fields).toMatchObject({ kind: 'video', title: 'A synthetic clip', caption: 'Shown', duration: 30 })
    // media and poster are populated documents with the media url (absolute with CMS_PUBLIC_URL, like featuredImage)
    expect(fields.media).toMatchObject({ id: v.id, mimeType: 'video/mp4' })
    expect(String(fields.media.url)).toMatch(/\/api\/media\/file\/[^/]+\.mp4$/)
    expect(fields.poster).toMatchObject({ id: p.id, mimeType: 'image/png' })
    expect(fields.media).not.toHaveProperty('uploadedBy')
    expect(fields.media).not.toHaveProperty('legacyPath')

    // the files are public exactly while the article is published
    const file = await api('GET', `/api/media/file/${v.filename}`)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toMatch(/video\/mp4/)
    expect((await api('GET', `/api/media/file/${p.filename}`)).status).toBe(200)

    // withdrawn (archived): private again immediately
    await f.payload.update({ collection: 'articles', id: art.id, data: { status: 'archived' } as never, overrideAccess: true, context: { seed: true } })
    expect((await api('GET', `/api/media/file/${v.filename}`)).status).toBe(403)
    expect((await api('GET', `/api/articles/${art.id}`)).status).not.toBe(200)
  })

  it('freezes media shown in a published article for non-editors', async () => {
    const v = await must('frozen-video', MP4, 'video/mp4', 'mp4')
    const art = await f.createArticle(f.tokens.reporter, { content: bodyWith(avBlock({ media: v.id })) })
    expect(art.status).toBe(201)
    await f.payload.update({ collection: 'articles', id: art.id!, data: { status: 'published', publishedAt: new Date().toISOString() } as never, overrideAccess: true, context: { seed: true } })
    const res = await api('PATCH', `/api/media/${v.id}`, { token: f.tokens.reporter, body: { alt: `${runId} renamed` } })
    expect(res.status).toBe(403)
  })
})

describe('importer: audio/video', () => {
  it('writes blocks for shortcodes and elements, keeps unresolved files, counts unresolved-media, and rolls back', async () => {
    const uploads = path.join(dir, 'uploads')
    fs.mkdirSync(path.join(uploads, '2097', '01'), { recursive: true })
    fs.writeFileSync(path.join(uploads, '2097', '01', 'sermon.mp3'), MP3)
    fs.writeFileSync(path.join(uploads, '2097', '01', 'choir.mp4'), MP4)
    fs.writeFileSync(path.join(uploads, '2097', '01', 'corrupt.mp4'), SVG) // not a video: the safety check refuses it (active content)
    fs.writeFileSync(path.join(uploads, '2097', '01', 'poster.png'), await png())
    const cat = { nicename: `${runId}-av`, name: `${runId} AV` }
    const items: FixtureItem[] = [
      {
        id: base + 1,
        slug: `${runId}-av-story`,
        categories: [cat],
        content:
          '<p>Intro</p>' +
          '<p>[fvplayer src="https://old.example.test/wp-content/uploads/2097/01/choir.mp4" splash="https://old.example.test/wp-content/uploads/2097/01/poster.png" caption="Choir"]</p>' +
          '<figure class="wp-block-audio"><audio controls src="https://old.example.test/wp-content/uploads/2097/01/sermon.mp3"></audio><figcaption>The sermon</figcaption></figure>' +
          '<p>[video src="https://old.example.test/wp-content/uploads/2097/01/missing.mp4"]</p>' +
          '<p>[fvplayer src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"]</p>',
      },
      {
        id: base + 2,
        slug: `${runId}-av-corrupt`,
        categories: [cat],
        content: '<p>[video src="https://old.example.test/wp-content/uploads/2097/01/corrupt.mp4"]</p>',
      },
    ]
    const file = path.join(dir, 'export.xml')
    fs.writeFileSync(file, wxr(items))
    const manifestPath = path.join(dir, 'manifest.jsonl')
    const rep = await runImport(f.payload, { file, uploadsRoot: uploads, manifestPath, dryRun: false })
    expect(rep.articles, JSON.stringify(rep.articles)).toMatchObject({ created: 2 })
    expect(rep.content).toMatchObject({ avResolved: 2, avUnresolvedMedia: 2, youtube: 1 })
    expect(rep.media.unresolved).toMatchObject({ 'missing-file': 1, 'rejected-unsafe': 1 })
    expect(rep.media.created).toBe(3)

    const doc = (
      await f.payload.find({ collection: 'articles', where: { legacyId: { equals: base + 1 } }, depth: 0, limit: 1, overrideAccess: true })
    ).docs[0] as unknown as { id: number; content: unknown; bodyMedia: Array<number | { id: number }> }
    const blocks: any[] = []
    const walk = (n: any) => {
      if (n && typeof n === 'object') {
        if (n.type === 'block') blocks.push(n.fields)
        for (const c of Object.values(n)) walk(c)
      }
    }
    walk(doc.content)
    const av = blocks.filter((b) => b.blockType === 'audioVideo')
    expect(av.map((b) => [b.kind, typeof b.media, b.sourceUrl ? 'legacy' : 'file'])).toEqual([
      ['video', 'number', 'file'],
      ['audio', 'number', 'file'],
      ['video', 'undefined', 'legacy'],
    ])
    expect(typeof av[0].poster).toBe('number')
    expect(av[1].caption).toBe('The sermon')
    expect(blocks.filter((b) => b.blockType === 'youtubeEmbed')).toHaveLength(1)
    // the files and the poster are recorded for the media rules
    expect(doc.bodyMedia).toHaveLength(3)

    // the rollback manifest lists the article and the three media documents (two files and the poster)
    const m = readManifest(manifestPath)
    expect(m.articles.created).toHaveLength(2)
    expect(new Set(m.media).size).toBe(3)

    const rb = await runRollback(f.payload, { manifestPath, apply: true, minIncompleteAgeMs: 0 })
    expect(rb.articles.deleted).toBe(2)
    expect(rb.media.deleted).toBe(3)
    expect((await f.payload.count({ collection: 'media', where: { legacyPath: { like: '2097/01/' } }, overrideAccess: true })).totalDocs).toBe(0)
  })
})
