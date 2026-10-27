import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readManifest } from '../../src/import/manifest'
import { runRollback } from '../../src/import/rollback'
import { runImport, type ImportOptions } from '../../src/import/run'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'
import { newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Category modes against a real database with a SYNTHETIC export: rules mode, the fallback category, provenance in the
 * manifest, the review file, idempotence, rollback, and the dry run reporting what apply creates.
 */
const runId = newRunId()
const base = 7_400_000 + (parseInt(runId.slice(1, 5), 16) % 50_000) * 100
const slug = (s: string) => `${runId}-${s}`
const ids = {
  labelled: Array.from({ length: 12 }, (_, i) => base + 1 + i), // categorised, June 2020, "interviews"
  newsPost: base + 20, // categorised "news"
  placed: base + 21, // no category, June 2020: the neighbours place it
  lonely: base + 22, // no category, 2010, nothing nearby: fallback
  suggested: base + 23, // no category, 2010, one weak cue: fallback with a suggestion
  cue: base + 24, // no category, 2010, explicit cue in the title: rules
  empty: [base + 30, base + 31, base + 32, base + 33, base + 34, base + 35], // skipped (empty body) between the others
}
let f: Fixtures
let dir: string
let exportFile: string
let rulesFile: string
const manifest = (n: string) => path.join(dir, `manifest-${n}.jsonl`)

beforeAll(async () => {
  f = await setupFixtures(runId)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-categorise-int-'))
  const interviews = { nicename: slug('interviews'), name: `${runId} Interviews` }
  const news = { nicename: slug('news'), name: `${runId} News` }
  const post = (id: number, extra: Partial<FixtureItem> = {}): FixtureItem => ({
    id,
    slug: slug(`p-${id}`),
    dateGmt: '2020-06-10 10:00:00',
    content: '<p>Synthetic body text.</p>',
    ...extra,
  })
  const items: FixtureItem[] = [
    ...ids.labelled.map((id) => post(id, { categories: [interviews] })),
    post(ids.newsPost, { categories: [news], dateGmt: '2020-06-12 10:00:00' }),
    post(ids.empty[0], { content: '', dateGmt: '2010-01-05 10:00:00' }),
    post(ids.placed, { dateGmt: '2020-06-20 10:00:00', title: 'Plain title' }),
    post(ids.empty[1], { content: '', dateGmt: '2010-01-06 10:00:00' }),
    post(ids.lonely, { dateGmt: '2010-01-07 10:00:00' }),
    post(ids.empty[2], { content: '', dateGmt: '2010-01-08 10:00:00' }),
    post(ids.suggested, { dateGmt: '2010-01-09 10:00:00', content: '<p>An interview was held.</p>' }),
    post(ids.empty[3], { content: '', dateGmt: '2010-01-10 10:00:00' }),
    post(ids.cue, { dateGmt: '2010-01-11 10:00:00', title: 'An interview with a synthetic bishop' }),
    post(ids.empty[4], { content: '', dateGmt: '2010-01-12 10:00:00' }),
    post(ids.empty[5], { content: '', dateGmt: '2010-01-13 10:00:00' }),
  ]
  exportFile = path.join(dir, 'export.xml')
  fs.writeFileSync(
    exportFile,
    wxr(items, {
      channelCategories: [
        { id: 11, nicename: interviews.nicename, name: interviews.name },
        { id: 12, nicename: news.nicename, name: news.name },
      ],
    }),
  )
  rulesFile = path.join(dir, 'rules.json')
  fs.writeFileSync(
    rulesFile,
    JSON.stringify({
      minScore: 6,
      minMargin: 3,
      neighbours: { windowMonths: 1, minPosts: 5, weight: 10, maxWindowMonths: 2, smoothing: 0 },
      rules: [{ id: 'cue.interview', category: interviews.nicename, patterns: [{ phrase: 'interview*', weight: 3 }] }],
    }),
  )
})

afterAll(async () => {
  await f?.cleanup()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

const options = (extra: Partial<ImportOptions> = {}): ImportOptions => ({
  file: exportFile,
  manifestPath: undefined,
  dryRun: true,
  fallbackCategory: { slug: slug('general'), title: `${runId} General` },
  ...extra,
})

const articleCategories = async (): Promise<Map<number, string>> => {
  const all = [...ids.labelled, ids.newsPost, ids.placed, ids.lonely, ids.suggested, ids.cue]
  const docs = (await f.payload.find({ collection: 'articles', where: { legacyId: { in: all } }, limit: 50, depth: 1, overrideAccess: true })).docs as unknown as Array<{ legacyId: number; category: { slug: string } }>
  return new Map(docs.map((d) => [d.legacyId, d.category.slug]))
}
const categoryRows = async () => (await f.payload.count({ collection: 'categories', where: { slug: { in: [slug('interviews'), slug('news'), slug('general')] } }, overrideAccess: true })).totalDocs

describe('category modes', () => {
  it('strict (the default) never uses the rules: unplaced posts go to the configured fallback', async () => {
    const rep = await runImport(f.payload, options())
    expect(rep.categories.mode).toBe('strict')
    expect(rep.categories.bySource).toMatchObject({ wordpress: 13, rules: 0, fallback: 4 })
    expect(rep.categories.rulesLowConfidence).toBe(0)
  })

  it('a dry run reports the categories apply creates, even when posts are skipped in between', async () => {
    const dry = await runImport(f.payload, options({ categoryMode: 'rules', categoryRulesFile: rulesFile }))
    expect(dry.articles.skipped['empty-body']).toBe(6)
    expect(dry.categories.created).toBe(3) // interviews, news, general
    expect(await categoryRows()).toBe(0)
    const strict = await runImport(f.payload, options())
    expect(strict.categories.created).toBe(3)
  })

  it('rules mode places posts from the neighbours and an explicit cue, and records why', async () => {
    const review = path.join(dir, 'review-1.csv')
    const rep = await runImport(f.payload, options({ dryRun: false, manifestPath: manifest('1'), categoryMode: 'rules', categoryRulesFile: rulesFile, categoryReviewFile: review }))
    expect(rep.categories.mode).toBe('rules')
    expect(rep.categories.bySource).toMatchObject({ wordpress: 13, rules: 2, fallback: 2 })
    expect(rep.categories.rulesLowConfidence).toBe(1)
    expect(rep.categories.created).toBe(3)

    const cats = await articleCategories()
    expect(cats.get(ids.placed)).toBe(slug('interviews'))
    expect(cats.get(ids.cue)).toBe(slug('interviews'))
    expect(cats.get(ids.newsPost)).toBe(slug('news'))
    expect(cats.get(ids.lonely)).toBe(slug('general'))
    expect(cats.get(ids.suggested)).toBe(slug('general'))

    // provenance in the manifest: step, category and the rule, ids and slugs only
    const lines = fs.readFileSync(manifest('1'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>)
    const prov = new Map(lines.filter((l) => l.type === 'category').map((l) => [l.legacyId as number, l]))
    expect(prov.get(ids.placed)).toMatchObject({ step: 'rules', category: slug('interviews'), rule: { id: 'era-neighbours', confident: true } })
    expect(prov.get(ids.placed)!.rule.score).toBeGreaterThanOrEqual(6)
    expect(prov.get(ids.cue)).toMatchObject({ step: 'rules', rule: { id: 'cue.interview', confident: true } })
    expect(prov.get(ids.suggested)).toMatchObject({ step: 'fallback', category: slug('general'), rule: { id: 'cue.interview', confident: false } })
    expect(prov.get(ids.lonely)).toMatchObject({ step: 'fallback' })
    expect(prov.get(ids.lonely)!.rule).toBeUndefined()
    expect(prov.get(ids.newsPost)).toMatchObject({ step: 'wordpress' })
    expect(fs.readFileSync(manifest('1'), 'utf8')).not.toMatch(/example\.test|Synthetic|bishop/)

    // review file: legacy id, suggestion, score, runner-up. No titles, text or addresses.
    const csv = fs.readFileSync(review, 'utf8')
    const rows = csv.trim().split('\n')
    expect(rows[0]).toBe('legacy_id,suggested_category,score,runner_up,runner_up_score')
    expect(rows).toHaveLength(2)
    expect(rows[1].startsWith(`${ids.suggested},${slug('interviews')},`)).toBe(true)
    expect(csv).not.toMatch(/example\.test|Synthetic|bishop|Plain title/)
  })

  it('rollback ignores the provenance lines and removes everything the run created, categories included', async () => {
    const summary = readManifest(manifest('1'))
    expect(summary.articles.created).toHaveLength(ids.labelled.length + 5)
    expect(summary.categories).toHaveLength(3)
    expect(summary).toMatchObject({ complete: true, openIntents: [] })
    expect(summary.aborted).toHaveLength(ids.empty.length) // the skipped empty-body posts
    const rb = await runRollback(f.payload, { manifestPath: manifest('1'), apply: true, minIncompleteAgeMs: 0 })
    expect(rb.articles.deleted).toBe(ids.labelled.length + 5)
    expect(rb.categories.deleted).toBe(3)
    expect(rb.articles.failed + rb.categories.failed).toBe(0)
    expect(await categoryRows()).toBe(0)
    expect((await articleCategories()).size).toBe(0)
  })

  it('is idempotent: the same run twice gives the same categories and the second changes nothing', async () => {
    const opts = (n: string) => options({ dryRun: false, manifestPath: manifest(n), categoryMode: 'rules', categoryRulesFile: rulesFile })
    await runImport(f.payload, opts('2'))
    const first = await articleCategories()
    const again = await runImport(f.payload, opts('3'))
    expect(again.articles).toMatchObject({ created: 0, updated: 0, unchanged: ids.labelled.length + 5 })
    expect(again.categories.created).toBe(0)
    expect(await articleCategories()).toEqual(first)
    expect(readManifest(manifest('3')).articles).toEqual({ created: [], updated: [] })
  })

  it('refuses unsafe or inconsistent options before touching anything', async () => {
    await expect(runImport(f.payload, options({ categoryRulesFile: rulesFile }))).rejects.toThrow('IMPORT_CATEGORY_RULES_NEED_RULES_MODE')
    await expect(runImport(f.payload, options({ categoryReviewFile: path.join(dir, 'r.csv') }))).rejects.toThrow('IMPORT_CATEGORY_REVIEW_NEEDS_RULES_MODE')
    await expect(runImport(f.payload, options({ categoryMode: 'rules', categoryReviewFile: path.join(dir, 'review-1.csv') }))).rejects.toThrow('IMPORT_CATEGORY_REVIEW_EXISTS')
    await expect(runImport(f.payload, options({ categoryMode: 'rules', categoryRulesFile: path.join(dir, 'missing.json') }))).rejects.toThrow('IMPORT_CATEGORY_RULES_UNREADABLE')
    const bad = path.join(dir, 'bad.json')
    fs.writeFileSync(bad, '{"minScore":1}')
    await expect(runImport(f.payload, options({ categoryMode: 'rules', categoryRulesFile: bad }))).rejects.toThrow('IMPORT_CATEGORY_RULES_INVALID')
  })
})
