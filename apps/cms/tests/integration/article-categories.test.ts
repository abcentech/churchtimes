import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resetSearchLimiter } from '../../src/endpoints/publicSearch'
import { reindexArticleSearch } from '../../src/lib/articleSearch'
import { migrations } from '../../src/migrations'
import { api, lexical, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Secondary categories (`articles.categories`): validation, public projections and filters, the C8 search filter,
 * reindex, category deletion and the migration. `category` stays the required primary.
 */
const runId = newRunId()
let f: Fixtures
let cats: number[] // 7 extra categories besides catA (primary) and catB
const word = (label: string) => `${runId}${label}`
const NOW = () => new Date(Date.now() - 60_000).toISOString()
const saved = { rate: process.env.SEARCH_RATE_LIMIT }
const db = () => (f.payload.db as any).drizzle

beforeAll(async () => {
  process.env.SEARCH_RATE_LIMIT = '10000'
  f = await setupFixtures(runId)
  cats = []
  for (let i = 1; i <= 7; i++) {
    const c = (await f.payload.create({ collection: 'categories', data: { title: `${runId} x${i}`, slug: `${runId}-cat-x${i}` }, overrideAccess: true })) as { id: number }
    cats.push(c.id)
  }
})
afterAll(async () => {
  if (saved.rate === undefined) delete process.env.SEARCH_RATE_LIMIT
  else process.env.SEARCH_RATE_LIMIT = saved.rate
  resetSearchLimiter()
  await f?.cleanup()
})
beforeEach(() => resetSearchLimiter())

const seed = (data: Record<string, unknown>) => f.seedArticle({ status: 'published', publishedAt: NOW(), ...data })
const search = (qs: string) => api('GET', `/api/public/search?${qs}`)
const ids = (r: { json: { docs: Array<{ id: number }> } }) => r.json.docs.map((d) => d.id)
const rowIds = async (articleId: number): Promise<number[]> => {
  const r = (await db().execute(`select "category_ids" as c from "article_search" where "article_id" = ${articleId}`)) as { rows: { c: number[] }[] }
  return r.rows[0]?.c ?? []
}

describe('validation (server-side)', () => {
  it('accepts up to five additional categories and stores them in order', async () => {
    const r = await f.createArticle(f.tokens.eic, { category: f.catA.id, categories: cats.slice(0, 5) })
    expect(r.status).toBe(201)
    const doc = (await f.payload.findByID({ collection: 'articles', id: r.id!, depth: 0, overrideAccess: true })) as any
    expect(doc.categories).toEqual(cats.slice(0, 5))
    expect(doc.category).toBe(f.catA.id)
  })

  it('refuses six, a duplicate and the primary (400), on create', async () => {
    for (const categories of [cats.slice(0, 6), [cats[0], cats[0]], [cats[0], f.catA.id]]) {
      const r = await f.createArticle(f.tokens.eic, { category: f.catA.id, categories })
      expect(r.status, JSON.stringify(categories)).toBe(400)
    }
  })

  it('refuses a missing category id and a non-id', async () => {
    expect((await f.createArticle(f.tokens.eic, { categories: [987654321] })).status).toBe(400)
    expect((await f.createArticle(f.tokens.eic, { categories: ['news'] })).status).toBe(400)
  })

  it('checks a partial update against the stored side: changing only the primary cannot collide with an extra', async () => {
    const r = await f.createArticle(f.tokens.eic, { category: f.catA.id, categories: [cats[0]] })
    expect(r.status).toBe(201)
    const clash = await api('PATCH', `/api/articles/${r.id}`, { token: f.tokens.eic, body: { category: cats[0] } })
    expect(clash.status).toBe(400)
    const clash2 = await api('PATCH', `/api/articles/${r.id}`, { token: f.tokens.eic, body: { categories: [f.catA.id] } })
    expect(clash2.status).toBe(400)
    const ok = await api('PATCH', `/api/articles/${r.id}`, { token: f.tokens.eic, body: { categories: [cats[1], cats[2]] } })
    expect(ok.status).toBe(200)
    const cleared = await api('PATCH', `/api/articles/${r.id}`, { token: f.tokens.eic, body: { categories: [] } })
    expect(cleared.status).toBe(200)
    expect(cleared.json.doc.categories ?? []).toEqual([])
  })

  it('the primary category is still required', async () => {
    const label = f.uniq('np')
    const r = await api('POST', '/api/articles', { token: f.tokens.eic, body: { title: label, slug: label, content: lexical(), categories: [cats[0]] } })
    expect(r.status).toBe(400)
  })

  it('a reporter can set additional categories on their own draft', async () => {
    const r = await f.createArticle(f.tokens.reporter, { categories: [cats[3]] })
    expect(r.status).toBe(201)
  })
})

describe('public projection and filters', () => {
  it('anonymous reads expose categories additively (id, slug, title at depth=1; ids at depth=0), primary stays category', async () => {
    const a = await seed({ category: f.catA.id, categories: [cats[0], cats[1]] })
    const d1 = await api('GET', `/api/articles/${a.id}?depth=1`)
    expect(d1.status).toBe(200)
    expect(d1.json.category).toMatchObject({ id: f.catA.id, slug: `${runId}-cat-a` })
    expect(d1.json.categories.map((c: { id: number; slug: string; title: string }) => [c.id, c.slug, c.title])).toEqual([
      [cats[0], `${runId}-cat-x1`, `${runId} x1`],
      [cats[1], `${runId}-cat-x2`, `${runId} x2`],
    ])
    const d0 = await api('GET', `/api/articles/${a.id}?depth=0`)
    expect(d0.json.categories).toEqual([cats[0], cats[1]])
  })

  it('where[categories][in] finds articles by a secondary category; the or-form lists primary OR secondary', async () => {
    const x = cats[4]
    const viaSecondary = await seed({ category: f.catA.id, categories: [x] })
    const viaPrimary = await seed({ category: x })
    const other = await seed({ category: f.catB.id, categories: [cats[5]] })
    const draft = await f.seedArticle({ status: 'draft', category: f.catA.id, categories: [x] })

    const only = await api('GET', `/api/articles?where[categories][in]=${x}&where[status][equals]=published&limit=50`)
    expect(only.status).toBe(200)
    expect(only.json.docs.map((d: { id: number }) => d.id)).toEqual([viaSecondary.id])

    const both = await api(
      'GET',
      `/api/articles?where[or][0][category][equals]=${x}&where[or][1][categories][equals]=${x}&where[status][equals]=published&limit=50`,
    )
    const got = both.json.docs.map((d: { id: number }) => d.id)
    expect([...got].sort()).toEqual([viaPrimary.id, viaSecondary.id].sort())
    expect(got).not.toContain(other.id)
    expect(got).not.toContain(draft.id) // drafts never reach an anonymous caller
  })
})

describe('C8 search', () => {
  it('category= matches the primary OR a secondary category (slug or id); hits carry categories (secondary only)', async () => {
    const t = word('multisearch')
    const a = await seed({ title: `Both ${t}`, category: f.catA.id, categories: [cats[0], cats[1]] })
    const b = await seed({ title: `Plain ${t}`, category: f.catB.id })
    expect(ids(await search(`q=${t}&category=${runId}-cat-a`))).toEqual([a.id])
    const bySecondarySlug = await search(`q=${t}&category=${runId}-cat-x2`)
    expect(ids(bySecondarySlug)).toEqual([a.id])
    expect(ids(await search(`q=${t}&category=${cats[0]}`))).toEqual([a.id])
    const onlyB = await search(`q=${t}&category=${f.catB.id}`)
    expect(ids(onlyB)).toEqual([b.id])
    expect(ids(await search(`q=${t}&category=${runId}-cat-x5`))).toEqual([])
    const hit = bySecondarySlug.json.docs[0]
    expect(hit.category).toMatchObject({ id: f.catA.id, slug: `${runId}-cat-a` })
    expect(hit.categories.map((c: { id: number }) => c.id)).toEqual([cats[0], cats[1]])
    expect(onlyB.json.docs[0].categories).toEqual([])
  })

  it('stays in step on edit, and reindex is idempotent and repairs the array', async () => {
    const t = word('stepsearch')
    const a = await seed({ title: `Step ${t}`, category: f.catA.id, categories: [cats[0]] })
    expect(await rowIds(a.id)).toEqual([f.catA.id, cats[0]])
    await f.payload.update({ collection: 'articles', id: a.id, data: { categories: [cats[2], cats[3]] } as never, overrideAccess: true, context: { seed: true } })
    expect(await rowIds(a.id)).toEqual([f.catA.id, cats[2], cats[3]])
    expect(ids(await search(`q=${t}&category=${cats[0]}`))).toEqual([])
    expect(ids(await search(`q=${t}&category=${cats[3]}`))).toEqual([a.id])
    // moving the primary: the new primary leads
    await f.payload.update({ collection: 'articles', id: a.id, data: { category: f.catB.id, categories: [] } as never, overrideAccess: true, context: { seed: true } })
    expect(await rowIds(a.id)).toEqual([f.catB.id])

    await f.payload.update({ collection: 'articles', id: a.id, data: { categories: [cats[6]] } as never, overrideAccess: true, context: { seed: true } })
    await db().execute(`update "article_search" set "category_ids" = '{}' where "article_id" = ${a.id}`) // simulate a stale projection
    const r1 = await reindexArticleSearch(f.payload)
    expect(r1.indexed).toBeGreaterThan(0)
    expect(await rowIds(a.id)).toEqual([f.catB.id, cats[6]])
    const r2 = await reindexArticleSearch(f.payload)
    expect(r2.indexed).toBe(r1.indexed)
    expect(await rowIds(a.id)).toEqual([f.catB.id, cats[6]])
  })
})

describe('category deletion and preview', () => {
  it('deleting a category removes its join rows and leaves the article, with the primary untouched', async () => {
    const victim = (await f.payload.create({ collection: 'categories', data: { title: `${runId} gone`, slug: `${runId}-cat-gone` }, overrideAccess: true })) as { id: number }
    const a = await seed({ category: f.catA.id, categories: [victim.id, cats[0]] })
    await f.payload.delete({ collection: 'categories', id: victim.id, overrideAccess: true })
    const doc = (await f.payload.findByID({ collection: 'articles', id: a.id, depth: 0, overrideAccess: true })) as any
    expect(doc.categories).toEqual([cats[0]])
    expect(doc.category).toBe(f.catA.id)
  })

  it('the preview projection includes the categories', async () => {
    const a = await f.seedArticle({ status: 'draft', category: f.catA.id, categories: [cats[0]] })
    const tok = await api('POST', `/api/articles/${a.id}/preview-token`, { token: f.tokens.eic, body: {} })
    expect(tok.status).toBe(200)
    const pv = await api('GET', `/api/preview/articles?token=${encodeURIComponent(String(tok.json.token))}`)
    expect(pv.status).toBe(200)
    expect(pv.json.doc.categories.map((c: { id: number }) => c.id)).toEqual([cats[0]])
  })
})

describe('migration 20261027_140000_article_multi_category', () => {
  it('is reversible and re-runnable (IF EXISTS), keeping the search projection usable', async () => {
    const entry = migrations.find((m) => m.name === '20261027_140000_article_multi_category')
    expect(entry).toBeTruthy()
    const args = { db: db(), payload: f.payload, req: {} } as never
    const colExists = async (table: string, col: string) => {
      const r = (await db().execute(`select 1 as x from information_schema.columns where table_name = '${table}' and column_name = '${col}'`)) as { rows: unknown[] }
      return r.rows.length > 0
    }
    expect(await colExists('articles_rels', 'categories_id')).toBe(true)
    expect(await colExists('article_search', 'category_ids')).toBe(true)
    await entry!.down(args)
    expect(await colExists('articles_rels', 'categories_id')).toBe(false)
    expect(await colExists('article_search', 'category_ids')).toBe(false)
    await entry!.down(args) // idempotent
    await entry!.up(args)
    await entry!.up(args) // re-runnable
    expect(await colExists('articles_rels', 'categories_id')).toBe(true)
    expect(await colExists('_articles_v_rels', 'categories_id')).toBe(true)
    expect(await colExists('article_search', 'category_ids')).toBe(true)
    // up() backfills the array from the primary; a reindex then adds the secondary ones
    const a = await seed({ category: f.catA.id, categories: [cats[0]] })
    await db().execute(`update "article_search" set "category_ids" = '{}' where "article_id" = ${a.id}`)
    await entry!.up(args)
    expect(await rowIds(a.id)).toEqual([f.catA.id])
    await reindexArticleSearch(f.payload)
    expect(await rowIds(a.id)).toEqual([f.catA.id, cats[0]])
  })
})
