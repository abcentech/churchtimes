import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

const runId = newRunId()
let f: Fixtures

beforeAll(async () => {
  f = await setupFixtures(runId)
})

afterAll(async () => {
  await f?.cleanup()
})

const idOf = (v: unknown): number => (typeof v === 'object' && v ? (v as { id: number }).id : (v as number))

async function createEvent(label: string, status: 'draft' | 'live' | 'ended' = 'live') {
  const slug = `${runId}-${label}`
  const res = await api('POST', '/api/live-events', {
    token: f.tokens.eic,
    body: { title: `${runId} ${label}`, slug, category: f.catA.id, status },
  })
  expect(res.status).toBe(201)
  return { id: res.json.doc.id as number, slug }
}

const postUpdate = (token: string, event: number, body: Record<string, unknown> = {}) =>
  api('POST', '/api/live-updates', {
    token,
    body: { event, body: `Update ${Math.random().toString(36).slice(2)}`, ...body },
  })

const setStatus = (token: string, id: number, status: string) =>
  api('PATCH', `/api/live-updates/${id}`, { token, body: { status } })

const poll = (slug: string, query = '') => api('GET', `/api/live-events/${slug}/updates${query}`)

describe('live updates', () => {
  it('reporter creates a pending update with a server-assigned sequence, and cannot approve', async () => {
    const ev = await createEvent('pending')
    const first = await postUpdate(f.tokens.reporter, ev.id, { sequence: 99, status: 'approved' })
    expect(first.status).toBe(201)
    expect(first.json.doc.status).toBe('pending')
    expect(first.json.doc.sequence).toBe(1)

    const second = await postUpdate(f.tokens.reporter, ev.id, { sequence: 1 })
    expect(second.json.doc.sequence).toBe(2)

    const approve = await setStatus(f.tokens.reporter, first.json.doc.id, 'approved')
    expect([403, 404]).toContain(approve.status)
    expect(approve.status).toBe(403)

    // The reporter cannot rewrite the sequence either.
    await api('PATCH', `/api/live-updates/${first.json.doc.id}`, {
      token: f.tokens.reporter,
      body: { body: 'edited while pending', sequence: 50 },
    })
    const stored = await f.payload.findByID({ collection: 'live-updates', id: first.json.doc.id, overrideAccess: true })
    expect(stored.sequence).toBe(1)
    expect(stored.status).toBe('pending')
  })

  it('shows only approved updates in the public feed, with since filtering and nextSince', async () => {
    const ev = await createEvent('feed')
    const u1 = (await postUpdate(f.tokens.reporter, ev.id)).json.doc // stays pending
    const u2 = (await postUpdate(f.tokens.reporter, ev.id)).json.doc
    const u3 = (await postUpdate(f.tokens.reporter, ev.id)).json.doc // rejected
    const u4 = (await postUpdate(f.tokens.reporter, ev.id)).json.doc

    expect((await setStatus(f.tokens.eic, u2.id, 'approved')).status).toBe(200)
    expect((await setStatus(f.tokens.eic, u3.id, 'rejected')).status).toBe(200)
    expect((await setStatus(f.tokens.sectionEditor, u4.id, 'approved')).status).toBe(200)

    const all = await poll(ev.slug)
    expect(all.status).toBe(200)
    expect(all.headers.get('cache-control')).toContain('max-age')
    expect(all.json.event).toMatchObject({ slug: ev.slug, status: 'live' })
    expect(all.json.docs.map((d: { id: number }) => d.id)).toEqual([u2.id, u4.id])
    // `sequence` in the public feed is the publication order (u2 was approved first, then u4), not
    // the creation order (u2.sequence=2, u4.sequence=4).
    expect(all.json.docs.map((d: { sequence: number }) => d.sequence)).toEqual([1, 2])
    expect([u2.sequence, u4.sequence]).toEqual([2, 4])
    expect(all.json.nextSince).toBe(2)
    for (const d of all.json.docs) {
      expect(Object.keys(d).sort()).toEqual(['approvedAt', 'body', 'id', 'occurredAt', 'sequence'])
      expect(d.approvedAt).toBeTruthy()
    }
    expect(all.text).not.toContain(u1.body)
    expect(all.text).not.toContain(u3.body)

    const since = await poll(ev.slug, '?since=1')
    expect(since.json.docs.map((d: { id: number }) => d.id)).toEqual([u4.id])
    expect(since.json.nextSince).toBe(2)

    const caughtUp = await poll(ev.slug, '?since=2')
    expect(caughtUp.json.docs).toEqual([])
    expect(caughtUp.json.nextSince).toBe(2)

    const limited = await poll(ev.slug, '?limit=1')
    expect(limited.json.docs).toHaveLength(1)
    expect(limited.json.nextSince).toBe(1)
  })

  it('returns 404 for a draft or unknown event and 400 for bad parameters', async () => {
    const draft = await createEvent('draftev', 'draft')
    const u = (await postUpdate(f.tokens.eic, draft.id, { status: 'approved' })).json.doc
    expect(u.status).toBe('approved')
    expect((await poll(draft.slug)).status).toBe(404)
    expect((await poll(`${runId}-does-not-exist`)).status).toBe(404)

    const live = await createEvent('params')
    for (const q of ['?since=abc', '?since=-1', '?since=1.5', '?limit=abc', '?limit=-5']) {
      const res = await poll(live.slug, q)
      expect(res.status, q).toBe(400)
    }
    expect((await poll(live.slug, '?limit=100000')).status).toBe(200)
  })

  it('assigns a strictly increasing sequence per event and ignores client values', async () => {
    const ev = await createEvent('seq')
    const seqs: number[] = []
    for (const fake of [500, 0, undefined, 3]) {
      const res = await postUpdate(f.tokens.sectionEditor, ev.id, fake === undefined ? {} : { sequence: fake })
      expect(res.status).toBe(201)
      seqs.push(res.json.doc.sequence)
    }
    expect(seqs).toEqual([1, 2, 3, 4])

    // Another event has its own counter.
    const other = await createEvent('seq2')
    expect((await postUpdate(f.tokens.reporter, other.id)).json.doc.sequence).toBe(1)
  })

  it('exposes only approved updates of non-draft events on anonymous /api/live-updates', async () => {
    const ev = await createEvent('anon')
    const pending = (await postUpdate(f.tokens.reporter, ev.id)).json.doc
    const approved = (await postUpdate(f.tokens.eic, ev.id, { status: 'approved' })).json.doc
    const draftEv = await createEvent('anon-draft', 'draft')
    const inDraft = (await postUpdate(f.tokens.eic, draftEv.id, { status: 'approved' })).json.doc

    const res = await api('GET', '/api/live-updates?limit=100&depth=0&sort=-createdAt')
    expect(res.status).toBe(200)
    const ids = res.json.docs.map((d: { id: number }) => d.id)
    expect(ids).toContain(approved.id)
    expect(ids).not.toContain(pending.id)
    expect(ids).not.toContain(inDraft.id)
    expect(res.json.docs.every((d: { status: string }) => d.status === 'approved')).toBe(true)
    for (const d of res.json.docs) {
      expect(d).not.toHaveProperty('author')
      expect(d).not.toHaveProperty('approvedBy')
    }

    // Explicitly asking for pending still yields nothing.
    const asked = await api('GET', '/api/live-updates?where[status][equals]=pending&depth=0')
    expect(asked.json.docs).toEqual([])

    // Anonymous cannot create or approve.
    expect([401, 403]).toContain(
      (await api('POST', '/api/live-updates', { body: { event: ev.id, body: 'anon' } })).status,
    )
    expect(idOf(approved.event)).toBe(ev.id)
  })
})
