import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runArchiveImport, type ArchiveImportOptions } from '../../src/import/archiveCandidates'
import { readManifest } from '../../src/import/manifest'
import { runRollback } from '../../src/import/rollback'
import { candidate, jsonl, sha } from '../fixtures/archive/candidates'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Archive-candidate importer against a real database, SYNTHETIC candidates only (old-site.test, invented titles).
 * Every title carries the run id so the slug (and the fixtures' cleanup) is unique to this file.
 */
const runId = newRunId()
let f: Fixtures
let dir: string
let out: string
let seq = 0
const category = `${runId}-archive`

const row = (over: Record<string, unknown> = {}) => {
  const n = ++seq
  return candidate(
    {
      title: `${runId} Recovered story ${n}`,
      originalUrl: `https://old-site.test/${runId}/story-${n}/`,
      rawSha256: sha(`${runId}-${n}`),
      ...over,
    },
    n,
  )
}
const write = (name: string, rows: unknown[]): string => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, jsonl(rows))
  return p
}
const run = (file: string, extra: Partial<ArchiveImportOptions> = {}) =>
  runArchiveImport(f.payload, { file, apply: true, manifestDir: out, category, now: Date.parse('2026-10-23T00:00:00Z'), ...extra })
const code = async (p: Promise<unknown>) => await p.then(() => null, (e: { code?: string }) => e.code ?? 'other')
const bySha = async (hash: string) =>
  (await f.payload.find({ collection: 'articles', where: { 'provenance.sourceSha256': { equals: hash } }, limit: 5, depth: 0, overrideAccess: true })).docs as unknown as Array<Record<string, any>>
const searchRows = async (ids: number[]): Promise<number> => {
  const db = (f.payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<{ rows: unknown[] }> } }).drizzle
  const res = await db.execute(sql`select 1 from "article_search" where "article_id" in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
  return res.rows.length
}
const countAll = async () => (await f.payload.count({ collection: 'articles', where: { 'provenance.importBatch': { exists: true } }, overrideAccess: true })).totalDocs

beforeAll(async () => {
  f = await setupFixtures(runId)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-archive-in-'))
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-archive-out-'))
})

afterAll(async () => {
  try {
    // Imported articles carry the run id in the slug unless renamed; remove the stragglers and the category.
    await f.payload.delete({ collection: 'articles', where: { 'provenance.sourceUrl': { like: `/${runId}/` } } as never, overrideAccess: true })
    await f.payload.delete({ collection: 'audit-logs', where: { summary: { like: 'Archive candidate imported' } } as never, overrideAccess: true })
  } catch {
    // best effort
  }
  await f?.cleanup()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(out, { recursive: true, force: true })
})

describe('dry run', () => {
  it('writes nothing to the database, no manifest, and reports what would be created', async () => {
    const r1 = row()
    const file = write('dry.jsonl', [r1, row({ bodyHtml: '<script>x</script>' }), 'not json'])
    const before = await countAll()
    const rep = await run(file, { apply: false })
    expect(rep.mode).toBe('dry-run')
    expect(rep.created).toBe(1)
    expect(rep.invalid).toEqual({ 'bodyHtml-script': 1, 'invalid-json': 1 })
    expect(rep.manifestFile).toBeNull()
    expect(rep.detailFile && fs.existsSync(rep.detailFile)).toBe(true)
    expect(await countAll()).toBe(before)
    expect(await bySha(r1.rawSha256 as string)).toHaveLength(0)
    // The category was not created either.
    expect((await f.payload.count({ collection: 'categories', where: { slug: { equals: category } }, overrideAccess: true })).totalDocs).toBe(0)
  })
})

describe('safety checks', () => {
  it('refuses a source file inside a repository, a missing manifest on apply, and bad labels', async () => {
    const file = write('safe.jsonl', [row()])
    expect(await code(run(path.join(process.cwd(), 'candidates.jsonl')))).toBe('ARCHIVE_FILE_INSIDE_REPO')
    expect(await code(run(file, { manifestDir: undefined }))).toBe('ARCHIVE_MANIFEST_REQUIRED')
    expect(await code(run(file, { manifestDir: process.cwd() }))).toBe('ARCHIVE_MANIFEST_INSIDE_REPO')
    expect(await code(run(file, { manifestDir: path.join(out, 'nope') }))).toBe('ARCHIVE_MANIFEST_DIR_MISSING')
    expect(await code(run(file, { batch: 'Bad Batch!' }))).toBe('ARCHIVE_BATCH_INVALID')
    expect(await code(run(path.join(dir, 'missing.jsonl')))).toBe('ARCHIVE_FILE_UNREADABLE')
  })
})

describe('apply: drafts only, never public, review gate, dedup, rollback', () => {
  let articleId: number
  let hash: string
  let manifestFile: string
  const r1 = row({ confidence: 'citation-only', byline: 'Desk Reporter', date: '2013-05-06' })
  const r2 = row({ confidence: 'missing' })
  const bad = [row({ confidence: 'verified-full' }), row({ originalUrl: 'ftp://old-site.test/x' }), row({ schema: 'archive-candidate/9' })]

  it('creates draft articles with provenance and a rollback manifest', async () => {
    hash = r1.rawSha256 as string
    const file = write('apply.jsonl', [r1, r2, ...bad])
    const rep = await run(file, { batch: `b-${runId}` })
    expect(rep.created).toBe(2)
    expect(rep.invalid).toEqual({ 'confidence-verified-full': 1, 'originalUrl-invalid': 1, 'schema-version': 1 })
    expect(rep.confidence).toEqual({ 'citation-only': 1, missing: 1 })
    expect(rep.categoryCreated).toBe(1)
    manifestFile = rep.manifestFile as string
    expect(fs.existsSync(manifestFile)).toBe(true)
    const m = readManifest(manifestFile)
    expect(m.complete).toBe(true)
    expect(m.articles.created).toHaveLength(2)
    expect(m.categories).toHaveLength(1)
    expect(m.audits).toHaveLength(2)

    const [doc] = await bySha(hash)
    articleId = doc.id
    expect(doc.status).toBe('draft')
    expect(doc.publishedAt ?? null).toBeNull()
    expect(doc.bylineName).toBe('Desk Reporter')
    expect(doc.provenance).toMatchObject({
      sourceUrl: r1.originalUrl,
      sourceHost: 'old-site.test',
      sourceSha256: hash,
      confidence: 'citation-only',
      importBatch: `b-${runId}`,
      reviewStatus: 'pending',
    })
    expect(new Date(doc.provenance.captureTimestamp).toISOString()).toBe('2020-01-15T10:20:30.000Z')
    expect(new Date(doc.provenance.originalDate).toISOString()).toBe('2013-05-06T00:00:00.000Z')
    expect(JSON.stringify(doc.content)).toContain('Synthetic paragraph one')
    // Drafts are never in the public search projection.
    const ids = [doc.id, (await bySha(r2.rawSha256 as string))[0].id]
    expect(await searchRows(ids)).toBe(0)
  })

  it('is never public: anonymous reads see nothing, staff see the provenance', async () => {
    const list = await api('GET', `/api/articles?where[provenance.importBatch][equals]=b-${runId}&limit=10`)
    // Filtering on a staff-only field is refused (400) or returns nothing: never a hit.
    expect([200, 400]).toContain(list.status)
    expect(list.json?.docs ?? []).toHaveLength(0)
    expect((await api('GET', `/api/articles/${articleId}`)).status).toBe(404)
    // Filtering by a provenance field must not reveal anything either.
    const probe = await api('GET', `/api/articles?where[provenance.sourceSha256][equals]=${hash}`)
    expect([200, 400]).toContain(probe.status)
    expect(probe.json?.docs ?? []).toHaveLength(0)

    const staff = await api('GET', `/api/articles/${articleId}?depth=0`, { token: f.tokens.eic })
    expect(staff.status).toBe(200)
    expect(staff.json.provenance.reviewStatus).toBe('pending')
  })

  it('has no provenance on a public projection of a published article', async () => {
    const pub = await f.seedArticle({
      status: 'published',
      publishedAt: new Date().toISOString(),
      provenance: { importBatch: `b-${runId}`, reviewStatus: 'reviewed', sourceUrl: 'https://old-site.test/secret-origin', sourceSha256: sha('pub'), confidence: 'partial' },
    })
    for (const url of [`/api/articles/${pub.id}`, `/api/articles?where[slug][equals]=${pub.slug}&depth=0`, `/api/articles?limit=100&depth=0`]) {
      const res = await api('GET', url)
      expect(res.status).toBe(200)
      expect(res.text, url).not.toContain('secret-origin')
      expect(res.text, url).not.toContain('importBatch')
      expect(res.text, url).not.toContain('reviewStatus')
      const docs = res.json.docs ?? [res.json]
      for (const d of docs) expect(d).not.toHaveProperty('provenance')
    }
    // Versions are staff-only; anonymous cannot read them.
    expect([401, 403]).toContain((await api('GET', `/api/articles/versions?where[parent][equals]=${pub.id}`)).status)
    // A staff read does carry it.
    expect((await api('GET', `/api/articles/${pub.id}?depth=0`, { token: f.tokens.eic })).json.provenance.importBatch).toBe(`b-${runId}`)
  })

  it('cannot be published or scheduled before review, by anyone', async () => {
    const attempts = [
      api('PATCH', `/api/articles/${articleId}`, { token: f.tokens.eic, body: { status: 'published' } }),
      api('PATCH', `/api/articles/${articleId}`, { token: f.tokens.admin, body: { status: 'scheduled', scheduledFor: new Date(Date.now() + 86_400_000).toISOString() } }),
    ]
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(409)
    }
    // Server-side callers are bound too: the importer context, the scheduler and the seed context.
    for (const context of [{ import: true }, { seed: true }, { systemTransition: true }]) {
      expect(await code(f.payload.update({ collection: 'articles', id: articleId, data: { status: 'published' } as never, overrideAccess: true, context }))).not.toBeNull()
    }
    const [doc] = await bySha(hash)
    expect(doc.status).toBe('draft')
    expect(doc.publishedAt ?? null).toBeNull()
    // A client cannot clear the batch or the source to get round the guard (server-owned fields are ignored on write).
    await api('PATCH', `/api/articles/${articleId}`, { token: f.tokens.eic, body: { provenance: { importBatch: null, sourceUrl: 'https://elsewhere.test/' } } })
    const after = (await bySha(hash))[0]
    expect(after.provenance.importBatch).toBe(`b-${runId}`)
    expect(after.provenance.sourceUrl).toBe(r1.originalUrl)
    expect((await api('PATCH', `/api/articles/${articleId}`, { token: f.tokens.eic, body: { status: 'published' } })).status).toBe(409)
  })

  it('can be published after an editor marks it reviewed, and an author-level reporter cannot flip the status', async () => {
    const denied = await api('PATCH', `/api/articles/${articleId}`, { token: f.tokens.reporter, body: { provenance: { reviewStatus: 'reviewed' } } })
    expect([401, 403, 404]).toContain(denied.status)
    expect((await bySha(hash))[0].provenance.reviewStatus).toBe('pending')

    const flip = await api('PATCH', `/api/articles/${articleId}`, { token: f.tokens.eic, body: { provenance: { reviewStatus: 'reviewed' } } })
    expect(flip.status).toBe(200)
    expect((await bySha(hash))[0].provenance.reviewStatus).toBe('reviewed')
    const pub = await api('PATCH', `/api/articles/${articleId}`, { token: f.tokens.eic, body: { status: 'published' } })
    expect(pub.status).toBe(200)
    const open = await api('GET', `/api/articles/${articleId}`)
    expect(open.status).toBe(200)
    expect(open.json).not.toHaveProperty('provenance')
    // Only once reviewed and published does the article enter the search projection.
    expect(await searchRows([articleId])).toBe(1)
  })

  it('is idempotent: a second run over the same file creates nothing', async () => {
    const before = await countAll()
    const rep = await run(write('apply.jsonl', [r1, r2]), { batch: `b-${runId}-again` })
    expect(rep.created).toBe(0)
    expect(rep.alreadyPresent).toEqual({ 'present-source-url': 2 })
    expect(await countAll()).toBe(before)
    // Same page under another spelling of the address, or with the same raw hash, is also recognised.
    const variant = await run(write('variant.jsonl', [row({ originalUrl: (r1.originalUrl as string).replace('https://', 'http://www.').replace(/\/$/, ''), host: 'www.old-site.test' })]), { apply: false })
    expect(variant.alreadyPresent).toEqual({ 'present-source-url': 1 })
    const sameHash = await run(write('hash.jsonl', [row({ rawSha256: hash })]), { apply: false })
    expect(sameHash.alreadyPresent).toEqual({ 'present-source-hash': 1 })
  })

  it('skips duplicates inside the file, and articles already present by slug and title', async () => {
    const a = row()
    const dupUrl = { ...a, rawSha256: sha('other-1'), title: `${runId} Another title` }
    const dupSha = row({ rawSha256: a.rawSha256 })
    const existing = await f.seedArticle({ title: `${runId} Present on the site`, slug: `${runId}-present-on-the-site` })
    const sameTitle = row({ title: existing.slug.replace(/-/g, ' ') })
    const rep = await run(write('dups.jsonl', [a, dupUrl, dupSha, sameTitle]), { apply: false })
    expect(rep.duplicateInFile).toEqual({ 'source-url': 1, 'source-hash': 1 })
    expect(rep.alreadyPresent).toEqual({ 'present-slug-title': 1 })
    expect(rep.created).toBe(1)
  })

  it('renames the slug when another article owns it, and when it is a reserved route name', async () => {
    const owner = await f.seedArticle({ title: `${runId} Owned slug`, slug: `${runId}-owned-slug` })
    const clash = row({ title: owner.slug.replace(/-/g, ' ') + ' ' }) // same words, so the title matches: present
    expect((await run(write('clash0.jsonl', [clash]), { apply: false })).alreadyPresent).toEqual({ 'present-slug-title': 1 })
    const other = await f.seedArticle({ title: `${runId} zebra crossing`, slug: `${runId}-zebra-crossing` })
    // Non-ASCII letters drop out of the slug, so the slug matches while the title differs.
    const clash2 = row({ title: `${runId} zebra crossing 日本` })
    const rep = await run(write('clash.jsonl', [clash2, row({ title: 'Admin' })]), { batch: `b-${runId}-slug` })
    expect(other.slug).toBe(`${runId}-zebra-crossing`)
    expect(rep.created).toBe(2)
    expect(rep.slugRenamed).toBe(1 + 1)
    expect(rep.slugRenamedReserved).toBe(1)
    const made = (
      await f.payload.find({ collection: 'articles', where: { 'provenance.importBatch': { equals: `b-${runId}-slug` } }, depth: 0, overrideAccess: true })
    ).docs.map((d) => (d as { slug: string }).slug)
    expect(made.sort()).toEqual(['admin-archive', `${runId}-zebra-crossing-archive`].sort())
    await runRollback(f.payload, { manifestPath: rep.manifestFile as string, apply: true, minIncompleteAgeMs: 0 })
  })

  it('rolls back through import:rollback, keeping what an editor changed', async () => {
    const mine = row()
    const edited = row()
    const rep = await run(write('rb.jsonl', [mine, edited]), { batch: `b-${runId}-rb` })
    expect(rep.created).toBe(2)
    const [editedDoc] = await bySha(edited.rawSha256 as string)
    await new Promise((r) => setTimeout(r, 1300))
    await f.payload.update({ collection: 'articles', id: editedDoc.id, data: { excerpt: 'Edited by staff.' } as never, overrideAccess: true, context: { import: true } })

    const dry = await runRollback(f.payload, { manifestPath: rep.manifestFile as string, minIncompleteAgeMs: 0 })
    expect(dry.mode).toBe('dry-run')
    expect(dry.articles.wouldDelete).toBe(1)
    expect(await bySha(mine.rawSha256 as string)).toHaveLength(1)

    const done = await runRollback(f.payload, { manifestPath: rep.manifestFile as string, apply: true, minIncompleteAgeMs: 0 })
    expect(done.articles.deleted).toBe(1)
    expect(done.articles.skipped).toEqual({ 'edited-since-import': 1 })
    expect(await bySha(mine.rawSha256 as string)).toHaveLength(0)
    expect(await bySha(edited.rawSha256 as string)).toHaveLength(1)
    // Nothing left to undo on a second rollback of the first article.
    const again = await runRollback(f.payload, { manifestPath: rep.manifestFile as string, apply: true, minIncompleteAgeMs: 0 })
    expect(again.articles.deleted).toBe(0)
    // The original run's first batch is left alone: its manifest was never rolled back here.
    expect(await countAll()).toBeGreaterThan(0)
  })

  it('writes no row text into the private detail file', async () => {
    const rep = await run(write('detail.jsonl', [row({ title: `${runId} Secret headline text` })]), { apply: false })
    const detail = fs.readFileSync(rep.detailFile as string, 'utf8')
    expect(detail).not.toContain('Secret headline')
    expect(JSON.parse(detail.trim().split('\n')[0])).toMatchObject({ row: 1, outcome: 'would-create' })
  })
})
