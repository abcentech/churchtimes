import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resetSearchLimiter } from '../../src/endpoints/publicSearch'
import { reindexArticleSearch } from '../../src/lib/articleSearch'
import { api, lexical, newRunId, setupFixtures, type Fixtures } from './helpers'

const runId = newRunId()
let f: Fixtures
const word = (label: string) => `${runId}${label}`
const search = (qs: string, headers: Record<string, string> = {}) => api('GET', `/api/public/search?${qs}`, { headers })
const q = (text: string, extra = '') => `q=${encodeURIComponent(text)}${extra}`
const ids = (r: { json: { docs: Array<{ id: number }> } }) => r.json.docs.map((d) => d.id)
const NOW = () => new Date(Date.now() - 60_000).toISOString()
const saved = { rate: process.env.SEARCH_RATE_LIMIT, origins: process.env.PUBLIC_SUBMISSION_ORIGINS }

beforeAll(async () => {
  process.env.SEARCH_RATE_LIMIT = '10000'
  f = await setupFixtures(runId)
})
afterAll(async () => {
  if (saved.rate === undefined) delete process.env.SEARCH_RATE_LIMIT
  else process.env.SEARCH_RATE_LIMIT = saved.rate
  if (saved.origins === undefined) delete process.env.PUBLIC_SUBMISSION_ORIGINS
  else process.env.PUBLIC_SUBMISSION_ORIGINS = saved.origins
  resetSearchLimiter()
  await f?.cleanup()
})
beforeEach(() => resetSearchLimiter())

const seed = (data: Record<string, unknown>) => f.seedArticle({ status: 'published', publishedAt: NOW(), ...data })

describe('GET /api/public/search: visibility', () => {
  it('finds a published article by title, excerpt and body, with a plain snippet and the documented shape', async () => {
    const t = word('titleterm')
    const e = word('excerptterm')
    const b = word('bodyterm')
    const a = await seed({
      title: `Headline ${t}`,
      excerpt: `An excerpt about ${e}`,
      content: lexical(`Opening paragraph. The body mentions ${b} in the middle of <b>some</b> text & more.`),
    })
    for (const term of [t, e, b]) {
      const r = await search(q(term))
      expect(r.status).toBe(200)
      expect(ids(r)).toContain(a.id)
    }
    const r = await search(q(b))
    const hit = r.json.docs.find((d: { id: number }) => d.id === a.id)
    expect(hit).toMatchObject({ id: a.id, slug: a.slug })
    expect(hit.category.slug).toBe(`${runId}-cat-a`)
    expect(typeof hit.publishedAt).toBe('string')
    expect(hit.snippet).toContain(b)
    expect(hit.snippet).not.toMatch(/[<>]/)
    expect(hit.snippet.length).toBeLessThanOrEqual(240)
    expect(r.json).toMatchObject({ page: 1, limit: 10, hasPrevPage: false })
    expect(r.json.totalDocs).toBe(1)
    // no staff fields
    expect(hit.categories).toEqual([])
    expect(Object.keys(hit).sort()).toEqual(['categories', 'category', 'excerpt', 'id', 'publishedAt', 'rank', 'slug', 'snippet', 'title'])
  })

  it('never returns drafts, in-review, archived (withdrawn), scheduled or future-dated articles', async () => {
    const t = word('hidden')
    const published = await seed({ title: `Visible ${t}` })
    const draft = await f.seedArticle({ status: 'draft', title: `Draft ${t}` })
    const review = await f.seedArticle({ status: 'in_review', title: `Review ${t}` })
    const archived = await f.seedArticle({ status: 'archived', title: `Archived ${t}`, publishedAt: NOW() })
    const scheduled = await f.seedArticle({
      status: 'scheduled',
      title: `Scheduled ${t}`,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
    })
    const future = await seed({ title: `Future ${t}`, publishedAt: new Date(Date.now() + 86_400_000).toISOString() })
    const r = await search(q(t))
    expect(ids(r)).toEqual([published.id])
    expect(r.json.totalDocs).toBe(1)
    for (const x of [draft, review, archived, scheduled, future]) expect(ids(r)).not.toContain(x.id)
  })

  it('removes an article when it is unpublished, archived or deleted, and adds it when published', async () => {
    const t = word('lifecycle')
    const a = await f.seedArticle({ status: 'draft', title: `Life ${t}` })
    expect(ids(await search(q(t)))).toEqual([])
    await f.payload.update({
      collection: 'articles',
      id: a.id,
      data: { status: 'published', publishedAt: NOW() } as never,
      overrideAccess: true,
      context: { seed: true },
    })
    expect(ids(await search(q(t)))).toEqual([a.id])
    await f.payload.update({ collection: 'articles', id: a.id, data: { status: 'archived' } as never, overrideAccess: true, context: { seed: true } })
    expect(ids(await search(q(t)))).toEqual([])
    await f.payload.update({ collection: 'articles', id: a.id, data: { status: 'published' } as never, overrideAccess: true, context: { seed: true } })
    expect(ids(await search(q(t)))).toEqual([a.id])
    await f.payload.update({ collection: 'articles', id: a.id, data: { status: 'draft' } as never, overrideAccess: true, context: { seed: true } })
    expect(ids(await search(q(t)))).toEqual([])
    await f.payload.update({ collection: 'articles', id: a.id, data: { status: 'published' } as never, overrideAccess: true, context: { seed: true } })
    await f.payload.delete({ collection: 'articles', id: a.id, overrideAccess: true, context: { seed: true } })
    expect(ids(await search(q(t)))).toEqual([])
  })

  it('an update to the text changes what is found and how results rank', async () => {
    const t = word('rerank')
    const weak = await seed({ title: 'Weak match', content: lexical(`only a single passing mention of ${t} here`) })
    const strong = await seed({ title: 'Strong match', excerpt: `no term yet`, content: lexical('nothing relevant') })
    expect(ids(await search(q(t)))).toEqual([weak.id])
    await f.payload.update({
      collection: 'articles',
      id: strong.id,
      data: { title: `${t} headline`, excerpt: `${t} excerpt` } as never,
      overrideAccess: true,
      context: { seed: true },
    })
    // title (weight A) + excerpt (B) outrank a lone body mention (C)
    expect(ids(await search(q(t)))).toEqual([strong.id, weak.id])
    // and the old text no longer matches
    await f.payload.update({ collection: 'articles', id: weak.id, data: { content: lexical('replaced body') } as never, overrideAccess: true, context: { seed: true } })
    expect(ids(await search(q(t)))).toEqual([strong.id])
  })
})

describe('GET /api/public/search: filters and paging', () => {
  it('filters by category (slug or id) and by year', async () => {
    const t = word('filter')
    const a = await seed({ title: `A ${t}`, category: f.catA.id, publishedAt: '2019-06-01T10:00:00.000Z' })
    const b = await seed({ title: `B ${t}`, category: f.catB.id, publishedAt: '2021-03-01T10:00:00.000Z' })
    const c = await seed({ title: `C ${t}`, category: f.catB.id, publishedAt: '2019-12-31T23:59:59.000Z' })
    expect(new Set(ids(await search(q(t))))).toEqual(new Set([a.id, b.id, c.id]))
    expect(new Set(ids(await search(q(t, `&category=${runId}-cat-b`))))).toEqual(new Set([b.id, c.id]))
    expect(ids(await search(q(t, `&category=${f.catA.id}`)))).toEqual([a.id])
    expect(new Set(ids(await search(q(t, '&year=2019'))))).toEqual(new Set([a.id, c.id]))
    expect(ids(await search(q(t, `&year=2019&category=${runId}-cat-b`)))).toEqual([c.id])
    expect(ids(await search(q(t, '&category=no-such-category')))).toEqual([])
    expect(ids(await search(q(t, '&year=1999')))).toEqual([])
    expect((await search(q(t, '&year=abcd'))).status).toBe(400)
    expect((await search(q(t, '&year=99999'))).status).toBe(400)
  })

  it('paginates, caps limit at 20 and page at 100, and survives junk paging values', async () => {
    const t = word('paging')
    for (let i = 0; i < 7; i++) await seed({ title: `P${i} ${t}`, publishedAt: new Date(Date.now() - (i + 1) * 60_000).toISOString() })
    const p1 = await search(q(t, '&limit=3&page=1'))
    const p2 = await search(q(t, '&limit=3&page=2'))
    const p3 = await search(q(t, '&limit=3&page=3'))
    expect([p1, p2, p3].map((r) => r.json.docs.length)).toEqual([3, 3, 1])
    expect(p1.json).toMatchObject({ totalDocs: 7, totalPages: 3, hasNextPage: true, nextPage: 2, prevPage: null })
    expect(p3.json).toMatchObject({ hasNextPage: false, hasPrevPage: true, prevPage: 2 })
    expect(new Set([...ids(p1), ...ids(p2), ...ids(p3)]).size).toBe(7)
    // equal rank: newest first
    expect(p1.json.docs[0].title).toContain('P0')

    expect((await search(q(t, '&limit=1000'))).json.limit).toBe(20)
    expect((await search(q(t, '&limit=0'))).json.limit).toBe(10)
    expect((await search(q(t, '&limit=-5'))).json.limit).toBe(10)
    expect((await search(q(t, '&limit=abc'))).json.limit).toBe(10)
    const far = await search(q(t, '&page=99999999'))
    expect(far.status).toBe(200)
    expect(far.json.page).toBe(100)
    expect(far.json.docs).toEqual([])
    expect(far.json.totalDocs).toBe(7)
    expect((await search(q(t, '&page=0'))).json.page).toBe(1)
  })
})

describe('GET /api/public/search: hostile input', () => {
  it.each([
    ["'"],
    ["' OR 1=1 --"],
    ["'; DROP TABLE article_search; --"],
    ['"unbalanced quote'],
    ['a & | ! : * ( ) < > \\ ~ ^'],
    ['!!!'],
    ['&|!:*'],
    ['foo:bar & (baz'],
    ['-'],
    ['OR OR OR'],
    ['日本語 العربية Ελληνικά 🙂 ñandú'],
    ['\u0000nul'],
    ['the and of'],
  ])('answers 200 with a JSON body for %j', async (text) => {
    const r = await search(q(text))
    expect(r.status).toBe(200)
    expect(Array.isArray(r.json.docs)).toBe(true)
    expect(r.headers.get('content-type')).toContain('application/json')
  })

  it('survives invalid UTF-8 in q (percent-encoded lone surrogate)', async () => {
    const r = await search('q=%ED%A0%80x')
    expect([200, 400]).toContain(r.status)
  })

  it('rejects an empty or missing q, and a q over 200 characters', async () => {
    for (const qs of ['', 'q=', 'q=%20%20', 'page=2']) {
      const r = await search(qs)
      expect(r.status).toBe(400)
      expect(r.headers.get('cache-control')).toBe('no-store')
    }
    expect((await search(q('a'.repeat(200)))).status).toBe(200)
    expect((await search(q('a'.repeat(201)))).status).toBe(400)
    expect((await search(q('word '.repeat(20000)))).status).toBe(400)
  })

  it('still works after hostile queries (table intact) and treats operators as plain words', async () => {
    const t = word('safe')
    const a = await seed({ title: `Only ${t}` })
    const r = await search(q(`${t} & | ! : * "`))
    expect(r.status).toBe(200)
    expect(ids(r)).toContain(a.id)
  })
})

describe('GET /api/public/search: counting, categories and uncategorised articles', () => {
  const rawDb = async () => ({
    db: (f.payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<unknown> } }).drizzle,
    sql: (await import('@payloadcms/db-postgres')).sql,
  })

  it('a page past the end with a category filter reports the real total and no docs', async () => {
    const t = word('pastend')
    for (let i = 0; i < 3; i++) await seed({ title: `PE${i} ${t}`, category: f.catB.id })
    await seed({ title: `PEother ${t}`, category: f.catA.id })
    const r = await search(q(t, `&category=${runId}-cat-b&limit=2&page=5`))
    expect(r.status).toBe(200)
    expect(r.json.docs).toEqual([])
    expect(r.json).toMatchObject({ totalDocs: 3, totalCapped: false, page: 5, hasNextPage: false })
  })

  it('totalDocs stops at SEARCH_COUNT_CAP and totalCapped says there are more (also past the end)', async () => {
    const t = word('capped')
    for (let i = 0; i < 4; i++) await seed({ title: `Cap ${i} ${t}` })
    const before = process.env.SEARCH_COUNT_CAP
    process.env.SEARCH_COUNT_CAP = '3'
    try {
      const r = await search(q(t, '&limit=2'))
      expect(r.json).toMatchObject({ totalDocs: 3, totalCapped: true, totalPages: null, hasNextPage: true, nextPage: 2 })
      expect(r.json.docs).toHaveLength(2)
      const p2 = await search(q(t, '&limit=2&page=2'))
      expect(p2.json.docs).toHaveLength(2)
      const far = await search(q(t, '&limit=2&page=9'))
      expect(far.json).toMatchObject({ docs: [], totalDocs: 3, totalCapped: true, totalPages: null, hasNextPage: false })
    } finally {
      if (before === undefined) delete process.env.SEARCH_COUNT_CAP
      else process.env.SEARCH_COUNT_CAP = before
    }
    const all = await search(q(t))
    expect(all.json).toMatchObject({ totalDocs: 4, totalCapped: false })
  })

  it('articles.category_id is NOT NULL in the database, so a published article without a category cannot exist (nothing to seed or index)', async () => {
    const t = word('nocat')
    const a = await seed({ title: `Orphan ${t}` })
    const { db, sql } = await rawDb()
    await expect(db.execute(sql`update "articles" set "category_id" = null where "id" = ${a.id}`)).rejects.toThrow()
    expect(ids(await search(q(t)))).toEqual([a.id])
  })
})

describe('GET /api/public/search: transport', () => {
  it('without a configured public origin the response is private (CORS echo varies per request); nosniff and Vary: Origin always', async () => {
    delete process.env.PUBLIC_SUBMISSION_ORIGINS
    const r = await search(q('anything'))
    expect(r.headers.get('cache-control')).toBe('private, max-age=60')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('vary')).toBe('Origin')
  })

  it('with exactly one public origin every 200 is identical (same ACAO, with or without an Origin) and public; others get an uncached 403', async () => {
    process.env.PUBLIC_SUBMISSION_ORIGINS = 'https://allowed.test'
    try {
      const plain = await search(q('anything'))
      const cors = await search(q('anything'), { origin: 'https://allowed.test' })
      for (const r of [plain, cors]) {
        expect(r.status).toBe(200)
        expect(r.headers.get('cache-control')).toBe('public, max-age=60')
        expect(r.headers.get('access-control-allow-origin')).toBe('https://allowed.test')
        expect(r.headers.get('vary')).toBe('Origin')
      }
      const bad = await search(q('anything'), { origin: 'https://evil.test' })
      expect(bad.status).toBe(403)
      expect(bad.headers.get('cache-control')).toBe('no-store')
      expect(bad.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      if (saved.origins === undefined) delete process.env.PUBLIC_SUBMISSION_ORIGINS
      else process.env.PUBLIC_SUBMISSION_ORIGINS = saved.origins
    }
  })

  it('with several public origins the grant is echoed per request, so the response is private', async () => {
    process.env.PUBLIC_SUBMISSION_ORIGINS = 'https://a.test,https://b.test'
    try {
      const r = await search(q('anything'), { origin: 'https://b.test' })
      expect(r.headers.get('cache-control')).toBe('private, max-age=60')
      expect(r.headers.get('access-control-allow-origin')).toBe('https://b.test')
    } finally {
      if (saved.origins === undefined) delete process.env.PUBLIC_SUBMISSION_ORIGINS
      else process.env.PUBLIC_SUBMISSION_ORIGINS = saved.origins
    }
  })

  it('applies the Origin allowlist and CORS like the other public endpoints', async () => {
    process.env.PUBLIC_SUBMISSION_ORIGINS = 'https://allowed.test'
    try {
      const ok = await search(q('x'), { origin: 'https://allowed.test' })
      expect(ok.status).toBe(200)
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://allowed.test')
      const bad = await search(q('x'), { origin: 'https://evil.test' })
      expect(bad.status).toBe(403)
      expect(bad.headers.get('access-control-allow-origin')).toBeNull()
      const pre = await api('OPTIONS', '/api/public/search', { headers: { origin: 'https://allowed.test' } })
      expect(pre.status).toBe(204)
      expect(pre.headers.get('access-control-allow-methods')).toContain('GET')
      const preBad = await api('OPTIONS', '/api/public/search', { headers: { origin: 'https://evil.test' } })
      expect(preBad.status).toBe(403)
    } finally {
      if (saved.origins === undefined) delete process.env.PUBLIC_SUBMISSION_ORIGINS
      else process.env.PUBLIC_SUBMISSION_ORIGINS = saved.origins
    }
  })

  it('answers HEAD without a body', async () => {
    const r = await api('HEAD', `/api/public/search?${q('x')}`)
    expect(r.status).toBe(200)
    expect(r.text).toBe('')
  })

  it('rate limits per client with 429 and Retry-After', async () => {
    process.env.SEARCH_RATE_LIMIT = '3'
    resetSearchLimiter()
    try {
      const codes: number[] = []
      let last: Awaited<ReturnType<typeof search>> | undefined
      for (let i = 0; i < 5; i++) {
        last = await search(q('limited'))
        codes.push(last.status)
      }
      expect(codes).toEqual([200, 200, 200, 429, 429])
      expect(Number(last!.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(last!.headers.get('cache-control')).toBe('no-store')
    } finally {
      process.env.SEARCH_RATE_LIMIT = '10000'
      resetSearchLimiter()
    }
  })
})

describe('golden queries and reindex', () => {
  it('golden: stemming, phrase, exclusion and OR behave as documented', async () => {
    const k = word('gold')
    const a = await seed({ title: `Elections ${k} results`, content: lexical('Voters queued early for the election.') })
    const b = await seed({ title: `Harvest ${k} festival`, content: lexical('Farmers celebrated the harvest season together.') })
    const c = await seed({ title: `Synod ${k} meeting`, content: lexical('The synod discussed the election of delegates.') })
    // stemming: "election" finds "Elections"
    expect(new Set(ids(await search(q(`${k} election`))))).toEqual(new Set([a.id, c.id]))
    // exclusion
    expect(ids(await search(q(`${k} election -synod`)))).toEqual([a.id])
    // phrase
    expect(ids(await search(q(`"harvest ${k} festival"`)))).toEqual([b.id])
    expect(ids(await search(q(`"${k} harvest festival"`)))).toEqual([])
    // OR
    expect(new Set(ids(await search(q(`harvest or synod ${k}`))))).toEqual(new Set([b.id, c.id]))
    // title outranks a body-only mention of the same word
    const r = await search(q(`${k} election`))
    expect(ids(r)[0]).toBe(a.id)
  })

  it('reindex rebuilds missing rows, drops stale rows, and is idempotent', async () => {
    const t = word('reindex')
    const a = await seed({ title: `Re ${t}`, content: lexical(`body ${t}`) })
    const db = (f.payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<unknown> } }).drizzle
    const { sql } = await import('@payloadcms/db-postgres')
    await db.execute(sql`delete from "article_search" where "article_id" = ${a.id}`)
    expect(ids(await search(q(t)))).toEqual([])
    const first = await reindexArticleSearch(f.payload, { batchSize: 2 })
    expect(first.indexed).toBeGreaterThanOrEqual(1)
    expect(ids(await search(q(t)))).toEqual([a.id])
    // stale: a row for an article that is no longer published
    const d = await f.seedArticle({ status: 'draft', title: `Stale ${t}` })
    await db.execute(sql`insert into "article_search" ("article_id","category_id","published_at","title") values (${d.id}, ${f.catA.id}, now(), ${`Stale ${t}`})`)
    expect(ids(await search(q(`Stale ${t}`)))).not.toContain(d.id) // the endpoint joins on status, so a stale row is already hidden
    const second = await reindexArticleSearch(f.payload, { batchSize: 1000 })
    expect(second.removedStale).toBeGreaterThanOrEqual(1)
    const third = await reindexArticleSearch(f.payload)
    expect(third.removedStale).toBe(0)
    expect(third.indexed).toBe(second.indexed)
    expect(ids(await search(q(t)))).toEqual([a.id])
  })
})
