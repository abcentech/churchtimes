import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openManifest, readManifest } from '../../src/import/manifest'
import { formatRollbackReport, runRollback, type RollbackOptions } from '../../src/import/rollback'
import { runImport } from '../../src/import/run'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'
import { newRunId, setupFixtures, type Fixtures } from './helpers'

/** The rollback tool against a real database, with a SYNTHETIC export (invented names, generated PNGs). */
const runId = newRunId()
const base = 8_000_000 + (parseInt(runId.slice(1, 5), 16) % 60_000) * 10
const ids = { a: base + 1, b: base + 2, att: base + 5 }
let f: Fixtures
let dir: string
let exportFile: string
let uploads: string
let importCategory = 0

const manifest = (n: string) => path.join(dir, `manifest-${n}.jsonl`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rb = (n: string, extra: Partial<RollbackOptions> = {}) => runRollback(f.payload, { manifestPath: manifest(n), ...extra })
const code = async (p: Promise<unknown>) => (await p.then(() => null, (e: { code?: string }) => e.code ?? 'other'))

const count = async (collection: string, where: Record<string, unknown>) =>
  (await f.payload.count({ collection: collection as never, where: where as never, overrideAccess: true })).totalDocs
const articleCount = () => count('articles', { legacyId: { in: [ids.a, ids.b] } })
const commentCount = () => count('legacy-comments', { legacyId: { in: [base + 101, base + 102, base + 103] } })
const mediaDocs = async () =>
  (await f.payload.find({ collection: 'media', where: { legacyPath: { like: '2098/' } }, limit: 10, depth: 0, overrideAccess: true })).docs as unknown as Array<Record<string, any>>

beforeAll(async () => {
  f = await setupFixtures(runId)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-rollback-int-'))
  uploads = path.join(dir, 'uploads')
  fs.mkdirSync(path.join(uploads, '2098', '01'), { recursive: true })
  const png = (g: number) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g, b: 80 } } }).png().toBuffer()
  fs.writeFileSync(path.join(uploads, '2098', '01', 'a.png'), await png(90))
  fs.writeFileSync(path.join(uploads, '2098', '01', 'b.png'), await png(140))
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
  const rep = await runImport(f.payload, { file: exportFile, uploadsRoot: uploads, manifestPath: manifest('run'), dryRun: false })
  expect(rep.articles.created).toBe(2)
})

afterAll(async () => {
  await f?.cleanup()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe('import rollback', () => {
  it('refuses a missing, foreign or incomplete manifest', async () => {
    expect(await code(rb('nope'))).toBe('ROLLBACK_MANIFEST_UNREADABLE')
    fs.writeFileSync(manifest('junk'), 'not a manifest\n{"type":"id"}\n')
    expect(await code(rb('junk'))).toBe('ROLLBACK_MANIFEST_INVALID')
    // A killed run: everything but the `end` line.
    const lines = fs.readFileSync(manifest('run'), 'utf8').trim().split('\n')
    expect(JSON.parse(lines[lines.length - 1]).type).toBe('end')
    fs.writeFileSync(manifest('killed'), lines.slice(0, -1).join('\n') + '\n{"type":"id","collection":"articles","act')
    expect(await code(rb('killed', { apply: true }))).toBe('ROLLBACK_MANIFEST_INCOMPLETE')
    expect(await articleCount()).toBe(2)
    const m = readManifest(manifest('killed'))
    expect(m.complete).toBe(false)
    const allowed = await rb('killed', { allowIncomplete: true })
    expect(allowed.mode).toBe('dry-run')
    expect(allowed.manifest.complete).toBe(false)
    expect(allowed.notes).toContain('incomplete-manifest-allowed')
    expect(allowed.articles.wouldDelete).toBe(2)
  })

  it('a dry run lists what would go and changes nothing', async () => {
    const rep = await rb('run')
    const text = formatRollbackReport(rep)
    expect(rep.mode).toBe('dry-run')
    expect(rep.articles).toMatchObject({ listed: 2, wouldDelete: 2, deleted: 0 })
    expect(rep.comments).toMatchObject({ listed: 3, wouldDelete: 3, deleted: 0 })
    expect(rep.media).toMatchObject({ listed: 2, wouldDelete: 2 })
    expect(rep.categories).toMatchObject({ listed: 1, wouldDelete: 1 })
    expect(rep.auditRowsKept).toBe(6)
    expect(await articleCount()).toBe(2)
    expect(await commentCount()).toBe(3)
    expect((await mediaDocs()).length).toBe(2)
    expect(text).not.toMatch(/@|example\.test|story|Synthetic|\.png/)
  })

  it('leaves articles that a run only updated, and never deletes a row the loader did not make', async () => {
    // (An update run is simulated by a manifest that lists the articles as updated: a real one would itself count as an edit.)
    const live = (await f.payload.find({ collection: 'articles', where: { legacyId: { in: [ids.a, ids.b] } }, depth: 0, overrideAccess: true })).docs as unknown as Array<{ id: number }>
    const up = openManifest(manifest('update'))
    for (const d of live) up.id('articles', 'updated', d.id)
    up.append({ type: 'end', at: new Date().toISOString(), status: 'complete' })
    up.close()
    const r = await rb('update', { apply: true })
    expect(r.articles).toMatchObject({ listed: 0, deleted: 0 })
    expect(r.articlesUpdatedNotReverted).toBe(2)
    expect(await articleCount()).toBe(2)

    // A hand-written manifest naming a staff article (no legacy id) and a media id the run never made.
    const staff = await f.seedArticle()
    const sink = openManifest(manifest('foreign'))
    sink.id('articles', 'created', staff.id)
    sink.id('articles', 'created', 2_000_000_000)
    sink.append({ type: 'end', at: new Date().toISOString(), status: 'complete' })
    sink.close()
    const fr = await rb('foreign', { apply: true, force: true })
    expect(fr.articles).toMatchObject({ listed: 2, deleted: 0, alreadyGone: 1, skipped: { 'not-an-imported-article': 1 } })
    expect(await count('articles', { id: { equals: staff.id } })).toBe(1)
  })

  it('apply deletes what the run created, skips an edited article and what it still needs, keeps audit rows', async () => {
    const m = readManifest(manifest('run'))
    const auditsBefore = await count('audit-logs', { id: { in: m.audits } })
    expect(auditsBefore).toBe(6)
    const uploadsDir = path.resolve((f.payload.collections as any).media.config.upload.staticDir as string)
    const files = (await mediaDocs()).map((d) => path.join(uploadsDir, d.filename as string))
    expect(files.every((p) => fs.existsSync(p))).toBe(true)

    // Staff edit article A after the run.
    await sleep(25)
    const articleA = (await f.payload.find({ collection: 'articles', where: { legacyId: { equals: ids.a } }, depth: 0, overrideAccess: true })).docs[0] as unknown as { id: number }
    await f.payload.update({ collection: 'articles', id: articleA.id, data: { excerpt: 'Edited by staff.' } as never, overrideAccess: true, context: { import: true } })

    const rep = await rb('run', { apply: true })
    expect(rep.mode).toBe('apply')
    expect(rep.comments).toMatchObject({ listed: 3, deleted: 3, failed: 0 })
    expect(rep.articles).toMatchObject({ listed: 2, deleted: 1, failed: 0, skipped: { 'edited-since-import': 1 } })
    expect(rep.media).toMatchObject({ deleted: 0, skipped: { 'still-used': 2 } })
    expect(rep.categories).toMatchObject({ deleted: 0, skipped: { 'still-used': 1 } })
    expect(rep.notes).toContain('audit-row-written')
    expect(await articleCount()).toBe(1)
    expect(await commentCount()).toBe(0)
    expect(files.every((p) => fs.existsSync(p))).toBe(true)

    // Audit rows are kept and one rollback row was added (no personal data in it).
    expect(await count('audit-logs', { id: { in: m.audits } })).toBe(6)
    const rows = (await f.payload.find({ collection: 'audit-logs', where: { action: { equals: 'import.rollback' } }, sort: '-createdAt', limit: 1, depth: 0, overrideAccess: true })).docs as unknown as Array<Record<string, any>>
    expect(rows[0].actorRole).toBe('import')
    expect(JSON.stringify(rows[0])).not.toMatch(/example\.test|story|Synthetic/)
    expect(formatRollbackReport(rep)).not.toMatch(/@|example\.test|story|Synthetic|\.png/)
  })

  it('--force removes the edited article; a category and media still in use by staff are kept', async () => {
    importCategory = ((await f.payload.find({ collection: 'categories', where: { slug: { equals: `${runId}-news` } }, depth: 0, overrideAccess: true })).docs[0] as unknown as { id: number }).id
    const staffInCategory = await f.seedArticle({ category: importCategory })
    const uploadsDir = path.resolve((f.payload.collections as any).media.config.upload.staticDir as string)
    const files = (await mediaDocs()).map((d) => path.join(uploadsDir, d.filename as string))

    const rep = await rb('run', { apply: true, force: true })
    expect(rep.articles).toMatchObject({ deleted: 1, alreadyGone: 1, failed: 0 })
    expect(rep.comments).toMatchObject({ deleted: 0, alreadyGone: 3 })
    expect(rep.media).toMatchObject({ deleted: 2, failed: 0 })
    expect(rep.categories).toMatchObject({ deleted: 0, skipped: { 'still-used': 1 } })
    expect(await articleCount()).toBe(0)
    expect((await mediaDocs()).length).toBe(0)
    expect(files.some((p) => fs.existsSync(p))).toBe(false)
    expect(await count('articles', { id: { equals: (staffInCategory as any).id } })).toBe(1)
  })

  it('a second rollback is a no-op (everything already gone) and, once the staff article is gone, the category goes', async () => {
    const again = await rb('run', { apply: true })
    expect(again.articles).toMatchObject({ deleted: 0, alreadyGone: 2, failed: 0 })
    expect(again.comments).toMatchObject({ deleted: 0, alreadyGone: 3 })
    expect(again.media).toMatchObject({ deleted: 0, alreadyGone: 2 })
    expect(again.categories).toMatchObject({ deleted: 0, skipped: { 'still-used': 1 } })
    expect(importCategory).toBeGreaterThan(0)

    await f.payload.delete({ collection: 'articles', where: { slug: { like: `${runId}-seed` } }, overrideAccess: true, context: { seed: true } })
    const last = await rb('run', { apply: true })
    expect(last.categories).toMatchObject({ deleted: 1 })
    const noop = await rb('run', { apply: true })
    expect(noop.categories).toMatchObject({ deleted: 0, alreadyGone: 1 })
    expect([noop.articles.deleted, noop.comments.deleted, noop.media.deleted]).toEqual([0, 0, 0])
  })
})
