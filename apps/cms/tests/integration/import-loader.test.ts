import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { readManifest } from '../../src/import/manifest'
import { formatImportReport } from '../../src/import/qa'
import { runImport, type ImportOptions } from '../../src/import/run'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

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

const manifest = (n: number) => path.join(dir, `manifest-${n}.jsonl`)
const read = (n: number) => readManifest(manifest(n))

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
    expect(a.seoTitle).toBe('Search title Church Times Nigeria') // Rank Math %sitename% resolved
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
    const m = read(1)
    expect(m.articles.created.slice().sort()).toEqual(docs.map((d) => d.id).sort())
    expect(m.articles.updated).toEqual([])
    expect(m.media).toHaveLength(2)
    expect(m.comments).toHaveLength(3)
    expect(m.audits).toHaveLength(6) // 2 import.article + 2 Articles create + 2 Media upload
    expect(m.categories).toHaveLength(1)
    expect(m).toMatchObject({ complete: true, endStatus: 'complete', openIntents: [], aborted: [] })
    expect(fs.readFileSync(manifest(1), 'utf8')).not.toMatch(/example\.test|story/)
    if (process.platform !== 'win32') expect(fs.statSync(manifest(1)).mode & 0o777).toBe(0o600)

    // audit rows: one import.article per article, no title or address
    const audits = (await f.payload.find({ collection: 'audit-logs', where: { action: { equals: 'import.article' }, docId: { in: docs.map((d) => String(d.id)) } }, limit: 10, depth: 0, overrideAccess: true })).docs as unknown as Array<Record<string, any>>
    expect(audits).toHaveLength(2)
    expect(audits.every((a) => a.actorRole === 'import' && a.toStatus === 'published')).toBe(true)
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
    const m = read(2)
    expect(m.articles).toEqual({ created: [], updated: [] })
    expect([m.media, m.comments, m.audits, m.categories]).toEqual([[], [], [], []])
    expect(m.complete).toBe(true)
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
    const m = read(3)
    expect(m.articles.updated).toHaveLength(2)
    expect(m.audits).toHaveLength(2)
    expect((await articlesFor()).filter((d) => d.status === 'published')).toHaveLength(2)
  })

  it('--update leaves an article an editor changed after its import, unless --force-update', async () => {
    const [a] = (await articlesFor()).filter((d) => d.legacyId === ids.a)
    await f.payload.update({ collection: 'articles', id: a.id, data: { title: `${runId} edited by an editor` } as never, overrideAccess: true, context: { seed: true } })
    const rep = await runImport(f.payload, options(31, { update: true }))
    expect(rep.articles.updated).toBe(1)
    expect(rep.articles.skipped['edited-since-import']).toBe(1)
    const stillEdited = (await articlesFor()).find((d) => d.legacyId === ids.a)!
    expect(stillEdited.title).toContain('edited by an editor')
    const forced = await runImport(f.payload, options(32, { update: true, forceUpdate: true }))
    expect(forced.articles.updated).toBe(2)
    expect((await articlesFor()).find((d) => d.legacyId === ids.a)!.title).toBe(`${runId} story A & more`)
  })

  it('refuses a manifest inside the repository, an existing manifest, and a missing manifest path', async () => {
    await expect(runImport(f.payload, options(4, { manifestPath: path.join(process.cwd(), 'never-written-manifest.json') }))).rejects.toMatchObject({ code: 'IMPORT_MANIFEST_INSIDE_REPO' })
    expect(fs.existsSync(path.join(process.cwd(), 'never-written-manifest.json'))).toBe(false)
    await expect(runImport(f.payload, options(1))).rejects.toMatchObject({ code: 'IMPORT_MANIFEST_UNWRITABLE' })
    await expect(runImport(f.payload, options(5, { manifestPath: undefined }))).rejects.toMatchObject({ code: 'IMPORT_MANIFEST_REQUIRED' })
    await expect(runImport(f.payload, options(6, { uploadsRoot: process.cwd() }))).rejects.toMatchObject({ code: 'IMPORT_UPLOADS_INSIDE_REPO' })
  })
})

describe('WXR loader: atomicity, stopping, failure limits and ownership', () => {
  const post = (id: number, extra: Partial<FixtureItem> = {}): FixtureItem => ({
    id,
    slug: `${runId}-extra-${id}`,
    categories: [{ nicename: `${runId}-extra`, name: `${runId} Extra` }],
    ...extra,
  })
  const exportOf = (name: string, items: FixtureItem[]) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, wxr(items))
    return file
  }
  const exists = async (legacyId: number) =>
    (await f.payload.count({ collection: 'articles', where: { legacyId: { equals: legacyId } }, overrideAccess: true })).totalDocs

  it('a SIGINT-style stop ends cleanly between posts and a rerun finishes the rest', async () => {
    const file = exportOf('stop.xml', [post(base + 30), post(base + 31)])
    let checks = 0
    const signal = {
      get stopped() {
        return checks++ >= 1
      },
    }
    const rep = await runImport(f.payload, { ...options(40, { file }), signal })
    expect(rep.articles.created).toBe(1)
    expect(rep.notes).toContain('stopped-early-by-signal')
    expect(read(40)).toMatchObject({ complete: true, endStatus: 'stopped', openIntents: [] })
    const again = await runImport(f.payload, options(41, { file }))
    expect(again.articles).toMatchObject({ created: 1, unchanged: 1 })
  })

  it('a post that fails midway leaves nothing behind (one transaction) and the manifest still lists what was written', async () => {
    const file = exportOf('atomic.xml', [
      post(base + 50, {
        comments: [
          { id: base + 151, content: 'first' },
          { id: base + 152, content: 'second' },
        ],
      }),
    ])
    const original = f.payload.create.bind(f.payload)
    const spy = vi.spyOn(f.payload, 'create').mockImplementation(((args: { collection: string; data: { legacyId?: number } }) => {
      if (args.collection === 'legacy-comments' && args.data.legacyId === base + 152) return Promise.reject(new Error('disk full (synthetic)'))
      return original(args as never)
    }) as never)
    try {
      const rep = await runImport(f.payload, options(42, { file }))
      expect(rep.articles.skipped['write-failed']).toBe(1)
      expect(rep.articles.created).toBe(0)
      expect(rep.comments.created).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(await exists(base + 50)).toBe(0)
    const m = read(42)
    expect(m.articles.created).toHaveLength(1) // logged before the failure
    expect(m.aborted).toEqual([base + 50])
    expect(m.complete).toBe(true)
    // the cached category of the rolled-back transaction is forgotten: a rerun succeeds completely
    const rep2 = await runImport(f.payload, options(43, { file }))
    expect(rep2.articles.created).toBe(1)
    expect(rep2.comments.created).toBe(2)
    expect(await exists(base + 50)).toBe(1)
  })

  it('aborts after too many failed posts in a row, with a readable manifest', async () => {
    const file = exportOf('fail.xml', [post(base + 60), post(base + 61), post(base + 62)])
    const original = f.payload.create.bind(f.payload)
    const spy = vi.spyOn(f.payload, 'create').mockImplementation(((args: { collection: string }) =>
      args.collection === 'articles' ? Promise.reject(new Error('db down (synthetic)')) : original(args as never)) as never)
    try {
      await expect(runImport(f.payload, options(44, { file, maxConsecutiveFailures: 2 }))).rejects.toMatchObject({ code: 'IMPORT_TOO_MANY_FAILURES' })
    } finally {
      spy.mockRestore()
    }
    expect(read(44)).toMatchObject({ complete: true, endStatus: 'failed', aborted: [base + 60, base + 61], openIntents: [] })
    expect(await exists(base + 60)).toBe(0)
    expect(await exists(base + 62)).toBe(0)
  })

  it('legacyId and legacyUrl are server-owned and legacyId is unique', async () => {
    const res = await f.createArticle(f.tokens.reporter, { legacyId: base + 70, legacyUrl: 'https://old.example.test/hijack/' })
    expect(res.status).toBe(201)
    expect(res.json.doc.legacyId ?? null).toBeNull()
    expect(res.json.doc.legacyUrl ?? null).toBeNull()
    const patch = await api('PATCH', `/api/articles/${res.id}`, { token: f.tokens.eic, body: { legacyId: base + 71 } })
    expect(patch.status).toBeLessThan(500)
    expect((await api('GET', `/api/articles/${res.id}`, { token: f.tokens.eic })).json.legacyId ?? null).toBeNull()
    await f.seedArticle({ legacyId: base + 72 })
    await expect(f.seedArticle({ legacyId: base + 72 })).rejects.toThrow()
  })

  it('the Articles validators still run under the import context', async () => {
    const content = { root: { type: 'root', version: 1, direction: null, format: '', indent: 0, children: [{ type: 'upload', version: 3, relationTo: 'media', value: 2147483000, fields: null }] } }
    await expect(
      f.payload.create({
        collection: 'articles',
        data: { title: `${runId} validators`, slug: `${runId}-validators`, content, category: f.catA.id, status: 'published' } as never,
        overrideAccess: true,
        context: { import: true },
      }),
    ).rejects.toThrow()
  })
})
