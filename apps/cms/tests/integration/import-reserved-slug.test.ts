import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runRollback } from '../../src/import/rollback'
import { formatImportReport } from '../../src/import/qa'
import { runImport } from '../../src/import/run'
import { wxr } from '../fixtures/wxr/generate'
import { newRunId, setupFixtures, type Fixtures } from './helpers'

/** Under /{slug}/ (owner decision D1) a WordPress slug equal to a real route is never used by the importer. */
const runId = newRunId()
const base = 7_000_000 + (parseInt(runId.slice(1, 5), 16) % 60_000) * 10
const ids = { reserved: base + 1, fine: base + 2 }
let f: Fixtures
let dir: string
let manifestFile: string
let exportFile: string
const savedTemplate = process.env.PUBLIC_ARTICLE_PATH_TEMPLATE

beforeAll(async () => {
  delete process.env.PUBLIC_ARTICLE_PATH_TEMPLATE // default /{slug}/
  f = await setupFixtures(runId)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-reserved-int-'))
  manifestFile = path.join(dir, 'manifest.jsonl')
  exportFile = path.join(dir, 'export.xml')
  fs.writeFileSync(
    exportFile,
    wxr([
      { id: ids.reserved, slug: 'wp-json', categories: [{ nicename: `${runId}-news`, name: `${runId} news` }] },
      { id: ids.fine, slug: `${runId}-fine`, categories: [{ nicename: `${runId}-news`, name: `${runId} news` }] },
    ]),
  )
})

afterAll(async () => {
  await runRollback(f.payload, { manifestPath: manifestFile, minIncompleteAgeMs: 0, apply: true }).catch(() => undefined)
  if (savedTemplate === undefined) delete process.env.PUBLIC_ARTICLE_PATH_TEMPLATE
  else process.env.PUBLIC_ARTICLE_PATH_TEMPLATE = savedTemplate
  await f?.cleanup()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe('importer and reserved root slugs', () => {
  it('gives a post whose slug is a reserved route the id-suffixed slug, and reports it', async () => {
    const rep = await runImport(f.payload, {
      file: exportFile,
      manifestPath: manifestFile,
      dryRun: false,
      fallbackCategory: { slug: `${runId}-cat-fallback`, title: 'Fallback' },
    })
    expect(rep.articles.created).toBe(2)
    expect(rep.articles.slugRenamedReserved).toBe(1)
    expect(formatImportReport(rep)).toContain('reserved route name')
    const docs = (await f.payload.find({ collection: 'articles', where: { legacyId: { in: Object.values(ids) } }, limit: 5, depth: 0, overrideAccess: true })).docs as unknown as Array<Record<string, any>>
    expect(docs.find((d) => d.legacyId === ids.reserved)!.slug).toBe(`wp-json-${ids.reserved}`)
    expect(docs.find((d) => d.legacyId === ids.fine)!.slug).toBe(`${runId}-fine`)
  })
})
