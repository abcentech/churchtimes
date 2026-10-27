import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resetStaffRelatedLimiter } from '../../src/endpoints/staffRelatedArticles'
import { reindexArticleSearch } from '../../src/lib/articleSearch'
import { api, lexical, newRunId, ORIGIN, setupFixtures, type Fixtures } from './helpers'

const runId = newRunId()
let f: Fixtures
const word = (label: string) => `${runId}${label}`
const NOW = () => new Date(Date.now() - 60_000).toISOString()
const URL_PATH = '/api/staff/related-articles'
const post = (body: unknown, token?: string, headers: Record<string, string> = {}) => api('POST', URL_PATH, { token, body, headers })
const ids = (r: { json: { results: Array<{ id: number }> } }) => r.json.results.map((d) => d.id)
const saved = { rate: process.env.STAFF_RELATED_RATE_LIMIT, site: process.env.PUBLIC_SITE_URL }

beforeAll(async () => {
  process.env.STAFF_RELATED_RATE_LIMIT = '10000'
  process.env.PUBLIC_SITE_URL = 'https://www.example.org'
  f = await setupFixtures(runId)
})
afterAll(async () => {
  if (saved.rate === undefined) delete process.env.STAFF_RELATED_RATE_LIMIT
  else process.env.STAFF_RELATED_RATE_LIMIT = saved.rate
  if (saved.site === undefined) delete process.env.PUBLIC_SITE_URL
  else process.env.PUBLIC_SITE_URL = saved.site
  resetStaffRelatedLimiter()
  await f?.cleanup()
})
beforeEach(() => resetStaffRelatedLimiter())

const seed = (data: Record<string, unknown>) => f.seedArticle({ status: 'published', publishedAt: NOW(), ...data })

describe('POST /api/staff/related-articles', () => {
  it('requires authentication and never serves anonymous callers', async () => {
    const t = word('anon')
    await seed({ title: `Anon ${t}` })
    const r = await post({ text: t })
    expect(r.status).toBe(401)
    expect(r.text).not.toContain(t)
    expect(r.headers.get('cache-control')).toBe('private, no-store')
  })

  it('allows every staff role', async () => {
    const t = word('roles')
    const a = await seed({ title: `Roles ${t}` })
    for (const key of ['reporter', 'trusted', 'sectionEditor', 'eic', 'admin'] as const) {
      const r = await post({ text: t }, f.tokens[key])
      expect(r.status, key).toBe(200)
      expect(ids(r)).toContain(a.id)
    }
  })

  it('returns the documented shape with canonical citations and a plain snippet', async () => {
    const t = word('shape')
    const a = await seed({ title: `Shape ${t}`, excerpt: 'Excerpt', content: lexical(`Body mentions ${t} in <b>markup</b> & more.`) })
    const r = await post({ text: `about ${t}` }, f.tokens.reporter)
    expect(r.status).toBe(200)
    const hit = r.json.results.find((d: { id: number }) => d.id === a.id)
    expect(Object.keys(hit).sort()).toEqual(['canonicalPath', 'canonicalUrl', 'id', 'matchedTerms', 'publishedAt', 'score', 'slug', 'snippet', 'title'])
    expect(hit.canonicalPath).toBe(`/${a.slug}/`)
    expect(hit.canonicalUrl).toMatch(/^https?:\/\/[^/]+\/.+\/$/)
    expect(hit.canonicalUrl.endsWith(hit.canonicalPath)).toBe(true)
    expect(hit.matchedTerms).toContain(t.toLowerCase())
    expect(hit.snippet).not.toMatch(/[<>]/)
    expect(hit.snippet.length).toBeLessThanOrEqual(240)
    expect(hit.score).toBeGreaterThan(0)
    expect(Date.parse(hit.publishedAt)).not.toBeNaN()
  })

  it('returns published articles only (no drafts, review, archived, scheduled or future-dated)', async () => {
    const t = word('pub')
    const published = await seed({ title: `Visible ${t}` })
    const draft = await f.seedArticle({ status: 'draft', title: `Draft ${t}` })
    const review = await f.seedArticle({ status: 'in_review', title: `Review ${t}` })
    const archived = await f.seedArticle({ status: 'archived', title: `Archived ${t}`, publishedAt: NOW() })
    const scheduled = await f.seedArticle({ status: 'scheduled', title: `Scheduled ${t}`, scheduledFor: new Date(Date.now() + 86_400_000).toISOString() })
    const r = await post({ text: t }, f.tokens.admin)
    expect(ids(r)).toEqual([published.id])
    for (const x of [draft, review, archived, scheduled]) expect(ids(r)).not.toContain(x.id)
  })

  it('derives the query from a draft by articleId and excludes the article itself', async () => {
    const t = word('self')
    const own = await seed({ title: `Own ${t}`, content: lexical(`${t} ${t} unique body`) })
    const other = await seed({ title: `Other ${t}`, content: lexical(`${t} elsewhere`) })
    const draft = await f.seedArticle({ status: 'draft', title: `Draft about ${t}`, content: lexical(`${t} draft body`) })
    const viaDraft = await post({ articleId: draft.id }, f.tokens.admin)
    expect(viaDraft.status).toBe(200)
    expect(ids(viaDraft)).toEqual(expect.arrayContaining([own.id, other.id]))
    expect(ids(viaDraft)).not.toContain(draft.id)
    const viaPublished = await post({ articleId: String(own.id) }, f.tokens.admin)
    expect(ids(viaPublished)).toContain(other.id)
    expect(ids(viaPublished)).not.toContain(own.id)
    // text given with articleId: the text drives the query, the article is still excluded
    const both = await post({ articleId: own.id, text: t }, f.tokens.admin)
    expect(ids(both)).not.toContain(own.id)
  })

  it('respects the caller access rules for articleId and rejects bad ids', async () => {
    const t = word('acl')
    const theirs = await f.seedArticle({ status: 'draft', title: `Theirs ${t}`, author: f.users.reporter2.id })
    expect((await post({ articleId: theirs.id }, f.tokens.reporter)).status).toBe(404)
    expect((await post({ articleId: 999999999 }, f.tokens.admin)).status).toBe(404)
    for (const bad of ['abc', -1, 1.5, '1; drop table', {}]) {
      expect((await post({ articleId: bad }, f.tokens.admin)).status).toBe(400)
    }
  })

  it('caps limit at 20 and defaults to 10; rejects non-integer limits', async () => {
    const t = word('lim')
    for (let i = 0; i < 25; i++) await seed({ title: `Item ${i} ${t}` })
    expect((await post({ text: t, limit: 500 }, f.tokens.admin)).json.results).toHaveLength(20)
    expect((await post({ text: t, limit: 3 }, f.tokens.admin)).json.results).toHaveLength(3)
    expect((await post({ text: t }, f.tokens.admin)).json.results).toHaveLength(10)
    for (const bad of [0, -2, 'ten', 2.5]) expect((await post({ text: t, limit: bad }, f.tokens.admin)).status).toBe(400)
  })

  it('treats injection-style text as plain words and never errors', async () => {
    const t = word('inj')
    const a = await seed({ title: `Safe ${t}` })
    const nasty = [
      `${t}'; DROP TABLE article_search; --`,
      `${t} & !x | (y) <-> z :* \\ $$ ${'"'.repeat(5)}`,
      `'${t}' || pg_sleep(5)`,
      '& | ! ( ) <-> :* \u0000 ‮',
    ]
    for (const text of nasty) {
      const r = await post({ text }, f.tokens.admin)
      expect(r.status, text).toBe(200)
    }
    expect(ids(await post({ text: nasty[0] }, f.tokens.admin))).toContain(a.id)
    // the projection survived
    expect(ids(await post({ text: t }, f.tokens.admin))).toContain(a.id)
    // only operators / stopwords: no terms, empty result, still 200
    const empty = await post({ text: 'the and of & | !' }, f.tokens.admin)
    expect(empty.status).toBe(200)
    expect(empty.json.results).toEqual([])
  })

  it('caps very large text at 20k characters and refuses oversized bodies', async () => {
    const t = word('big')
    const a = await seed({ title: `Big ${t}` })
    const early = `${t} `
    const late = `${word('late')} `.repeat(500)
    const r = await post({ text: early + 'filler '.repeat(4000) + late }, f.tokens.admin)
    expect(r.status).toBe(200)
    expect(r.json.truncated).toBe(true)
    expect(ids(r)).toContain(a.id)
    const huge = await post({ text: 'x'.repeat(400 * 1024) }, f.tokens.admin)
    expect(huge.status).toBe(413)
    // multi-byte: 150k characters is under 256 KiB as characters but over it as UTF-8 bytes
    const wide = await post({ text: 'é'.repeat(150 * 1024) }, f.tokens.admin)
    expect(wide.status).toBe(413)
  })

  it('validates the body', async () => {
    expect((await post({}, f.tokens.admin)).status).toBe(400)
    expect((await post({ text: '   ' }, f.tokens.admin)).status).toBe(400)
    expect((await post({ text: 5 }, f.tokens.admin)).status).toBe(400)
    expect((await api('POST', URL_PATH, { token: f.tokens.admin, body: 'not json', headers: { 'content-type': 'application/json' } })).status).toBe(400)
    expect((await api('POST', URL_PATH, { token: f.tokens.admin, body: '[1]', headers: { 'content-type': 'application/json' } })).status).toBe(400)
  })

  it('is rate limited per user', async () => {
    process.env.STAFF_RELATED_RATE_LIMIT = '2'
    resetStaffRelatedLimiter()
    try {
      expect((await post({ text: word('rl') }, f.tokens.reporter)).status).toBe(200)
      expect((await post({ text: word('rl') }, f.tokens.reporter)).status).toBe(200)
      const blocked = await post({ text: word('rl') }, f.tokens.reporter)
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
      expect((await post({ text: word('rl') }, f.tokens.admin)).status).toBe(200)
    } finally {
      process.env.STAFF_RELATED_RATE_LIMIT = '10000'
      resetStaffRelatedLimiter()
    }
  })

  it('is CSRF protected for cookie sessions and sends no-cache headers on every response', async () => {
    const t = word('csrf')
    await seed({ title: `Csrf ${t}` })
    const cookie = { cookie: `payload-token=${f.tokens.admin}` }
    const evil = await post({ text: t }, undefined, { ...cookie, origin: 'https://evil.example' })
    expect(evil.status).toBe(401)
    const good = await post({ text: t }, undefined, { ...cookie, origin: ORIGIN })
    expect(good.status).toBe(200)
    for (const r of [evil, good, await post({ text: t }), await post({ text: t }, f.tokens.admin), await post({}, f.tokens.admin)]) {
      expect(r.headers.get('cache-control')).toBe('private, no-store')
    }
    expect(good.headers.get('set-cookie')).toBeNull()
  })

  it('stays in step with the projection after a reindex and drops unpublished articles', async () => {
    const t = word('sync')
    const a = await seed({ title: `Sync ${t}` })
    expect(ids(await post({ text: t }, f.tokens.admin))).toContain(a.id)
    await f.payload.update({ collection: 'articles', id: a.id, data: { status: 'archived' } as never, overrideAccess: true, context: { seed: true } })
    await reindexArticleSearch(f.payload)
    expect(ids(await post({ text: t }, f.tokens.admin))).not.toContain(a.id)
  })
})
