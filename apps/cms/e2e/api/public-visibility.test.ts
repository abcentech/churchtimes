/**
 * What an anonymous visitor (the public site, `credentials: 'omit'`) can and cannot see, plus the
 * proxy.ts query guard that only exists on a real server (it is Next middleware, not a route handler).
 * Uses the synthetic seed (src/seed/staging.ts): staging-draft-1, staging-in-review-1, staging-live-event ...
 */
import { beforeAll, describe, expect, it } from 'vitest'

import { Client, EVIL_ORIGIN, PUBLIC_ORIGIN, categoryId, loginAs } from './support'

let anon: Client
let admin: Client
let news: number

beforeAll(async () => {
  anon = new Client(PUBLIC_ORIGIN)
  admin = (await loginAs('admin')).client
  news = await categoryId(anon)
})

const publicGet = (p: string) => anon.get(p, { credentials: false })

describe('published-only visibility for anonymous readers', () => {
  it('lists only published articles, newest first, with no staff-only fields', async () => {
    const res = await publicGet('/api/articles?limit=100&depth=1&sort=-publishedAt')
    expect(res.status).toBe(200)
    expect(res.json.docs.length).toBeGreaterThanOrEqual(6)
    for (const doc of res.json.docs) {
      expect(doc.status, doc.slug).toBe('published')
      for (const f of ['author', 'reviewNotes', 'scheduledFor']) expect(doc[f], `${doc.slug}.${f}`).toBeUndefined()
    }
    const dates = res.json.docs.map((d: { publishedAt: string }) => Date.parse(d.publishedAt))
    expect(dates).toEqual([...dates].sort((a, b) => b - a))
    const slugs = res.json.docs.map((d: { slug: string }) => d.slug)
    for (const hidden of ['staging-draft-1', 'staging-in-review-1', 'staging-approved-1', 'staging-scheduled-1', 'staging-archived-1', 'staging-changes-requested-1']) {
      expect(slugs, hidden).not.toContain(hidden)
    }
  })

  it('`?pagination=false` is ignored: the list stays paginated and capped at 100', async () => {
    const res = await publicGet('/api/articles?pagination=false&limit=1')
    expect(res.status).toBe(200)
    expect(res.json.docs).toHaveLength(1)
    expect(res.json.totalPages).toBeGreaterThan(1)
    expect(res.json.hasNextPage).toBe(true)
    const big = await publicGet('/api/articles?limit=100000')
    expect(big.json.limit).toBeLessThanOrEqual(100)
  })

  it('`where[status][equals]=draft` (and other non-published statuses) returns nothing to anonymous readers', async () => {
    for (const status of ['draft', 'in_review', 'approved', 'scheduled', 'archived', 'changes_requested']) {
      const res = await publicGet(`/api/articles?where[status][equals]=${status}`)
      expect(res.status, status).toBe(200)
      expect(res.json.docs, status).toHaveLength(0)
      expect(res.json.totalDocs, status).toBe(0)
    }
    const either = await publicGet('/api/articles?where[or][0][status][equals]=draft&where[or][1][status][equals]=published&limit=100')
    expect(either.status).toBe(200)
    expect(either.json.docs.length, 'published rows still match').toBeGreaterThan(0)
    for (const doc of either.json.docs) expect(doc.status).toBe('published')
  })

  it('an unpublished article by id is 404 for anonymous callers but readable by an admin', async () => {
    const found = await admin.get('/api/articles?where[slug][equals]=staging-draft-1&limit=1')
    const id = found.json.docs[0]?.id
    expect(id, 'seeded draft exists').toBeTypeOf('number')
    expect((await publicGet(`/api/articles/${id}`)).status).toBe(404)
    expect((await admin.get(`/api/articles/${id}`)).status).toBe(200)
  })

  it('a published article can be read by slug and by category id', async () => {
    const bySlug = await publicGet('/api/articles?where[slug][equals]=staging-published-1&depth=1&limit=1')
    expect(bySlug.json.docs[0]).toMatchObject({ slug: 'staging-published-1', status: 'published' })
    const byCat = await publicGet(`/api/articles?where[category][equals]=${news}&where[status][equals]=published`)
    expect(byCat.status).toBe(200)
    expect(byCat.json.docs.length).toBeGreaterThan(0)
  })

  it('categories are public', async () => {
    const res = await publicGet('/api/categories?limit=100')
    expect(res.status).toBe(200)
    expect(res.json.docs.map((c: { slug: string }) => c.slug)).toEqual(expect.arrayContaining(['news', 'features', 'opinion']))
  })

  it('live coverage: a draft event is hidden; only APPROVED updates of a live event are public', async () => {
    const draft = await publicGet('/api/live-events/staging-draft-event/updates')
    expect(draft.status).toBe(404)
    const draftList = await publicGet('/api/live-events?where[slug][equals]=staging-draft-event')
    expect(draftList.json.docs).toHaveLength(0)

    const live = await publicGet('/api/live-events/staging-live-event/updates')
    expect(live.status).toBe(200)
    expect(live.headers.get('cache-control')).toMatch(/max-age=10/)
    expect(live.json.event).toMatchObject({ slug: 'staging-live-event', status: 'live' })
    const bodies = live.json.docs.map((d: { body: string }) => d.body)
    expect(bodies).toEqual(expect.arrayContaining(['Synthetic approved update one.', 'Synthetic approved update two.']))
    expect(bodies.join(' ')).not.toMatch(/PENDING/)
    expect(live.json.nextSince).toBe(live.json.docs[live.json.docs.length - 1].sequence)

    // Polling with the cursor returns nothing new.
    const again = await publicGet(`/api/live-events/staging-live-event/updates?since=${live.json.nextSince}`)
    expect(again.json.docs).toHaveLength(0)

    // The raw collection never exposes the pending row either.
    const raw = await publicGet('/api/live-updates?limit=100')
    expect(raw.status).toBe(200)
    expect(raw.json.docs.length, 'the seeded approved updates are listed').toBeGreaterThanOrEqual(2)
    for (const doc of raw.json.docs) expect(doc.status).toBe('approved')

    // ... but an editor sees it in the review queue.
    const queue = await admin.get('/api/live-updates?where[status][equals]=pending&limit=10')
    expect(queue.json.docs.map((d: { body: string }) => d.body).join(' ')).toMatch(/PENDING/)
  })
})

describe('invalid filters are rejected by proxy.ts (only reachable on the real server)', () => {
  it('where[category][equals]=news (a slug, not an id) -> 400 with a field error, not 500', async () => {
    const res = await publicGet('/api/articles?where[category][equals]=news')
    expect(res.status).toBe(400)
    expect(res.json.ok).toBe(false)
    expect(res.json.errors[0].field).toBe('where[category][equals]')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('the 400 carries CORS headers for an allowlisted origin (so a browser can read it) and none for others', async () => {
    const ok = await anon.get('/api/articles?where[category][equals]=news', { credentials: false, origin: PUBLIC_ORIGIN })
    expect(ok.status).toBe(400)
    expect(ok.headers.get('access-control-allow-origin')).toBe(PUBLIC_ORIGIN)
    const evil = await anon.get('/api/articles?where[category][equals]=news', { credentials: false, origin: EVIL_ORIGIN })
    expect(evil.status).toBe(400)
    expect(evil.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('other malformed relationship filters (operators in, not_in, etc. with non-numeric ids) are 400 too', async () => {
    for (const q of [
      'where[category][in]=news,features',
      'where[category][not_equals]=abc',
      'where[featuredImage][equals]=../../etc/passwd',
    ]) {
      const res = await publicGet(`/api/articles?${q}`)
      expect(res.status, q).toBe(400)
    }
  })

  it('a numeric id filter still works', async () => {
    const res = await publicGet(`/api/articles?where[category][equals]=${news}`)
    expect(res.status).toBe(200)
  })
})
