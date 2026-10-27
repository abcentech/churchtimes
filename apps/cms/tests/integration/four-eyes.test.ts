import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { publishDueArticles } from '../../src/lib/scheduler'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Four-eyes rule for recovered archive articles (SYNTHETIC data only): whoever approves one (provenance.reviewStatus ->
 * reviewed) must not be the person who publishes or schedules it, except admins, who may do both. `provenance.reviewedBy` and
 * `reviewedAt` are server-set and never client-writable.
 */
const runId = newRunId()
let f: Fixtures
let n = 0

const MSG = 'A different editor must publish a recovered article you approved'
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
const approve = (token: string, id: number) => patch(token, id, { provenance: { reviewStatus: 'reviewed' } })
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()

beforeAll(async () => {
  f = await setupFixtures(runId)
})
afterAll(async () => {
  await f?.cleanup()
})

describe('server-set review stamp', () => {
  it('records the approver and time when reviewStatus becomes reviewed, and clears them when it changes away', async () => {
    const a = await candidate()
    const t0 = Date.now()
    expect((await approve(f.tokens.sectionEditor, a.id)).status).toBe(200)
    const doc = await stored(a.id)
    expect(doc.provenance.reviewedBy).toBe(f.users.sectionEditor.id)
    expect(Date.parse(doc.provenance.reviewedAt)).toBeGreaterThanOrEqual(t0 - 5000)
    // unrelated edits keep the stamp
    expect((await patch(f.tokens.eic, a.id, { excerpt: 'A synthetic standfirst.' })).status).toBe(200)
    expect((await stored(a.id)).provenance.reviewedBy).toBe(f.users.sectionEditor.id)
    // a reset clears it; a later approval by someone else takes over
    expect((await patch(f.tokens.eic, a.id, { provenance: { reviewStatus: 'pending' } })).status).toBe(200)
    const cleared = await stored(a.id)
    expect(cleared.provenance.reviewedBy ?? null).toBeNull()
    expect(cleared.provenance.reviewedAt ?? null).toBeNull()
    expect((await approve(f.tokens.eic, a.id)).status).toBe(200)
    expect((await stored(a.id)).provenance.reviewedBy).toBe(f.users.eic.id)
    expect((await patch(f.tokens.eic, a.id, { provenance: { reviewStatus: 'rejected' } })).status).toBe(200)
    expect((await stored(a.id)).provenance.reviewedBy ?? null).toBeNull()
  })

  it('clients cannot set or forge reviewedBy / reviewedAt', async () => {
    const a = await candidate()
    const forged = await patch(f.tokens.sectionEditor, a.id, {
      provenance: { reviewStatus: 'reviewed', reviewedBy: f.users.admin.id, reviewedAt: '2001-01-01T00:00:00.000Z' },
    })
    expect(forged.status).toBeLessThan(500)
    const doc = await stored(a.id)
    if (doc.provenance.reviewStatus === 'reviewed') {
      expect(doc.provenance.reviewedBy).toBe(f.users.sectionEditor.id)
      expect(doc.provenance.reviewedAt).not.toContain('2001')
    }
    // forging without changing the status does nothing
    const b = await candidate()
    await patch(f.tokens.eic, b.id, { provenance: { reviewedBy: f.users.admin.id, reviewedAt: '2001-01-01T00:00:00.000Z' } })
    const after = await stored(b.id)
    expect(after.provenance.reviewedBy ?? null).toBeNull()
    expect(after.provenance.reviewedAt ?? null).toBeNull()
    // and a forged value cannot make the approver look like someone else
    await patch(f.tokens.eic, b.id, { provenance: { reviewStatus: 'reviewed', reviewedBy: f.users.sectionEditor.id } })
    expect((await patch(f.tokens.eic, b.id, { status: 'published' })).status).toBe(409)
  })

  it('a reporter cannot set it', async () => {
    const a = await candidate({ author: f.users.reporter.id })
    await patch(f.tokens.reporter, a.id, { provenance: { reviewedBy: f.users.reporter.id } })
    expect((await stored(a.id)).provenance.reviewedBy ?? null).toBeNull()
  })

  it('is never in an anonymous response, nor visible to a reporter; staff see it', async () => {
    const a = await candidate({ author: f.users.reporter.id })
    await approve(f.tokens.eic, a.id)
    await patch(f.tokens.admin, a.id, { status: 'published' })
    const anon = await api('GET', `/api/articles/${a.id}?depth=2`)
    expect(anon.status).toBe(200)
    expect(JSON.stringify(anon.json)).not.toMatch(/reviewedBy|reviewedAt/)
    const asReporter = await api('GET', `/api/articles/${a.id}?depth=0`, { token: f.tokens.reporter })
    expect(JSON.stringify(asReporter.json)).not.toMatch(/reviewedBy/)
    const staff = await api('GET', `/api/articles/${a.id}?depth=0`, { token: f.tokens.sectionEditor })
    expect(staff.json.provenance.reviewedBy).toBe(f.users.eic.id)
  })
})

describe('the approver cannot publish or schedule', () => {
  it('refuses publishing by the approver (409, nothing changes); a different editor can', async () => {
    const a = await candidate()
    expect((await approve(f.tokens.eic, a.id)).status).toBe(200)
    const res = await patch(f.tokens.eic, a.id, { status: 'published' })
    expect(res.status).toBe(409)
    expect(JSON.stringify(res.json)).toContain(MSG)
    expect((await stored(a.id)).status).toBe('draft')
    expect((await patch(f.tokens.sectionEditor, a.id, { status: 'published' })).status).toBe(200)
    expect((await stored(a.id)).status).toBe('published')
  })

  it('refuses scheduling by the approver; a different editor can schedule', async () => {
    const a = await candidate()
    await approve(f.tokens.sectionEditor, a.id)
    const res = await patch(f.tokens.sectionEditor, a.id, { status: 'scheduled', scheduledFor: inAnHour() })
    expect(res.status).toBe(409)
    expect((await stored(a.id)).status).toBe('draft')
    expect((await patch(f.tokens.eic, a.id, { status: 'scheduled', scheduledFor: inAnHour() })).status).toBe(200)
    // the approver cannot move the schedule of an already-scheduled article either
    const later = new Date(Date.now() + 7_200_000).toISOString()
    expect((await patch(f.tokens.sectionEditor, a.id, { scheduledFor: later })).status).toBe(409)
  })

  it('admins may approve and publish (both, also in one request)', async () => {
    const a = await candidate()
    expect((await approve(f.tokens.admin, a.id)).status).toBe(200)
    expect((await patch(f.tokens.admin, a.id, { status: 'published' })).status).toBe(200)
    const b = await candidate()
    expect((await patch(f.tokens.admin, b.id, { status: 'scheduled', scheduledFor: inAnHour(), provenance: { reviewStatus: 'reviewed' } })).status).toBe(200)
    expect((await stored(b.id)).provenance.reviewedBy).toBe(f.users.admin.id)
  })

  it('does not block other edits by the approver on a published article, nor ordinary articles', async () => {
    const a = await candidate()
    await approve(f.tokens.sectionEditor, a.id)
    await patch(f.tokens.eic, a.id, { status: 'published' })
    const edit = await patch(f.tokens.sectionEditor, a.id, { corrections: [{ note: 'Fixed a typo.' }] })
    expect(edit.status).not.toBe(409)
    const plain = await f.seedArticle({ status: 'draft' })
    expect((await patch(f.tokens.eic, plain.id, { status: 'published' })).status).toBe(200)
  })

  it('applies to a bulk PATCH, per article', async () => {
    const mine = await candidate()
    const theirs = await candidate()
    await approve(f.tokens.eic, mine.id)
    await approve(f.tokens.sectionEditor, theirs.id)
    const res = await api('PATCH', `/api/articles?where[id][in]=${mine.id},${theirs.id}`, { token: f.tokens.eic, body: { status: 'published' } })
    expect(res.status).toBeLessThan(500)
    expect((await stored(mine.id)).status).toBe('draft')
    expect((await stored(theirs.id)).status).toBe('published')
  })

  it('applies to the Local API with a user, but not to server code without one', async () => {
    const a = await candidate()
    await approve(f.tokens.eic, a.id)
    const user = { ...(await f.payload.findByID({ collection: 'users', id: f.users.eic.id, overrideAccess: true })), collection: 'users' } as never
    await expect(
      f.payload.update({ collection: 'articles', id: a.id, data: { status: 'published' } as never, user, overrideAccess: false }),
    ).rejects.toThrow(/different editor/)
    expect((await stored(a.id)).status).toBe('draft')
    await f.payload.update({ collection: 'articles', id: a.id, data: { status: 'published' } as never, overrideAccess: true, context: { seed: true } })
    expect((await stored(a.id)).status).toBe('published')
  })

  it('the scheduler publishes what a different editor scheduled (no actor rule at publish time)', async () => {
    const a = await candidate()
    await approve(f.tokens.sectionEditor, a.id)
    const when = new Date(Date.now() + 3_600_000)
    expect((await patch(f.tokens.eic, a.id, { status: 'scheduled', scheduledFor: when.toISOString() })).status).toBe(200)
    await publishDueArticles(f.payload, new Date(when.getTime() + 60_000))
    const after = await stored(a.id)
    expect(after.status).toBe('published')
    expect(after.provenance.reviewedBy).toBe(f.users.sectionEditor.id)
  })

  it('a version restore by the approver cannot republish; and keeps the stored approver', async () => {
    const a = await candidate()
    await approve(f.tokens.eic, a.id)
    expect((await patch(f.tokens.admin, a.id, { status: 'published' })).status).toBe(200)
    const versions = await f.payload.findVersions({ collection: 'articles', where: { parent: { equals: a.id } }, sort: '-createdAt', limit: 10, overrideAccess: true })
    const publishedVersion = versions.docs.find((v) => (v.version as any).status === 'published')
    expect(publishedVersion).toBeTruthy()
    expect((await patch(f.tokens.admin, a.id, { status: 'archived' })).status).toBe(200)
    const denied = await api('POST', `/api/articles/versions/${publishedVersion!.id}`, { token: f.tokens.eic })
    expect(denied.status).toBe(409)
    expect((await stored(a.id)).status).toBe('archived')
    const ok = await api('POST', `/api/articles/versions/${publishedVersion!.id}`, { token: f.tokens.admin })
    expect(ok.status).toBeLessThan(300)
    const after = await stored(a.id)
    expect(after.status).toBe('published')
    expect(after.provenance.reviewedBy).toBe(f.users.eic.id)
  })
})
