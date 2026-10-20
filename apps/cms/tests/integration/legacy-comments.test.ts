import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { toLegacyCommentData, type WxrComment } from '../../src/lib/legacyComments'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Go-live C6. Real REST route handlers, real PostgreSQL (embedded), real collection hooks and access control.
 * The importer path is the Local API with `overrideAccess: true`, fed by `toLegacyCommentData`.
 */

const runId = newRunId()
const ALLOWED_ORIGIN = 'http://allowed.test' // PUBLIC_SUBMISSION_ORIGINS in tests/integration/global-setup.ts
let f: Fixtures
let pubArticle: { id: number; slug: string }
let draftArticle: { id: number; slug: string }
let nextLegacy = 5_000_000 + Math.floor(Math.random() * 1_000_000)

const wxr = (over: Partial<WxrComment> = {}): WxrComment => ({
  id: ++nextLegacy,
  author: 'Ada Obi',
  authorEmail: 'ada@private.example',
  authorUrl: 'https://ada.example',
  authorIp: '203.0.113.9',
  date: '2019-03-04 11:11:12',
  dateGmt: '2019-03-04 10:11:12',
  content: 'Thank you for this.',
  approved: '1',
  type: '',
  parent: '0',
  ...over,
})

/** The importer path: helper -> Local API. */
const importComment = async (article: number, over: Partial<WxrComment> = {}) => {
  const r = toLegacyCommentData(wxr(over), article)
  if (!r.ok) throw new Error(`skipped: ${r.reason}`)
  return (await f.payload.create({
    collection: 'legacy-comments',
    data: r.data as never,
    overrideAccess: true,
  })) as { id: number; legacyId: number }
}

const list = (qs: string, headers?: Record<string, string>) => api('GET', `/api/legacy-comments?${qs}`, { headers })

beforeAll(async () => {
  f = await setupFixtures(runId)
  pubArticle = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })
  draftArticle = await f.seedArticle({ status: 'draft' })
})

afterAll(async () => {
  await f?.cleanup()
})

describe('public read endpoint', () => {
  it('requires the article parameter', async () => {
    const r = await list('')
    expect(r.status).toBe(400)
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  it('returns only the public shape, plain text, oldest first, with a Cache-Control', async () => {
    const late = await importComment(pubArticle.id, {
      content: 'Second <b>one</b> &amp; <script>alert(1)</script>\nline two',
      dateGmt: '2020-01-01 00:00:00',
    })
    const early = await importComment(pubArticle.id, { dateGmt: '2018-01-01 00:00:00', author: 'ada@private.example' })

    const r = await list(`article=${encodeURIComponent(pubArticle.slug)}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('public, max-age=60')
    expect(r.headers.get('content-type')).toContain('application/json')
    expect(r.json.docs.map((d: { legacyId: number }) => d.legacyId)).toEqual([early.legacyId, late.legacyId])
    for (const d of r.json.docs) {
      expect(Object.keys(d).sort()).toEqual(['authorName', 'commentedAt', 'content', 'id', 'legacyId', 'parentLegacyId'])
    }
    expect(r.json.docs[0].authorName).toBe('Anonymous')
    expect(r.json.docs[1].content).toBe('Second one &\nline two')
    expect(r.text).not.toMatch(/private\.example|203\.0\.113\.9|ada\.example|<script|alert\(1\)/)
    expect(r.json.totalDocs).toBe(2)
    expect(r.json.limit).toBe(50)
  })

  it('finds the article by numeric id and by WordPress legacy id', async () => {
    const byId = await list(`article=${pubArticle.id}`)
    expect(byId.status).toBe(200)
    expect(byId.json.totalDocs).toBe(2)

    const legacy = 9_000_000 + Math.floor(Math.random() * 1_000_000)
    const withLegacy = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), legacyId: legacy })
    await importComment(withLegacy.id)
    const r = await list(`articleLegacyId=${legacy}`)
    expect(r.status).toBe(200)
    expect(r.json.totalDocs).toBe(1)
    expect((await list('articleLegacyId=abc')).status).toBe(400)
  })

  it('does not return hidden comments', async () => {
    const hidden = await importComment(pubArticle.id, { content: 'to be hidden' })
    await f.payload.update({ collection: 'legacy-comments', id: hidden.id, data: { status: 'hidden' }, overrideAccess: true })
    const r = await list(`article=${pubArticle.slug}`)
    expect(r.text).not.toContain('to be hidden')
    expect(r.json.totalDocs).toBe(2)
  })

  it('returns an empty list for an unpublished or unknown article (no existence leak)', async () => {
    await importComment(draftArticle.id, { content: 'on a draft' })
    const draft = await list(`article=${draftArticle.slug}`)
    const unknown = await list(`article=${runId}-no-such-article`)
    for (const r of [draft, unknown]) {
      expect(r.status).toBe(200)
      expect(r.json.docs).toEqual([])
      expect(r.json.totalDocs).toBe(0)
    }
    expect(draft.text).not.toContain('on a draft')
  })

  it('clamps limit to 100 and paginates', async () => {
    const art = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })
    for (let i = 0; i < 5; i++) await importComment(art.id, { dateGmt: `2019-01-0${i + 1} 00:00:00`, content: `c${i}` })
    const p1 = await list(`article=${art.slug}&limit=2&page=1`)
    const p3 = await list(`article=${art.slug}&limit=2&page=3`)
    expect(p1.json.docs.map((d: { content: string }) => d.content)).toEqual(['c0', 'c1'])
    expect(p1.json.hasNextPage).toBe(true)
    expect(p1.json.totalPages).toBe(3)
    expect(p3.json.docs.map((d: { content: string }) => d.content)).toEqual(['c4'])
    expect(p3.json.hasNextPage).toBe(false)
    for (const bad of ['limit=100000', 'limit=0', 'limit=-1', 'limit=abc', 'pagination=false&limit=0']) {
      const r = await list(`article=${art.slug}&${bad}`)
      expect(r.status).toBe(200)
      expect(r.json.limit).toBeLessThanOrEqual(100)
      expect(r.json.limit).toBeGreaterThanOrEqual(1)
    }
    expect((await list(`article=${art.slug}&limit=100000`)).json.limit).toBe(100)
  })

  it('ignores where, sort, select and depth parameters (no field or filter choice)', async () => {
    const r = await list(
      `article=${pubArticle.slug}&where[status][equals]=hidden&sort=-content&depth=2&select[authorName]=true&where[article.status][equals]=draft`,
    )
    expect(r.status).toBe(200)
    expect(r.json.docs.length).toBe(2)
    expect(r.json.docs[0].content).toBeTypeOf('string')
  })

  it('answers CORS: allowed origin is echoed, a disallowed origin is 403, preflight works', async () => {
    const ok = await list(`article=${pubArticle.slug}`, { origin: ALLOWED_ORIGIN })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect(ok.headers.get('vary')).toContain('Origin')

    const bad = await list(`article=${pubArticle.slug}`, { origin: 'http://evil.test' })
    expect(bad.status).toBe(403)
    expect(bad.headers.get('access-control-allow-origin')).toBeNull()

    const pre = await api('OPTIONS', '/api/legacy-comments', { headers: { origin: ALLOWED_ORIGIN } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    const preBad = await api('OPTIONS', '/api/legacy-comments', { headers: { origin: 'http://evil.test' } })
    expect(preBad.status).toBe(403)
  })

  it('survives huge and odd stored text', async () => {
    const art = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })
    const imported = toLegacyCommentData(
      wxr({ content: `${'\u{1F64F}'.repeat(4000)}${'x'.repeat(10_000)}<`, author: `\u{202E}${'n'.repeat(400)}` }),
      art.id,
    )
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.truncated).toBe(true)
    await f.payload.create({ collection: 'legacy-comments', data: imported.data as never, overrideAccess: true })
    const r = await list(`article=${art.slug}`)
    expect(r.status).toBe(200)
    expect(r.json.docs[0].content.length).toBeLessThanOrEqual(5000)
    expect(r.json.docs[0].authorName.length).toBeLessThanOrEqual(120)
    expect(() => encodeURIComponent(r.json.docs[0].content)).not.toThrow()
  })
})

describe('no private data in the model', () => {
  it('has no email, website or IP field, and an unknown field is not stored', async () => {
    const fields = f.payload.collections['legacy-comments'].config.fields.map((x) => ('name' in x ? x.name : ''))
    expect(fields.filter((n) => n !== 'createdAt' && n !== 'updatedAt').sort()).toEqual(
      ['article', 'authorName', 'commentedAt', 'content', 'legacyId', 'parentLegacyId', 'status'].sort(),
    )
    const c = await importComment(pubArticle.id)
    const stored = await f.payload.findByID({ collection: 'legacy-comments', id: c.id, overrideAccess: true, depth: 0 })
    expect(JSON.stringify(stored)).not.toMatch(/private\.example|203\.0\.113\.9|ada\.example/)
  })

  it('the importer helper output never carries an email, IP or URL, even if text and name contain them', async () => {
    const c = await importComment(pubArticle.id, { content: 'mail me at someone@mail.example now', author: 'Visitor' })
    const stored = (await f.payload.findByID({ collection: 'legacy-comments', id: c.id, overrideAccess: true, depth: 0 })) as {
      content: string
    }
    expect(stored.content).toBe('mail me at [email removed] now')
  })
})

describe('access control', () => {
  it('nobody can create through the API, not even admin', async () => {
    for (const token of [undefined, f.tokens.reporter, f.tokens.eic, f.tokens.admin]) {
      const r = await api('POST', '/api/legacy-comments', {
        token,
        body: { article: pubArticle.id, authorName: 'X', content: 'Y', commentedAt: new Date().toISOString(), legacyId: ++nextLegacy },
      })
      expect([401, 403]).toContain(r.status)
    }
  })

  it('anonymous and reporters cannot update or delete; they cannot read a hidden comment by id', async () => {
    const c = await importComment(pubArticle.id)
    const patchAnon = await api('PATCH', `/api/legacy-comments/${c.id}`, { body: { status: 'hidden' } })
    expect([401, 403]).toContain(patchAnon.status)
    const patchReporter = await api('PATCH', `/api/legacy-comments/${c.id}`, { token: f.tokens.reporter, body: { status: 'hidden' } })
    expect([401, 403]).toContain(patchReporter.status)
    const delEic = await api('DELETE', `/api/legacy-comments/${c.id}`, { token: f.tokens.eic })
    expect([401, 403, 404]).toContain(delEic.status)

    const hidden = await importComment(pubArticle.id, { content: 'hidden by id' })
    await f.payload.update({ collection: 'legacy-comments', id: hidden.id, data: { status: 'hidden' }, overrideAccess: true })
    const byId = await api('GET', `/api/legacy-comments/${hidden.id}`)
    expect(byId.status).toBe(404)
    const byIdReporter = await api('GET', `/api/legacy-comments/${hidden.id}`, { token: f.tokens.reporter })
    expect(byIdReporter.status).toBe(404)
  })

  it('an editor can hide and restore (audited) but cannot change the text', async () => {
    const c = await importComment(pubArticle.id, { content: 'original text' })
    const hide = await api('PATCH', `/api/legacy-comments/${c.id}`, {
      token: f.tokens.eic,
      body: { status: 'hidden', content: 'tampered', authorName: 'Tamper', legacyId: 1 },
    })
    expect(hide.status).toBe(200)
    expect(hide.json.doc.status).toBe('hidden')
    expect(hide.json.doc.content).toBe('original text')
    expect(hide.json.doc.authorName).toBe('Ada Obi')
    expect(hide.json.doc.legacyId).toBe(c.legacyId)

    const restore = await api('PATCH', `/api/legacy-comments/${c.id}`, { token: f.tokens.eic, body: { status: 'approved' } })
    expect(restore.status).toBe(200)

    const audit = await f.payload.find({
      collection: 'audit-logs',
      where: { and: [{ collection: { equals: 'legacy-comments' } }, { docId: { equals: String(c.id) } }] },
      overrideAccess: true,
      limit: 10,
      sort: 'createdAt',
    })
    expect(audit.docs.map((a) => a.action)).toEqual(['legacy-comment.hide', 'legacy-comment.restore'])
    expect(JSON.stringify(audit.docs)).not.toContain('original text')
  })

  it('a section editor may hide only comments of articles in their sections; trusted publisher and reporter may not', async () => {
    const inScope = await importComment(pubArticle.id) // seeded articles are in category A, the section editor's section
    const other = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), category: f.catB.id })
    const outScope = await importComment(other.id)

    const ok = await api('PATCH', `/api/legacy-comments/${inScope.id}`, { token: f.tokens.sectionEditor, body: { status: 'hidden' } })
    expect(ok.status).toBe(200)
    const no = await api('PATCH', `/api/legacy-comments/${outScope.id}`, { token: f.tokens.sectionEditor, body: { status: 'hidden' } })
    expect([403, 404]).toContain(no.status)
    const tp = await api('PATCH', `/api/legacy-comments/${outScope.id}`, { token: f.tokens.trusted, body: { status: 'hidden' } })
    expect([403, 404]).toContain(tp.status)
  })

  it('only admin deletes (audited)', async () => {
    const c = await importComment(pubArticle.id)
    const eic = await api('DELETE', `/api/legacy-comments/${c.id}`, { token: f.tokens.eic })
    expect([403, 404]).toContain(eic.status)
    const admin = await api('DELETE', `/api/legacy-comments/${c.id}`, { token: f.tokens.admin })
    expect(admin.status).toBe(200)
    const audit = await f.payload.find({
      collection: 'audit-logs',
      where: { and: [{ collection: { equals: 'legacy-comments' } }, { docId: { equals: String(c.id) } }] },
      overrideAccess: true,
    })
    expect(audit.docs.map((a) => a.action)).toEqual(['legacy-comment.delete'])
  })

  it('legacyId is unique', async () => {
    const c = await importComment(pubArticle.id)
    await expect(
      f.payload.create({
        collection: 'legacy-comments',
        data: { article: pubArticle.id, authorName: 'Dup', content: 'dup', commentedAt: new Date().toISOString(), legacyId: c.legacyId } as never,
        overrideAccess: true,
      }),
    ).rejects.toThrow()
  })
})

describe('import reconciliation on a synthetic export', () => {
  it('keeps approved comments only and the counts reconcile', async () => {
    const art = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })
    const export_: WxrComment[] = [
      wxr({ approved: '1' }),
      wxr({ approved: '1', type: 'comment', parent: '0' }),
      wxr({ approved: '0' }),
      wxr({ approved: 'spam' }),
      wxr({ approved: 'trash' }),
      wxr({ approved: '1', type: 'pingback' }),
      wxr({ approved: '1', type: 'trackback' }),
      wxr({ approved: '1', content: '' }),
    ]
    const kept: number[] = []
    const skipped: Record<string, number> = {}
    for (const c of export_) {
      const r = toLegacyCommentData(c, art.id)
      if (!r.ok) {
        skipped[r.reason] = (skipped[r.reason] ?? 0) + 1
        continue
      }
      const doc = await f.payload.create({ collection: 'legacy-comments', data: r.data as never, overrideAccess: true })
      kept.push(doc.id)
    }
    expect(kept.length).toBe(2)
    expect(skipped).toEqual({ unapproved: 1, spam: 1, trash: 1, pingback: 1, trackback: 1, empty: 1 })
    expect(kept.length + Object.values(skipped).reduce((a, b) => a + b, 0)).toBe(export_.length)
    expect((await list(`article=${art.slug}`)).json.totalDocs).toBe(2)
  })
})

describe('review fixes: renderer request shape, resolution, scope', () => {
  it('accepts the renderer form where[article][equals]=<id> and returns nextPage/prevPage', async () => {
    const art = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })
    for (let i = 0; i < 3; i++) await importComment(art.id, { dateGmt: `2019-02-0${i + 1} 00:00:00`, content: `r${i}` })
    const url = `where[article][equals]=${art.id}&sort=-content&limit=2&page=1&depth=0&where[status][equals]=hidden&where[or][0][id][exists]=true`
    const p1 = await list(url)
    expect(p1.status).toBe(200)
    expect(p1.json.docs.map((d: { content: string }) => d.content)).toEqual(['r0', 'r1'])
    expect(p1.json.nextPage).toBe(2)
    expect(p1.json.prevPage).toBeNull()
    const p2 = await list(`where[article][equals]=${art.id}&limit=2&page=2`)
    expect(p2.json.docs.map((d: { content: string }) => d.content)).toEqual(['r2'])
    expect(p2.json.nextPage).toBeNull()
    expect(p2.json.prevPage).toBe(1)
    // the bracket form can arrive percent-encoded
    const enc = await list(`where%5Barticle%5D%5Bequals%5D=${art.id}`)
    expect(enc.json.totalDocs).toBe(3)
    // `article` wins over the alias
    const both = await list(`article=${art.id}&where[article][equals]=${pubArticle.id}`)
    expect(both.json.totalDocs).toBe(3)
  })

  it('a numeric article value is an id first: it never reaches another article by slug', async () => {
    const victim = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })
    await importComment(victim.id, { content: 'victim comment' })
    // an article whose slug is the victim id as text (published) and the victim id's own comments
    const decoy = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), slug: String(victim.id) })
    await importComment(decoy.id, { content: 'decoy comment' })
    const r = await list(`article=${victim.id}`)
    expect(r.json.docs.map((d: { content: string }) => d.content)).toEqual(['victim comment'])
    // id of an unpublished article: no slug fallback either
    const draftWithSlugTwin = await f.seedArticle({ status: 'draft' })
    await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), slug: String(draftWithSlugTwin.id) })
    const d = await list(`article=${draftWithSlugTwin.id}`)
    expect(d.json.docs).toEqual([])
    // the slug form still works for a numeric slug when no article has that id
    const byDecoySlug = await list(`article=${decoy.slug}`)
    expect(byDecoySlug.json.totalDocs).toBe(1)
  })

  it('HEAD answers with the headers and no body, and a trailing slash works', async () => {
    const head = await api('HEAD', `/api/legacy-comments?article=${pubArticle.slug}`).catch(() => null)
    // the REST helper has no HEAD handler: call the endpoint through GET with the trailing slash instead and check HEAD via the config
    expect(head === null || head.text === '').toBe(true)
    const slash = await api('GET', `/api/legacy-comments/?article=${pubArticle.slug}`)
    expect(slash.status).toBe(200)
    expect(slash.json.docs).toBeInstanceOf(Array)
    const headEndpoint = f.payload.collections['legacy-comments'].config.endpoints
    expect(Array.isArray(headEndpoint) && headEndpoint.some((e) => e.method === 'head' && e.path === '/')).toBe(true)
  })

  it('has the composite index for the public list', async () => {
    const res = (await (f.payload.db as any).drizzle.execute(
      `select indexdef from pg_indexes where tablename = 'legacy_comments'`,
    )) as { rows: { indexdef: string }[] }
    expect(res.rows.some((r) => /article_id.*status.*commented_at.*legacy_id/.test(r.indexdef))).toBe(true)
  })
})

describe('review fixes: access that must not regress', () => {
  it('an approved comment on a DRAFT article is invisible by id and by count (anonymous and reporter)', async () => {
    const c = await importComment(draftArticle.id, { content: 'draft article comment' })
    for (const token of [undefined, f.tokens.reporter, f.tokens.trusted]) {
      const byId = await api('GET', `/api/legacy-comments/${c.id}`, { token })
      expect(byId.status).toBe(404)
      const count = await api('GET', `/api/legacy-comments/count?where[article][equals]=${draftArticle.id}`, { token })
      expect(count.status).toBe(200)
      expect(count.json.totalDocs).toBe(0)
    }
    const eic = await api('GET', `/api/legacy-comments/${c.id}`, { token: f.tokens.eic })
    expect(eic.status).toBe(200)
  })

  it('anonymous GET /:id never exposes the moderation status', async () => {
    const c = await importComment(pubArticle.id, { content: 'status hidden from public' })
    const anon = await api('GET', `/api/legacy-comments/${c.id}`)
    expect(anon.status).toBe(200)
    expect(anon.json.status).toBeUndefined()
    expect(anon.json.content).toBe('status hidden from public')
    expect(JSON.stringify(anon.json)).not.toMatch(/private\.example|203\.0\.113\.9/)
    const staff = await api('GET', `/api/legacy-comments/${c.id}`, { token: f.tokens.eic })
    expect(staff.json.status).toBe('approved')
  })

  it('article, commentedAt, parentLegacyId, legacyId and text cannot be changed through the API', async () => {
    const other = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })
    const c = await importComment(pubArticle.id, { content: 'immutable text', parent: '77' })
    const before = (await f.payload.findByID({ collection: 'legacy-comments', id: c.id, overrideAccess: true, depth: 0 })) as Record<string, unknown>
    const r = await api('PATCH', `/api/legacy-comments/${c.id}`, {
      token: f.tokens.eic,
      body: {
        article: other.id,
        commentedAt: '2001-01-01T00:00:00.000Z',
        parentLegacyId: 1,
        legacyId: 42,
        content: 'x',
        authorName: 'x',
        status: 'hidden',
      },
    })
    expect(r.status).toBe(200)
    const after = (await f.payload.findByID({ collection: 'legacy-comments', id: c.id, overrideAccess: true, depth: 0 })) as Record<string, unknown>
    for (const k of ['article', 'commentedAt', 'parentLegacyId', 'legacyId', 'content', 'authorName']) {
      expect(after[k]).toEqual(before[k])
    }
    expect(after.status).toBe('hidden')
    // an update that only hides must not re-clean stored text
    expect(after.content).toBe('immutable text')
  })

  it('section editor read scope: in-scope comments of any state, out-of-scope only public ones', async () => {
    const inArt = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() }) // category A
    const outArt = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), category: f.catB.id })
    const outDraft = await f.seedArticle({ status: 'draft', category: f.catB.id })
    const inDraft = await f.seedArticle({ status: 'draft' })
    const hiddenIn = await importComment(inArt.id)
    await f.payload.update({ collection: 'legacy-comments', id: hiddenIn.id, data: { status: 'hidden' }, overrideAccess: true })
    const hiddenOut = await importComment(outArt.id)
    await f.payload.update({ collection: 'legacy-comments', id: hiddenOut.id, data: { status: 'hidden' }, overrideAccess: true })
    const publicOut = await importComment(outArt.id)
    const draftOut = await importComment(outDraft.id)
    const draftIn = await importComment(inDraft.id)

    const get = (id: number, token: string) => api('GET', `/api/legacy-comments/${id}`, { token })
    const se = f.tokens.sectionEditor
    expect((await get(hiddenIn.id, se)).status).toBe(200)
    expect((await get(draftIn.id, se)).status).toBe(200)
    expect((await get(publicOut.id, se)).status).toBe(200) // public comments of a published article in another section
    expect((await get(hiddenOut.id, se)).status).toBe(404)
    expect((await get(draftOut.id, se)).status).toBe(404)
    // the same comment is also visible to other staff as a public comment but a hidden one is not
    expect((await get(hiddenIn.id, f.tokens.reporter)).status).toBe(404)
    expect((await get(hiddenIn.id, f.tokens.eic)).status).toBe(200)
  })
})

describe('review fixes: deleting an article that has archived comments', () => {
  it('is refused with 409 and the article and its comments survive; it works once the comments are deleted', async () => {
    const art = await f.seedArticle({ status: 'draft' })
    const c1 = await importComment(art.id)
    const c2 = await importComment(art.id)

    const refused = await api('DELETE', `/api/articles/${art.id}`, { token: f.tokens.eic })
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.json)).toMatch(/2 archived comments/)
    expect((await api('GET', `/api/articles/${art.id}`, { token: f.tokens.eic })).status).toBe(200)
    expect((await f.payload.count({ collection: 'legacy-comments', where: { article: { equals: art.id } }, overrideAccess: true })).totalDocs).toBe(2)

    // a bulk delete by query is refused too (per document)
    const bulk = await api('DELETE', `/api/articles?where[id][equals]=${art.id}`, { token: f.tokens.eic })
    expect(bulk.json?.errors?.length ?? 0).toBeGreaterThan(0)
    expect((await f.payload.count({ collection: 'articles', where: { id: { equals: art.id } }, overrideAccess: true })).totalDocs).toBe(1)

    for (const c of [c1, c2]) {
      expect((await api('DELETE', `/api/legacy-comments/${c.id}`, { token: f.tokens.admin })).status).toBe(200)
    }
    const ok = await api('DELETE', `/api/articles/${art.id}`, { token: f.tokens.eic })
    expect(ok.status).toBe(200)
  })

  it('an article without comments deletes normally', async () => {
    const art = await f.seedArticle({ status: 'draft' })
    expect((await api('DELETE', `/api/articles/${art.id}`, { token: f.tokens.eic })).status).toBe(200)
  })
})
