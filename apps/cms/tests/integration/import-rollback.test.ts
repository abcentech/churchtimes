import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openManifest, readManifest } from '../../src/import/manifest'
import { formatRollbackReport, runRollback, type RollbackOptions } from '../../src/import/rollback'
import { runImport } from '../../src/import/run'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'
import { lexical, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * The rollback tool against a real database, with SYNTHETIC rows (invented names, generated PNGs).
 * Every protection test builds its own rows and its own manifest, so the tests do not depend on their order.
 */
const runId = newRunId()
const base = 8_000_000 + (parseInt(runId.slice(1, 5), 16) % 60_000) * 10
const ids = { a: base + 1, b: base + 2, att: base + 5 }
let f: Fixtures
let dir: string
let exportFile: string
let uploads: string
let pngFile: string
let n = 0
let legacyCounter = base + 500_000
const cleanups: Array<() => Promise<unknown>> = []

const manifest = (name: string) => path.join(dir, `manifest-${name}.jsonl`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rb = (name: string, extra: Partial<RollbackOptions> = {}) => runRollback(f.payload, { manifestPath: manifest(name), minIncompleteAgeMs: 0, ...extra })
const code = async (p: Promise<unknown>) => await p.then(() => null, (e: { code?: string }) => e.code ?? 'other')
const exists = async (collection: string, id: number) => (await f.payload.count({ collection: collection as never, where: { id: { equals: id } } as never, overrideAccess: true })).totalDocs === 1
const count = async (collection: string, where: Record<string, unknown>) =>
  (await f.payload.count({ collection: collection as never, where: where as never, overrideAccess: true })).totalDocs
const mediaDocs = async () =>
  (await f.payload.find({ collection: 'media', where: { legacyPath: { like: '2098/01/' } }, limit: 10, depth: 0, overrideAccess: true })).docs as unknown as Array<Record<string, any>>
const staticDir = () => path.resolve((f.payload.collections as any).media.config.upload.staticDir as string)

type Listed = { articles?: number[]; articlesUpdated?: number[]; media?: number[]; mediaUpdated?: number[]; categories?: number[]; categoriesUpdated?: number[]; comments?: number[]; commentsUpdated?: number[] }
/** A manifest written by hand, with a chosen window; `start` and `end` are epoch ms. */
function handManifest(name: string, listed: Listed, win: { start?: number; end?: number } = {}): void {
  const lines: unknown[] = [{ type: 'start', schema: 'churchtimes-import-manifest/2', at: new Date(win.start ?? Date.now() - 2000).toISOString() }]
  const add = (collection: string, action: 'created' | 'updated', list: number[] | undefined) => (list ?? []).forEach((id) => lines.push({ type: 'id', collection, action, id }))
  add('articles', 'created', listed.articles)
  add('articles', 'updated', listed.articlesUpdated)
  add('media', 'created', listed.media)
  add('media', 'updated', listed.mediaUpdated)
  add('categories', 'created', listed.categories)
  add('categories', 'updated', listed.categoriesUpdated)
  add('legacy-comments', 'created', listed.comments)
  add('legacy-comments', 'updated', listed.commentsUpdated)
  lines.push({ type: 'end', at: new Date(win.end ?? Date.now() + 1000).toISOString(), status: 'complete' })
  fs.writeFileSync(manifest(name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

const mkMedia = async (legacyPath: string | undefined, file = pngFile): Promise<number> =>
  (
    (await f.payload.create({
      collection: 'media',
      data: { alt: `${runId} hand media ${++n}`, ...(legacyPath ? { legacyPath } : {}) } as never,
      filePath: file,
      overrideAccess: true,
    })) as { id: number }
  ).id
const mkCategory = async (): Promise<number> =>
  ((await f.payload.create({ collection: 'categories', data: { title: `${runId} hc ${++n}`, slug: `${runId}-hc-${n}` }, overrideAccess: true })) as { id: number }).id
const mkArticle = async (category: number): Promise<number> =>
  (
    (await f.payload.create({
      collection: 'articles',
      data: { title: `${runId} ha ${++n}`, slug: `${runId}-ha-${n}`, content: lexical(), category, status: 'published', publishedAt: '2023-05-04T10:30:00.000Z', legacyId: ++legacyCounter } as never,
      overrideAccess: true,
      context: { import: true },
    })) as { id: number }
  ).id
const mkComment = async (article: number): Promise<number> =>
  (
    (await f.payload.create({
      collection: 'legacy-comments',
      data: { article, authorName: 'Synthetic Commenter', content: 'A synthetic comment.', commentedAt: '2023-05-05T11:00:00.000Z', legacyId: ++legacyCounter, status: 'approved' } as never,
      overrideAccess: true,
    })) as { id: number }
  ).id

beforeAll(async () => {
  f = await setupFixtures(runId)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-rollback-int-'))
  uploads = path.join(dir, 'uploads')
  fs.mkdirSync(path.join(uploads, '2098', '01'), { recursive: true })
  const png = (g: number) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g, b: 80 } } }).png().toBuffer()
  fs.writeFileSync(path.join(uploads, '2098', '01', 'a.png'), await png(90))
  fs.writeFileSync(path.join(uploads, '2098', '01', 'b.png'), await png(140))
  pngFile = path.join(dir, 'hand.png')
  fs.writeFileSync(pngFile, await png(200))
  const cat = { nicename: `${runId}-news`, name: `${runId} News` }
  const items: FixtureItem[] = [
    {
      id: ids.a,
      slug: `${runId}-story-a`,
      categories: [cat],
      meta: { _thumbnail_id: String(ids.att) },
      content: `<p>Body.</p><p><img src="https://old.example.test/wp-content/uploads/2098/01/a.png" alt="${runId} body alt"></p>`,
      comments: [{ id: base + 101, author: 'Ada Synthetic', content: 'A top level comment.' }],
    },
    {
      id: ids.b,
      slug: `${runId}-story-b`,
      categories: [cat],
      comments: [
        { id: base + 102, author: 'Bo Synthetic', content: 'First.' },
        { id: base + 103, author: 'Cy Synthetic', content: 'Second.' },
      ],
    },
    {
      id: ids.att,
      postType: 'attachment',
      status: 'inherit',
      slug: `${runId}-att`,
      attachmentUrl: 'https://old.example.test/wp-content/uploads/2098/01/b.png',
      meta: { _wp_attached_file: '2098/01/b.png', _wp_attachment_image_alt: `${runId} featured alt` },
    },
  ]
  exportFile = path.join(dir, 'export.xml')
  fs.writeFileSync(exportFile, wxr(items))
})

afterAll(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => undefined)
  await f?.payload.db.deleteMany({ collection: 'ad-campaigns', where: { sponsor: { like: runId } }, req: undefined as never }).catch(() => undefined)
  await f?.payload.db.deleteMany({ collection: 'advertisers', where: { name: { like: runId } }, req: undefined as never }).catch(() => undefined)
  await f?.cleanup()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe('rollback refusals', () => {
  it('refuses a missing, foreign or incomplete manifest, and an incomplete one that is too recent', async () => {
    expect(await code(rb('nope'))).toBe('ROLLBACK_MANIFEST_UNREADABLE')
    fs.writeFileSync(manifest('junk'), 'not a manifest\n{"type":"id"}\n')
    expect(await code(rb('junk'))).toBe('ROLLBACK_MANIFEST_INVALID')
    // A killed run: no `end` line, and a torn last line.
    const start = JSON.stringify({ type: 'start', schema: 'churchtimes-import-manifest/2', at: new Date().toISOString() })
    fs.writeFileSync(manifest('killed'), `${start}\n{"type":"id","collection":"articles","action":"created","id":2000000000}\n{"type":"id","collection":"articles","act`)
    expect(await code(rb('killed', { apply: true }))).toBe('ROLLBACK_MANIFEST_INCOMPLETE')
    expect(await code(rb('killed', { allowIncomplete: true, minIncompleteAgeMs: 60_000 }))).toBe('ROLLBACK_MANIFEST_TOO_RECENT')
    const allowed = await rb('killed', { allowIncomplete: true })
    expect(readManifest(manifest('killed')).complete).toBe(false)
    expect(allowed).toMatchObject({ mode: 'dry-run', articles: { listed: 1, alreadyGone: 1 } })
    expect(allowed.notes).toContain('incomplete-manifest-allowed')
  })
})

describe('rollback provenance', () => {
  it('never deletes media without a legacy path, but deletes the same row once it has one', async () => {
    const foreign = await mkMedia(undefined)
    const mine = await mkMedia(`2098/09/${runId}-mine.png`)
    handManifest('prov-media', { media: [foreign, mine] })
    const rep = await rb('prov-media', { apply: true })
    expect(rep.media).toMatchObject({ listed: 2, deleted: 1, skipped: { 'not-an-imported-row': 1 } })
    expect(await exists('media', foreign)).toBe(true)
    expect(await exists('media', mine)).toBe(false)
  })

  it('never deletes an article without a legacy id (a staff article)', async () => {
    const cat = await mkCategory()
    const staffArticle = (await f.seedArticle({ category: cat })).id
    handManifest('prov-article', { articles: [staffArticle] })
    const rep = await rb('prov-article', { apply: true })
    expect(rep.articles).toMatchObject({ listed: 1, deleted: 0, skipped: { 'not-an-imported-row': 1 } })
    expect(await exists('articles', staffArticle)).toBe(true)
  })

  it('skips every kind of row created outside the run window (before the start or after the end)', async () => {
    const cat = await mkCategory()
    const article = await mkArticle(cat)
    const comment = await mkComment(article)
    const media = await mkMedia(`2098/09/${runId}-w.png`)
    const rows = { articles: [article], comments: [comment], media: [media], categories: [cat] }
    const hour = 3_600_000
    // The run ended an hour before the rows were created.
    handManifest('win-after', rows, { start: Date.now() - 2 * hour, end: Date.now() - hour })
    const after = await rb('win-after', { apply: true, force: true, includePublished: true })
    for (const k of ['articles', 'comments', 'media', 'categories'] as const) expect(after[k], k).toMatchObject({ deleted: 0, skipped: { 'outside-run-window': 1 } })
    // The run started an hour after the rows were created.
    handManifest('win-before', rows, { start: Date.now() + hour, end: Date.now() + 2 * hour })
    const before = await rb('win-before', { apply: true, force: true, includePublished: true })
    for (const k of ['articles', 'comments', 'media', 'categories'] as const) expect(before[k], k).toMatchObject({ deleted: 0, skipped: { 'outside-run-window': 1 } })
    expect(await exists('legacy-comments', comment)).toBe(true)
    expect(await exists('media', media)).toBe(true)
    expect(await exists('categories', cat)).toBe(true)
    expect(await exists('articles', article)).toBe(true)
  })

  it('does not read an `updated` action as a creation (media, categories, comments)', async () => {
    const cat = await mkCategory()
    const article = await mkArticle(cat)
    const comment = await mkComment(article)
    const media = await mkMedia(`2098/09/${runId}-u.png`)
    handManifest('updated-only', { mediaUpdated: [media], categoriesUpdated: [cat], commentsUpdated: [comment] })
    const rep = await rb('updated-only', { apply: true, force: true, includePublished: true })
    expect([rep.media.listed, rep.categories.listed, rep.comments.listed]).toEqual([0, 0, 0])
    expect(await exists('media', media)).toBe(true)
    expect(await exists('categories', cat)).toBe(true)
    expect(await exists('legacy-comments', comment)).toBe(true)
  })
})

describe('rollback edit detection', () => {
  it('skips media, categories, comments and articles changed after creation, and --force removes them', async () => {
    const cat = await mkCategory()
    const article = await mkArticle(cat)
    const comment = await mkComment(article)
    const media = await mkMedia(`2098/09/${runId}-e.png`)
    await sleep(1200)
    await f.payload.update({ collection: 'media', id: media, data: { alt: `${runId} edited by staff` } as never, overrideAccess: true })
    await f.payload.update({ collection: 'categories', id: cat, data: { title: `${runId} edited by staff` }, overrideAccess: true })
    await f.payload.update({ collection: 'legacy-comments', id: comment, data: { status: 'hidden' } as never, overrideAccess: true })
    await f.payload.update({ collection: 'articles', id: article, data: { excerpt: 'Edited by staff.' } as never, overrideAccess: true, context: { import: true } })
    handManifest('edited', { articles: [article], comments: [comment], media: [media], categories: [cat] })
    const rep = await rb('edited', { apply: true })
    expect(rep.comments).toMatchObject({ deleted: 0, skipped: { 'edited-since-import': 1 } })
    expect(rep.articles).toMatchObject({ deleted: 0, skipped: { 'edited-since-import': 1 } })
    expect(rep.media).toMatchObject({ deleted: 0, skipped: { 'edited-since-import': 1 } })
    expect(rep.categories).toMatchObject({ deleted: 0, skipped: { 'edited-since-import': 1 } })
    const forced = await rb('edited', { apply: true, force: true, includePublished: true })
    expect([forced.comments.deleted, forced.articles.deleted, forced.media.deleted, forced.categories.deleted]).toEqual([1, 1, 1, 1])
  })
})

describe('rollback --force and live content', () => {
  it('--force alone keeps published and reviewed articles; --include-published removes them', async () => {
    const cat = await mkCategory()
    const published = await mkArticle(cat)
    const reviewed = (
      (await f.payload.create({
        collection: 'articles',
        data: {
          title: `${runId} hr ${++n}`,
          slug: `${runId}-hr-${n}`,
          content: lexical(),
          category: cat,
          status: 'draft',
          provenance: { importBatch: `b-${runId}`, reviewStatus: 'reviewed' },
        } as never,
        overrideAccess: true,
        context: { import: true },
      })) as { id: number }
    ).id
    const draft = await mkArticle(cat)
    await f.payload.update({ collection: 'articles', id: draft, data: { status: 'draft' } as never, overrideAccess: true, context: { import: true } })
    await sleep(1200)
    for (const id of [published, reviewed, draft]) {
      await f.payload.update({ collection: 'articles', id, data: { excerpt: 'Edited by staff.' } as never, overrideAccess: true, context: { import: true } })
    }
    handManifest('force-live', { articles: [published, reviewed, draft] })
    const forced = await rb('force-live', { apply: true, force: true })
    expect(forced.articles).toMatchObject({ deleted: 1, skipped: { 'published-or-reviewed': 2 } })
    expect(await exists('articles', published)).toBe(true)
    expect(await exists('articles', reviewed)).toBe(true)
    expect(await exists('articles', draft)).toBe(false)
    const all = await rb('force-live', { apply: true, force: true, includePublished: true })
    expect(all.articles.deleted).toBe(2)
    expect(await exists('articles', published)).toBe(false)
    expect(await exists('articles', reviewed)).toBe(false)
  })
})

describe('rollback still-used checks', () => {
  it('keeps media used as a creative of a placement the campaign did NOT select', async () => {
    const adv = (await f.payload.create({ collection: 'advertisers', data: { name: `${runId} Advertiser Ltd`, contactName: 'Pat', contactEmail: 'pat@example.test' } as never, overrideAccess: true })) as { id: number }
    const small = path.join(dir, 'banner.png')
    fs.writeFileSync(small, await sharp({ create: { width: 320, height: 50, channels: 3, background: '#336699' } }).png().toBuffer())
    const valid = await mkMedia(undefined, small)
    const hidden = await mkMedia(`2098/09/${runId}-ad.png`)
    const campaign = (await f.payload.create({
      collection: 'ad-campaigns',
      data: {
        advertiser: adv.id,
        sponsor: `${runId} sponsor`,
        alt: 'An offer',
        destinationUrl: 'https://example.test/offer',
        placements: ['mobile-banner'],
        creatives: { mobileBanner: { mobile: valid }, homepageBillboard: { desktop: hidden } },
        startsAt: new Date(Date.now() - 3600_000).toISOString(),
        endsAt: new Date(Date.now() + 3600_000).toISOString(),
        priority: 1,
      } as never,
      overrideAccess: true,
    })) as { id: number; creativeMedia?: unknown[] }
    // The derived column only knows the selected placement: this is exactly the gap the check must not rely on.
    expect(((campaign.creativeMedia ?? []) as Array<{ id: number } | number>).map((m) => (typeof m === 'number' ? m : m.id))).not.toContain(hidden)
    handManifest('ad', { media: [hidden] })
    const rep = await rb('ad', { apply: true })
    expect(rep.media).toMatchObject({ deleted: 0, skipped: { 'still-used': 1 } })
    expect(await exists('media', hidden)).toBe(true)
    await f.payload.db.deleteMany({ collection: 'ad-campaigns', where: { id: { equals: campaign.id } }, req: undefined as never })
    const free = await rb('ad', { apply: true })
    expect(free.media.deleted).toBe(1)
  })

  it('keeps media used by a live update', async () => {
    const media = await mkMedia(`2098/09/${runId}-lu.png`)
    const event = (await f.payload.create({ collection: 'live-events', data: { title: `${runId} event`, slug: `${runId}-lu-event`, category: f.catA.id, status: 'live' } as never, overrideAccess: true })) as { id: number }
    await f.payload.create({ collection: 'live-updates', data: { event: event.id, body: 'An update.', image: media, status: 'approved' } as never, overrideAccess: true })
    handManifest('liveupdate', { media: [media] })
    const rep = await rb('liveupdate', { apply: true })
    expect(rep.media).toMatchObject({ deleted: 0, skipped: { 'still-used': 1 } })
    expect(await exists('media', media)).toBe(true)
  })

  it('keeps media used by an article it does not delete, and categories used by a live event, a user or an article', async () => {
    const catArticle = await mkCategory()
    const catEvent = await mkCategory()
    const catUser = await mkCategory()
    const mediaFeatured = await mkMedia(`2098/09/${runId}-feat.png`)
    const staffArticle = (await f.seedArticle({ category: catArticle, featuredImage: mediaFeatured })).id
    await f.payload.create({ collection: 'live-events', data: { title: `${runId} ev2`, slug: `${runId}-cat-event`, category: catEvent, status: 'draft' } as never, overrideAccess: true })
    await f.payload.create({
      collection: 'users',
      data: { email: `${runId}-sections@test.invalid`, name: `${runId} sections`, password: 'Test-only-pass-1234!', role: 'section-editor', sections: [catUser] } as never,
      overrideAccess: true,
    })
    handManifest('used', { media: [mediaFeatured], categories: [catArticle, catEvent, catUser] })
    const rep = await rb('used', { apply: true })
    expect(rep.media).toMatchObject({ deleted: 0, skipped: { 'still-used': 1 } })
    expect(rep.categories).toMatchObject({ deleted: 0, skipped: { 'still-used': 3 } })
    expect(await exists('articles', staffArticle)).toBe(true)
  })

  it('keeps a category that a staff article still uses as an ADDITIONAL category, and removes it once nothing uses it', async () => {
    const primary = await mkCategory()
    const extra = await mkCategory()
    const staffArticle = (await f.seedArticle({ category: primary, categories: [extra] })).id
    handManifest('secondary-used', { categories: [extra] })
    const rep = await rb('secondary-used', { apply: true })
    expect(rep.categories).toMatchObject({ deleted: 0, skipped: { 'still-used': 1 } })
    expect(await exists('categories', extra)).toBe(true)
    await f.payload.delete({ collection: 'articles', id: staffArticle, overrideAccess: true })
    const again = await rb('secondary-used', { apply: true })
    expect(again.categories).toMatchObject({ deleted: 1 })
    expect(await exists('categories', extra)).toBe(false)
  })

  it('removes an imported article together with its additional category links, and the categories only it used', async () => {
    const primary = await mkCategory()
    const extra = await mkCategory()
    const article = await mkArticle(primary)
    await f.payload.update({ collection: 'articles', id: article, data: { categories: [extra] } as never, overrideAccess: true, context: { seed: true } })
    handManifest('secondary-own', { articles: [article], categories: [primary, extra] })
    const rep = await rb('secondary-own', { apply: true })
    expect(rep.articles).toMatchObject({ deleted: 1 })
    expect(rep.categories).toMatchObject({ deleted: 2 })
    expect(await exists('articles', article)).toBe(false)
    expect(await exists('categories', extra)).toBe(false)
  })

  it('keeps an article that still has a comment the manifest does not list', async () => {
    const cat = await mkCategory()
    const article = await mkArticle(cat)
    const listed = await mkComment(article)
    const unlisted = await mkComment(article)
    handManifest('remaining', { articles: [article], comments: [listed] })
    const rep = await rb('remaining', { apply: true })
    expect(rep.comments.deleted).toBe(1)
    expect(rep.articles).toMatchObject({ deleted: 0, skipped: { 'has-remaining-comments': 1 } })
    expect(await exists('articles', article)).toBe(true)
    expect(await exists('legacy-comments', unlisted)).toBe(true)
  })
})

describe('rollback media files', () => {
  it('refuses a file name that leaves the media folder, even with --force', async () => {
    const media = await mkMedia(`2098/09/${runId}-evil.png`)
    const outside = path.join(dir, 'escape.png')
    fs.writeFileSync(outside, 'x')
    await f.payload.db.updateOne({ collection: 'media', id: media, data: { filename: '../../escape.png' } as never, req: undefined as never } as never)
    handManifest('unsafe', { media: [media] })
    const rep = await rb('unsafe', { apply: true, force: true, includePublished: true })
    expect(rep.media).toMatchObject({ deleted: 0, skipped: { 'unsafe-file-name': 1 } })
    expect(await exists('media', media)).toBe(true)
    expect(fs.existsSync(outside)).toBe(true)
  })

  it('accepts legitimate names (spaces, non-ASCII, a leading underscore) and removes only that file', async () => {
    const media = await mkMedia(`2098/09/${runId}-nice.png`)
    const odd = '_my photo é.png'
    const current = (await f.payload.findByID({ collection: 'media', id: media, depth: 0, overrideAccess: true })) as unknown as { filename: string }
    fs.copyFileSync(path.join(staticDir(), current.filename), path.join(staticDir(), odd))
    await f.payload.db.updateOne({ collection: 'media', id: media, data: { filename: odd } as never, req: undefined as never } as never)
    handManifest('nice', { media: [media] })
    const rep = await rb('nice', { apply: true, force: true, includePublished: true })
    expect(rep.media).toMatchObject({ deleted: 1, failed: 0 })
    expect(fs.existsSync(path.join(staticDir(), odd))).toBe(false)
    fs.rmSync(path.join(staticDir(), current.filename), { force: true })
  })
})

describe('rollback of a real import', () => {
  it('dry run, apply (skipping an edited article and what it needs), --force, and an idempotent second rollback', async () => {
    const rep0 = await runImport(f.payload, { file: exportFile, uploadsRoot: uploads, manifestPath: manifest('run'), dryRun: false })
    expect(rep0.articles.created).toBe(2)
    const articleCount = () => count('articles', { legacyId: { in: [ids.a, ids.b] } })
    const commentCount = () => count('legacy-comments', { legacyId: { in: [base + 101, base + 102, base + 103] } })
    const m = readManifest(manifest('run'))

    // Dry run: counts, nothing changes, no personal data.
    const dry = await rb('run')
    expect(dry.mode).toBe('dry-run')
    expect(dry.articles).toMatchObject({ listed: 2, wouldDelete: 2, deleted: 0 })
    expect(dry.comments).toMatchObject({ listed: 3, wouldDelete: 3 })
    expect(dry.media).toMatchObject({ listed: 2, wouldDelete: 2 })
    expect(dry.categories).toMatchObject({ listed: 1, wouldDelete: 1 })
    expect(dry.auditRowsKept).toBe(6)
    expect(dry.manifest.startedAt).toBe(m.startedAt)
    expect(await articleCount()).toBe(2)
    expect(formatRollbackReport(dry)).not.toMatch(/@|example\.test|story|Synthetic|\.png/)

    // A run that only updated articles never deletes them.
    const live = (await f.payload.find({ collection: 'articles', where: { legacyId: { in: [ids.a, ids.b] } }, depth: 0, overrideAccess: true })).docs as unknown as Array<{ id: number; legacyId: number }>
    handManifest('update', { articlesUpdated: live.map((d) => d.id) })
    const upd = await rb('update', { apply: true })
    expect(upd.articles).toMatchObject({ listed: 0, deleted: 0 })
    expect(upd.articlesUpdatedNotReverted).toBe(2)
    expect(await articleCount()).toBe(2)

    const auditsBefore = await count('audit-logs', { id: { in: m.audits } })
    expect(auditsBefore).toBe(6)
    const files = (await mediaDocs()).map((d) => path.join(staticDir(), d.filename as string))
    expect(files.every((p) => fs.existsSync(p))).toBe(true)

    // Staff edit article A after the run.
    await sleep(1200)
    const articleA = live.find((d) => d.legacyId === ids.a)!
    await f.payload.update({ collection: 'articles', id: articleA.id, data: { excerpt: 'Edited by staff.' } as never, overrideAccess: true, context: { import: true } })

    const rep = await rb('run', { apply: true })
    expect(rep.comments).toMatchObject({ listed: 3, deleted: 3, failed: 0 })
    expect(rep.articles).toMatchObject({ listed: 2, deleted: 1, failed: 0, skipped: { 'edited-since-import': 1 } })
    expect(rep.media).toMatchObject({ deleted: 0, skipped: { 'still-used': 2 } })
    expect(rep.categories).toMatchObject({ deleted: 0, skipped: { 'still-used': 1 } })
    expect(rep.notes).toContain('audit-row-written')
    expect(await articleCount()).toBe(1)
    expect(await commentCount()).toBe(0)
    expect(files.every((p) => fs.existsSync(p))).toBe(true)
    expect(await count('audit-logs', { id: { in: m.audits } })).toBe(6) // kept
    const rows = (await f.payload.find({ collection: 'audit-logs', where: { action: { equals: 'import.rollback' } }, sort: '-createdAt', limit: 1, depth: 0, overrideAccess: true })).docs as unknown as Array<Record<string, any>>
    expect(rows[0].actorRole).toBe('import')
    expect(JSON.stringify(rows[0])).not.toMatch(/example\.test|story|Synthetic/)

    // --force removes the edited article; media and the category are freed with it.
    const forced = await rb('run', { apply: true, force: true, includePublished: true })
    expect(forced.articles).toMatchObject({ deleted: 1, alreadyGone: 1, failed: 0 })
    expect(forced.media).toMatchObject({ deleted: 2, failed: 0 })
    expect(forced.categories).toMatchObject({ deleted: 1 })
    expect(await articleCount()).toBe(0)
    expect((await mediaDocs()).length).toBe(0)
    expect(files.some((p) => fs.existsSync(p))).toBe(false)

    // A second rollback finds everything gone and changes nothing.
    const again = await rb('run', { apply: true, force: true, includePublished: true })
    expect(again.articles).toMatchObject({ deleted: 0, alreadyGone: 2, failed: 0 })
    expect([again.comments.alreadyGone, again.media.alreadyGone, again.categories.alreadyGone]).toEqual([3, 2, 1])
    expect([again.articles.deleted, again.comments.deleted, again.media.deleted, again.categories.deleted]).toEqual([0, 0, 0, 0])
  }, 180_000)
})
