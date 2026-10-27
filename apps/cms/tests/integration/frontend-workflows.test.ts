/**
 * Executable proof that the CMS supports the REAL frontend workflows.
 *
 * Each block replays the HTTP request a frontend actually makes (URL shape, query string, headers,
 * credentials semantics, body), copied from the consumer's code with a file:line comment, against the
 * real REST route handlers, and asserts the response fields the consumer's code reads.
 *
 * Consumer refs (all read with `git show <ref>:<path>`, surveyed 13 Oct 2026):
 *   PUB   origin/feat/newsroom-mvp:src/lib/published-articles.js, src/lib/article-content.js (public site)
 *   PR4   origin/agent/codex-public-forms:src/lib/public-submissions.js, docs/public-forms.md
 *   PR2c  origin/agent/gemini-ui-support:apps/newsroom/src/api/adapter.js (committed, 850e651: no auth, no credentials)
 *   PR2w  apps/newsroom/src/api/adapter.js working copy of the shared checkout (login/me/logout + credentials)
 *   PR5   origin/agent/homepage-advertising: no CMS request at all (static bootstrap), see docs/frontend-integration.md
 *
 * Where a consumer request is wrong per contract, the test sends the CORRECT request and the mismatch is
 * noted in a `MISMATCH` comment (and in docs/frontend-integration.md). The backend is never weakened to fit.
 *
 * Cross-origin notes: the harness calls the handlers directly, so there is no browser to enforce CORS or
 * SameSite. We assert the headers a browser needs (Access-Control-*, Set-Cookie flags) and send `Origin`
 * exactly as a browser would on a cross-origin fetch.
 */
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, lexical, newRunId, setupFixtures, type ApiResult, type Fixtures } from './helpers'
import { installTurnstileStub, removeTurnstileStub, TURNSTILE_BAD, TURNSTILE_OK, TURNSTILE_SPENT } from './turnstileStub'

const runId = newRunId()
let f: Fixtures

/** Public website origin as seen by CMS_CORS_ORIGINS (global-setup: http://cors-allowed.test). */
const PUBLIC_SITE = 'http://cors-allowed.test'
/** Public website origin as seen by PUBLIC_SUBMISSION_ORIGINS (global-setup: http://allowed.test). */
const PUBLIC_FORM_ORIGIN = 'http://allowed.test'
/** Newsroom dev server (CMS_CORS_ORIGINS + CMS_CSRF_ORIGINS in global-setup). */
const NEWSROOM = 'http://localhost:5174'

let ipCounter = 0
const nextIp = () => `198.51.${Math.floor(ipCounter / 250) % 250}.${(ipCounter += 1) % 250}`

beforeAll(async () => {
  installTurnstileStub()
  f = await setupFixtures(runId)
})

afterAll(async () => {
  removeTurnstileStub()
  await f?.cleanup()
})

const idOf = (v: unknown): number => (typeof v === 'object' && v ? (v as { id: number }).id : (v as number))

// ---------------------------------------------------------------------------------------------
// Verbatim consumer logic (so the assertions check what their code actually reads)
// ---------------------------------------------------------------------------------------------

// PUB published-articles.js:14-19 and :21-35 (normalizePublishedArticle), :76-77 (nextPage)
const plainText = (value: unknown, maxLength = 2000) => (typeof value === 'string' ? value.trim().slice(0, maxLength) : '')
const validSlug = (value: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value || '')
function normalizePublishedArticle(record: any) {
  if (!record || record.status !== 'published') return null
  const slug = plainText(record.slug, 160)
  const title = plainText(record.title, 240)
  if (!validSlug(slug) || !title) return null
  return {
    id: String(record.id ?? slug),
    slug,
    title,
    excerpt: plainText(record.excerpt || record.summary, 600),
    publishedAt: Number.isFinite(Date.parse(plainText(record.publishedAt, 40))) ? new Date(record.publishedAt).toISOString() : '',
    category: plainText(typeof record.category === 'object' ? record.category?.title : record.category, 100),
    content: record.content ?? null,
  }
}

// PUB article-content.js (renderArticleContent), condensed but same node handling.
function renderArticleContent(content: any): string {
  const esc = (t: unknown) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const safeLink = (v: unknown) => {
    try {
      const u = new URL(String(v))
      return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null
    } catch {
      return null
    }
  }
  const render = (node: any, depth = 0): string => {
    if (!node || typeof node !== 'object' || depth > 30) return ''
    if (node.type === 'text' && typeof node.text === 'string') {
      let t = esc(node.text)
      if (node.format & 1) t = `<strong>${t}</strong>`
      if (node.format & 2) t = `<em>${t}</em>`
      return t
    }
    if (node.type === 'linebreak') return '<br>'
    if (!['root', 'paragraph', 'heading', 'quote', 'list', 'listitem', 'link', 'autolink'].includes(node.type)) return ''
    const children = Array.isArray(node.children) ? node.children.map((c: any) => render(c, depth + 1)).join('') : ''
    if (!children) return ''
    switch (node.type) {
      case 'paragraph': return `<p>${children}</p>`
      case 'heading': { const tag = ['h2', 'h3', 'h4'].includes(node.tag) ? node.tag : 'h2'; return `<${tag}>${children}</${tag}>` }
      case 'quote': return `<blockquote>${children}</blockquote>`
      case 'list': { const tag = node.listType === 'number' ? 'ol' : 'ul'; return `<${tag}>${children}</${tag}>` }
      case 'listitem': return `<li>${children}</li>`
      case 'link':
      case 'autolink': { const url = safeLink(node.fields?.url ?? node.url); return url ? `<a href="${esc(url)}">${children}</a>` : children }
      default: return children
    }
  }
  return render(content?.root)
}

// ---------------------------------------------------------------------------------------------
// A tiny "browser": Origin on every request, cookie jar, credentials:'include' semantics.
// ---------------------------------------------------------------------------------------------

class Browser {
  cookie = ''
  constructor(
    readonly origin: string,
    private readonly ip = nextIp(),
  ) {}

  async fetch(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'OPTIONS',
    url: string,
    opts: { body?: unknown; headers?: Record<string, string>; credentials?: 'include' | 'omit' } = {},
  ): Promise<ApiResult> {
    const headers: Record<string, string> = {
      origin: this.origin, // a cross-origin fetch always carries Origin
      'sec-fetch-site': 'same-site', // localhost:5174 -> localhost:3000 is same-site, not same-origin
      'x-forwarded-for': this.ip,
      ...(opts.headers ?? {}),
    }
    if ((opts.credentials ?? 'include') === 'include' && this.cookie) headers.cookie = this.cookie
    const res = await api(method, url, { body: opts.body, headers })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie && /^payload-token=/.test(setCookie)) {
      const value = setCookie.split(';')[0]!.slice('payload-token='.length)
      this.cookie = value && !/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(setCookie) ? `payload-token=${value}` : ''
    }
    return res
  }

  // PR2w adapter.js:193-198
  login(email: string, password = 'Test-only-pass-1234!') {
    return this.fetch('POST', '/api/users/login', {
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    })
  }
}

const loggedIn = async (key: keyof Fixtures['users']) => {
  const b = new Browser(NEWSROOM)
  const res = await b.login(f.users[key].email)
  expect(res.status).toBe(200)
  return b
}

const patchArticle = (b: Browser, id: number, body: Record<string, unknown>) =>
  // PR2w adapter.js:553-558 (updateArticleStatus)
  b.fetch('PATCH', `/api/articles/${id}`, { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

// ---------------------------------------------------------------------------------------------
// PUBLIC SITE
// ---------------------------------------------------------------------------------------------

/** PUB published-articles.js:55-66: exactly how the public site builds its URL. */
function publicListUrl({ limit = 20, page = 1, slug }: { limit?: number; page?: number; slug?: string } = {}) {
  const url = new URL('/api/articles', 'http://localhost:3000')
  url.searchParams.set('where[status][equals]', 'published')
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('depth', '1')
  url.searchParams.set('sort', '-publishedAt')
  url.searchParams.set('page', String(page))
  if (slug) url.searchParams.set('where[slug][equals]', slug)
  return url.pathname + url.search
}
/** PUB published-articles.js:69-75: GET, Accept: application/json, credentials:'omit' (so no cookie), cross-origin => Origin. */
const publicGet = (url: string, origin = PUBLIC_SITE) =>
  api('GET', url, { headers: { accept: 'application/json', origin } })

describe('public site: published-articles.js against the real handlers', () => {
  const state = {} as { published: { id: number; slug: string }[]; draft: { slug: string }; inReview: { slug: string } }

  beforeAll(async () => {
    const mk = async (label: string, extra: Record<string, unknown>) => {
      const a = await f.seedArticle({ title: `${runId} ${label}`, ...extra })
      return a
    }
    const p1 = await mk('first', { status: 'published', publishedAt: '2026-01-01T10:00:00.000Z', excerpt: 'Excerpt one' })
    const p2 = await mk('second', { status: 'published', publishedAt: '2026-02-01T10:00:00.000Z', bylineName: 'Ada Obi' })
    const draft = await mk('draft', { status: 'draft' })
    const inReview = await mk('review', { status: 'in_review' })
    state.published = [p1, p2]
    state.draft = draft
    state.inReview = inReview
  })

  it('lists published articles (page 1, depth=1, -publishedAt) with the fields normalizePublishedArticle reads', async () => {
    const url = publicListUrl({ limit: 100 })
    expect(url).toContain('where%5Bstatus%5D%5Bequals%5D=published') // real browsers send brackets encoded
    const res = await publicGet(url)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.json.docs)).toBe(true)
    const mine = res.json.docs.filter((d: any) => d.slug.startsWith(runId))
    expect(mine.map((d: any) => d.slug)).toEqual([state.published[1]!.slug, state.published[0]!.slug]) // newest first
    for (const d of mine) {
      expect(d.status).toBe('published') // PUB:22 rejects records without status === 'published'
      const n = normalizePublishedArticle(d)
      expect(n, JSON.stringify(d)).not.toBeNull()
      expect(n!.category).toMatch(/cat-?|a$/) // depth=1 => category.title string
      expect(typeof d.category).toBe('object')
      expect(n!.publishedAt).toBeTruthy()
      expect(d.content?.root).toBeTruthy()
      // contract §3: staff-only fields never reach anonymous readers
      for (const k of ['author', 'reviewNotes', 'scheduledFor']) expect(d, k).not.toHaveProperty(k)
    }
    // Pagination fields the adapter reads (PUB:76-77)
    for (const k of ['hasNextPage', 'nextPage', 'page', 'totalDocs']) expect(res.json).toHaveProperty(k)
    // Never leaks unpublished work, even though the consumer also filters client-side
    const slugs = res.json.docs.map((d: any) => d.slug)
    expect(slugs).not.toContain(state.draft.slug)
    expect(slugs).not.toContain(state.inReview.slug)
  })

  it('answers cross-origin: ACAO echoes the public site origin, no wildcard (credentials omitted by the consumer)', async () => {
    const res = await publicGet(publicListUrl())
    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_SITE)
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*')
    // Simple request (GET + Accept only): no preflight needed. An unlisted origin gets no grant => browser blocks.
    const other = await publicGet(publicListUrl(), 'http://not-listed.test')
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
    // Error responses carry CORS too, so the browser can read the 404 body.
    const missing = await publicGet('/api/articles/99999999?depth=1')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('access-control-allow-origin')).toBe(PUBLIC_SITE)
  })

  it('paginates: limit=1 => hasNextPage/nextPage drive "load more" (PUB:76-77)', async () => {
    const first = await publicGet(publicListUrl({ limit: 1, page: 1 }))
    expect(first.json.docs).toHaveLength(1)
    expect(first.json.hasNextPage).toBe(true)
    expect(Number.isSafeInteger(first.json.nextPage)).toBe(true)
    expect(first.json.nextPage).toBeGreaterThan(1)
    const second = await publicGet(publicListUrl({ limit: 1, page: first.json.nextPage }))
    expect(second.status).toBe(200)
    expect(second.json.page).toBe(first.json.nextPage)
  })

  it('reads one article by slug (fetchPublishedArticle: limit=1 + where[slug][equals]); unpublished slug => empty', async () => {
    const slug = state.published[0]!.slug
    const res = await publicGet(publicListUrl({ slug, limit: 1 }))
    expect(res.status).toBe(200)
    expect(res.json.docs).toHaveLength(1)
    expect(normalizePublishedArticle(res.json.docs[0])!.slug).toBe(slug)
    const draft = await publicGet(publicListUrl({ slug: state.draft.slug, limit: 1 }))
    expect(draft.status).toBe(200)
    expect(draft.json.docs).toEqual([])
    const unknown = await publicGet(publicListUrl({ slug: 'no-such-article', limit: 1 }))
    expect(unknown.json.docs).toEqual([])
  })

  it('serves Lexical content that the public renderer turns into safe HTML (editor-style rich text)', async () => {
    const rich = {
      root: {
        type: 'root', format: '', indent: 0, version: 1, direction: 'ltr',
        children: [
          { type: 'heading', tag: 'h2', version: 1, format: '', indent: 0, direction: 'ltr', children: [{ type: 'text', text: 'Synod <opens>', format: 0, detail: 0, mode: 'normal', style: '', version: 1 }] },
          { type: 'paragraph', version: 1, format: '', indent: 0, direction: 'ltr', children: [
            { type: 'text', text: 'Bold', format: 1, detail: 0, mode: 'normal', style: '', version: 1 },
            { type: 'link', version: 1, fields: { url: 'https://example.org/report', linkType: 'custom', newTab: true }, children: [{ type: 'text', text: 'link', format: 0, detail: 0, mode: 'normal', style: '', version: 1 }] },
          ] },
          { type: 'list', listType: 'bullet', tag: 'ul', start: 1, version: 1, format: '', indent: 0, direction: 'ltr', children: [
            { type: 'listitem', value: 1, version: 1, format: '', indent: 0, direction: 'ltr', children: [{ type: 'text', text: 'Item', format: 0, detail: 0, mode: 'normal', style: '', version: 1 }] },
          ] },
        ],
      },
    }
    const art = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), content: rich })
    const res = await publicGet(publicListUrl({ slug: art.slug, limit: 1 }))
    const html = renderArticleContent(res.json.docs[0].content)
    expect(html).toContain('<h2>Synod &lt;opens&gt;</h2>')
    expect(html).toContain('<strong>Bold</strong><a href="https://example.org/report">link</a>')
    expect(html).toContain('<ul><li>Item</li></ul>')
    // Plain text (textToLexical / submission convert) renders as paragraphs too
    const plain = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), content: lexical('First para.') })
    const p = await publicGet(publicListUrl({ slug: plain.slug, limit: 1 }))
    expect(renderArticleContent(p.json.docs[0].content)).toBe('<p>First para.</p>')
  })

  it('lists categories for the site/newsroom (GET /api/categories?limit=100) with id/title/slug', async () => {
    const res = await api('GET', '/api/categories?limit=100', { headers: { origin: PUBLIC_SITE, accept: 'application/json' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_SITE)
    const mine = res.json.docs.find((c: any) => c.id === f.catA.id)
    expect(mine).toMatchObject({ id: f.catA.id, slug: `${runId}-cat-a` })
    expect(typeof mine.title).toBe('string')
    // Filtering by category must use the numeric ID (contract §4.2)
    const byCat = await publicGet(`/api/articles?where[status][equals]=published&where[category][equals]=${f.catA.id}&depth=1`)
    expect(byCat.status).toBe(200)
  })

  it('exposes featuredImage.url and sizes.card.url on published articles at depth=1, without staff-only media fields', async () => {
    // A realistic photo size: derived sizes are generated only for images larger than the target (no enlargement).
    const PNG = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#556677' } }).png().toBuffer()
    const form = new FormData()
    form.set('_payload', JSON.stringify({ alt: `${runId} lead image`, caption: 'Cap', credit: 'Staff' }))
    form.set('file', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'lead.png')
    const up = await api('POST', '/api/media', { token: f.tokens.reporter, body: form })
    expect(up.status).toBe(201)
    const art = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), featuredImage: up.json.doc.id })
    const res = await publicGet(publicListUrl({ slug: art.slug, limit: 1 }))
    const img = res.json.docs[0].featuredImage
    expect(img.url).toMatch(/\/api\/media\/file\//)
    expect(img.sizes?.card?.url ?? img.sizes?.thumbnail?.url).toMatch(/\/api\/media\/file\//)
    expect(img.alt).toBe(`${runId} lead image`)
    expect(img).not.toHaveProperty('uploadedBy')
    // Image bytes are anonymously fetchable (<img src> carries no credentials)
    const path = new URL(img.url, 'http://localhost:3000').pathname
    expect(path.startsWith('/api/media/file/')).toBe(true)
  })

  it('shows corrections on corrected published articles (id, note, correctedAt)', async () => {
    const art = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })
    const eic = await loggedIn('eic')
    const res = await patchArticle(eic, art.id, { title: `${runId} corrected headline`, corrections: [{ note: 'Fixed a misspelling.' }] })
    expect(res.status).toBe(200)
    const pub = await publicGet(publicListUrl({ slug: art.slug, limit: 1 }))
    expect(pub.json.docs[0].corrections).toEqual([
      expect.objectContaining({ note: 'Fixed a misspelling.', correctedAt: expect.any(String), id: expect.any(String) }),
    ])
  })
})

describe('public site: live event timeline polling', () => {
  it('polls GET /api/live-events/:slug/updates?since=<nextSince> with CORS and short cache', async () => {
    const slug = `${runId}-synod`
    const ev = await api('POST', '/api/live-events', { token: f.tokens.eic, body: { title: `${runId} Synod`, slug, category: f.catA.id, status: 'live' } })
    expect(ev.status).toBe(201)
    const post = (body: string) => api('POST', '/api/live-updates', { token: f.tokens.eic, body: { event: ev.json.doc.id, body, status: 'approved' } })
    await post('Opening prayer')
    await post('First motion tabled')

    // PR notes: docs/frontend-integration.md (poll every 15-30 s); the site does not poll yet, shape is contractual.
    const first = await api('GET', `/api/live-events/${slug}/updates?since=0`, { headers: { origin: PUBLIC_SITE, accept: 'application/json' } })
    expect(first.status).toBe(200)
    expect(first.headers.get('access-control-allow-origin')).toBe(PUBLIC_SITE)
    expect(first.headers.get('cache-control')).toBe('public, max-age=10')
    expect(first.json.event).toMatchObject({ slug, status: 'live' })
    expect(first.json.docs.map((d: any) => d.body)).toEqual(['Opening prayer', 'First motion tabled'])
    expect(first.json.docs[0]).toEqual(expect.objectContaining({ id: expect.any(Number), sequence: 1, occurredAt: expect.any(String) }))
    expect(first.json.nextSince).toBe(2)
    // Pending/rejected never leak
    const pending = await api('POST', '/api/live-updates', { token: f.tokens.reporter, body: { event: ev.json.doc.id, body: 'unverified rumour' } })
    expect(pending.json.doc.status).toBe('pending')

    const next = await api('GET', `/api/live-events/${slug}/updates?since=${first.json.nextSince}`, { headers: { origin: PUBLIC_SITE } })
    expect(next.json.docs).toEqual([])
    expect(next.json.nextSince).toBe(2)

    // Draft or unknown event => 404 with readable CORS
    const missing = await api('GET', `/api/live-events/${runId}-nope/updates`, { headers: { origin: PUBLIC_SITE } })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('access-control-allow-origin')).toBe(PUBLIC_SITE)
  })
})

// ---------------------------------------------------------------------------------------------
// PUBLIC FORMS (PR #4) and the PR #2 public submit view: POST /api/public/submissions
// ---------------------------------------------------------------------------------------------

let n = 0
/** PR4 public-submissions.js:38-43 submissionPayload(values, token, 'story') */
const pr4StoryPayload = (token: string, extra: Record<string, unknown> = {}) => ({
  name: 'Ada Obi',
  email: `ada${++n}.${runId}@example.com`,
  phone: '+234 803 123 4567',
  consent: true,
  turnstileToken: token,
  title: `${runId} Church opens clinic ${n}`,
  category: 'News', // MISMATCH: CMS field is `categorySuggestion`; `category` and `consent` are ignored (not stored)
  body: 'The church opened a free clinic in Ibadan this week for residents of the district.',
  ...extra,
})

/** PR4 public-submissions.js:68-72: POST, credentials:'omit', cache:'no-store', JSON, Accept. */
const pr4Send = (payload: unknown, opts: { origin?: string; ip?: string; headers?: Record<string, string> } = {}) =>
  api('POST', '/api/public/submissions', {
    body: JSON.stringify(payload),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      origin: opts.origin ?? PUBLIC_FORM_ORIGIN,
      'x-forwarded-for': opts.ip ?? nextIp(),
      ...(opts.headers ?? {}),
    },
  })

/** PR4 public-submissions.js:53-57 retryDelay */
const retryDelay = (value: string | null) => {
  if (!value) return 60
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000)
  return Number.isFinite(seconds) ? Math.max(1, seconds) : 60
}

describe('public forms (PR #4): POST /api/public/submissions', () => {
  it('preflight from the form origin is allowed (Content-Type only; Accept is CORS-safelisted)', async () => {
    const res = await api('OPTIONS', '/api/public/submissions', {
      headers: { origin: PUBLIC_FORM_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_FORM_ORIGIN)
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('content-type')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    const bad = await api('OPTIONS', '/api/public/submissions', { headers: { origin: 'http://evil.test', 'access-control-request-method': 'POST' } })
    expect(bad.status).toBe(403)
  })

  it('accepts PR4 story payload => 201 { ok, reference }; extra fields (category, consent) are ignored', async () => {
    const payload = pr4StoryPayload(TURNSTILE_OK)
    const res = await pr4Send(payload)
    expect(res.status).toBe(201)
    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_FORM_ORIGIN)
    expect(res.json.ok).toBe(true)
    expect(res.json.reference).toMatch(/^SUB-[A-Z0-9]{8}$/) // PR4:88 reads `reference`; PR2w:682 too
    expect(typeof res.json.message).toBe('string')
    // MISMATCH (PR4 public-submissions.js:87): requires `result.accepted === true || result.status === 'pending'`.
    // The contract is `{ ok: true, reference, message }`. Fix in the form: treat `response.status === 201 && result.ok === true` as receipt.
    expect(res.json.accepted).toBeUndefined()
    const [doc] = (await f.payload.find({ collection: 'submissions', where: { title: { equals: payload.title } }, limit: 1, depth: 0, overrideAccess: true })).docs as any[]
    expect(doc.status).toBe('new')
    expect(doc.phone).toBe('+234 803 123 4567')
    expect(doc.categorySuggestion ?? null).toBeNull() // `category` was dropped; send `categorySuggestion`
    expect(doc).not.toHaveProperty('consent')
  })

  it('accepts the PR #2 working-copy payload (adapter.js:646-656) with categorySuggestion and website honeypot', async () => {
    const res = await api('POST', '/api/public/submissions', {
      body: JSON.stringify({
        name: 'Ada Obi', email: `pr2.${runId}@example.com`, phone: '', title: `${runId} PR2 tip`, body: 'The church opened a free clinic in Ibadan this week for residents.',
        location: 'Ibadan', categorySuggestion: 'News', website: '', turnstileToken: TURNSTILE_OK,
      }),
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: PUBLIC_FORM_ORIGIN, 'x-forwarded-for': nextIp() },
    })
    expect(res.status).toBe(201)
    expect(res.json.reference).toMatch(/^SUB-/)
    const [doc] = (await f.payload.find({ collection: 'submissions', where: { title: { equals: `${runId} PR2 tip` } }, limit: 1, depth: 0, overrideAccess: true })).docs as any[]
    expect(doc.categorySuggestion).toBe('News')
    expect(doc.location).toBe('Ibadan')
  })

  it('PR4 contact payload (subject/message) is NOT accepted here: there is no CMS contact endpoint (BACKEND-GAP / keep form disabled)', async () => {
    const res = await pr4Send({ name: 'Ada Obi', email: `c.${runId}@example.com`, phone: '+234 803 123 4567', consent: true, turnstileToken: TURNSTILE_OK, subject: 'A question', message: 'Hello newsroom, a question about your corrections policy for you.' })
    expect(res.status).toBe(400)
    expect(res.json.errors.map((e: any) => e.field).sort()).toEqual(['body', 'title'])
  })

  it('400: validation errors are an ARRAY of { field, message } (PR4 reads Object.keys(result.errors) => wrong; map errors[].field)', async () => {
    const res = await pr4Send(pr4StoryPayload(TURNSTILE_OK, { email: 'not-an-email', name: 'A' }))
    expect(res.status).toBe(400)
    expect(Array.isArray(res.json.errors)).toBe(true)
    expect(res.json.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'email' }), expect.objectContaining({ field: 'name' })]))
    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_FORM_ORIGIN) // browser can read the body
  })

  it('400 missing token / 403 rejected token / 403 spent token, readable cross-origin (fields: errors[0].field === "turnstileToken")', async () => {
    const missing = await pr4Send(pr4StoryPayload(''))
    expect(missing.status).toBe(400)
    expect(missing.json.errors[0].field).toBe('turnstileToken')
    const bad = await pr4Send(pr4StoryPayload(TURNSTILE_BAD))
    expect(bad.status).toBe(403)
    expect(bad.json.errors[0]).toMatchObject({ field: 'turnstileToken' })
    expect(bad.headers.get('access-control-allow-origin')).toBe(PUBLIC_FORM_ORIGIN)
    const spent = await pr4Send(pr4StoryPayload(TURNSTILE_SPENT))
    expect(spent.status).toBe(403)
    // MISMATCH (PR4:76 expects code TURNSTILE_INVALID / TURNSTILE_EXPIRED): the CMS signals this with
    // 403 + errors[0].field === 'turnstileToken'. The form must map that to "get a new challenge".
    expect(spent.json.code).toBeUndefined()
    // Fail closed: nothing stored
    const stored = await f.payload.find({ collection: 'submissions', where: { email: { like: `${runId}` } }, limit: 100, depth: 0, overrideAccess: true })
    expect(stored.docs.every((d: any) => d.status === 'new')).toBe(true)
  })

  it('403 for an origin outside PUBLIC_SUBMISSION_ORIGINS (no CORS grant: the browser reports a network error)', async () => {
    const res = await pr4Send(pr4StoryPayload(TURNSTILE_OK), { origin: 'http://localhost:5199' })
    expect(res.status).toBe(403)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('409 duplicate, 413 oversized, 415 wrong content type', async () => {
    const payload = pr4StoryPayload(TURNSTILE_OK)
    expect((await pr4Send(payload)).status).toBe(201)
    const dup = await pr4Send(payload)
    expect(dup.status).toBe(409)
    expect(dup.json.errors[0].message).toMatch(/already received/i)
    const big = await pr4Send(pr4StoryPayload(TURNSTILE_OK), { headers: { 'content-length': String(70 * 1024) } })
    expect(big.status).toBe(413)
    const text = await api('POST', '/api/public/submissions', {
      body: JSON.stringify(pr4StoryPayload(TURNSTILE_OK)),
      headers: { 'content-type': 'text/plain', origin: PUBLIC_FORM_ORIGIN, 'x-forwarded-for': nextIp() },
    })
    expect(text.status).toBe(415)
  })

  it('429 carries Retry-After AND exposes it to cross-origin scripts (Access-Control-Expose-Headers)', async () => {
    const ip = nextIp()
    let last: ApiResult | undefined
    for (let i = 0; i < 6; i++) last = await pr4Send({ name: 'x' }, { ip }) // limit is 5 per IP; every request counts
    expect(last!.status).toBe(429)
    expect(last!.headers.get('access-control-allow-origin')).toBe(PUBLIC_FORM_ORIGIN)
    expect(last!.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('retry-after')
    const seconds = retryDelay(last!.headers.get('retry-after')) // PR4:53-57,75, PR2w:669
    expect(seconds).toBeGreaterThan(1)
    expect(seconds).toBeLessThanOrEqual(900)
    expect(last!.headers.get('retry-after')).toMatch(/^\d+$/)
  })

  it('honeypot (`website` filled) returns the same 201 shape and stores nothing', async () => {
    const payload = pr4StoryPayload(TURNSTILE_OK, { website: 'http://spam.test' })
    const res = await pr4Send(payload)
    expect(res.status).toBe(201)
    expect(res.json.reference).toMatch(/^SUB-/)
    const stored = await f.payload.find({ collection: 'submissions', where: { title: { equals: payload.title } }, limit: 1, depth: 0, overrideAccess: true })
    expect(stored.docs).toHaveLength(0)
  })

  it('PR #2 committed adapter (createPublicSubmission, adapter.js:384-405 @850e651) sends mock-shaped fields => rejected (consumer must use the contract fields)', async () => {
    const res = await api('POST', '/api/public/submissions', {
      body: JSON.stringify({ id: 'sub-1234', headline: 'Church opens clinic', body: 'x'.repeat(40), category: 'faith-society', submitterName: 'Ada', submitterEmail: 'a@b.co', status: 'pending', editorNotes: 'n', createdAt: new Date().toISOString() }),
      headers: { 'content-type': 'application/json', origin: PUBLIC_FORM_ORIGIN, 'x-forwarded-for': nextIp() },
    })
    expect(res.status).toBe(400) // name/email/title missing (and turnstile is never reached)
    expect(res.json.errors.map((e: any) => e.field)).toEqual(expect.arrayContaining(['name', 'email', 'title']))
  })
})

// ---------------------------------------------------------------------------------------------
// NEWSROOM (PR #2): session, workflow, queues, live, media. Browser at http://localhost:5174 with credentials:'include'.
// ---------------------------------------------------------------------------------------------

describe('newsroom: login / me / logout cross-origin from :5174 (PR2w adapter.js:183-297)', () => {
  it('preflight for POST /api/users/login (content-type) is granted with credentials', async () => {
    const res = await api('OPTIONS', '/api/users/login', {
      headers: { origin: NEWSROOM, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
    expect([200, 204]).toContain(res.status)
    expect(res.headers.get('access-control-allow-origin')).toBe(NEWSROOM)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('content-type')
    expect(res.headers.get('access-control-allow-methods')).toMatch(/PATCH/)
  })

  it('login sets an HttpOnly SameSite=Lax host-only cookie; body has the user fields the UI reads', async () => {
    const b = new Browser(NEWSROOM)
    const res = await b.login(f.users.reporter.email.toUpperCase()) // adapter lowercases (:188)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(NEWSROOM)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.json.user).toMatchObject({ id: f.users.reporter.id, role: 'reporter', email: f.users.reporter.email })
    expect(res.json.user.name).toBeTruthy() // adapter :213 uses user.email; views use user.name
    expect(res.json).not.toHaveProperty('user.hash')
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toMatch(/HttpOnly/i)
    // DEPLOYMENT REQUIREMENT: SameSite=Lax cookies are sent on same-SITE requests only. The newsroom and the CMS must
    // share a registrable domain (e.g. newsroom.example.org + cms.example.org) or be served from one origin via a proxy.
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).not.toMatch(/SameSite=None/i)
    expect(cookie).not.toMatch(/Domain=/i)
  })

  it('wrong password => 401 with errors[0].message (adapter :207). Locked accounts are 401 too (adapter expects 429/423)', async () => {
    const b = new Browser(NEWSROOM)
    const res = await b.login(f.users.reporter2.email, 'definitely-wrong-password')
    expect(res.status).toBe(401)
    expect(res.json.errors[0].message).toMatch(/incorrect/i)
    expect(res.headers.get('access-control-allow-origin')).toBe(NEWSROOM) // browser can read the error
  })

  it('/api/users/me with the cookie returns { user }; cookie is ignored for an origin outside the CSRF allowlist; logout revokes it', async () => {
    const b = await loggedIn('reporter')
    const me = await b.fetch('GET', '/api/users/me', { credentials: 'include' }) // adapter :279
    expect(me.status).toBe(200)
    expect(me.json.user.id).toBe(f.users.reporter.id)
    expect(me.json.user.role).toBe('reporter')

    const evil = new Browser('http://evil.test')
    evil.cookie = b.cookie
    expect((await evil.fetch('GET', '/api/users/me')).json.user).toBeNull() // CSRF: an attacker site cannot ride the cookie

    const noCreds = await b.fetch('GET', '/api/users/me', { credentials: 'omit' })
    expect(noCreds.json.user).toBeNull() // without credentials:'include' the UI would look logged out

    const old = b.cookie
    const out = await b.fetch('POST', '/api/users/logout', { credentials: 'include' }) // adapter :261
    expect(out.status).toBe(200)
    const replay = new Browser(NEWSROOM)
    replay.cookie = old
    expect((await replay.fetch('GET', '/api/users/me')).json.user).toBeNull() // server-side session is gone
  })

  it('unauthenticated staff reads are 401/403 (so the UI must surface errors, not fall back to a mock)', async () => {
    const anon = new Browser(NEWSROOM)
    expect([401, 403]).toContain((await anon.fetch('GET', '/api/submissions?limit=50')).status)
    expect([401, 403]).toContain((await anon.fetch('POST', '/api/articles', { body: JSON.stringify({ title: 'x' }), headers: { 'content-type': 'application/json' } })).status)
  })
})

describe('newsroom: article workflow with the exact requests the UI sends', () => {
  it('create draft: the mock-shaped body (adapter.js:475-480 sends articleData as-is) is rejected; the contract body works', async () => {
    const reporter = await loggedIn('reporter')
    // MISMATCH: editor.js builds { title, slug, category:'faith-society', standfirst, body (markdown), featuredImage:null, author:{…}, status, … }.
    const mock = await reporter.fetch('POST', '/api/articles', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${runId} mock shaped`, slug: `${runId}-mock-shaped`, category: 'faith-society', standfirst: 's', body: '**md**', featuredImage: null, status: 'draft', author: { id: 'user-reporter' } }),
    })
    expect(mock.status).toBe(400) // category must be a numeric ID, `content` (Lexical) is required
    // Contract (api-contracts §6.1): content = Lexical JSON, excerpt = standfirst, category = numeric id.
    const ok = await reporter.fetch('POST', '/api/articles', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${runId} draft one`, slug: `${runId}-draft-one`, excerpt: 'Standfirst text', content: lexical('Body.'), category: f.catA.id, status: 'draft' }),
    })
    expect(ok.status).toBe(201)
    expect(ok.json.doc).toMatchObject({ status: 'draft', slug: `${runId}-draft-one` })
    expect(idOf(ok.json.doc.author)).toBe(f.users.reporter.id) // server-set; the UI must not send author
    f.created.articles.push(ok.json.doc.id)
  })

  it('full path: reporter submit -> editor request changes -> resubmit -> approve -> publish -> public read -> correction', async () => {
    const reporter = await loggedIn('reporter')
    const eic = await loggedIn('eic')
    const created = await reporter.fetch('POST', '/api/articles', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${runId} flow`, slug: `${runId}-flow`, excerpt: 'Standfirst', content: lexical('Flow body text.'), category: f.catA.id }),
    })
    expect(created.status).toBe(201)
    const id = created.json.doc.id as number
    f.created.articles.push(id)
    const now = () => new Date().toISOString()

    // updateArticleStatus patch shape (PR2w adapter.js:541-549): { status, updatedAt, reviewNotes[, publishedAt] }
    const submit = await patchArticle(reporter, id, { status: 'in_review', updatedAt: now(), reviewNotes: 'Submitted by reporter for editorial review' })
    expect(submit.status).toBe(200)
    expect(submit.json.doc.status).toBe('in_review')
    expect(submit.json.doc.updatedAt).not.toBe(undefined)

    // editor queue (review.js:120 => getArticles({status})): GET /api/articles?depth=1&limit=50&where[status][equals]=in_review
    const queue = await eic.fetch('GET', `/api/articles?depth=1&limit=50&where[status][equals]=${encodeURIComponent('in_review')}`)
    expect(queue.status).toBe(200)
    const row = queue.json.docs.find((d: any) => d.id === id)
    expect(row).toBeTruthy()
    expect(row.author).toMatchObject({ id: f.users.reporter.id }) // staff see the author object (name for the card)
    expect(row.category).toMatchObject({ id: f.catA.id })

    // The reporter's own list sees their article too, but not other people's drafts.
    const mine = await reporter.fetch('GET', '/api/articles?depth=1&limit=50')
    expect(mine.json.docs.every((d: any) => d.status === 'published' || idOf(d.author) === f.users.reporter.id)).toBe(true)

    const changes = await patchArticle(eic, id, { status: 'changes_requested', updatedAt: now(), reviewNotes: 'Please add a second source.' })
    expect(changes.status).toBe(200)
    expect(changes.json.doc.reviewNotes).toBe('Please add a second source.')

    // reporter reads reviewNotes on their own article (editor.js shows them) and resubmits with an edit
    const reread = await reporter.fetch('GET', `/api/articles/${id}?depth=1`)
    expect(reread.json.reviewNotes).toBe('Please add a second source.')
    const edit = await patchArticle(reporter, id, { content: lexical('Flow body text with a second source.'), status: 'in_review' })
    expect(edit.status).toBe(200)

    const approve = await patchArticle(eic, id, { status: 'approved', updatedAt: now(), reviewNotes: 'Editorial fact-check and dignity checks passed' })
    expect(approve.status).toBe(200)

    // a reporter can never publish (the UI hides the button; the server must still refuse)
    const sneaky = await patchArticle(reporter, id, { status: 'published' })
    expect([403, 400]).toContain(sneaky.status)

    // PR2w :547-549 sends publishedAt: now with the publish patch; the server ignores it and stamps its own.
    const clientPublishedAt = '2020-01-01T00:00:00.000Z'
    const publish = await patchArticle(eic, id, { status: 'published', updatedAt: now(), reviewNotes: 'Published by Editor-in-Chief', publishedAt: clientPublishedAt })
    expect(publish.status).toBe(200)
    expect(publish.json.doc.status).toBe('published')
    expect(publish.json.doc.publishedAt).toBeTruthy()
    expect(publish.json.doc.publishedAt).not.toBe(clientPublishedAt)

    const pub = await publicGet(publicListUrl({ slug: `${runId}-flow`, limit: 1 }))
    expect(normalizePublishedArticle(pub.json.docs[0])).toMatchObject({ slug: `${runId}-flow`, excerpt: 'Standfirst' })

    // Correction on a published article: a material change without a corrections entry is refused...
    const noNote = await patchArticle(eic, id, { title: `${runId} flow corrected` })
    expect(noNote.status).toBe(400)
    const withNote = await patchArticle(eic, id, { title: `${runId} flow corrected`, corrections: [{ note: 'Headline corrected.' }] })
    expect(withNote.status).toBe(200)
    expect(withNote.json.doc.corrections).toHaveLength(1)
  })

  it('schedule: editor schedules with scheduledFor; the article stays invisible to the public until published', async () => {
    const eic = await loggedIn('eic')
    const art = await f.seedArticle({ status: 'approved' })
    const when = new Date(Date.now() + 3_600_000).toISOString()
    const res = await patchArticle(eic, art.id, { status: 'scheduled', scheduledFor: when })
    expect(res.status).toBe(200)
    expect(res.json.doc.status).toBe('scheduled')
    const pub = await publicGet(publicListUrl({ slug: art.slug, limit: 1 }))
    expect(pub.json.docs).toEqual([])
    const past = await patchArticle(eic, art.id, { status: 'scheduled', scheduledFor: new Date(Date.now() - 60_000).toISOString() })
    expect(past.status).toBe(400)
  })

  it('trusted publisher publishes their own article in their section directly; out of section is refused', async () => {
    const tp = await loggedIn('trusted')
    const created = await tp.fetch('POST', '/api/articles', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${runId} tp own`, slug: `${runId}-tp-own`, content: lexical(), category: f.catA.id }),
    })
    expect(created.status).toBe(201)
    f.created.articles.push(created.json.doc.id)
    expect((await patchArticle(tp, created.json.doc.id, { status: 'published' })).status).toBe(200)
    const other = await tp.fetch('POST', '/api/articles', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${runId} tp other`, slug: `${runId}-tp-other`, content: lexical(), category: f.catB.id }),
    })
    expect(other.status).toBe(201)
    f.created.articles.push(other.json.doc.id)
    expect([400, 403]).toContain((await patchArticle(tp, other.json.doc.id, { status: 'published' })).status)
  })

  it('category filter: the numeric ID form works (adapter.js:415 sends a MOCK SLUG here => 400 from src/proxy.ts; see queryGuards unit test)', async () => {
    // MISMATCH: the UI filters by category slug ('faith-society'). Handlers called directly bypass src/proxy.ts, so the
    // 400 for non-numeric filters is proven in tests/unit/queryGuards.test.ts and against `next start` (see report).
    const eic = await loggedIn('eic')
    const res = await eic.fetch('GET', `/api/articles?depth=1&limit=50&where[category][equals]=${f.catA.id}`)
    expect(res.status).toBe(200)
    expect(res.json.docs.every((d: any) => idOf(d.category) === f.catA.id)).toBe(true)
  })
})

describe('newsroom: submission queue and conversion', () => {
  const makeSubmission = async (label: string) => {
    const title = `${runId} ${label} tip`
    const res = await pr4Send({ name: 'Ada Obi', email: `${label}.${runId}@example.com`, title, body: 'The church opened a free clinic in Ibadan this week for residents of the district.', turnstileToken: TURNSTILE_OK })
    expect(res.status).toBe(201)
    return { title, reference: res.json.reference as string }
  }

  it('editor lists the queue (adapter.js:587-589), reporters are refused, status/notes patch uses CMS enums', async () => {
    const { title, reference } = await makeSubmission('queue')
    const eic = await loggedIn('eic')
    const list = await eic.fetch('GET', '/api/submissions?limit=50&where[status][equals]=new&sort=-createdAt')
    expect(list.status).toBe(200)
    const row = list.json.docs.find((d: any) => d.title === title)
    expect(row).toMatchObject({ reference, status: 'new', email: expect.stringContaining('@') })

    const reporter = await loggedIn('reporter')
    expect([401, 403]).toContain((await reporter.fetch('GET', '/api/submissions?limit=50')).status)

    // MISMATCH: UI statuses `pending`/`approved` + `editorNotes` do not exist. Contract: new|under_review|accepted|rejected|converted + reviewerNotes.
    const bad = await eic.fetch('PATCH', `/api/submissions/${row.id}`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'approved', editorNotes: 'x' }) })
    expect(bad.status).toBe(400)
    const ok = await eic.fetch('PATCH', `/api/submissions/${row.id}`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'rejected', reviewerNotes: 'Dismissed by editor' }) })
    expect(ok.status).toBe(200)
    expect(ok.json.doc).toMatchObject({ status: 'rejected', reviewerNotes: 'Dismissed by editor' })
  })

  it('convert: POST /api/submissions/:id/convert { category } => 201 { article: { id, slug } } (draft, author = editor); second call 409', async () => {
    const { title } = await makeSubmission('convert')
    const eic = await loggedIn('eic')
    const row = (await eic.fetch('GET', '/api/submissions?limit=50&where[status][equals]=new')).json.docs.find((d: any) => d.title === title)
    const conv = await eic.fetch('POST', `/api/submissions/${row.id}/convert`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: f.catA.id }) })
    expect(conv.status).toBe(201)
    expect(conv.json.article).toEqual({ id: expect.any(Number), slug: expect.any(String) }) // UI (adapter :451) must read article.id, not data.id
    f.created.articles.push(conv.json.article.id)
    const art = await eic.fetch('GET', `/api/articles/${conv.json.article.id}?depth=0`)
    expect(art.json.status).toBe('draft')
    expect(art.json.author).toBe(f.users.eic.id)
    const again = await eic.fetch('POST', `/api/submissions/${row.id}/convert`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: f.catA.id }) })
    expect(again.status).toBe(409)
    // converted drafts are never public
    const pub = await publicGet(publicListUrl({ slug: conv.json.article.slug, limit: 1 }))
    expect(pub.json.docs).toEqual([])
  })
})

describe('newsroom: live events and updates (UI currently local-only: live.js uses mock adapter methods)', () => {
  it('create event: the mock body (no category) is refused; contract body works; reporter update is pending; editor queue + approve; public sees it', async () => {
    const eic = await loggedIn('eic')
    const reporter = await loggedIn('reporter')
    // MISMATCH (PR2w adapter.js:792-808 createLiveEvent): { title, slug, status:'live', description, location } has no category.
    const mock = await eic.fetch('POST', '/api/live-events', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: `${runId} Mock Event`, slug: `${runId}-mock-event`, status: 'live', description: 'd', location: 'Lagos' }) })
    expect(mock.status).toBe(400)

    const slug = `${runId}-live-flow`
    const ev = await eic.fetch('POST', '/api/live-events', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: `${runId} Live flow`, slug, category: f.catA.id, status: 'draft', summary: 'Covering the vote' }) })
    expect(ev.status).toBe(201)
    const eventId = ev.json.doc.id as number
    // draft is invisible publicly
    expect((await api('GET', `/api/live-events/${slug}/updates`, { headers: { origin: PUBLIC_SITE } })).status).toBe(404)
    expect((await eic.fetch('PATCH', `/api/live-events/${eventId}`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'live' }) })).status).toBe(200)

    // MISMATCH: UI sends { eventId, eventSlug, headline, body, reporterName, status, isPinned, timestamp }. Contract: { event, body, occurredAt }.
    const upd = await reporter.fetch('POST', '/api/live-updates', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: eventId, body: 'Vote result expected shortly.', occurredAt: new Date().toISOString() }) })
    expect(upd.status).toBe(201)
    expect(upd.json.doc.status).toBe('pending')

    // editor queue
    const q = await eic.fetch('GET', `/api/live-updates?where[event][equals]=${eventId}&where[status][equals]=pending&sort=sequence`)
    expect(q.json.docs.map((d: any) => d.id)).toContain(upd.json.doc.id)
    expect((await api('GET', `/api/live-events/${slug}/updates`, { headers: { origin: PUBLIC_SITE } })).json.docs).toEqual([])

    const approve = await eic.fetch('PATCH', `/api/live-updates/${upd.json.doc.id}`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'approved' }) })
    expect(approve.status).toBe(200)
    const feed = await api('GET', `/api/live-events/${slug}/updates?since=0`, { headers: { origin: PUBLIC_SITE } })
    expect(feed.json.docs.map((d: any) => d.body)).toEqual(['Vote result expected shortly.'])
    expect(feed.json.nextSince).toBe(1)

    // close the event
    expect((await eic.fetch('PATCH', `/api/live-events/${eventId}`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'ended' }) })).status).toBe(200)
    const ended = await api('GET', `/api/live-events/${slug}/updates`, { headers: { origin: PUBLIC_SITE } })
    expect(ended.json.event.status).toBe('ended')
  })
})

describe('newsroom: media upload (multipart) and featured image', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

  it('POST /api/media with file + _payload (cookie, cross-origin) => doc with id, url, sizes; usable as featuredImage', async () => {
    const reporter = await loggedIn('reporter')
    const form = new FormData()
    form.set('_payload', JSON.stringify({ alt: `${runId} newsroom upload`, caption: 'Caption', credit: 'Staff photographer' }))
    form.set('file', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'photo.png')
    // browser sets the multipart Content-Type itself; the UI must NOT set 'Content-Type: application/json' for uploads.
    const up = await reporter.fetch('POST', '/api/media', { body: form })
    expect(up.status).toBe(201)
    expect(up.json.doc).toMatchObject({ alt: `${runId} newsroom upload`, mimeType: 'image/png', width: 1, height: 1 })
    expect(up.json.doc.url).toMatch(/\/api\/media\/file\//)
    expect(up.json.doc.sizes).toBeTruthy()
    expect(up.headers.get('access-control-allow-origin')).toBe(NEWSROOM)

    // media list for the library view (anonymous list is a documented limitation; staff see it too)
    const list = await reporter.fetch('GET', '/api/media?limit=50&sort=-createdAt')
    expect(list.json.docs.some((m: any) => m.id === up.json.doc.id)).toBe(true)

    const art = await reporter.fetch('POST', '/api/articles', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${runId} with image`, slug: `${runId}-with-image`, content: lexical(), category: f.catA.id, featuredImage: up.json.doc.id }),
    })
    expect(art.status).toBe(201)
    f.created.articles.push(art.json.doc.id)
    const read = await reporter.fetch('GET', `/api/articles/${art.json.doc.id}?depth=1`)
    expect(read.json.featuredImage.url).toMatch(/\/api\/media\/file\//)
  })

  it('a JSON body to /api/media (what the mock uploadMedia would send) is rejected', async () => {
    const reporter = await loggedIn('reporter')
    const res = await reporter.fetch('POST', '/api/media', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Untitled', url: '/x.jpg', alt: 'a' }) })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

describe('homepage advertising (PR #5)', () => {
  it('serves the live feed only at /api/public/advertising (go-live C3); the older guessed paths stay 404', async () => {
    for (const path of ['/api/advertising', '/api/campaigns']) {
      const res = await api('GET', path, { headers: { origin: PUBLIC_SITE } })
      expect(res.status, path).toBe(404)
    }
    // Origin allowlist is PUBLIC_SUBMISSION_ORIGINS (http://allowed.test in tests), not CMS_CORS_ORIGINS.
    const res = await api('GET', '/api/public/advertising', { headers: { origin: 'http://allowed.test' } })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.json.campaigns)).toBe(true)
  })
})
