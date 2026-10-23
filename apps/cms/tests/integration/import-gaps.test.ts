import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readManifest } from '../../src/import/manifest'
import { formatImportReport } from '../../src/import/qa'
import { runRollback } from '../../src/import/rollback'
import { runImport } from '../../src/import/run'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'
import { newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Importer gaps against a real database, SYNTHETIC export: several categories per post, bylines without accounts,
 * the old permalink in legacyUrl. Records carry the run id so the shared cleanup removes them.
 */
const runId = newRunId()
const base = 6_000_000 + (parseInt(runId.slice(1, 5), 16) % 60_000) * 10
const ids = { multi: base + 1, mail: base + 2, plain: base + 3, query: base + 4 }
let f: Fixtures
let dir: string
let exportFile: string
let manifestFile: string

const cat = (k: string) => ({ nicename: `${runId}-${k}`, name: `${runId} ${k}` })
const users = async () => (await f.payload.count({ collection: 'users', overrideAccess: true })).totalDocs
const articles = async () =>
  (await f.payload.find({ collection: 'articles', where: { legacyId: { in: Object.values(ids) } }, limit: 10, depth: 0, overrideAccess: true })).docs as unknown as Array<Record<string, any>>
const byLegacy = (docs: Array<Record<string, any>>, id: number) => docs.find((d) => d.legacyId === id)!

beforeAll(async () => {
  f = await setupFixtures(runId)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-gaps-int-'))
  manifestFile = path.join(dir, 'manifest.jsonl')
  const items: FixtureItem[] = [
    {
      id: ids.multi,
      slug: `${runId}-multi`,
      categories: [{ nicename: 'uncategorised', name: 'Uncategorised' }, cat('news'), cat('sport'), cat('faith')],
      creator: 'known_writer',
      link: `https://old.example.test/2023/05/${runId}-multi/?utm_source=x#comments`,
    },
    { id: ids.mail, slug: `${runId}-mail`, categories: [cat('news')], creator: 'pat@mail.example.test', link: `/2023/05/${runId}-mail/` },
    { id: ids.plain, slug: `${runId}-plain`, categories: [], creator: 'login_without_profile', link: 'javascript:alert(1)' },
    { id: ids.query, slug: `${runId}-query`, categories: [cat('news')], creator: 'known_writer', link: 'https://old.example.test/?p=99' },
  ]
  exportFile = path.join(dir, 'export.xml')
  fs.writeFileSync(exportFile, wxr(items, { authors: [{ id: 2, login: 'known_writer', display: 'Known Writer' }] }))
})

afterAll(async () => {
  await f?.cleanup()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe('importer gaps', () => {
  it('keeps one category per post and reports what the schema cannot hold', async () => {
    const before = await users()
    const rep = await runImport(f.payload, { file: exportFile, manifestPath: manifestFile, dryRun: false, fallbackCategory: { slug: `${runId}-cat-fallback`, title: 'Gap fallback' } })
    expect(rep.articles.created).toBe(4)

    const docs = await articles()
    const catOf = async (legacyId: number) =>
      ((await f.payload.findByID({ collection: 'categories', id: byLegacy(docs, legacyId).category, depth: 0, overrideAccess: true })) as unknown as { slug: string }).slug
    expect(await catOf(ids.multi)).toBe(`${runId}-news`) // a real category beats Uncategorised
    expect(await catOf(ids.plain)).toBe(`${runId}-cat-fallback`) // none given: the configured fallback

    // News is created once and shared; sport and faith (not kept) are never created; uncategorised is not created for the multi post
    const made = await f.payload.find({ collection: 'categories', where: { slug: { like: runId } }, limit: 20, depth: 0, overrideAccess: true })
    expect((made.docs as unknown as Array<{ slug: string }>).map((c) => c.slug).filter((s) => !s.includes('-cat-')).sort()).toEqual([`${runId}-news`])
    expect(rep.categories).toMatchObject({ postsWithExtraCategories: 1, extraCategoriesDropped: 3, fallbackUsed: 1 })
    expect(rep.categories.bySource).toEqual({ wordpress: 3, yoastPrimary: 0, tagMap: 0, rules: 0, generic: 0, fallback: 1 })
    expect(rep.seo.titleFrom.none).toBe(4)

    // the manifest records the created category ids exactly
    const m = readManifest(manifestFile)
    const newsId = byLegacy(docs, ids.multi).category as number
    expect(m.categories).toContain(newsId)

    // no account was created
    expect(await users()).toBe(before)
    expect(byLegacy(docs, ids.multi).author ?? null).toBeNull()
  })

  it('maps wp:creator to the byline text only, and counts authors without a usable name', async () => {
    const docs = await articles()
    expect(byLegacy(docs, ids.multi).bylineName).toBe('Known Writer')
    expect(byLegacy(docs, ids.mail).bylineName ?? '').toBe('') // email-like: empty
    expect(byLegacy(docs, ids.plain).bylineName).toBe('login_without_profile') // login is the fallback text
    const rep = await runImport(f.payload, { file: exportFile, dryRun: true })
    expect(rep.authors).toEqual({ distinct: 0, withByline: 0, unmapped: 0, postsWithoutByline: 0 }) // dry run: all unchanged, none written
  })

  it('counts distinct authors on a fresh dry run (before any article exists for them)', async () => {
    const other = path.join(dir, 'fresh.xml')
    const fresh = base + 50
    fs.writeFileSync(
      other,
      wxr(
        [
          { id: fresh, slug: `${runId}-f1`, categories: [cat('news')], creator: 'known_writer' },
          { id: fresh + 1, slug: `${runId}-f2`, categories: [cat('news')], creator: 'known_writer' },
          { id: fresh + 2, slug: `${runId}-f3`, categories: [cat('news')], creator: 'a@b.example.test' },
          { id: fresh + 3, slug: `${runId}-f4`, categories: [cat('news')], creator: 'Someone Named' },
        ],
        { authors: [{ id: 2, login: 'known_writer', display: 'Known Writer' }] },
      ),
    )
    const rep = await runImport(f.payload, { file: other, dryRun: true })
    expect(rep.authors).toEqual({ distinct: 3, withByline: 2, unmapped: 1, postsWithoutByline: 1 })
    expect(formatImportReport(rep)).toContain('distinct authors: 3')
    expect(formatImportReport(rep)).not.toMatch(/known_writer|Known Writer|example\.test/)
  })

  it('stores the old permalink in legacyUrl: query and fragment stripped, invalid values dropped', async () => {
    const docs = await articles()
    expect(byLegacy(docs, ids.multi).legacyUrl).toBe(`https://old.example.test/2023/05/${runId}-multi/`)
    expect(byLegacy(docs, ids.mail).legacyUrl).toBe(`/2023/05/${runId}-mail/`)
    expect(byLegacy(docs, ids.plain).legacyUrl ?? null).toBeNull()
    expect(byLegacy(docs, ids.query).legacyUrl ?? null).toBeNull()
  })

  it('rollback still removes the created category and articles, and creates no users', async () => {
    const before = await users()
    const rep = await runRollback(f.payload, { manifestPath: manifestFile, minIncompleteAgeMs: 0, apply: true })
    expect(rep.articles.deleted).toBe(4)
    expect(rep.categories.deleted).toBeGreaterThanOrEqual(1)
    expect(await articles()).toHaveLength(0)
    const left = await f.payload.count({ collection: 'categories', where: { slug: { equals: `${runId}-news` } }, overrideAccess: true })
    expect(left.totalDocs).toBe(0)
    expect(await users()).toBe(before)
  })
})
