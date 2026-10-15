import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/** "Approve what you saw" (review finding L2): optional `expectedUpdatedAt` on PATCH of articles and live updates. */
const runId = newRunId()
let f: Fixtures

beforeAll(async () => {
  f = await setupFixtures(runId)
})

afterAll(async () => {
  await f?.cleanup()
})

const STALE = 'This item changed after you opened it. Reload and review it again.'

const getArticle = async (id: number) => (await api('GET', `/api/articles/${id}?depth=0`, { token: f.tokens.eic })).json
const patchArticle = (id: number, body: Record<string, unknown>, token = f.tokens.eic) =>
  api('PATCH', `/api/articles/${id}`, { token, body })
const statusChangeLogs = async (id: number) =>
  (
    await f.payload.find({
      collection: 'audit-logs',
      where: { and: [{ collection: { equals: 'articles' } }, { docId: { equals: String(id) } }, { action: { equals: 'status-change' } }] },
      overrideAccess: true,
      depth: 0,
    })
  ).totalDocs

/** A reporter's article that is waiting in the review queue. */
async function inReview(): Promise<number> {
  const art = await f.createArticle(f.tokens.reporter, { status: 'in_review' })
  expect(art.status).toBe(201)
  return art.id!
}

describe('expectedUpdatedAt: articles', () => {
  it('approves when it matches the version the editor saw, and never stores or echoes the field', async () => {
    const id = await inReview()
    const seen = (await getArticle(id)).updatedAt as string
    const res = await patchArticle(id, { status: 'approved', expectedUpdatedAt: seen })
    expect(res.status).toBe(200)
    expect(res.json.doc.status).toBe('approved')
    expect(res.json.doc).not.toHaveProperty('expectedUpdatedAt')
    expect(await getArticle(id)).not.toHaveProperty('expectedUpdatedAt')
    // The version that came back is the new current one: chaining the next action with it works.
    const next = await patchArticle(id, { status: 'published', expectedUpdatedAt: res.json.doc.updatedAt })
    expect(next.status).toBe(200)
    expect(next.json.doc.status).toBe('published')
  })

  it('rejects approve / publish / request-changes of a stale version with 409 and changes nothing', async () => {
    for (const body of [
      { status: 'approved' },
      { status: 'published' },
      { status: 'changes_requested', reviewNotes: `${runId} notes that must not be stored` },
    ]) {
      const id = await inReview()
      const seen = (await getArticle(id)).updatedAt as string
      // Someone else edits the story after the editor opened it.
      expect((await patchArticle(id, { title: `${runId} edited by someone else ${body.status}` })).status).toBe(200)
      const before = await getArticle(id)
      expect(before.updatedAt).not.toBe(seen)
      const logs = await statusChangeLogs(id)

      const res = await patchArticle(id, { ...body, expectedUpdatedAt: seen })
      expect(res.status).toBe(409)
      expect(res.json.errors[0].message).toBe(STALE)

      const after = await getArticle(id)
      expect(after.status).toBe('in_review')
      expect(after.updatedAt).toBe(before.updatedAt)
      expect(after.reviewNotes ?? null).toBe(before.reviewNotes ?? null)
      expect(after.publishedAt ?? null).toBeNull()
      expect(await statusChangeLogs(id)).toBe(logs)

      // Reloading and acting on the new version works.
      const retry = await patchArticle(id, { ...body, expectedUpdatedAt: before.updatedAt })
      expect(retry.status).toBe(200)
      expect(retry.json.doc.status).toBe(body.status)
    }
  })

  it('keeps API clients working: no expectedUpdatedAt means no check', async () => {
    const id = await inReview()
    expect((await patchArticle(id, { title: `${runId} touched` })).status).toBe(200)
    const res = await patchArticle(id, { status: 'approved' })
    expect(res.status).toBe(200)
    const explicitNull = await patchArticle(id, { status: 'published', expectedUpdatedAt: null })
    expect(explicitNull.status).toBe(200)
  })

  it('compares instants, not strings, and refuses malformed values with 400', async () => {
    const id = await inReview()
    const seen = (await getArticle(id)).updatedAt as string
    expect((await patchArticle(id, { status: 'approved', expectedUpdatedAt: 'yesterday' })).status).toBe(400)
    expect((await patchArticle(id, { status: 'approved', expectedUpdatedAt: 12345 })).status).toBe(400)
    expect((await getArticle(id)).status).toBe('in_review')
    // Same instant written with an explicit offset.
    const offset = new Date(Date.parse(seen)).toISOString().replace('Z', '+00:00')
    expect((await patchArticle(id, { status: 'approved', expectedUpdatedAt: offset })).status).toBe(200)
  })

  it('does not let a permission failure turn into a stale-version oracle', async () => {
    const id = await inReview()
    const seen = (await getArticle(id)).updatedAt as string
    // reporter2 cannot update the article at all (not the author): 403/404 from access, whatever expectedUpdatedAt says.
    const res = await patchArticle(id, { status: 'approved', expectedUpdatedAt: seen }, f.tokens.reporter2)
    expect([403, 404]).toContain(res.status)
  })

  it('serialises two editors acting on the same version: exactly one wins, the other gets 409', async () => {
    const id = await inReview()
    const seen = (await getArticle(id)).updatedAt as string
    const [a, b] = await Promise.all([
      patchArticle(id, { status: 'approved', expectedUpdatedAt: seen }, f.tokens.eic),
      patchArticle(id, { status: 'changes_requested', reviewNotes: `${runId} race`, expectedUpdatedAt: seen }, f.tokens.admin),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const final = await getArticle(id)
    expect(final.status).toBe(a.status === 200 ? 'approved' : 'changes_requested')
  })
})

describe('expectedUpdatedAt: live updates', () => {
  async function event() {
    const res = await api('POST', '/api/live-events', {
      token: f.tokens.eic,
      body: { title: `${runId} ev`, slug: `${runId}-ev-${Math.random().toString(36).slice(2, 7)}`, category: f.catA.id, status: 'live' },
    })
    expect(res.status).toBe(201)
    return res.json.doc.id as number
  }
  const pendingUpdate = async (ev: number, text = 'Pending update') => {
    const res = await api('POST', '/api/live-updates', { token: f.tokens.reporter, body: { event: ev, body: `${text} ${runId}` } })
    expect(res.status).toBe(201)
    return res.json.doc as { id: number; updatedAt: string }
  }
  const getUpdate = async (id: number) => (await api('GET', `/api/live-updates/${id}?depth=0`, { token: f.tokens.eic })).json
  const patchUpdate = (id: number, body: Record<string, unknown>) =>
    api('PATCH', `/api/live-updates/${id}`, { token: f.tokens.eic, body })

  it('approves a matching version, and rejects a stale one without publishing anything', async () => {
    const ev = await event()
    const ok = await pendingUpdate(ev)
    const approved = await patchUpdate(ok.id, { status: 'approved', expectedUpdatedAt: ok.updatedAt })
    expect(approved.status).toBe(200)
    expect(approved.json.doc.status).toBe('approved')
    expect(approved.json.doc).not.toHaveProperty('expectedUpdatedAt')

    const stale = await pendingUpdate(ev, 'Will be corrected')
    // The text is corrected after the editor opened it.
    expect((await patchUpdate(stale.id, { body: `Corrected ${runId}` })).status).toBe(200)
    const before = await getUpdate(stale.id)
    const logs = await f.payload.count({
      collection: 'audit-logs',
      where: { and: [{ collection: { equals: 'live-updates' } }, { docId: { equals: String(stale.id) } }] },
      overrideAccess: true,
    })

    const res = await patchUpdate(stale.id, { status: 'approved', expectedUpdatedAt: stale.updatedAt })
    expect(res.status).toBe(409)
    expect(res.json.errors[0].message).toBe(STALE)
    const after = await getUpdate(stale.id)
    expect(after.status).toBe('pending')
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(after.publishSequence ?? null).toBeNull()
    expect(after.approvedAt ?? null).toBeNull()
    expect(
      (
        await f.payload.count({
          collection: 'audit-logs',
          where: { and: [{ collection: { equals: 'live-updates' } }, { docId: { equals: String(stale.id) } }] },
          overrideAccess: true,
        })
      ).totalDocs,
    ).toBe(logs.totalDocs)
    // Not on the public feed.
    expect((await api('GET', `/api/live-updates/${stale.id}`)).status).not.toBe(200)

    // Reject of a stale version is refused the same way; the reloaded version can be approved.
    expect((await patchUpdate(stale.id, { status: 'rejected', expectedUpdatedAt: stale.updatedAt })).status).toBe(409)
    expect((await patchUpdate(stale.id, { status: 'approved', expectedUpdatedAt: before.updatedAt })).status).toBe(200)
  })

  it('keeps API clients working without expectedUpdatedAt', async () => {
    const ev = await event()
    const u = await pendingUpdate(ev)
    expect((await patchUpdate(u.id, { body: `Edited ${runId}` })).status).toBe(200)
    expect((await patchUpdate(u.id, { status: 'approved' })).status).toBe(200)
  })
})
