/**
 * Security regression: what anonymous callers can SEE.
 * - published-only invariant across list, detail, count, versions, filters, search, live updates, legacy comments;
 * - provenance / legacy / staff-only fields and e-mail addresses never appear in any anonymous response;
 * - field-level filter oracles (querying on a field the caller cannot read);
 * - preview token misuse; media privacy and Range; uploads (SVG / HTML / PHP polyglots); redirects (open redirect).
 */
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetSearchLimiter } from '../../src/endpoints/publicSearch'
import { resetRedirectsCache } from '../../src/endpoints/publicRedirects'
import { reindexArticleSearch } from '../../src/lib/articleSearch'
import { createPreviewToken } from '../../src/lib/previewToken'
import { lexical, newRunId, setupFixtures, type Fixtures } from '../integration/helpers'
import { anon, forbiddenKeysIn, send } from './harness'

const runId = newRunId()
let f: Fixtures
const word = (label: string) => `${runId}${label}`
const NOW = () => new Date(Date.now() - 60_000).toISOString()
const saved = { rate: process.env.SEARCH_RATE_LIMIT }
const SECRET_NOTE = `${runId}SECRETREVIEWNOTE`
const SOURCE_URL = `https://web.archive.org/web/2020/https://example.invalid/${runId}-src`

type Seeded = { id: number; slug: string }
const seeded: Record<string, Seeded> = {}
let published: Seeded
let png: Buffer
let publicMedia: { id: number; filename: string }
let privateMedia: { id: number; filename: string }
let legacyIdValue: number

beforeAll(async () => {
  process.env.SEARCH_RATE_LIMIT = '100000'
  resetSearchLimiter()
  f = await setupFixtures(runId)
  legacyIdValue = 900_000_000 + Math.floor(Math.random() * 90_000_000)
  const marker = word('marker')
  for (const status of ['draft', 'in_review', 'changes_requested', 'approved', 'archived'] as const) {
    seeded[status] = await f.seedArticle({
      status,
      title: `${status} ${marker}`,
      reviewNotes: SECRET_NOTE,
      ...(status === 'archived' ? { publishedAt: NOW() } : {}),
    })
  }
  seeded.scheduled = await f.seedArticle({
    status: 'scheduled',
    title: `scheduled ${marker}`,
    scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
  })
  published = seeded.published = await f.seedArticle({
    status: 'published',
    publishedAt: NOW(),
    title: `published ${marker}`,
    excerpt: `excerpt ${marker}`,
    reviewNotes: SECRET_NOTE,
    author: f.users.reporter.id,
    bylineName: 'Ada Obi',
    legacyId: legacyIdValue,
    legacyUrl: `https://churchtimesnigeria.net/${runId}-legacy/`,
    provenance: {
      sourceUrl: SOURCE_URL,
      sourceHost: 'web.archive.org',
      importBatch: `${runId}-batch`,
      reviewStatus: 'reviewed',
      reviewedBy: f.users.eic.id,
      reviewedAt: NOW(),
    },
  })
  await reindexArticleSearch(f.payload).catch(() => undefined)

  png = await sharp({ create: { width: 900, height: 500, channels: 3, background: { r: 10, g: 90, b: 160 } } }).png().toBuffer()
  const mk = async (label: string, token = f.tokens.reporter) => {
    const form = new FormData()
    form.set('_payload', JSON.stringify({ alt: `${runId} ${label}` }))
    form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${runId}-${label}.png`)
    const res = await send('POST', '/api/media', { token, body: form })
    expect(res.status).toBe(201)
    return { id: res.json.doc.id as number, filename: res.json.doc.filename as string }
  }
  publicMedia = await mk('pub')
  privateMedia = await mk('priv')
  await f.payload.update({ collection: 'articles', id: published.id, data: { featuredImage: publicMedia.id } as never, overrideAccess: true, context: { seed: true } })
})

afterAll(async () => {
  if (saved.rate === undefined) delete process.env.SEARCH_RATE_LIMIT
  else process.env.SEARCH_RATE_LIMIT = saved.rate
  resetSearchLimiter()
  await f?.payload.delete({ collection: 'redirects', where: { from: { like: runId } }, overrideAccess: true }).catch(() => undefined)
  await f?.cleanup()
})

const mine = `where[slug][like]=${runId}`
const hiddenIds = () => ['draft', 'in_review', 'changes_requested', 'approved', 'archived', 'scheduled'].map((k) => seeded[k]!.id)

describe('published-only invariant (articles)', () => {
  const lists = [
    `/api/articles?${mine}&limit=100`,
    `/api/articles?${mine}&limit=100&depth=3`,
    `/api/articles?${mine}&limit=100&draft=true`,
    `/api/articles?${mine}&limit=100&trash=true`,
    `/api/articles?${mine}&limit=100&where[status][equals]=draft`,
    `/api/articles?limit=100&where[or][0][status][equals]=draft&where[or][1][slug][like]=${runId}`,
    `/api/articles?${mine}&limit=100&where[status][not_equals]=published`,
    `/api/articles?${mine}&limit=100&where[status][in]=draft,archived,scheduled,approved`,
    `/api/articles?${mine}&limit=100&select[title]=true&select[status]=true`,
    `/api/articles?${mine}&limit=100&sort=-status`,
  ]
  for (const url of lists) {
    it(`list never contains an unpublished article: ${url.replace(`${runId}`, 'RUN').slice(0, 90)}`, async () => {
      const res = await anon('GET', url)
      if (res.status !== 200) {
        expect([400, 403]).toContain(res.status) // refused is fine, leaking is not
        return
      }
      const ids = (res.json.docs as Array<{ id: number }>).map((d) => d.id)
      for (const id of hiddenIds()) expect(ids).not.toContain(id)
      for (const d of res.json.docs as Array<{ status?: string }>) {
        if (d.status !== undefined) expect(d.status).toBe('published')
      }
    })
  }

  it('the published article is listed (control: the filter is not simply returning nothing)', async () => {
    const res = await anon('GET', `/api/articles?${mine}&limit=100`)
    expect((res.json.docs as Array<{ id: number }>).map((d) => d.id)).toContain(published.id)
    expect(res.json.totalDocs).toBe(1)
  })

  it('detail, versions and count: every unpublished article is 404/403, count only counts published', async () => {
    for (const id of hiddenIds()) {
      expect([403, 404], `article ${id}`).toContain((await anon('GET', `/api/articles/${id}`)).status)
      expect([403, 404]).toContain((await anon('GET', `/api/articles/${id}?draft=true`)).status)
      expect([403, 404]).toContain((await anon('GET', `/api/articles/versions?where[parent][equals]=${id}`)).status)
    }
    const count = await anon('GET', `/api/articles/count?${mine}`)
    expect(count.json.totalDocs).toBe(1)
    expect((await anon('GET', `/api/articles/${published.id}`)).status).toBe(200)
  })

  it('/api/public/search returns the published article only', async () => {
    resetSearchLimiter()
    const res = await anon('GET', `/api/public/search?q=${encodeURIComponent(word('marker'))}&limit=50`)
    expect(res.status).toBe(200)
    const ids = (res.json.docs as Array<{ id: number }>).map((d) => d.id)
    for (const id of hiddenIds()) expect(ids).not.toContain(id)
    expect(res.text).not.toContain(SECRET_NOTE)
  })

  it('a scheduled article is not published early and the preview endpoint refuses it without a token', async () => {
    expect((await anon('GET', `/api/preview/articles`)).status).toBe(401)
    expect((await anon('GET', `/api/preview/articles?token=${createPreviewToken({ articleId: seeded.scheduled!.id }).token}x`)).status).toBe(401)
  })
})

describe('published-only invariant (live events, live updates, legacy comments)', () => {
  let draftEvent: Seeded
  let liveEvent: Seeded

  beforeAll(async () => {
    const mk = async (status: string, label: string) =>
      (await f.payload.create({
        collection: 'live-events',
        data: { title: `${runId} ${label}`, slug: `${runId}-${label}`, status, category: f.catA.id } as never,
        overrideAccess: true,
      })) as unknown as Seeded
    draftEvent = await mk('draft', 'ev-draft')
    liveEvent = await mk('live', 'ev-live')
    const upd = (event: number, status: string, body: string) =>
      f.payload.create({
        collection: 'live-updates',
        data: { event, status, body, occurredAt: NOW() } as never,
        overrideAccess: true,
      })
    await upd(draftEvent.id, 'approved', `${runId} approved-in-draft-event`)
    await upd(liveEvent.id, 'approved', `${runId} approved-visible`)
    await upd(liveEvent.id, 'pending', `${runId} PENDING-update`)
    await upd(liveEvent.id, 'rejected', `${runId} REJECTED-update`)
  })

  it('draft events are invisible everywhere; unapproved updates never leave the building', async () => {
    expect((await anon('GET', `/api/live-events/${draftEvent.id}`)).status).toBe(404)
    expect((await anon('GET', `/api/live-events/${draftEvent.slug}/updates`)).status).toBe(404)
    const list = await anon('GET', `/api/live-events?where[slug][like]=${runId}&limit=50`)
    expect((list.json.docs as Array<{ id: number }>).map((d) => d.id)).toEqual([liveEvent.id])
    const updates = await anon('GET', `/api/live-updates?limit=100&depth=2`)
    expect(updates.text).not.toMatch(/PENDING-update|REJECTED-update|approved-in-draft-event/)
    const poll = await anon('GET', `/api/live-events/${liveEvent.slug}/updates`)
    expect(poll.status).toBe(200)
    expect(poll.text).toContain('approved-visible')
    expect(poll.text).not.toMatch(/PENDING-update|REJECTED-update/)
    expect(forbiddenKeysIn(poll.json)).toEqual([])
  })

  it('legacy comments: only approved comments of published articles, never commenter e-mail/IP', async () => {
    const mkc = (article: number, status: string, n: number) =>
      f.payload.create({
        collection: 'legacy-comments',
        data: {
          article,
          legacyId: 800_000_000 + Math.floor(Math.random() * 1_000_000) + n,
          authorName: `${runId} Commenter`,
          authorEmail: `${runId}-c${n}@leak.test`,
          authorIp: '203.0.113.77',
          content: `${runId} comment ${status}`,
          commentedAt: NOW(),
          status,
        } as never,
        overrideAccess: true,
      })
    await mkc(published.id, 'approved', 1).catch(() => undefined)
    await mkc(published.id, 'hidden', 2).catch(() => undefined)
    await mkc(seeded.draft!.id, 'approved', 3).catch(() => undefined)
    const ok = await anon('GET', `/api/legacy-comments?article=${published.id}`)
    expect(ok.status).toBe(200)
    expect(ok.text).not.toMatch(/comment hidden|leak\.test|203\.0\.113\.77|authorEmail|authorIp/)
    const forDraft = await anon('GET', `/api/legacy-comments?article=${seeded.draft!.id}`)
    expect(forDraft.json?.docs ?? []).toEqual([])
    const generic = await anon('GET', `/api/legacy-comments?where[article][equals]=${seeded.draft!.id}&limit=50`)
    expect(generic.json?.docs ?? []).toEqual([])
  })
})

describe('provenance, legacy, e-mail and staff-only fields are never in an anonymous response', () => {
  const urls = () => [
    `/api/articles?${mine}&limit=100&depth=3`,
    `/api/articles/${published.id}?depth=4`,
    `/api/articles/${published.id}?depth=4&select[provenance]=true&select[reviewNotes]=true&select[author]=true`,
    `/api/articles?${mine}&populate[users][email]=true&depth=3`,
    `/api/categories?limit=100&depth=3`,
    `/api/media?limit=100&depth=3`,
    `/api/live-events?limit=100&depth=3`,
    `/api/live-updates?limit=100&depth=3`,
    `/api/public/search?q=${encodeURIComponent(word('marker'))}`,
    `/api/public/redirects`,
    `/api/public/advertising`,
    `/api/public/authors`,
    `/api/public/topics`,
    `/api/public/corrections`,
    `/api/public/site-trust`,
    `/api/authors?limit=100&depth=3`,
    `/api/topics?limit=100&depth=3`,
    `/api/legacy-comments?article=${published.id}`,
    `/api/users/me`,
    `/api/users/init`,
    `/api/access`,
  ]

  it('forbidden key names and known secret values appear in none of the anonymous GET responses', async () => {
    resetRedirectsCache()
    const problems: string[] = []
    for (const url of urls()) {
      const res = await anon('GET', url)
      if (res.status >= 500) problems.push(`${url} -> ${res.status}`)
      if (url.startsWith('/api/access')) continue // Payload permission map: key names are field names, not data
      const bad = forbiddenKeysIn(res.json)
      if (bad.length) problems.push(`${url}: ${bad.join(',')}`)
      for (const secret of [SECRET_NOTE, SOURCE_URL, f.users.reporter.email, `${runId}-batch`, 'leak.test']) {
        if (res.text.includes(secret)) problems.push(`${url}: leaks value ${secret.slice(0, 24)}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('legacyId/legacyUrl on articles are public BY CONTRACT (docs/api-contracts.md): pinned so a change is deliberate', async () => {
    const res = await anon('GET', `/api/articles/${published.id}?depth=0`)
    expect(res.json.legacyId).toBe(legacyIdValue)
    expect(res.json.legacyUrl).toContain('churchtimesnigeria.net')
    expect(res.json.provenance).toBeUndefined()
    expect(res.json.reviewNotes).toBeUndefined()
    expect(res.json.author).toBeUndefined()
  })

  it('filter oracle: querying on a field the caller cannot read is refused or matches nothing', async () => {
    const probes = [
      `where[reviewNotes][like]=${SECRET_NOTE}`,
      `where[reviewNotes][contains]=SECRETREVIEWNOTE`,
      `where[provenance.sourceUrl][equals]=${encodeURIComponent(SOURCE_URL)}`,
      `where[provenance.importBatch][like]=${runId}`,
      `where[provenance.reviewedBy][equals]=${f.users.eic.id}`,
      `where[provenance.reviewedAt][exists]=true`,
      `where[author][equals]=${f.users.reporter.id}`,
      `where[author.email][equals]=${encodeURIComponent(f.users.reporter.email)}`,
      `where[author.role][equals]=reporter`,
      `where[scheduledFor][exists]=true`,
    ]
    for (const p of probes) {
      const res = await anon('GET', `/api/articles?${p}&limit=5`)
      if (res.status === 200) {
        expect(res.json.docs, `oracle: ${p}`).toEqual([])
        expect(res.json.totalDocs, `oracle: ${p}`).toBe(0)
      } else {
        expect([400, 403, 404]).toContain(res.status)
      }
    }
    // same through /count and users (must never even answer)
    expect((await anon('GET', `/api/users?where[email][like]=${runId}`)).status).toBeGreaterThanOrEqual(400)
    expect((await anon('GET', `/api/articles/count?where[reviewNotes][like]=${SECRET_NOTE}`)).json?.totalDocs ?? 0).toBe(0)
  })
})

describe('preview tokens', () => {
  const previewUrl = (token: string) => `/api/preview/articles?token=${encodeURIComponent(token)}`

  it('a valid token shows exactly its article, without staff fields', async () => {
    const { token } = createPreviewToken({ articleId: seeded.draft!.id })
    const res = await anon('GET', previewUrl(token))
    expect(res.status).toBe(200)
    expect(res.json.doc.id).toBe(seeded.draft!.id)
    expect(forbiddenKeysIn(res.json)).toEqual([])
    expect(res.text).not.toContain(SECRET_NOTE)
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('expired, forged, tampered, truncated, malformed and cross-article tokens are all 401', async () => {
    const id = seeded.draft!.id
    const valid = createPreviewToken({ articleId: id }).token
    const expired = createPreviewToken({ articleId: id, now: new Date(Date.now() - 2 * 3600_000), ttlSeconds: 60 }).token
    const wrongSecret = createPreviewToken({ articleId: id, secret: 'x'.repeat(40) }).token
    const [payload, sig] = valid.split('.') as [string, string]
    const other = createPreviewToken({ articleId: seeded.approved!.id }).token.split('.')[0]!
    const forgedPayload = Buffer.from(JSON.stringify({ a: id, e: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
    const tokens: Record<string, string> = {
      expired,
      wrongSecret,
      'payload swapped to another article, same signature': `${other}.${sig}`,
      'forged payload, old signature': `${forgedPayload}.${sig}`,
      'signature stripped': `${payload}.`,
      'no signature part': payload,
      'extra part': `${valid}.x`,
      'alg-none style': `${payload}.AAAA`,
      empty: '',
      huge: 'A'.repeat(4000) + '.' + 'B'.repeat(4000),
      'sql-ish': "1' OR '1'='1.x",
      'null byte': `${payload}\u0000.${sig}`,
    }
    for (const [name, token] of Object.entries(tokens)) {
      const res = await anon('GET', previewUrl(token))
      // a NUL byte is refused earlier, by the proxy shape guard (400)
      expect(name === 'null byte' ? [400, 401] : [401], name).toContain(res.status)
      expect(res.text, name).not.toContain(SECRET_NOTE)
    }
  })

  it('a token for one article never opens another (id in the URL is ignored) and cannot be used as a media or REST credential', async () => {
    const token = createPreviewToken({ articleId: seeded.draft!.id }).token
    const other = await anon('GET', `/api/preview/articles?token=${encodeURIComponent(token)}&id=${seeded.approved!.id}&articleId=${seeded.approved!.id}`)
    expect(other.json.doc.id).toBe(seeded.draft!.id)
    // not an Authorization / cookie credential
    expect((await anon('GET', `/api/articles/${seeded.draft!.id}`, { headers: { authorization: `JWT ${token}` } })).status).toBe(404)
    expect((await anon('GET', `/api/articles/${seeded.draft!.id}`, { headers: { cookie: `payload-token=${token}` } })).status).toBe(404)
    expect((await anon('GET', `/api/articles/${seeded.draft!.id}?preview=${encodeURIComponent(token)}`)).status).toBe(404)
  })

  it('a preview token for article A does not unlock the media of article B', async () => {
    const token = createPreviewToken({ articleId: seeded.draft!.id }).token
    const res = await anon('GET', `/api/media/file/${privateMedia.filename}?preview=${encodeURIComponent(token)}`)
    expect([403, 404]).toContain(res.status)
  })

  it('only authenticated staff can mint a token, and only for an article they can read', async () => {
    expect((await anon('POST', `/api/articles/${seeded.draft!.id}/preview-token`, { body: {} })).status).toBe(401)
    const other = await anon('POST', `/api/articles/${seeded.draft!.id}/preview-token`, { token: f.tokens.reporter2, body: {} })
    expect([403, 404]).toContain(other.status)
  })
})

describe('media access', () => {
  const file = (name: string, headers: Record<string, string> = {}) => anon('GET', `/api/media/file/${name}`, { headers })

  it('media not used by a published article is private (metadata, list and bytes); published media is public', async () => {
    expect((await file(publicMedia.filename)).status).toBe(200)
    expect([403, 404]).toContain((await file(privateMedia.filename)).status)
    expect([403, 404]).toContain((await anon('GET', `/api/media/${privateMedia.id}`)).status)
    const list = await anon('GET', `/api/media?where[alt][like]=${runId}&limit=50`)
    expect((list.json.docs as Array<{ id: number }>).map((d) => d.id)).toEqual([publicMedia.id])
    expect(forbiddenKeysIn(list.json)).toEqual([])
  })

  it('Range requests cannot read private files and answer public ones consistently', async () => {
    for (const range of ['bytes=0-99', 'bytes=0-', 'bytes=-10', 'bytes=0-0,5-9', 'bytes=999999999-']) {
      const priv = await file(privateMedia.filename, { range })
      expect([403, 404], `private ${range}`).toContain(priv.status)
      const pub = await file(publicMedia.filename, { range })
      expect([200, 206, 416], `public ${range}`).toContain(pub.status)
    }
    const part = await file(publicMedia.filename, { range: 'bytes=0-7' })
    if (part.status === 206) expect(part.headers.get('content-range')).toMatch(/^bytes 0-7\//)
  })

  it('path traversal and encoded separators in the file route never read outside the media directory', async () => {
    for (const name of ['..%2f..%2fpackage.json', '%2e%2e%2f%2e%2e%2f.env', '..\\..\\package.json', `${publicMedia.filename}%00.png`, '....//....//etc/passwd']) {
      const res = await anon('GET', `/api/media/file/${name}`)
      expect(res.status, name).toBeGreaterThanOrEqual(400)
      expect(res.text).not.toMatch(/"name":\s*"churchtimes-cms"|PAYLOAD_SECRET|root:x:/)
    }
  })

  it('served images carry an image content type', async () => {
    const res = await file(publicMedia.filename)
    expect(res.headers.get('content-type')).toMatch(/^image\//)
    // nosniff for this route comes from next.config.mjs headers (asserted in transport.test.ts, 'response headers')
  })
})

describe('uploads: only real images are accepted, whatever the name or declared type says', () => {
  const upload = async (name: string, bytes: Buffer | string, type: string, token: string | null = f.tokens.reporter) => {
    const form = new FormData()
    form.set('_payload', JSON.stringify({ alt: `${runId} up-${name}` }))
    form.set('file', new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type }), name)
    return send('POST', '/api/media', { token: token ?? undefined, body: form })
  }
  const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(document.cookie)</script></svg>'
  const HTML = '<!doctype html><html><script>alert(1)</script></html>'
  const PHP = '<?php system($_GET["c"]); ?>'

  const cases: Array<[string, () => Buffer | string, string]> = [
    ['evil.svg', () => SVG, 'image/svg+xml'],
    ['evil.png', () => SVG, 'image/png'],
    ['evil.html', () => HTML, 'text/html'],
    ['evil.png.html', () => HTML, 'image/png'],
    ['evil.php', () => PHP, 'application/x-php'],
    ['evil.php.png', () => PHP, 'image/png'],
    ['evil.jpg', () => PHP, 'image/jpeg'],
    ['evil.phtml', () => PHP, 'image/png'],
    ['evil.gif', () => Buffer.from('GIF89a<?php system($_GET[0]);?>'), 'image/gif'],
    ['evil.js', () => 'alert(1)', 'application/javascript'],
    ['evil.exe', () => Buffer.from('MZ\u0090\u0000\u0003'), 'application/octet-stream'],
    ['empty.png', () => Buffer.alloc(0), 'image/png'],
  ]
  for (const [name, bytes, type] of cases) {
    it(`refuses ${name} (${type})`, async () => {
      const res = await upload(name, bytes(), type)
      expect(res.status, res.text.slice(0, 200)).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
    })
  }

  it('a PNG with PHP appended is re-encoded: the stored bytes no longer contain the payload', async () => {
    const poly = Buffer.concat([png, Buffer.from(PHP)])
    const res = await upload('poly.png', poly, 'image/png')
    if (res.status >= 400) {
      expect(res.status).toBeLessThan(500)
      return
    }
    const bytes = await anon('GET', `/api/media/file/${res.json.doc.filename}`, { token: f.tokens.reporter })
    // staff token: the file route is readable by staff; metadata stripping/re-encoding drops trailing data
    expect(bytes.text).not.toContain('<?php')
    expect(res.json.doc.mimeType).toBe('image/png')
    expect(res.json.doc.filename).toMatch(/\.png$/)
  })

  it('anonymous upload is refused', async () => {
    const res = await upload('anon.png', png, 'image/png', null)
    expect([401, 403]).toContain(res.status)
  })

  it('filenames with traversal, null bytes or double extensions are sanitised, never written outside', async () => {
    for (const name of ['../../evil.png', '..\\..\\evil.png', 'con.png', '.htaccess.png', `${'x'.repeat(400)}.png`]) {
      const res = await upload(name, png, 'image/png')
      if (res.status === 201) {
        expect(res.json.doc.filename).not.toMatch(/[\\/\u0000]|\.\./)
        expect(res.json.doc.filename.length).toBeLessThanOrEqual(255)
      } else {
        expect(res.status, JSON.stringify(name.slice(0, 30)) + ' ' + res.text.slice(0, 200)).toBeLessThan(500)
      }
    }
  })
})

describe('NUL byte in an uploaded file name (was F-2)', () => {
  it('is a 400 from the proxy shape guard, never a 500, and nothing is stored', async () => {
    const form = new FormData()
    form.set('_payload', JSON.stringify({ alt: `${runId} nul` }))
    form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'a' + String.fromCharCode(0) + '.php.png')
    const res = await send('POST', '/api/media', { token: f.tokens.reporter, body: form })
    expect(res.status).toBe(400)
    const found = await f.payload.find({ collection: 'media', where: { alt: { equals: `${runId} nul` } }, overrideAccess: true })
    expect(found.totalDocs).toBe(0)
  })
})

describe('redirects: no open redirect through the public list', () => {
  it('rows pointing at another host are refused at write time or never served; every served target is local or allow-listed', async () => {
    const evil = ['//evil.example/x', 'https://evil.example/x', 'http://evil.example', '/\\evil.example', 'javascript:alert(1)', 'data:text/html,x', '/%0d%0aSet-Cookie:x=1', '///evil.example', 'https:evil.example']
    let n = 0
    for (const to of evil) {
      await f.payload
        .create({ collection: 'redirects', data: { from: `/${runId}-evil-${++n}/`, to, status: 301, source: 'manual' } as never, overrideAccess: true })
        .catch(() => undefined)
    }
    resetRedirectsCache()
    const res = await anon('GET', '/api/public/redirects')
    expect(res.status).toBe(200)
    const rules = (res.json?.rules ?? res.json?.redirects ?? res.json) as unknown
    const flat = JSON.stringify(rules)
    expect(flat).not.toMatch(/evil\.example|javascript:|data:text|%0d%0a/i)
    const allowedHosts = (process.env.REDIRECT_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const targets: string[] = []
    const collect = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(collect)
      else if (node && typeof node === 'object') {
        const t = (node as { to?: unknown }).to
        if (typeof t === 'string') targets.push(t)
        Object.values(node as object).forEach(collect)
      }
    }
    collect(res.json)
    for (const t of targets) {
      if (t.startsWith('/')) expect(t.startsWith('//') || t.includes('\\'), t).toBe(false)
      else expect(allowedHosts.includes(new URL(t).hostname), `absolute target ${t}`).toBe(true)
    }
  })
})
