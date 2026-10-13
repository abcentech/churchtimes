/**
 * Regression tests for the verified security-review findings (docs/security.md, section "Review fixes").
 * Everything goes through the real REST route handlers. Numbering follows the review findings.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { api, lexical, newRunId, PASSWORD, setupFixtures, type Fixtures } from './helpers'

const runId = newRunId()
let f: Fixtures

beforeAll(async () => {
  f = await setupFixtures(runId)
})

afterAll(async () => {
  vi.restoreAllMocks()
  await f?.cleanup()
})

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString()

let ipN = 0
const withIp = () => ({ 'x-forwarded-for': `198.18.${Math.floor(ipN / 250)}.${(ipN += 1) % 250}` })

const auditFor = async (collection: string, docId: number | string) =>
  (
    await f.payload.find({
      collection: 'audit-logs',
      where: { and: [{ collection: { equals: collection } }, { docId: { equals: String(docId) } }] },
      limit: 100,
      depth: 0,
      overrideAccess: true,
    })
  ).docs as Array<{ action: string; summary?: string; details?: unknown; actor?: unknown }>

// ---------------------------------------------------------------------------------------------
// 1. Media ownership
// ---------------------------------------------------------------------------------------------

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const pngForm = (payload: Record<string, unknown>, name = 'pic.png') => {
  const form = new FormData()
  form.set('_payload', JSON.stringify(payload))
  form.set('file', new Blob([new Uint8Array(PNG_1X1)], { type: 'image/png' }), name)
  return form
}

let mediaN = 0
async function mkMedia(token: string, extra: Record<string, unknown> = {}) {
  const alt = `${runId} media ${++mediaN}`
  const res = await api('POST', '/api/media', { token, body: pngForm({ alt, ...extra }, `m${mediaN}.png`) })
  expect(res.status).toBe(201)
  f.created.media.push(res.json.doc.id)
  return res.json.doc as { id: number; alt: string; filename: string }
}

const rawMedia = (id: number) =>
  f.payload.findByID({ collection: 'media', id, depth: 0, overrideAccess: true }) as Promise<Record<string, any>>

describe('1. media ownership and replacement', () => {
  it('sets uploadedBy on the server, ignoring the client value, and hides it from the public', async () => {
    const m = await mkMedia(f.tokens.reporter, { uploadedBy: f.users.reporter2.id })
    const stored = await rawMedia(m.id)
    expect(stored.uploadedBy).toBe(f.users.reporter.id)

    const staff = await api('GET', `/api/media/${m.id}?depth=0`, { token: f.tokens.reporter })
    expect(staff.json.uploadedBy).toBe(f.users.reporter.id)
    const anon = await api('GET', `/api/media/${m.id}?depth=0`)
    expect(anon.status).toBe(200)
    expect(anon.json).not.toHaveProperty('uploadedBy')
  })

  it("does not let another reporter edit someone else's media metadata or replace its file", async () => {
    const m = await mkMedia(f.tokens.reporter)
    const meta = await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.reporter2, body: { alt: `${runId} hijacked` } })
    expect([403, 404]).toContain(meta.status)
    const file = await api('PATCH', `/api/media/${m.id}`, {
      token: f.tokens.reporter2,
      body: pngForm({ alt: `${runId} hijacked` }, 'evil.png'),
    })
    expect([403, 404]).toContain(file.status)
    const stored = await rawMedia(m.id)
    expect(stored.alt).toBe(m.alt)
    expect(stored.filename).toBe(m.filename)

    // uploadedBy itself cannot be rewritten by the owner.
    await api('PATCH', `/api/media/${m.id}`, {
      token: f.tokens.reporter,
      body: { alt: m.alt, uploadedBy: f.users.reporter2.id },
    })
    expect((await rawMedia(m.id)).uploadedBy).toBe(f.users.reporter.id)
  })

  it('lets the owner edit unreferenced media and editors edit any media; both are audited', async () => {
    const m = await mkMedia(f.tokens.reporter)
    const own = await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.reporter, body: { caption: 'owner caption' } })
    expect(own.status).toBe(200)

    const replaced = await api('PATCH', `/api/media/${m.id}`, {
      token: f.tokens.reporter,
      body: pngForm({ alt: m.alt }, 'replacement.png'),
    })
    expect(replaced.status).toBe(200)

    const byEditor = await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.sectionEditor, body: { credit: 'editor credit' } })
    expect(byEditor.status).toBe(200)

    const actions = (await auditFor('media', m.id)).map((a) => a.action)
    expect(actions).toContain('upload')
    expect(actions.filter((a) => a === 'media.update').length).toBeGreaterThanOrEqual(2)
    expect(actions).toContain('media.replace-file')
  })

  it('freezes media used by a published or scheduled article for non-editors', async () => {
    const m = await mkMedia(f.tokens.reporter)
    const art = await f.seedArticle({ status: 'published', publishedAt: iso(), featuredImage: m.id })

    const meta = await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.reporter, body: { alt: `${runId} swapped` } })
    expect(meta.status).toBe(403)
    const file = await api('PATCH', `/api/media/${m.id}`, {
      token: f.tokens.reporter,
      body: pngForm({ alt: m.alt }, 'swap.png'),
    })
    expect(file.status).toBe(403)
    expect((await rawMedia(m.id)).alt).toBe(m.alt)

    // Editors still can.
    const editor = await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.sectionEditor, body: { caption: 'fixed typo' } })
    expect(editor.status).toBe(200)

    // Once the article is archived the owner may edit again.
    await f.payload.update({ collection: 'articles', id: art.id, data: { status: 'archived' } as never, overrideAccess: true, context: { seed: true } })
    const again = await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.reporter, body: { caption: 'free again' } })
    expect(again.status).toBe(200)

    // Scheduled counts too.
    const m2 = await mkMedia(f.tokens.reporter)
    await f.seedArticle({ status: 'scheduled', scheduledFor: iso(86_400_000), featuredImage: m2.id })
    const sched = await api('PATCH', `/api/media/${m2.id}`, { token: f.tokens.reporter, body: { alt: `${runId} swapped2` } })
    expect(sched.status).toBe(403)
  })

  it('treats legacy media without uploadedBy as editor-only', async () => {
    const legacy = (await f.payload.create({
      collection: 'media',
      data: { alt: `${runId} legacy` },
      file: { data: PNG_1X1, mimetype: 'image/png', name: 'legacy.png', size: PNG_1X1.length },
      overrideAccess: true,
      context: { seed: true },
    })) as { id: number }
    f.created.media.push(legacy.id)
    expect((await rawMedia(legacy.id)).uploadedBy ?? null).toBeNull()

    const rep = await api('PATCH', `/api/media/${legacy.id}`, { token: f.tokens.reporter, body: { caption: 'nope' } })
    expect([403, 404]).toContain(rep.status)
    const ed = await api('PATCH', `/api/media/${legacy.id}`, { token: f.tokens.eic, body: { caption: 'ok' } })
    expect(ed.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------------------------
// 2. Article versions access
// ---------------------------------------------------------------------------------------------

describe('2. article versions follow the article read rule', () => {
  const versionsOf = (token: string | undefined, articleId: number) =>
    api('GET', `/api/articles/versions?where[parent][equals]=${articleId}&limit=100&depth=0`, { token })

  it("does not leak other users' drafts or review notes through /api/articles/versions", async () => {
    const mine = await f.createArticle(f.tokens.reporter)
    const theirs = await f.seedArticle({
      status: 'draft',
      author: f.users.reporter2.id,
      reviewNotes: `${runId} SECRET-REVIEW-NOTE`,
    })
    const otherSection = await f.seedArticle({ status: 'draft', category: f.catB.id, reviewNotes: `${runId} SECRET-B` })
    const published = await f.seedArticle({
      status: 'published',
      publishedAt: iso(),
      author: f.users.reporter2.id,
    })

    const own = await versionsOf(f.tokens.reporter, mine.id!)
    expect(own.status).toBe(200)
    expect(own.json.docs.length).toBeGreaterThan(0)

    const other = await versionsOf(f.tokens.reporter, theirs.id)
    expect(other.status).toBe(200)
    expect(other.json.docs).toEqual([])
    expect(other.text).not.toContain('SECRET-REVIEW-NOTE')

    // Versions of published articles stay visible to staff (same as the article itself).
    expect((await versionsOf(f.tokens.reporter, published.id)).json.docs.length).toBeGreaterThan(0)

    // Section editor: own sections only.
    expect((await versionsOf(f.tokens.sectionEditor, theirs.id)).json.docs.length).toBeGreaterThan(0)
    expect((await versionsOf(f.tokens.sectionEditor, otherSection.id)).json.docs).toEqual([])

    // Trusted publisher behaves like a section-scoped reader.
    expect((await versionsOf(f.tokens.trusted, otherSection.id)).json.docs).toEqual([])

    // EIC and admin read everything.
    expect((await versionsOf(f.tokens.eic, otherSection.id)).json.docs.length).toBeGreaterThan(0)
    expect((await versionsOf(f.tokens.admin, theirs.id)).json.docs.length).toBeGreaterThan(0)

    // The unscoped list does not contain them either.
    const all = await api('GET', '/api/articles/versions?limit=100&depth=0', { token: f.tokens.reporter })
    expect(all.text).not.toContain('SECRET-REVIEW-NOTE')
    expect(all.text).not.toContain('SECRET-B')
  })

  it('cannot read a single foreign version by id, and anonymous callers get nothing', async () => {
    const theirs = await f.seedArticle({ status: 'draft', author: f.users.reporter2.id })
    const versions = await f.payload.findVersions({
      collection: 'articles',
      where: { parent: { equals: theirs.id } },
      limit: 5,
      overrideAccess: true,
    })
    const versionId = versions.docs[0]!.id
    const res = await api('GET', `/api/articles/versions/${versionId}`, { token: f.tokens.reporter })
    expect([403, 404]).toContain(res.status)
    const ok = await api('GET', `/api/articles/versions/${versionId}`, { token: f.tokens.eic })
    expect(ok.status).toBe(200)

    expect([401, 403]).toContain((await api('GET', '/api/articles/versions')).status)
    expect([401, 403]).toContain((await api('GET', `/api/articles/versions/${versionId}`)).status)
    expect([401, 403]).toContain((await api('GET', `/api/articles/versions?where[parent][equals]=${theirs.id}`)).status)
  })
})

// ---------------------------------------------------------------------------------------------
// 3. Live updates approved out of order
// ---------------------------------------------------------------------------------------------

describe('3. live updates are delivered in publication order', () => {
  async function createEvent(label: string) {
    const slug = `${runId}-${label}`
    const res = await api('POST', '/api/live-events', {
      token: f.tokens.eic,
      body: { title: `${runId} ${label}`, slug, category: f.catA.id, status: 'live' },
    })
    expect(res.status).toBe(201)
    return { id: res.json.doc.id as number, slug }
  }
  const post = async (event: number, extra: Record<string, unknown> = {}, token = f.tokens.reporter) =>
    (await api('POST', '/api/live-updates', { token, body: { event, body: `u ${Math.random()}`, ...extra } })).json.doc
  const setStatus = (id: number, status: string, token = f.tokens.eic) =>
    api('PATCH', `/api/live-updates/${id}`, { token, body: { status } })
  const poll = (slug: string, query = '') => api('GET', `/api/live-events/${slug}/updates${query}`)

  it('delivers an update approved after a later-created one to pollers that already advanced', async () => {
    const ev = await createEvent('ooo')
    const u1 = await post(ev.id)
    const u2 = await post(ev.id)
    const u3 = await post(ev.id)

    expect((await setStatus(u3.id, 'approved')).status).toBe(200)
    const first = await poll(ev.slug)
    expect(first.json.docs.map((d: { id: number }) => d.id)).toEqual([u3.id])
    const cursor = first.json.nextSince as number

    // u1 was created before u3 but approved after it: it must still reach this poller.
    expect((await setStatus(u1.id, 'approved')).status).toBe(200)
    const second = await poll(ev.slug, `?since=${cursor}`)
    expect(second.json.docs.map((d: { id: number }) => d.id)).toEqual([u1.id])
    expect(second.json.nextSince).toBeGreaterThan(cursor)

    expect((await setStatus(u2.id, 'approved')).status).toBe(200)
    const third = await poll(ev.slug, `?since=${second.json.nextSince}`)
    expect(third.json.docs.map((d: { id: number }) => d.id)).toEqual([u2.id])

    // Full replay is in publication order, and `sequence` is the publication sequence.
    const all = await poll(ev.slug)
    expect(all.json.docs.map((d: { id: number }) => d.id)).toEqual([u3.id, u1.id, u2.id])
    expect(all.json.docs.map((d: { sequence: number }) => d.sequence)).toEqual([1, 2, 3])
    expect(all.json.nextSince).toBe(3)
  })

  it('assigns a publication sequence to updates created as approved and keeps creation order separately', async () => {
    const ev = await createEvent('created-approved')
    const pending = await post(ev.id)
    const direct = await post(ev.id, { status: 'approved' }, f.tokens.eic)
    expect(direct.status).toBe('approved')
    expect(direct.sequence).toBe(2) // creation order is unchanged

    const feed = await poll(ev.slug)
    expect(feed.json.docs.map((d: { id: number }) => d.id)).toEqual([direct.id])
    expect(feed.json.docs[0].sequence).toBe(1) // publication order
    expect(feed.json.nextSince).toBe(1)

    // The client cannot set publishSequence.
    const forged = await post(ev.id, { publishSequence: 99, status: 'approved' }, f.tokens.eic)
    const stored = await f.payload.findByID({ collection: 'live-updates', id: forged.id, overrideAccess: true })
    expect((stored as { publishSequence?: number }).publishSequence).toBe(2)
    await api('PATCH', `/api/live-updates/${pending.id}`, { token: f.tokens.eic, body: { publishSequence: 50 } })
    const still = await f.payload.findByID({ collection: 'live-updates', id: pending.id, overrideAccess: true })
    expect((still as { publishSequence?: number | null }).publishSequence ?? null).toBeNull()
  })

  it('removes an approved update from the feed when it is rejected, and re-delivers it when approved again', async () => {
    const ev = await createEvent('reject')
    const a = await post(ev.id, { status: 'approved' }, f.tokens.eic)
    const b = await post(ev.id, { status: 'approved' }, f.tokens.eic)
    expect((await setStatus(a.id, 'rejected')).status).toBe(200)
    expect((await poll(ev.slug)).json.docs.map((d: { id: number }) => d.id)).toEqual([b.id])
    expect((await setStatus(a.id, 'approved')).status).toBe(200)
    const after = await poll(ev.slug, '?since=2')
    expect(after.json.docs.map((d: { id: number }) => d.id)).toEqual([a.id])
  })

  it('never hands out the same publication sequence twice under concurrent approvals', async () => {
    const ev = await createEvent('concurrent')
    const ups = []
    for (let i = 0; i < 4; i++) ups.push(await post(ev.id))
    const results = await Promise.all(ups.map((u) => setStatus(u.id, 'approved')))
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200])
    const feed = await poll(ev.slug)
    expect(feed.json.docs.map((d: { sequence: number }) => d.sequence)).toEqual([1, 2, 3, 4])
  })
})

// ---------------------------------------------------------------------------------------------
// 6. pagination=false must not bypass the 100 item clamp
// ---------------------------------------------------------------------------------------------

describe('6. pagination=false is clamped on every collection', () => {
  beforeAll(async () => {
    for (let i = 0; i < 105; i++) {
      await f.payload.create({
        collection: 'categories',
        data: { title: `${runId} bulk ${i}`, slug: `${runId}-bulk-${i}` },
        overrideAccess: true,
      })
    }
  }, 120_000)

  it('anonymous pagination=false returns at most 100 docs and keeps hasNextPage truthful', async () => {
    const res = await api('GET', '/api/categories?pagination=false&depth=0')
    expect(res.status).toBe(200)
    expect(res.json.docs.length).toBeLessThanOrEqual(100)
    expect(res.json.hasNextPage).toBe(true)

    const big = await api('GET', '/api/categories?pagination=false&limit=100000&depth=0')
    expect(big.json.docs).toHaveLength(100)
    expect(big.json.limit).toBe(100)
    expect(big.json.hasNextPage).toBe(true)

    const zero = await api('GET', '/api/categories?pagination=false&limit=0&depth=0')
    expect(zero.json.docs.length).toBeLessThanOrEqual(100)
    expect(zero.json.docs.length).toBeGreaterThan(0)

    const page2 = await api('GET', '/api/categories?limit=100&page=2&depth=0&sort=createdAt')
    expect(page2.json.docs.length).toBeGreaterThan(0)
  })

  it('applies to articles, media, live events and live updates for anonymous callers', async () => {
    for (const c of ['articles', 'media', 'live-events', 'live-updates']) {
      const res = await api('GET', `/api/${c}?pagination=false&limit=100000&depth=0`)
      expect(res.status, c).toBe(200)
      expect(res.json.docs.length, c).toBeLessThanOrEqual(100)
      expect(res.json.limit, c).toBeLessThanOrEqual(100)
    }
  })

  it('applies to staff-only collections and to version listings', async () => {
    for (const c of ['submissions', 'audit-logs', 'users', 'articles/versions']) {
      const res = await api('GET', `/api/${c}?pagination=false&limit=100000&depth=0`, { token: f.tokens.eic })
      expect(res.status, c).toBe(200)
      expect(res.json.docs.length, c).toBeLessThanOrEqual(100)
      expect(res.json.limit, c).toBeLessThanOrEqual(100)
    }
  })

  it('does not affect trusted server-side (local API) calls', async () => {
    const all = await f.payload.find({ collection: 'categories', pagination: false, overrideAccess: true, depth: 0 })
    expect(all.docs.length).toBeGreaterThanOrEqual(105)
  })
})

// ---------------------------------------------------------------------------------------------
// 7 + 8. Corrections are append-only; semantically identical content is not a material edit
// ---------------------------------------------------------------------------------------------

type Correction = { id?: string; note: string; correctedAt?: string }
const patchArticle = (token: string, id: number, body: Record<string, unknown>) =>
  api('PATCH', `/api/articles/${id}`, { token, body })

async function publishedWithCorrections(notes: string[]) {
  const art = await f.seedArticle({
    status: 'published',
    publishedAt: iso(-60_000),
    author: f.users.reporter.id,
    corrections: notes.map((note, i) => ({ note, correctedAt: iso(-3_600_000 + i * 1000) })),
  })
  const doc = (await f.payload.findByID({ collection: 'articles', id: art.id, depth: 0, overrideAccess: true })) as {
    corrections: Required<Correction>[]
  }
  return { id: art.id, corrections: doc.corrections }
}

describe('7. corrections are append-only', () => {
  it('rejects rewriting, reordering or removing existing corrections for a section editor', async () => {
    const { id, corrections } = await publishedWithCorrections(['first note', 'second note'])

    const rewrite = await patchArticle(f.tokens.sectionEditor, id, {
      corrections: [{ ...corrections[0], note: 'quietly rewritten' }, corrections[1]],
    })
    expect(rewrite.status).toBe(400)

    const erase = await patchArticle(f.tokens.sectionEditor, id, { corrections: [corrections[0]] })
    expect(erase.status).toBe(400)
    const wipe = await patchArticle(f.tokens.sectionEditor, id, { corrections: [] })
    expect(wipe.status).toBe(400)
    const reorder = await patchArticle(f.tokens.sectionEditor, id, { corrections: [corrections[1], corrections[0]] })
    expect(reorder.status).toBe(400)
    const backdate = await patchArticle(f.tokens.sectionEditor, id, {
      corrections: [{ ...corrections[0], correctedAt: '2000-01-01T00:00:00.000Z' }, corrections[1]],
    })
    expect(backdate.status).toBe(400)

    const stored = (await f.payload.findByID({ collection: 'articles', id, depth: 0, overrideAccess: true })) as {
      corrections: Correction[]
    }
    expect(stored.corrections.map((c) => c.note)).toEqual(['first note', 'second note'])
  })

  it('appends with a server-set correctedAt and audits it', async () => {
    const { id, corrections } = await publishedWithCorrections(['first note'])
    const ok = await patchArticle(f.tokens.sectionEditor, id, {
      title: `${runId} corrected title`,
      corrections: [corrections[0], { note: 'second note', correctedAt: '1999-01-01T00:00:00.000Z' }],
    })
    expect(ok.status).toBe(200)
    const list = ok.json.doc.corrections as Required<Correction>[]
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ id: corrections[0]!.id, note: 'first note' })
    expect(Date.parse(list[1]!.correctedAt)).toBeGreaterThan(Date.now() - 60_000)
    expect(list[1]!.note).toBe('second note')
    expect((await auditFor('articles', id)).map((a) => a.action)).toContain('correction')
  })

  it('refuses a material edit that re-sends the old corrections without adding one', async () => {
    const { id, corrections } = await publishedWithCorrections(['first note'])
    const res = await patchArticle(f.tokens.sectionEditor, id, {
      title: `${runId} sneaky`,
      corrections,
    })
    expect(res.status).toBe(400)
  })

  it('lets only an admin or editor-in-chief amend history, with a correction.amend audit entry', async () => {
    const { id, corrections } = await publishedWithCorrections(['typo in note'])
    const fixed = await patchArticle(f.tokens.eic, id, { corrections: [{ ...corrections[0], note: 'typo fixed in note' }] })
    expect(fixed.status).toBe(200)
    expect(fixed.json.doc.corrections[0].note).toBe('typo fixed in note')
    expect((await auditFor('articles', id)).map((a) => a.action)).toContain('correction.amend')

    const removed = await patchArticle(f.tokens.admin, id, { corrections: [] })
    expect(removed.status).toBe(200)
    expect(removed.json.doc.corrections ?? []).toHaveLength(0)
    expect((await auditFor('articles', id)).filter((a) => a.action === 'correction.amend')).toHaveLength(2)
  })

  it('does not let someone who cannot edit the article add a correction', async () => {
    const { id, corrections } = await publishedWithCorrections(['first note'])
    // The reporter authored it but cannot edit a published article.
    const res = await patchArticle(f.tokens.reporter, id, { corrections: [...corrections, { note: 'forged' }] })
    expect([403, 404]).toContain(res.status)
    // A trusted publisher in scope who is not the author cannot either.
    const res2 = await patchArticle(f.tokens.trusted, id, { corrections: [...corrections, { note: 'forged' }] })
    expect([403, 404]).toContain(res2.status)
    const stored = (await f.payload.findByID({ collection: 'articles', id, depth: 0, overrideAccess: true })) as {
      corrections: Correction[]
    }
    expect(stored.corrections).toHaveLength(1)
  })
})

describe('8. canonical comparison of content', () => {
  const reorderKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(reorderKeys)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .reverse()
          .map(([k, val]) => [k, reorderKeys(val)]),
      )
    }
    return v
  }

  it('does not demand a correction when the content is semantically unchanged', async () => {
    const art = await f.seedArticle({ status: 'published', publishedAt: iso(-1000), author: f.users.reporter.id })
    const stored = (await f.payload.findByID({ collection: 'articles', id: art.id, depth: 0, overrideAccess: true })) as {
      content: unknown
      title: string
    }
    const res = await patchArticle(f.tokens.sectionEditor, art.id, {
      title: stored.title,
      content: reorderKeys(stored.content),
      bylineName: 'New Byline',
    })
    expect(res.status).toBe(200)
    expect(res.json.doc.bylineName).toBe('New Byline')
  })

  it('still demands a correction for a real change', async () => {
    const art = await f.seedArticle({ status: 'published', publishedAt: iso(-1000), author: f.users.reporter.id })
    const res = await patchArticle(f.tokens.sectionEditor, art.id, { content: lexical('Entirely different body text.') })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------------------------
// 12. Password / e-mail changes need the current password; conversions are atomic
// ---------------------------------------------------------------------------------------------

const STRONG = 'Correct-horse-battery-staple-91'
let userN = 0
async function mkUser(role = 'reporter') {
  const key = `rf${++userN}`
  const email = `${runId}-${key}@test.invalid`
  const user = (await f.payload.create({
    collection: 'users',
    data: { email, name: `${runId} ${key}`, password: PASSWORD, role, sections: [] } as never,
    overrideAccess: true,
  })) as { id: number }
  const login = await api('POST', '/api/users/login', { body: { email, password: PASSWORD }, headers: withIp() })
  expect(login.status).toBe(200)
  return { id: user.id, email, token: login.json.token as string }
}
const rawUser = (id: number) =>
  f.payload.db.findOne({ collection: 'users', where: { id: { equals: id } } }) as Promise<Record<string, any>>

describe('12a. password and e-mail changes', () => {
  it('requires the current password to change your own password', async () => {
    const u = await mkUser()
    const missing = await api('PATCH', `/api/users/${u.id}`, { token: u.token, body: { password: STRONG } })
    expect(missing.status).toBe(400)
    expect(missing.text).toMatch(/currentPassword/)
    const wrong = await api('PATCH', `/api/users/${u.id}`, {
      token: u.token,
      body: { password: STRONG, currentPassword: 'not-my-password-123' },
    })
    expect(wrong.status).toBe(403)
    // Still the old password.
    expect((await api('POST', '/api/users/login', { body: { email: u.email, password: PASSWORD }, headers: withIp() })).status).toBe(200)

    const ok = await api('PATCH', `/api/users/${u.id}`, {
      token: u.token,
      body: { password: STRONG, currentPassword: PASSWORD },
    })
    expect(ok.status).toBe(200)
    expect(JSON.stringify(ok.json)).not.toContain(PASSWORD)
    expect((await api('POST', '/api/users/login', { body: { email: u.email, password: STRONG }, headers: withIp() })).status).toBe(200)
    expect(await rawUser(u.id)).not.toHaveProperty('currentPassword')
  })

  it('requires the current password to change your own e-mail but not your name', async () => {
    const u = await mkUser()
    const name = await api('PATCH', `/api/users/${u.id}`, { token: u.token, body: { name: `${runId} renamed` } })
    expect(name.status).toBe(200)

    const newEmail = `${runId}-moved${u.id}@test.invalid`
    const missing = await api('PATCH', `/api/users/${u.id}`, { token: u.token, body: { email: newEmail } })
    expect(missing.status).toBe(400)
    const wrong = await api('PATCH', `/api/users/${u.id}`, { token: u.token, body: { email: newEmail, currentPassword: 'wrong-wrong-123' } })
    expect(wrong.status).toBe(403)
    expect((await rawUser(u.id)).email).toBe(u.email)

    const ok = await api('PATCH', `/api/users/${u.id}`, { token: u.token, body: { email: newEmail, currentPassword: PASSWORD } })
    expect(ok.status).toBe(200)
    expect((await rawUser(u.id)).email).toBe(newEmail)

    // Re-sending the unchanged e-mail is not a change.
    const same = await api('PATCH', `/api/users/${u.id}`, { token: u.token, body: { email: newEmail, name: `${runId} again` } })
    expect(same.status).toBe(200)
  })

  it('locks the account after repeated wrong current passwords (no free password oracle)', async () => {
    const u = await mkUser()
    for (let i = 0; i < 5; i++) {
      const res = await api('PATCH', `/api/users/${u.id}`, { token: u.token, body: { password: STRONG, currentPassword: `wrong-${i}-xxxxxxxx` } })
      expect(res.status).toBe(403)
    }
    const login = await api('POST', '/api/users/login', { body: { email: u.email, password: PASSWORD }, headers: withIp() })
    expect(login.status).toBe(401) // locked
    await f.payload.update({ collection: 'users', id: u.id, data: { loginAttempts: 0, lockUntil: null } as never, overrideAccess: true, context: { seed: true } })
  })

  it('does not require it when an admin changes someone else, and audits both kinds without values', async () => {
    const u = await mkUser()
    const adminChange = await api('PATCH', `/api/users/${u.id}`, { token: f.tokens.admin, body: { password: STRONG } })
    expect(adminChange.status).toBe(200)

    const u2 = await mkUser()
    const newEmail = `${runId}-audit${u2.id}@test.invalid`
    const selfChange = await api('PATCH', `/api/users/${u2.id}`, {
      token: u2.token,
      body: { email: newEmail, password: STRONG, currentPassword: PASSWORD },
    })
    expect(selfChange.status).toBe(200)

    const byAdmin = await auditFor('users', u.id)
    expect(byAdmin.map((a) => a.action)).toContain('user.password-change')
    const own = await auditFor('users', u2.id)
    expect(own.map((a) => a.action)).toEqual(expect.arrayContaining(['user.password-change', 'user.email-change']))
    const blob = JSON.stringify([...byAdmin, ...own].filter((a) => /password|email/.test(a.action) && a.action !== 'user.create'))
    for (const secret of [STRONG, PASSWORD, u2.email, newEmail]) expect(blob).not.toContain(secret)
    const adminEntry = byAdmin.find((a) => a.action === 'user.password-change')!
    expect(adminEntry.actor).toBe(f.users.admin.id)
  })
})

describe('12b. converting a submission is atomic', () => {
  let n = 0
  async function mkSubmission() {
    const title = `${runId} Convert race ${++n}`
    const doc = (await f.payload.create({
      collection: 'submissions',
      data: {
        name: 'Ada Obi',
        email: `race${n}.${runId}@example.com`,
        title,
        body: 'A story body that is long enough for the converter to use as article content.',
        status: 'new',
      } as never,
      overrideAccess: true,
    })) as { id: number }
    return { id: doc.id, title }
  }
  const convert = (id: number, token = f.tokens.eic) =>
    api('POST', `/api/submissions/${id}/convert`, { token, body: { category: f.catA.id } })

  it('lets exactly one of two concurrent conversions win', async () => {
    const sub = await mkSubmission()
    const results = await Promise.all([convert(sub.id), convert(sub.id), convert(sub.id, f.tokens.admin)])
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([201, 409, 409])

    const articles = await f.payload.find({
      collection: 'articles',
      where: { title: { equals: sub.title } },
      depth: 0,
      overrideAccess: true,
    })
    expect(articles.totalDocs).toBe(1)
    const stored = await f.payload.findByID({ collection: 'submissions', id: sub.id, depth: 0, overrideAccess: true })
    expect(stored.status).toBe('converted')
    expect(stored.article).toBe(articles.docs[0]!.id)
  })

  it('rolls the claim back when the article cannot be created', async () => {
    const sub = await mkSubmission()
    const original = f.payload.create.bind(f.payload)
    const spy = vi.spyOn(f.payload, 'create').mockImplementationOnce((async (args: { collection: string }) => {
      if (args.collection === 'articles') throw Object.assign(new Error('boom'), { status: 400 })
      return original(args as never)
    }) as never)
    const failed = await convert(sub.id)
    spy.mockRestore()
    expect(failed.status).toBe(400)
    const after = await f.payload.findByID({ collection: 'submissions', id: sub.id, depth: 0, overrideAccess: true })
    expect(after.status).toBe('new')
    expect(after.article ?? null).toBeNull()

    const retry = await convert(sub.id)
    expect(retry.status).toBe(201)
  })
})

// ---------------------------------------------------------------------------------------------
// 4. Rate limits use the address the trusted proxy appended, not a client-supplied prefix
// ---------------------------------------------------------------------------------------------

describe('4. client IP for rate limiting', () => {
  it('cannot be evaded by prepending addresses to X-Forwarded-For', async () => {
    const real = '203.0.113.200'
    const attempt = (spoof: string) =>
      api('POST', '/api/users/login', {
        body: { email: `${runId}-nobody@test.invalid`, password: 'not-a-password-123' },
        headers: { 'x-forwarded-for': `${spoof}, ${real}` },
      })
    const limit = Number(process.env.AUTH_LOGIN_RATE_LIMIT || 10)
    for (let i = 0; i < limit; i++) expect((await attempt(`6.6.6.${i + 1}`)).status).toBe(401)
    expect((await attempt('6.6.6.250')).status).toBe(429)
    // A genuinely different client (different appended address) is unaffected.
    const other = await api('POST', '/api/users/login', {
      body: { email: `${runId}-nobody@test.invalid`, password: 'not-a-password-123' },
      headers: { 'x-forwarded-for': '6.6.6.1, 203.0.113.201' },
    })
    expect(other.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------------------------
// 11. Restoring a published article
// ---------------------------------------------------------------------------------------------

describe('11. restoreVersion on a published article', () => {
  async function articleWithTwoVersions() {
    const art = await f.seedArticle({
      status: 'published',
      publishedAt: iso(-60_000),
      author: f.users.reporter.id,
      title: `${runId} original headline`,
    })
    const edit = await patchArticle(f.tokens.eic, art.id, {
      title: `${runId} corrected headline`,
      corrections: [{ note: 'Headline corrected.' }],
    })
    expect(edit.status).toBe(200)
    const versions = await f.payload.findVersions({
      collection: 'articles',
      where: { parent: { equals: art.id } },
      sort: 'createdAt',
      limit: 10,
      overrideAccess: true,
    })
    expect(versions.docs.length).toBeGreaterThanOrEqual(2)
    return { id: art.id, firstVersion: versions.docs[0]!.id as number | string }
  }

  it('is refused for a section editor (the corrections rule applies) and allowed for admin / editor-in-chief, audited', async () => {
    const { id, firstVersion } = await articleWithTwoVersions()
    const denied = await api('POST', `/api/articles/versions/${firstVersion}`, { token: f.tokens.sectionEditor })
    expect(denied.status).toBe(400)
    expect((await f.payload.findByID({ collection: 'articles', id, depth: 0, overrideAccess: true })).title).toBe(
      `${runId} corrected headline`,
    )

    const ok = await api('POST', `/api/articles/versions/${firstVersion}`, { token: f.tokens.eic })
    expect(ok.status).toBe(200)
    const restored = await f.payload.findByID({ collection: 'articles', id, depth: 0, overrideAccess: true })
    expect(restored.title).toBe(`${runId} original headline`)
    expect((await auditFor('articles', id)).map((a) => a.action)).toContain('article.restore')

    // A plain PATCH is not a restore: the same change without a new entry is still refused.
    const patchBack = await patchArticle(f.tokens.eic, id, { title: `${runId} corrected headline` })
    expect(patchBack.status).toBe(400)
  })

  it('does not let a reporter restore anything', async () => {
    const { firstVersion } = await articleWithTwoVersions()
    const res = await api('POST', `/api/articles/versions/${firstVersion}`, { token: f.tokens.reporter })
    expect([403, 404]).toContain(res.status)
  })
})

// ---------------------------------------------------------------------------------------------
// 12c. Reset through the e-mailed link is audited too
// ---------------------------------------------------------------------------------------------

describe('12c. password reset audit', () => {
  it('records user.password-reset without the token or the password', async () => {
    const u = await mkUser()
    const forgot = await api('POST', '/api/users/forgot-password', { body: { email: u.email }, headers: withIp() })
    expect(forgot.status).toBe(200)
    const token = (await rawUser(u.id)).resetPasswordToken as string
    expect(token).toBeTruthy()
    const reset = await api('POST', '/api/users/reset-password', { body: { token, password: STRONG }, headers: withIp() })
    expect(reset.status).toBe(200)

    const entries = (await auditFor('users', u.id)).filter((a) => a.action === 'user.password-reset')
    expect(entries).toHaveLength(1)
    expect(JSON.stringify(entries)).not.toContain(token)
    expect(JSON.stringify(entries)).not.toContain(STRONG)
  })
})
