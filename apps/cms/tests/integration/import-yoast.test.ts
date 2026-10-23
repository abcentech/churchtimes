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
 * Yoast SEO import and the uncategorised fallback chain against a real database, SYNTHETIC export only.
 * Records carry the run id so the shared cleanup removes them.
 */
const runId = newRunId()
const base = 7_000_000 + (parseInt(runId.slice(1, 5), 16) % 60_000) * 10


const yIds = { primary: base + 1, tagged: base + 2, plain: base + 3, ghostTag: base + 4, badPrimary: base + 5, both: base + 6 }
const faith = `${runId}-cat-faith`
const fallback = `${runId}-cat-fallback`
let f: Fixtures
let dir: string
let yFile: string
let mapFile: string
const man = (n: number) => path.join(dir, `y-manifest-${n}.jsonl`)
const opts = (n: number, extra: Record<string, unknown> = {}) => ({
  file: yFile,
  manifestPath: man(n),
  dryRun: false,
  categoryMapFile: mapFile,
  fallbackCategory: { slug: fallback, title: 'Yoast fallback' },
  ...extra,
})
const yDocs = async () =>
  (await f.payload.find({ collection: 'articles', where: { legacyId: { in: Object.values(yIds) } }, limit: 10, depth: 0, overrideAccess: true })).docs as unknown as Array<Record<string, any>>
const slugOf = async (doc: Record<string, any>) =>
  ((await f.payload.findByID({ collection: 'categories', id: doc.category, depth: 0, overrideAccess: true })) as unknown as { slug: string }).slug

beforeAll(async () => {
  f = await setupFixtures(runId)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-yoast-int-'))
  mapFile = path.join(dir, 'tag-map.json')
  fs.writeFileSync(mapFile, JSON.stringify({ 'church-life': faith, 'ghost-tag': `${runId}-cat-does-not-exist` }))
  yFile = path.join(dir, 'export.xml')
  const long = 'word '.repeat(60).trim()
  const items: FixtureItem[] = [
    {
      id: yIds.primary,
      slug: `${runId}-primary`,
      title: 'Primary Story',
      categories: [],
      meta: {
        _yoast_wpseo_primary_category: '7',
        _yoast_wpseo_title: '%%title%% %%page%% %%sep%% %%sitename%%',
        _yoast_wpseo_metadesc: `<b>Plain</b> &amp; ${long} %%sitename%%`,
        _yoast_wpseo_canonical: 'https://old.example.test/a/',
        '_yoast_wpseo_meta-robots-noindex': '1',
        '_yoast_wpseo_opengraph-title': 'Social title',
      },
    },
    { id: yIds.tagged, slug: `${runId}-tagged`, categories: [], tags: [{ nicename: 'church-life', name: 'Church life' }], meta: { _yoast_wpseo_title: 'Yoast only title', _yoast_wpseo_metadesc: '%%cf_unknown%% only text' } },
    { id: yIds.plain, slug: `${runId}-plain`, categories: [], tags: [{ nicename: 'free-text-tag', name: 'Free Text Tag' }], meta: { _yoast_wpseo_title: 'Broken %%title' } },
    { id: yIds.ghostTag, slug: `${runId}-ghost`, categories: [], tags: [{ nicename: 'ghost-tag', name: 'Ghost' }] },
    { id: yIds.badPrimary, slug: `${runId}-badprimary`, categories: [], meta: { _yoast_wpseo_primary_category: '999' } },
    {
      id: yIds.both,
      slug: `${runId}-both`,
      title: 'Both Story',
      categories: [{ nicename: `${runId}-cat-news`, name: 'Yoast news' }],
      meta: { rank_math_title: 'Rank Math wins', rank_math_description: '%title% %sep% rank', _yoast_wpseo_title: 'Yoast loses', _yoast_wpseo_metadesc: 'Yoast desc loses', _yoast_wpseo_primary_category: '7' },
    },
  ]
  fs.writeFileSync(yFile, wxr(items, { channelCategories: [{ id: 7, nicename: faith, name: 'Faith' }, { id: 8, nicename: `${runId}-cat-news`, name: 'Yoast news' }] }))
})

afterAll(async () => {
  await f?.cleanup()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

it('a dry run writes nothing but reports the chain and the SEO sources', async () => {
  const rep = await runImport(f.payload, opts(0, { dryRun: true, manifestPath: undefined }))
  expect(await yDocs()).toHaveLength(0)
  expect(rep.categories.bySource).toEqual({ wordpress: 1, yoastPrimary: 1, tagMap: 1, generic: 0, fallback: 3 })
  expect(rep.categories.yoastPrimaryUnresolved).toBe(1)
  expect(rep.categories.tagMapTargetMissing).toBe(1)
  const text = formatImportReport(rep)
  expect(text).toContain('category source: WordPress 1, Yoast primary 1, tag map 1')
  expect(text).not.toMatch(/Primary Story|church-life|free-text-tag|Social title/)
})

it('places posts by the chain, imports Yoast SEO with variables resolved, and prefers Rank Math', async () => {
  const rep = await runImport(f.payload, opts(1))
  expect(rep.articles.created).toBe(6)
  expect(rep.categories.bySource).toEqual({ wordpress: 1, yoastPrimary: 1, tagMap: 1, generic: 0, fallback: 3 })
  expect(rep.categories.fallbackUsed).toBe(3)
  const docs = await yDocs()
  const by = (id: number) => docs.find((d) => d.legacyId === id)!
  expect(await slugOf(by(yIds.primary))).toBe(faith)
  expect(await slugOf(by(yIds.tagged))).toBe(faith)
  expect(await slugOf(by(yIds.plain))).toBe(fallback) // a free-text tag with no map entry never creates a category
  expect(await slugOf(by(yIds.ghostTag))).toBe(fallback) // map target that does not exist is not created from a tag
  expect(await slugOf(by(yIds.badPrimary))).toBe(fallback)
  expect(await slugOf(by(yIds.both))).toBe(`${runId}-cat-news`)
  const cats = await f.payload.find({ collection: 'categories', where: { slug: { like: runId } }, limit: 50, depth: 0, overrideAccess: true })
  const slugs = (cats.docs as unknown as Array<{ slug: string }>).map((c) => c.slug).filter((s) => s.startsWith(`${runId}-cat-`) && !/-cat-[ab]$/.test(s))
  expect(slugs.sort()).toEqual([`${runId}-cat-news`, faith, fallback].sort())
  expect(slugs.some((s) => s.includes('free-text') || s.includes('does-not-exist'))).toBe(false)

  expect(by(yIds.primary).seoTitle).toBe('Primary Story - Church Times Nigeria')
  expect(by(yIds.primary).seoDescription.length).toBeLessThanOrEqual(200)
  expect(by(yIds.primary).seoDescription.endsWith('…')).toBe(true)
  expect(by(yIds.primary).seoDescription.startsWith('Plain & word')).toBe(true)
  expect(by(yIds.tagged).seoTitle).toBe('Yoast only title')
  expect(by(yIds.tagged).seoDescription).toBe('only text')
  expect(by(yIds.plain).seoTitle ?? null).toBeNull() // value kept a %%var text: dropped
  expect(by(yIds.both).seoTitle).toBe('Rank Math wins')
  expect(by(yIds.both).seoDescription).toBe('Both Story - rank')
  expect(rep.seo.titleFrom).toEqual({ rankMath: 1, yoast: 2, none: 3 })
  expect(rep.seo.descriptionFrom).toEqual({ rankMath: 1, yoast: 2, none: 3 })
  expect(rep.seo.droppedUnresolved).toBe(1)
  expect(rep.seo.truncated).toBe(1)
  expect(rep.seo).toMatchObject({ yoastCanonicalValid: 1, yoastCanonicalInvalid: 0, yoastNoindex: 1, yoastSocial: 1 })
  for (const d of docs) expect(`${d.seoTitle ?? ''}${d.seoDescription ?? ''}`).not.toMatch(/%|<|&amp;/)
})

it('a second run is idempotent: nothing created, no categories, no counters moved', async () => {
  const rep = await runImport(f.payload, opts(2))
  expect(rep.articles).toMatchObject({ created: 0, updated: 0, unchanged: 6 })
  expect(rep.categories.created).toBe(0)
  expect(rep.categories.bySource).toEqual({ wordpress: 0, yoastPrimary: 0, tagMap: 0, generic: 0, fallback: 0 })
  expect(await yDocs()).toHaveLength(6)
  expect(readManifest(man(2)).articles).toEqual({ created: [], updated: [] })
})

it('refuses a bad or in-repository category map with one code', async () => {
  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(bad, '{"a":"Not A Slug"}')
  await expect(runImport(f.payload, opts(3, { categoryMapFile: bad, dryRun: true }))).rejects.toMatchObject({ code: 'IMPORT_CATEGORY_MAP_INVALID' })
  await expect(runImport(f.payload, opts(3, { categoryMapFile: path.join(process.cwd(), 'package.json'), dryRun: true }))).rejects.toMatchObject({ code: 'IMPORT_CATEGORY_MAP_INSIDE_REPO' })
  await expect(runImport(f.payload, opts(3, { categoryMapFile: path.join(dir, 'missing.json'), dryRun: true }))).rejects.toMatchObject({ code: 'IMPORT_CATEGORY_MAP_UNREADABLE' })
  await expect(runImport(f.payload, opts(3, { fallbackCategory: { slug: 'Bad Slug', title: 'x' }, dryRun: true }))).rejects.toMatchObject({ code: 'IMPORT_FALLBACK_CATEGORY_INVALID' })
})

it('rollback removes the articles and the categories the chain created', async () => {
  const rep = await runRollback(f.payload, { manifestPath: man(1), minIncompleteAgeMs: 0, apply: true })
  expect(rep.articles.deleted).toBe(6)
  expect(await yDocs()).toHaveLength(0)
  for (const slug of [faith, fallback, `${runId}-cat-news`]) {
    const left = await f.payload.count({ collection: 'categories', where: { slug: { equals: slug } }, overrideAccess: true })
    expect(left.totalDocs).toBe(0)
  }
})
