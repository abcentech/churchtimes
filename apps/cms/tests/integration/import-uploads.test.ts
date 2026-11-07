import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readManifest } from '../../src/import/manifest'
import { formatImportReport } from '../../src/import/qa'
import { runRollback } from '../../src/import/rollback'
import { runImport, type ImportOptions } from '../../src/import/run'
import { checkUploads } from '../../src/import/uploadsCheck'
import { buildSyntheticUploads } from '../fixtures/uploads/tree'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'
import { newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * End to end with a SYNTHETIC export and a SYNTHETIC uploads tree that contains dangerous files (a script hidden in an
 * image, a PHP file, ...): the checker finds them, the loader refuses them even without the checker, and the
 * reports hold counts only. Then the import is rolled back.
 */
const runId = newRunId()
const base = 6_000_000 + (parseInt(runId.slice(1, 5), 16) % 60_000) * 10
const DIR = '2096/02'
const host = 'https://old.example.test/wp-content/uploads/'
let f: Fixtures
let dir: string
let uploads: string
let exportFile: string

const mediaDocs = async () =>
  (await f.payload.find({ collection: 'media', where: { legacyPath: { like: `${DIR}/` } }, limit: 20, depth: 0, overrideAccess: true })).docs as unknown as Array<Record<string, any>>
const options = (name: string, extra: Partial<ImportOptions> = {}): ImportOptions => ({ file: exportFile, uploadsRoot: uploads, manifestPath: path.join(dir, `manifest-${name}.jsonl`), dryRun: false, ...extra })

beforeAll(async () => {
  f = await setupFixtures(runId)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-uploads-int-'))
  uploads = path.join(dir, 'uploads')
  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 90, b: 80 } } }).png().toBuffer()
  buildSyntheticUploads(uploads, png, DIR)
  // b.png must be a different picture from a.png (the Media collection may de-duplicate by content)
  fs.writeFileSync(path.join(uploads, ...DIR.split('/'), 'b.png'), await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 150, b: 80 } } }).png().toBuffer())

  const cat = { nicename: `${runId}-news`, name: `${runId} News` }
  const att = (id: number, rel: string): FixtureItem => ({ id, postType: 'attachment', status: 'inherit', slug: `${runId}-att-${id}`, attachmentUrl: `${host}${rel}`, meta: { _wp_attached_file: rel, _wp_attachment_image_alt: `${runId} alt` } })
  const items: FixtureItem[] = [
    att(base + 11, `${DIR}/a.png`),
    att(base + 12, `${DIR}/b.png`),
    att(base + 13, `${DIR}/shell.jpg`),
    att(base + 14, `${DIR}/c.png`),
    {
      id: base + 1,
      slug: `${runId}-one`,
      categories: [cat],
      meta: { _thumbnail_id: String(base + 12) },
      content:
        `<p>Text.</p><p><img src="${host}${DIR}/a.png" alt="ok"></p>` +
        `<p><img src="${host}${DIR}/poly2.png" alt="polyglot"></p>` +
        `<p><img src="${host}${DIR}/shell.jpg" alt="php as jpg"></p>` +
        `<p><img src="${host}${DIR}/missing.png" alt="gone"></p>`,
    },
    { id: base + 2, slug: `${runId}-two`, categories: [cat], meta: { _thumbnail_id: String(base + 13) }, content: '<p>Featured image is unsafe.</p>' },
    { id: base + 3, slug: `${runId}-three`, categories: [cat], meta: { _thumbnail_id: String(base + 14) }, content: '<p>Featured image is missing.</p>' },
  ]
  exportFile = path.join(dir, 'export.xml')
  fs.writeFileSync(exportFile, wxr(items))
})

afterAll(async () => {
  await f?.cleanup()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe('import with an untrusted uploads folder', () => {
  it('the checker finds the unsafe files and reconciles with the export', async () => {
    const r = await checkUploads(uploads, exportFile)
    expect(r.files.rejected['polyglot']).toBeUndefined() // a script marker after valid image data is only a warning
    expect(r.files.warnings).toBe(2)
    expect(r.files.rejected['magic-mismatch']).toBeGreaterThanOrEqual(3)
    expect(r.attachments).toMatchObject({ inExport: 4, present: 2, rejectedUnsafe: 1, sizeVariantOnly: 1 })
    expect(r.bodyImages).toMatchObject({ distinctReferenced: 4, present: 2, rejectedUnsafe: 1, missing: 1 })
    expect(r.featured).toEqual({ posts: 3, present: 1, missing: 1, rejectedUnsafe: 1, notImportable: 0, noAttachment: 0 })
  })

  it('a dry run counts resolved, rejected and missing images and featured images', async () => {
    const rep = await runImport(f.payload, options('dry', { dryRun: true, manifestPath: undefined }))
    expect(rep.media.created).toBe(3)
    expect(rep.media.unresolved).toEqual({ 'rejected-unsafe': 1, 'missing-file': 2 })
    expect(rep.content).toMatchObject({ imagesResolved: 2, imagesUnresolved: 2, featuredImageResolved: 1, featuredImageRejected: 1, featuredImageMissing: 2 })
    expect(await mediaDocs()).toHaveLength(0)
  })

  it('apply imports only the safe images; the loader refuses the rest by itself', async () => {
    const rep = await runImport(f.payload, options('apply'))
    expect(rep.articles.created).toBe(3)
    expect(rep.media.created).toBe(3)
    expect(rep.media.unresolved).toEqual({ 'rejected-unsafe': 1, 'missing-file': 2 })
    expect(rep.content).toMatchObject({ imagesResolved: 2, imagesUnresolved: 2, featuredImageResolved: 1, featuredImageRejected: 1, featuredImageMissing: 2 })
    expect((await mediaDocs()).map((m) => m.legacyPath).sort()).toEqual([`${DIR}/a.png`, `${DIR}/b.png`, `${DIR}/poly2.png`])
    // The real protection: the picture that carried a script marker was decoded and re-saved, so nothing of it is stored.
    const poly = (await mediaDocs()).find((m) => m.legacyPath === `${DIR}/poly2.png`)
    const stored = path.resolve('media', String(poly?.filename))
    if (poly?.filename && fs.existsSync(stored)) expect(fs.readFileSync(stored).toString('latin1').toLowerCase()).not.toContain('<script')
    const text = formatImportReport(rep)
    expect(text).toContain('rejected-unsafe')
    expect(text).toContain('featured images resolved: 1')
    expect(text).not.toMatch(/poly|shell|example\.test|2096/)
  })

  it('rolls back: the created articles and media are gone', async () => {
    const m = readManifest(path.join(dir, 'manifest-apply.jsonl'))
    expect(m.media).toHaveLength(3)
    const rb = await runRollback(f.payload, { manifestPath: path.join(dir, 'manifest-apply.jsonl'), apply: true, minIncompleteAgeMs: 0 })
    expect(rb.articles.deleted).toBe(3)
    expect(rb.media.deleted).toBe(3)
    expect(await mediaDocs()).toHaveLength(0)
  })
})
