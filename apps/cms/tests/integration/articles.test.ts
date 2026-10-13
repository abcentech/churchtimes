import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { publishDueArticles } from '../../src/lib/scheduler'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

const runId = newRunId()
let f: Fixtures

beforeAll(async () => {
  f = await setupFixtures(runId)
})

afterAll(async () => {
  await f?.cleanup()
})

const patch = (token: string, id: number, body: Record<string, unknown>) =>
  api('PATCH', `/api/articles/${id}`, { token, body })

describe('anonymous article reads', () => {
  it('returns only published articles, clamps limit, and hides staff-only fields', async () => {
    const published = await f.seedArticle({
      status: 'published',
      publishedAt: new Date().toISOString(),
      author: f.users.reporter.id,
      reviewNotes: 'internal secret note',
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
    })
    const draft = await f.seedArticle({ status: 'draft' })
    const review = await f.seedArticle({ status: 'in_review' })

    // Explicitly asking for drafts must not leak them.
    const asked = await api('GET', '/api/articles?where[status][equals]=draft&limit=100')
    expect(asked.status).toBe(200)
    expect(asked.json.docs.every((d: { status: string }) => d.status === 'published')).toBe(true)
    expect(asked.json.docs.some((d: { id: number }) => d.id === draft.id)).toBe(false)

    // No filter.
    const all = await api('GET', '/api/articles?limit=100&depth=0')
    const ids = all.json.docs.map((d: { id: number }) => d.id)
    expect(ids).toContain(published.id)
    expect(ids).not.toContain(draft.id)
    expect(ids).not.toContain(review.id)

    // limit=1000 and limit=0 are clamped to at most 100.
    for (const limit of ['1000', '0']) {
      const big = await api('GET', `/api/articles?limit=${limit}&depth=0`)
      expect(big.status).toBe(200)
      expect(big.json.limit).toBeLessThanOrEqual(100)
      expect(big.json.docs.length).toBeLessThanOrEqual(100)
    }

    // Staff-only fields are stripped for every returned doc, and on direct reads.
    const one = await api('GET', `/api/articles?where[slug][equals]=${published.slug}&depth=0`)
    expect(one.json.docs).toHaveLength(1)
    for (const doc of [...all.json.docs, ...one.json.docs]) {
      expect(doc).not.toHaveProperty('author')
      expect(doc).not.toHaveProperty('reviewNotes')
      expect(doc).not.toHaveProperty('scheduledFor')
    }
    const byId = await api('GET', `/api/articles/${published.id}`)
    expect(byId.status).toBe(200)
    expect(byId.json).not.toHaveProperty('reviewNotes')
    expect((await api('GET', `/api/articles/${draft.id}`)).status).toBe(404)
  })
})

describe('reporter', () => {
  it('can create a draft', async () => {
    const res = await f.createArticle(f.tokens.reporter)
    expect(res.status).toBe(201)
    expect(res.json.doc.status).toBe('draft')
  })

  it('has author forced to self even if another author is supplied', async () => {
    const res = await f.createArticle(f.tokens.reporter, { author: f.users.reporter2.id })
    expect(res.status).toBe(201)
    expect(res.json.doc.author?.id ?? res.json.doc.author).toBe(f.users.reporter.id)
  })

  it('cannot set publishedAt', async () => {
    const res = await f.createArticle(f.tokens.reporter, { publishedAt: '2020-01-01T00:00:00.000Z' })
    expect(res.status).toBe(201)
    expect(res.json.doc.publishedAt ?? null).toBeNull()
    const upd = await patch(f.tokens.reporter, res.id!, { publishedAt: '2020-01-01T00:00:00.000Z' })
    expect(upd.json?.doc?.publishedAt ?? null).toBeNull()
  })

  it('can move draft to in_review', async () => {
    const res = await f.createArticle(f.tokens.reporter)
    const upd = await patch(f.tokens.reporter, res.id!, { status: 'in_review' })
    expect(upd.status).toBe(200)
    expect(upd.json.doc.status).toBe('in_review')
  })

  it('cannot approve (in_review to approved is 403)', async () => {
    const res = await f.createArticle(f.tokens.reporter, { status: 'in_review' })
    expect(res.status).toBe(201)
    const upd = await patch(f.tokens.reporter, res.id!, { status: 'approved' })
    expect(upd.status).toBe(403)
  })

  it('cannot publish (403), from draft or in_review, on create or update', async () => {
    const draft = await f.createArticle(f.tokens.reporter)
    expect((await patch(f.tokens.reporter, draft.id!, { status: 'published' })).status).toBe(403)
    const review = await f.createArticle(f.tokens.reporter, { status: 'in_review' })
    expect((await patch(f.tokens.reporter, review.id!, { status: 'published' })).status).toBe(403)
    const direct = await f.createArticle(f.tokens.reporter, { status: 'published' })
    expect(direct.status).toBe(403)
  })

  it('cannot edit an article while it is in_review', async () => {
    const res = await f.createArticle(f.tokens.reporter, { status: 'in_review' })
    const upd = await patch(f.tokens.reporter, res.id!, { title: 'Sneaky retitle' })
    expect(upd.status).toBe(403)
    const doc = await f.payload.findByID({ collection: 'articles', id: res.id!, depth: 0 })
    expect(doc.title).not.toBe('Sneaky retitle')
  })

  it("cannot see another reporter's drafts", async () => {
    const res = await f.createArticle(f.tokens.reporter)
    expect((await api('GET', `/api/articles/${res.id}`, { token: f.tokens.reporter2 })).status).toBe(404)
    const list = await api('GET', '/api/articles?limit=100&depth=0', { token: f.tokens.reporter2 })
    expect(list.json.docs.map((d: { id: number }) => d.id)).not.toContain(res.id)
    expect((await api('GET', `/api/articles/${res.id}`, { token: f.tokens.reporter })).status).toBe(200)
  })

  it('cannot change their own role (field access)', async () => {
    const id = f.users.reporter.id
    const res = await api('PATCH', `/api/users/${id}`, {
      token: f.tokens.reporter,
      body: { role: 'admin', sections: [f.catB.id] },
    })
    expect([200, 400, 403]).toContain(res.status)
    const user = await f.payload.findByID({ collection: 'users', id, depth: 0 })
    expect(user.role).toBe('reporter')
    expect(user.sections ?? []).toEqual([])
  })
})

describe('section editor', () => {
  it('moves an in-scope article through review to published and sets publishedAt', async () => {
    const art = await f.seedArticle({ status: 'in_review', author: f.users.reporter.id })
    const t = f.tokens.sectionEditor

    const changes = await patch(t, art.id, { status: 'changes_requested', reviewNotes: 'Please add quotes.' })
    expect(changes.status).toBe(200)
    expect(changes.json.doc.status).toBe('changes_requested')
    expect((await patch(t, art.id, { status: 'in_review' })).status).toBe(200)

    const approved = await patch(t, art.id, { status: 'approved' })
    expect(approved.status).toBe(200)
    expect(approved.json.doc.status).toBe('approved')
    expect(approved.json.doc.publishedAt ?? null).toBeNull()

    const published = await patch(t, art.id, { status: 'published' })
    expect(published.status).toBe(200)
    expect(published.json.doc.status).toBe('published')
    expect(Number.isNaN(Date.parse(published.json.doc.publishedAt))).toBe(false)
  })

  it('is refused (403) for an out-of-scope category', async () => {
    const art = await f.seedArticle({
      status: 'in_review',
      author: f.users.reporter.id,
      category: f.catB.id,
    })
    const res = await patch(f.tokens.sectionEditor, art.id, { status: 'approved' })
    expect(res.status).toBe(403)

    // Moving an in-scope article into an out-of-scope category while approving is refused too.
    const inScope = await f.seedArticle({ status: 'in_review', author: f.users.reporter.id })
    const move = await patch(f.tokens.sectionEditor, inScope.id, {
      status: 'approved',
      category: f.catB.id,
    })
    expect(move.status).toBe(403)
  })
})

describe('trusted publisher', () => {
  it('publishes their own in-scope article directly', async () => {
    const art = await f.createArticle(f.tokens.trusted)
    expect(art.status).toBe(201)
    const res = await patch(f.tokens.trusted, art.id!, { status: 'published' })
    expect(res.status).toBe(200)
    expect(res.json.doc.status).toBe('published')
    expect(res.json.doc.publishedAt).toBeTruthy()

    const direct = await f.createArticle(f.tokens.trusted, { status: 'published' })
    expect(direct.status).toBe(201)
    expect(direct.json.doc.status).toBe('published')
  })

  it('cannot publish their own out-of-scope article', async () => {
    const art = await f.createArticle(f.tokens.trusted, { category: f.catB.id })
    expect(art.status).toBe(201)
    const res = await patch(f.tokens.trusted, art.id!, { status: 'published' })
    expect(res.status).toBe(403)
    const direct = await f.createArticle(f.tokens.trusted, { category: f.catB.id, status: 'published' })
    expect(direct.status).toBe(403)
  })

  it("cannot approve someone else's article", async () => {
    const art = await f.seedArticle({ status: 'in_review', author: f.users.reporter.id })
    const res = await patch(f.tokens.trusted, art.id, { status: 'approved' })
    expect(res.status).toBe(403)
    const pub = await patch(f.tokens.trusted, art.id, { status: 'published' })
    expect(pub.status).toBe(403)
  })
})

describe('editor-in-chief scheduling and audit', () => {
  it('rejects a past scheduledFor with 400 and accepts a future one', async () => {
    const art = await f.seedArticle({ status: 'approved', author: f.users.reporter.id })
    const past = await patch(f.tokens.eic, art.id, {
      status: 'scheduled',
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    })
    expect(past.status).toBe(400)

    const missing = await patch(f.tokens.eic, art.id, { status: 'scheduled' })
    expect(missing.status).toBe(400)

    const future = new Date(Date.now() + 3_600_000)
    const ok = await patch(f.tokens.eic, art.id, { status: 'scheduled', scheduledFor: future.toISOString() })
    expect(ok.status).toBe(200)
    expect(ok.json.doc.status).toBe('scheduled')
  })

  it('publishDueArticles publishes due scheduled articles and audits the transition', async () => {
    const art = await f.createArticle(f.tokens.reporter)
    const when = new Date(Date.now() + 3_600_000)
    // reporter -> in_review, then EIC schedules.
    expect((await patch(f.tokens.reporter, art.id!, { status: 'in_review' })).status).toBe(200)
    expect(
      (await patch(f.tokens.eic, art.id!, { status: 'scheduled', scheduledFor: when.toISOString() })).status,
    ).toBe(200)

    // Not due yet.
    await publishDueArticles(f.payload, new Date())
    expect((await f.payload.findByID({ collection: 'articles', id: art.id!, depth: 0 })).status).toBe(
      'scheduled',
    )

    const count = await publishDueArticles(f.payload, new Date(when.getTime() + 60_000))
    expect(count).toBeGreaterThanOrEqual(1)
    const doc = await f.payload.findByID({ collection: 'articles', id: art.id!, depth: 0 })
    expect(doc.status).toBe('published')
    expect(doc.publishedAt).toBeTruthy()

    const logs = await f.payload.find({
      collection: 'audit-logs',
      where: { and: [{ collection: { equals: 'articles' } }, { docId: { equals: String(art.id) } }] },
      sort: 'createdAt',
      limit: 50,
      depth: 0,
      overrideAccess: true,
    })
    const transitions = logs.docs.map((l) => `${l.action}:${l.fromStatus ?? ''}>${l.toStatus ?? ''}`)
    expect(transitions).toEqual([
      'create:>draft',
      'status-change:draft>in_review',
      'status-change:in_review>scheduled',
      'status-change:scheduled>published',
    ])
    const actors = logs.docs.map((l) => l.actor)
    expect(actors[0]).toBe(f.users.reporter.id)
    expect(actors[2]).toBe(f.users.eic.id)
    expect(logs.docs[2]!.actorRole).toBe('editor-in-chief')
    expect(logs.docs[3]!.actorRole).toBe('system')
  })

  it('lets the EIC read audit logs but not the reporter', async () => {
    const art = await f.createArticle(f.tokens.reporter)
    const asReporter = await api('GET', '/api/audit-logs?limit=5', { token: f.tokens.reporter })
    expect(asReporter.status).toBe(403)
    const anon = await api('GET', '/api/audit-logs?limit=5')
    expect([401, 403]).toContain(anon.status)

    const asEic = await api(
      'GET',
      `/api/audit-logs?where[docId][equals]=${art.id}&where[collection][equals]=articles&depth=0`,
      { token: f.tokens.eic },
    )
    expect(asEic.status).toBe(200)
    expect(asEic.json.docs.length).toBeGreaterThanOrEqual(1)
    expect(asEic.json.docs[0].actor?.id ?? asEic.json.docs[0].actor).toBe(f.users.reporter.id)
  })

  it('makes audit logs immutable through the API for everyone', async () => {
    const log = await f.payload.find({
      collection: 'audit-logs',
      where: { actor: { equals: f.users.reporter.id } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    const id = log.docs[0]!.id
    for (const who of ['admin', 'eic'] as const) {
      const t = f.tokens[who]
      expect((await api('PATCH', `/api/audit-logs/${id}`, { token: t, body: { summary: 'tampered' } })).status).toBe(
        403,
      )
      expect((await api('DELETE', `/api/audit-logs/${id}`, { token: t })).status).toBe(403)
      expect((await api('POST', '/api/audit-logs', { token: t, body: { action: 'x', collection: 'x', docId: '1' } })).status).toBe(403)
    }
    const after = await f.payload.findByID({ collection: 'audit-logs', id, depth: 0, overrideAccess: true })
    expect(after.summary).not.toBe('tampered')
  })
})

describe('corrections on published articles', () => {
  it('requires a corrections entry to change a published title', async () => {
    const art = await f.seedArticle({
      status: 'published',
      publishedAt: new Date().toISOString(),
      title: `${runId} original title`,
    })
    const before = await f.payload.findVersions({
      collection: 'articles',
      where: { parent: { equals: art.id } },
      limit: 100,
      overrideAccess: true,
    })

    const bad = await patch(f.tokens.eic, art.id, { title: `${runId} changed title` })
    expect(bad.status).toBe(400)

    const good = await patch(f.tokens.eic, art.id, {
      title: `${runId} changed title`,
      corrections: [{ note: 'The original headline misstated the venue.' }],
    })
    expect(good.status).toBe(200)
    expect(good.json.doc.title).toBe(`${runId} changed title`)
    expect(good.json.doc.corrections).toHaveLength(1)
    expect(good.json.doc.corrections[0].correctedAt).toBeTruthy()

    const after = await f.payload.findVersions({
      collection: 'articles',
      where: { parent: { equals: art.id } },
      limit: 100,
      overrideAccess: true,
    })
    expect(after.totalDocs).toBe(before.totalDocs + 1)
  })
})
