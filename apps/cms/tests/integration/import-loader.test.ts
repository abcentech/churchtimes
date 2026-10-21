import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { formatImportReport } from '../../src/import/qa'
import { runImport, type ImportOptions } from '../../src/import/run'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'
import { newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * The loader against a real database, with a SYNTHETIC export (invented names, example.test addresses, generated PNGs).
 * Every record carries the run id so the shared cleanup removes it.
 */
const runId = newRunId()
const base = 7_000_000 + (parseInt(runId.slice(1, 5), 16) % 60_000) * 10
const ids = { a: base + 1, b: base + 2, pw: base + 3, draft: base + 4, att: base + 5 }
let f: Fixtures
let dir: string
let uploads: string
let exportFile: string

const manifest = (n: number) => path.join(dir, `manifest-${n}.json`)
const readManifest = (n: number) => JSON.parse(fs.readFileSync(manifest(n), 'utf8'))

beforeAll(async () => {
  f = await setupFixtures(runId)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-loader-int-'))
  uploads = path.join(dir, 'uploads')
  fs.mkdirSync(path.join(uploads, '2099', '01'), { recursive: true })
  const png = (g: number) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g, b: 80 } } }).png().toBuffer()
  fs.writeFileSync(path.join(uploads, '2099', '01', 'a.png'), await png(90))
  fs.writeFileSync(path.join(uploads, '2099', '01', 'b.png'), await png(140))
  fs.writeFileSync(path.join(dir, 'secret.png'), await png(200)) // outside the uploads root

  const cat = { nicename: `${runId}-news`, name: `${runId} News` }
  const items: FixtureItem[] = [
    {
      id: ids.a,
      slug: `${runId}-story-a`,
      title: `${runId} story A &amp; more`,
      categories: [cat],
      excerpt: '<p>A short synthetic excerpt.</p>',
      meta: { _thumbnail_id: String(ids.att), rank_math_title: 'Search title %sitename%', rank_math_description: 'A fine description' },
      content:
        '<p>First paragraph.</p>' +
        `<p><img src="https://old.example.test/wp-content/uploads/2099/01/a.png" alt="${runId} body alt"></p>` +
        '<p><img src="https://old.example.test/wp-content/uploads/2099/01/missing.png" alt="gone"></p>' +
        '<p><img src="https://old.example.test/wp-content/uploads/../../secret.png" alt="traversal"></p>' +
        '<p><img src="https://elsewhere.example.test/wp-content/uploads/2099/01/a.png" alt="foreign"></p>' +
        `<p><a href="https://old.example.test/${runId}-story-b/">sister story</a></p>`,
    },
    {
      id: ids.b,
      slug: `${runId}-story-b`,
      categories: [cat],
      comments: [
        { id: base + 101, author: 'Ada Synthetic', content: 'A top level comment.' },
        { id: base + 102, parent: base + 101, author: 'Bo Synthetic', content: 'A reply.' },
        { id: base + 103, author: 'Spammer', content: 'buy now', approved: 'spam' },
        { id: base + 104, author: 'jane.doe@mail.example.test', content: 'Mail me at jane.doe@mail.example.test please.' },
        { id: base + 105, author: 'Cy', content: 'Waiting', approved: '0' },
      ],
    },
    { id: ids.pw, slug: `${runId}-story-pw`, password: 'secret-synthetic', categories: [cat] },
    { id: ids.draft, slug: `${runId}-story-draft`, status: 'draft', categories: [cat] },
    {
      id: ids.att,
      postType: 'attachment',
      status: 'inherit',
      slug: `${runId}-att`,
      attachmentUrl: 'https://old.example.test/wp-content/uploads/2099/01/b.png',
      meta: { _wp_attached_file: '2099/01/b.png', _wp_attachment_image_alt: `${runId} featured alt` },
    },
  ]
  exportFile = path.join(dir, 'export.xml')
  fs.writeFileSync(exportFile, wxr(items))
})

afterAll(async () => {
  await f?.cleanup()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

const options = (n: number, extra: Partial<ImportOptions> = {}): ImportOptions => ({
  file: exportFile,
  uploadsRoot: uploads,
  manifestPath: manifest(n),
  dryRun: false,
  ...extra,
})

const articlesFor = async () =>
  (
    await f.payload.find({
      collection: 'articles',
      where: { legacyId: { in: [ids.a, ids.b, ids.pw, ids.draft] } },
      limit: 10,
      depth: 0,
      overrideAccess: true,
    })
  ).docs as unknown as Array<Record<string, any>>

describe('WXR loader', () => {
  it('a dry run reads everything and writes nothing', async () => {
    const rep = await runImport(f.payload, options(0, { dryRun: true, manifestPath: undefined }))
    expect(rep.mode).toBe('dry-run')
    expect(rep.articles).toMatchObject({ created: 2, passwordProtected: 1 })
    expect(rep.articles.skipped['status-draft']).toBe(1)
    expect(rep.comments.created).toBe(3)
    expect(await articlesFor()).toHaveLength(0)
    const media = await f.payload.count({ collection: 'media', where: { legacyPath: { like: '2099/01' } }, overrideAccess: true })
    expect(media.totalDocs).toBe(0)
    expect(fs.existsSync(manifest(0))).toBe(false)
  })

  it('imports published posts, resolves media, refuses the traversal path, writes manifest and audit rows', async () => {
    const rep = await runImport(f.payload, options(1))
    expect(rep.mode).toBe('apply')
    expect(rep.articles).toMatchObject({ created: 2, updated: 0, unchanged: 0, passwordProtected: 1 })
    expect(rep.articles.skipped).toEqual({ 'status-draft': 1 })
    expect(rep.source).toMatchObject({ publishedPosts: 3, approvedCommentsOnPublishedPosts: 3 })
    expect(rep.media.created).toBe(2)
    expect(rep.media.unresolved).toMatchObject({ 'missing-file': 1, 'bad-path': 1, 'external-host': 1 })
    expect(rep.comments.created).toBe(3)
    expect(rep.comments.skipped).toMatchObject({ spam: 1, unapproved: 1 })
    expect(rep.verified).toEqual({ articlesInDatabase: 2, commentsInDatabase: 3 })

    const docs = await articlesFor()
    expect(docs.map((d) => d.legacyId).sort()).toEqual([ids.a, ids.b])
    const a = docs.find((d) => d.legacyId === ids.a)!
    expect(a).toMatchObject({ status: 'published', slug: `${runId}-story-a`, title: `${runId} story A & more`, excerpt: 'A short synthetic excerpt.', bylineName: 'Editor One' })
    expect(a.publishedAt).toBe('2023-05-04T10:30:00.000Z')
    expect(a.seoTitle).toBeFalsy() // had a %variable%
    expect(a.seoDescription).toBe('A fine description')
    expect(typeof a.featuredImage).toBe('number')
    expect(a.bodyMedia).toHaveLength(1)
    const bodyKinds = JSON.stringify(a.content)
    expect(bodyKinds).toContain('"type":"upload"')

    // media: legacy paths kept, nothing created from the file outside the root
    const media = (await f.payload.find({ collection: 'media', where: { legacyPath: { like: '2099/01' } }, limit: 10, depth: 0, overrideAccess: true })).docs as unknown as Array<Record<string, any>>
    expect(media.map((m) => m.legacyPath).sort()).toEqual(['2099/01/a.png', '2099/01/b.png'])
    expect(a.featuredImage).toBe(media.find((m) => m.legacyPath === '2099/01/b.png')!.id)

    // comments
    const comments = (await f.payload.find({ collection: 'legacy-comments', where: { article: { equals: docs.find((d) => d.legacyId === ids.b)!.id } }, limit: 20, depth: 0, overrideAccess: true, sort: 'legacyId' })).docs as unknown as Array<Record<string, any>>
    expect(comments.map((c) => c.legacyId)).toEqual([base + 101, base + 102, base + 104])
    expect(comments[1].parentLegacyId).toBe(base + 101)
    expect(JSON.stringify(comments)).not.toMatch(/@|example\.test/)
    expect(comments[2].authorName).toBe('Anonymous')

    // manifest: ids only, owner-only
    const m = readManifest(1)
    expect(m.articles.created.slice().sort()).toEqual(docs.map((d) => d.id).sort())
    expect(m.articles.updated).toEqual([])
    expect(m.media).toHaveLength(2)
    expect(m.comments).toHaveLength(3)
    expect(m.audits).toHaveLength(2)
    expect(m.categories).toHaveLength(1)
    expect(m.finishedAt).toBeTruthy()
    expect(JSON.stringify(m)).not.toMatch(/example\.test|story/)
    if (process.platform !== 'win32') expect(fs.statSync(manifest(1)).mode & 0o777).toBe(0o600)

    // audit rows: one import.article per article, no title or address
    const audits = (await f.payload.find({ collection: 'audit-logs', where: { action: { equals: 'import.article' }, docId: { in: docs.map((d) => String(d.id)) } }, limit: 10, depth: 0, overrideAccess: true })).docs as unknown as Array<Record<string, any>>
    expect(audits).toHaveLength(2)
    expect(JSON.stringify(audits)).not.toMatch(/example\.test|story A/)

    // the report holds counts only
    const text = formatImportReport(rep)
    expect(text).not.toMatch(/@|example\.test|story|jane|Ada|Editor/)
  })

  it('a second run is a no-op', async () => {
    const before = await articlesFor()
    const rep = await runImport(f.payload, options(2))
    expect(rep.articles).toMatchObject({ created: 0, updated: 0, unchanged: 2, passwordProtected: 1 })
    expect(rep.media.created).toBe(0)
    expect(rep.comments).toMatchObject({ created: 0, existing: 3 })
    expect(rep.verified).toEqual({ articlesInDatabase: 2, commentsInDatabase: 3 })
    const m = readManifest(2)
    expect(m.articles).toEqual({ created: [], updated: [] })
    expect([m.media, m.comments, m.audits, m.categories]).toEqual([[], [], [], []])
    const after = await articlesFor()
    expect(after.map((d) => [d.id, d.updatedAt])).toEqual(before.map((d) => [d.id, d.updatedAt]))
    const audits = await f.payload.count({ collection: 'audit-logs', where: { action: { equals: 'import.article' }, docId: { in: before.map((d) => String(d.id)) } }, overrideAccess: true })
    expect(audits.totalDocs).toBe(2)
  })

  it('--update rewrites an imported article, records it as updated and audits it', async () => {
    const rep = await runImport(f.payload, options(3, { update: true }))
    expect(rep.articles).toMatchObject({ created: 0, updated: 2, unchanged: 0 })
    expect(rep.media.created).toBe(0)
    expect(rep.comments.created).toBe(0)
    const m = readManifest(3)
    expect(m.articles.updated).toHaveLength(2)
    expect(m.audits).toHaveLength(2)
    expect((await articlesFor()).filter((d) => d.status === 'published')).toHaveLength(2)
  })

  it('refuses a manifest inside the repository, an existing manifest, and a missing manifest path', async () => {
    await expect(runImport(f.payload, options(4, { manifestPath: path.join(process.cwd(), 'never-written-manifest.json') }))).rejects.toMatchObject({ code: 'IMPORT_MANIFEST_INSIDE_REPO' })
    expect(fs.existsSync(path.join(process.cwd(), 'never-written-manifest.json'))).toBe(false)
    await expect(runImport(f.payload, options(1))).rejects.toMatchObject({ code: 'IMPORT_MANIFEST_UNWRITABLE' })
    await expect(runImport(f.payload, options(5, { manifestPath: undefined }))).rejects.toMatchObject({ code: 'IMPORT_MANIFEST_REQUIRED' })
    await expect(runImport(f.payload, options(6, { uploadsRoot: process.cwd() }))).rejects.toMatchObject({ code: 'IMPORT_UPLOADS_INSIDE_REPO' })
  })
})
