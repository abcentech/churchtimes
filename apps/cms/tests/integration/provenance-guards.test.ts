import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { publishDueArticles } from '../../src/lib/scheduler'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Review follow-ups for recovered archive articles (SYNTHETIC data only): approving and publishing are separate requests,
 * `provenance: null` is not a 500, a scheduled article that lost its approval is not published by the scheduler, and a
 * restored version cannot republish a rejected recovered article.
 */
const runId = newRunId()
let f: Fixtures
let n = 0

const provenance = (over: Record<string, unknown> = {}) => ({
  importBatch: `b-${runId}`,
  sourceUrl: `https://old-site.test/${runId}/${++n}/`,
  sourceHost: 'old-site.test',
  sourceSha256: `${runId}${String(n).padStart(8, '0')}`.padEnd(64, '0'),
  confidence: 'partial',
  reviewStatus: 'pending',
  ...over,
})
const candidate = (over: Record<string, unknown> = {}) => f.seedArticle({ status: 'draft', provenance: provenance(), ...over })
const stored = async (id: number) =>
  (await f.payload.findByID({ collection: 'articles', id, depth: 0, overrideAccess: true })) as unknown as Record<string, any>
const patch = (token: string | undefined, id: number, body: Record<string, unknown>) => api('PATCH', `/api/articles/${id}`, { token, body })
const reviewRows = async (id: number) =>
  (
    await f.payload.find({
      collection: 'audit-logs',
      where: { and: [{ action: { equals: 'archive.review' } }, { docId: { equals: String(id) } }] },
      limit: 20,
      depth: 0,
      overrideAccess: true,
    })
  ).docs as unknown as Array<Record<string, any>>

beforeAll(async () => {
  f = await setupFixtures(runId)
})
afterAll(async () => {
  await f?.cleanup()
})

describe('approve and publish are separate requests', () => {
  it('refuses a non-admin who reviews and publishes in one PATCH; nothing changes', async () => {
    const a = await candidate()
    const both = await patch(f.tokens.eic, a.id, { status: 'published', provenance: { reviewStatus: 'reviewed' } })
    expect(both.status).toBe(409)
    const after = await stored(a.id)
    expect(after.status).toBe('draft')
    expect(after.provenance.reviewStatus).toBe('pending')
    expect(await reviewRows(a.id)).toHaveLength(0)
    // same for scheduling
    const sched = await patch(f.tokens.eic, a.id, {
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      provenance: { reviewStatus: 'reviewed' },
    })
    expect(sched.status).toBe(409)
  })

  it('two requests work, and the approval is audited before the publish', async () => {
    const a = await candidate()
    expect((await patch(f.tokens.eic, a.id, { provenance: { reviewStatus: 'reviewed' } })).status).toBe(200)
    expect(await reviewRows(a.id)).toHaveLength(1)
    expect((await patch(f.tokens.eic, a.id, { status: 'published' })).status).toBe(200)
    expect((await stored(a.id)).status).toBe('published')
  })

  it('an admin may do both in one request (and it is still audited)', async () => {
    const a = await candidate()
    const both = await patch(f.tokens.admin, a.id, { status: 'published', provenance: { reviewStatus: 'reviewed' } })
    expect(both.status).toBe(200)
    expect((await stored(a.id)).status).toBe('published')
    expect(await reviewRows(a.id)).toHaveLength(1)
  })

  it('a reviewStatus change writes an archive.review audit row with from/to and the actor', async () => {
    const a = await candidate()
    await patch(f.tokens.eic, a.id, { provenance: { reviewStatus: 'rejected' } })
    const rows = await reviewRows(a.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.details).toMatchObject({ from: 'pending', to: 'rejected' })
    expect(rows[0]!.actor ?? rows[0]!.actorIdSnapshot).toBeTruthy()
  })
})

describe('one-PATCH rule: edge cases', () => {
  it('a client cannot clear the import batch to dodge the rule or the publish guard', async () => {
    const a = await candidate()
    const res = await patch(f.tokens.eic, a.id, { status: 'published', provenance: { importBatch: '' } })
    expect(res.status).toBe(409)
    const after = await stored(a.id)
    expect(after.status).toBe('draft')
    expect(after.provenance.importBatch).toBe(`b-${runId}`)
    const both = await patch(f.tokens.eic, a.id, { status: 'published', provenance: { importBatch: '', reviewStatus: 'reviewed' } })
    expect(both.status).toBe(409)
    expect((await stored(a.id)).status).toBe('draft')
  })

  it('a bulk PATCH (where) cannot review and publish in one request for a non-admin', async () => {
    const a = await candidate()
    const b = await candidate()
    const res = await api('PATCH', `/api/articles?where[id][in]=${a.id},${b.id}`, {
      token: f.tokens.eic,
      body: { status: 'published', provenance: { reviewStatus: 'reviewed' } },
    })
    expect(res.status).toBeLessThan(500)
    for (const id of [a.id, b.id]) {
      const after = await stored(id)
      expect(after.status, `article ${id}`).toBe('draft')
      expect(after.provenance.reviewStatus).toBe('pending')
    }
  })

  it('a review status is refused on an ordinary article (no import batch) and writes no audit row', async () => {
    const plain = await f.seedArticle({ status: 'draft' })
    const res = await patch(f.tokens.eic, plain.id, { provenance: { reviewStatus: 'reviewed' } })
    expect(res.status).toBe(400)
    expect((await stored(plain.id)).provenance?.reviewStatus ?? null).toBeNull()
    expect(await reviewRows(plain.id)).toHaveLength(0)
  })

  it('an article created already reviewed is audited at creation (no seed context)', async () => {
    const doc = (await f.payload.create({
      collection: 'articles',
      data: {
        title: `${runId} created reviewed`,
        slug: `${runId}-created-reviewed`,
        content: (await import('./helpers')).lexical(),
        category: f.catA.id,
        status: 'draft',
        provenance: provenance({ reviewStatus: 'reviewed' }),
      } as never,
      overrideAccess: true,
      context: { import: true },
    })) as { id: number }
    f.created.articles.push(doc.id)
    const rows = await reviewRows(doc.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.details).toMatchObject({ from: null, to: 'reviewed' })
  })
})

describe('provenance: null', () => {
  it('a PATCH with provenance null is ignored (not a 500) and keeps the stored provenance', async () => {
    const a = await candidate()
    const res = await patch(f.tokens.eic, a.id, { provenance: null, excerpt: 'kept' })
    expect([200, 400]).toContain(res.status)
    expect(res.status).not.toBe(500)
    const after = await stored(a.id)
    expect(after.provenance.importBatch).toBe(`b-${runId}`)
    expect(after.provenance.reviewStatus).toBe('pending')
    const plain = await f.seedArticle({ status: 'draft' })
    expect((await patch(f.tokens.eic, plain.id, { provenance: null })).status).not.toBe(500)
  })
})

describe('server-side paths stay bound by the review', () => {
  it('the scheduler does not publish a scheduled recovered article whose approval was withdrawn', async () => {
    const a = await candidate()
    await patch(f.tokens.eic, a.id, { provenance: { reviewStatus: 'reviewed' } })
    const when = new Date(Date.now() + 3_600_000)
    expect((await patch(f.tokens.eic, a.id, { status: 'scheduled', scheduledFor: when.toISOString() })).status).toBe(200)
    // The approval cannot be withdrawn through the API while the article is scheduled (the guard refuses the inconsistent state)...
    const withdraw = await patch(f.tokens.eic, a.id, { provenance: { reviewStatus: 'pending' } })
    expect(withdraw.status).toBe(409)
    // ...so simulate the damage directly in the database (a restore from backup, a manual fix) and let the scheduler run.
    const db = (f.payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<unknown> } }).drizzle
    const { sql } = await import('@payloadcms/db-postgres')
    await db.execute(sql`update "articles" set "provenance_review_status" = 'pending' where "id" = ${a.id}`)
    await publishDueArticles(f.payload, new Date(when.getTime() + 60_000))
    const after = await stored(a.id)
    expect(after.status).toBe('scheduled')
    expect(after.publishedAt ?? null).toBeNull()
  })

  it('restoring a version that would republish a rejected recovered article is refused', async () => {
    const a = await candidate()
    await patch(f.tokens.eic, a.id, { provenance: { reviewStatus: 'reviewed' } })
    expect((await patch(f.tokens.eic, a.id, { status: 'published' })).status).toBe(200)
    // Find the version that is published and reviewed, then reject the article and take it down.
    const versions = await f.payload.findVersions({ collection: 'articles', where: { parent: { equals: a.id } }, sort: '-createdAt', limit: 10, overrideAccess: true })
    const publishedVersion = versions.docs.find((v) => (v.version as any).status === 'published')
    expect(publishedVersion).toBeTruthy()
    expect((await patch(f.tokens.eic, a.id, { status: 'archived' })).status).toBe(200)
    expect((await patch(f.tokens.eic, a.id, { provenance: { reviewStatus: 'rejected' } })).status).toBe(200)
    const res = await api('POST', `/api/articles/versions/${publishedVersion!.id}`, { token: f.tokens.eic })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    const after = await stored(a.id)
    expect(after.status).not.toBe('published')
    expect(after.provenance.reviewStatus).toBe('rejected')
  })
})
