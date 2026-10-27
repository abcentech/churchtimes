import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * The anonymous article list is given a shared-cache Cache-Control by src/proxy.ts (see tests/unit/publicReadCache.test.ts).
 * That is only safe because collection access gives an anonymous caller published rows and nothing else, whatever the query.
 */
const runId = newRunId()
let f: Fixtures
let pub: { id: number; slug: string }
let drafts: Array<{ id: number; slug: string }> = []

beforeAll(async () => {
  f = await setupFixtures(runId)
  pub = await f.seedArticle({ status: 'published', publishedAt: new Date(Date.now() - 60_000).toISOString() })
  drafts = [
    await f.seedArticle({ status: 'draft' }),
    await f.seedArticle({ status: 'in_review' }),
    await f.seedArticle({ status: 'scheduled', scheduledFor: new Date(Date.now() + 3_600_000).toISOString() }),
  ]
})
afterAll(async () => {
  await f?.cleanup()
})

describe('anonymous article reads never expose unpublished rows', () => {
  const queries = [
    '/api/articles?limit=100&depth=0',
    '/api/articles?limit=100&depth=0&draft=true',
    '/api/articles?limit=100&depth=0&where[status][in]=draft,in_review,scheduled',
    '/api/articles?limit=100&depth=0&where[status][not_equals]=published',
    '/api/articles?limit=100&depth=0&showHiddenFields=true',
  ]
  it.each(queries)('%s', async (url) => {
    const res = await api('GET', url)
    expect(res.status).toBe(200)
    const ids = (res.json.docs as Array<{ id: number; status: string }>).map((d) => d.id)
    for (const d of drafts) expect(ids).not.toContain(d.id)
    for (const d of res.json.docs) expect(d.status).toBe('published')
  })

  it('a forged Cookie or Authorization header does not widen what an anonymous caller reads', async () => {
    for (const headers of [{ cookie: 'payload-token=forged' }, { authorization: 'JWT forged' }] as Array<Record<string, string>>) {
      const res = await api('GET', '/api/articles?limit=100&depth=0&draft=true', { headers })
      const ids = ((res.json?.docs ?? []) as Array<{ id: number }>).map((d) => d.id)
      for (const d of drafts) expect(ids).not.toContain(d.id)
    }
    expect(pub.id).toBeGreaterThan(0)
  })
})
