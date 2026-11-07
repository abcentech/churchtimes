import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Newsroom "Archive review" access rules, against a real database, SYNTHETIC articles only (old-site.test).
 * Only editors (section-editor in scope, editor-in-chief, admin) may set provenance.reviewStatus; every change is audited with
 * the actor and the time; the article stays a draft; the publish guard still applies.
 */
const runId = newRunId()
let f: Fixtures
let n = 0

const provenance = (over: Record<string, unknown> = {}) => ({
  importBatch: `b-${runId}`,
  sourceUrl: `https://old-site.test/${runId}/${++n}/`,
  sourceHost: 'old-site.test',
  sourceSha256: String(n).padStart(64, '0'),
  confidence: 'partial',
  reviewStatus: 'pending',
  ...over,
})
const candidate = (over: Record<string, unknown> = {}) => f.seedArticle({ status: 'draft', provenance: provenance(), ...over })
const stored = async (id: number) =>
  (await f.payload.findByID({ collection: 'articles', id, depth: 0, overrideAccess: true })) as unknown as Record<string, any>
const reviewRows = async (id: number) =>
  (
    await f.payload.find({
      collection: 'audit-logs',
      where: { and: [{ action: { equals: 'archive.review' } }, { docId: { equals: String(id) } }] },
      sort: 'createdAt',
      limit: 20,
      depth: 0,
      overrideAccess: true,
    })
  ).docs as unknown as Array<Record<string, any>>
const setReview = (token: string | undefined, id: number, reviewStatus: string) =>
  api('PATCH', `/api/articles/${id}`, { token, body: { provenance: { reviewStatus } } })

beforeAll(async () => {
  f = await setupFixtures(runId)
})
afterAll(async () => {
  await f?.cleanup()
})

describe('who may set provenance.reviewStatus', () => {
  it('refuses anonymous callers, reporters and trusted publishers; nothing changes and nothing is audited', async () => {
    const a = await candidate()
    for (const token of [undefined, f.tokens.reporter, f.tokens.reporter2, f.tokens.trusted]) {
      const res = await setReview(token, a.id, 'reviewed')
      expect([401, 403, 404]).toContain(res.status)
    }
    expect((await stored(a.id)).provenance.reviewStatus).toBe('pending')
    expect(await reviewRows(a.id)).toHaveLength(0)
  })

  it('a reporter cannot set it even on their own recovered draft (field access ignores or refuses the write)', async () => {
    const own = await candidate({ author: f.users.reporter.id })
    await setReview(f.tokens.reporter, own.id, 'reviewed')
    expect((await stored(own.id)).provenance.reviewStatus).toBe('pending')
    expect(await reviewRows(own.id)).toHaveLength(0)
  })

  it('a section editor may review in their section only', async () => {
    const outside = await candidate({ category: f.catB.id })
    const denied = await setReview(f.tokens.sectionEditor, outside.id, 'reviewed')
    expect([401, 403, 404]).toContain(denied.status)
    expect((await stored(outside.id)).provenance.reviewStatus).toBe('pending')

    const inside = await candidate()
    expect((await setReview(f.tokens.sectionEditor, inside.id, 'reviewed')).status).toBe(200)
    expect((await stored(inside.id)).provenance.reviewStatus).toBe('reviewed')
  })

  it('an editor-in-chief and an admin may approve and reject', async () => {
    const a = await candidate()
    expect((await setReview(f.tokens.eic, a.id, 'reviewed')).status).toBe(200)
    expect((await setReview(f.tokens.admin, a.id, 'rejected')).status).toBe(200)
    expect((await stored(a.id)).provenance.reviewStatus).toBe('rejected')
  })
})

describe('audit entry', () => {
  it('records who and when for every review decision, with the old and new status', async () => {
    const a = await candidate()
    const t0 = Date.now()
    expect((await setReview(f.tokens.eic, a.id, 'reviewed')).status).toBe(200)
    expect((await setReview(f.tokens.sectionEditor, a.id, 'rejected')).status).toBe(200)
    const rows = await reviewRows(a.id)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ collection: 'articles', docId: String(a.id), actorIdSnapshot: String(f.users.eic.id), actorRole: 'editor-in-chief' })
    expect(rows[0].details).toEqual({ from: 'pending', to: 'reviewed' })
    expect(rows[1]).toMatchObject({ actorIdSnapshot: String(f.users.sectionEditor.id), actorRole: 'section-editor' })
    expect(rows[1].details).toEqual({ from: 'reviewed', to: 'rejected' })
    expect(Date.parse(rows[0].createdAt)).toBeGreaterThanOrEqual(t0 - 5000)
    // No source address or hash in the audit row.
    expect(JSON.stringify(rows)).not.toContain('old-site.test')
  })

  it('does not audit a write that leaves the review status unchanged', async () => {
    const a = await candidate()
    expect((await setReview(f.tokens.eic, a.id, 'pending')).status).toBe(200)
    expect((await api('PATCH', `/api/articles/${a.id}`, { token: f.tokens.eic, body: { excerpt: 'A synthetic standfirst.' } })).status).toBe(200)
    expect(await reviewRows(a.id)).toHaveLength(0)
  })

  it('is readable by editor-in-chief only, never by a reporter or anonymously', async () => {
    const a = await candidate()
    await setReview(f.tokens.eic, a.id, 'reviewed')
    const q = `/api/audit-logs?where[action][equals]=archive.review&where[docId][equals]=${a.id}`
    expect((await api('GET', q, { token: f.tokens.eic })).json.totalDocs).toBe(1)
    expect([401, 403]).toContain((await api('GET', q)).status)
    expect([401, 403]).toContain((await api('GET', q, { token: f.tokens.reporter })).status)
  })
})

describe('review and the publish guard', () => {
  it('a rejected article stays a draft and still cannot be published', async () => {
    const a = await candidate()
    await setReview(f.tokens.eic, a.id, 'rejected')
    const doc = await stored(a.id)
    expect(doc.status).toBe('draft')
    expect((await api('PATCH', `/api/articles/${a.id}`, { token: f.tokens.eic, body: { status: 'published' } })).status).toBe(409)
  })

  it('an approved article can then follow the normal workflow', async () => {
    const a = await candidate()
    expect((await api('PATCH', `/api/articles/${a.id}`, { token: f.tokens.eic, body: { status: 'published' } })).status).toBe(409)
    await setReview(f.tokens.eic, a.id, 'reviewed')
    expect((await api('PATCH', `/api/articles/${a.id}`, { token: f.tokens.admin, body: { status: 'published' } })).status).toBe(200)
  })

  it('staff can list recovered drafts filtered by confidence, batch and review status; the public cannot', async () => {
    const a = await candidate({ provenance: provenance({ confidence: 'citation-only' }) })
    const q = `/api/articles?depth=0&where[provenance.importBatch][equals]=b-${runId}&where[provenance.confidence][equals]=citation-only&where[provenance.reviewStatus][equals]=pending`
    const staff = await api('GET', q, { token: f.tokens.sectionEditor })
    expect(staff.status).toBe(200)
    expect(staff.json.docs.map((d: { id: number }) => d.id)).toContain(a.id)
    const anon = await api('GET', q)
    expect(anon.json.docs ?? []).toHaveLength(0)
    expect(anon.text).not.toContain('old-site.test')
  })
})
