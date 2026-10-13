/**
 * Media upload (multipart) and rendering through an article's featuredImage, against the real server.
 * Creates its own media + article and deletes them at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BASE_URL, Client, NEWSROOM_ORIGIN, categoryId, lexical, loginAs, makePng, mediaForm, newRunId } from './support'

const runId = newRunId()
const mediaIds: number[] = []
const articleIds: number[] = []

let reporter: Client
let editor: Client
let admin: Client
let anon: Client
let cat: number

/** Media `url` is absolute (CMS_PUBLIC_URL = the browser hostname); from a script we hit the loopback address. */
const loopback = (url: string) => BASE_URL + new URL(url, BASE_URL).pathname

beforeAll(async () => {
  reporter = (await loginAs('reporter', NEWSROOM_ORIGIN)).client
  editor = (await loginAs('editor-in-chief', NEWSROOM_ORIGIN)).client
  admin = (await loginAs('admin')).client
  anon = new Client()
  cat = await categoryId(anon)
})

afterAll(async () => {
  for (const id of articleIds) await admin?.del(`/api/articles/${id}`).catch(() => undefined)
  for (const id of mediaIds) await admin?.del(`/api/media/${id}`).catch(() => undefined)
})

describe('media upload and delivery', () => {
  let media: { id: number; url: string; alt: string; mimeType: string; width: number; height: number; sizes?: Record<string, { url?: string }> }

  it('a staff member can upload a PNG as multipart/form-data (file + _payload) -> 201 with absolute url and sizes', async () => {
    const res = await reporter.post('/api/media', { body: mediaForm(makePng(1200, 800), `${runId}-photo.png`, 'image/png', `${runId} alt text`), origin: NEWSROOM_ORIGIN })
    expect(res.status, res.text.slice(0, 300)).toBe(201)
    media = res.json.doc
    mediaIds.push(media.id)
    expect(media).toMatchObject({ alt: `${runId} alt text`, mimeType: 'image/png', width: 1200, height: 800 })
    expect(media.url).toMatch(/^http:\/\/cms\.churchtimes\.localhost:\d+\/api\/media\/file\/.+\.png$/)
    expect(media.sizes?.thumbnail?.url, "resized thumbnail (400px) generated").toBeTruthy()
    expect(media.sizes?.card?.url, "resized card (800px) generated").toBeTruthy()
  })

  it('fetching the media URL returns 200, image/png and X-Content-Type-Options: nosniff', async () => {
    expect(media, 'upload test must run first').toBeDefined()
    const res = await fetch(loopback(media.url))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^image\/png/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('the file is also served to anonymous callers without cookies (public site <img src>)', async () => {
    const res = await fetch(loopback(media.url), { headers: { origin: 'http://www.churchtimes.localhost:5173' } })
    expect(res.status).toBe(200)
  })

  it('an article with this featuredImage renders it at depth=1 for anonymous readers (url, alt, sizes)', async () => {
    const slug = `${runId}-with-image`
    const created = await editor.post('/api/articles', {
      json: { title: `${runId} with image`, slug, content: lexical('Image body.'), category: cat, featuredImage: media.id, status: 'published' },
      origin: NEWSROOM_ORIGIN,
    })
    expect(created.status, created.text.slice(0, 300)).toBe(201)
    articleIds.push(created.json.doc.id)

    const pub = await anon.get(`/api/articles?where[slug][equals]=${slug}&depth=1`, { credentials: false })
    const doc = pub.json.docs[0]
    expect(doc.featuredImage).toMatchObject({ id: media.id, alt: `${runId} alt text`, url: media.url })
    expect(doc.featuredImage.sizes).toBeTruthy()
    expect(doc.featuredImage.uploadedBy, 'uploadedBy is staff-only').toBeUndefined()

    const depth0 = await anon.get(`/api/articles?where[slug][equals]=${slug}&depth=0`, { credentials: false })
    expect(depth0.json.docs[0].featuredImage).toBe(media.id)

    // The image URL the page would use actually loads.
    expect((await fetch(loopback(doc.featuredImage.url))).status).toBe(200)
  })

  it('anonymous callers cannot upload', async () => {
    const res = await anon.post('/api/media', { body: mediaForm(makePng(), `${runId}-anon.png`, 'image/png', `${runId} anon`), credentials: false })
    expect([401, 403]).toContain(res.status)
  })

  it('SVG / HTML / mislabelled files are rejected (content is verified, not just the declared type)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const html = Buffer.from('<html><script>alert(1)</script></html>')
    const cases: [string, Buffer, string][] = [
      [`${runId}-x.svg`, svg, 'image/svg+xml'],
      [`${runId}-x.html`, html, 'text/html'],
      [`${runId}-fake.png`, html, 'image/png'], // declared PNG, contents HTML
    ]
    for (const [name, data, mime] of cases) {
      const res = await reporter.post('/api/media', { body: mediaForm(data, name, mime, `${runId} bad`), origin: NEWSROOM_ORIGIN })
      expect(res.status, name).toBeGreaterThanOrEqual(400)
      expect(res.status, name).toBeLessThan(500)
      if (res.json?.doc?.id) mediaIds.push(res.json.doc.id)
    }
  })

  it('an upload larger than the 11 MB media limit is 413 (proxy.ts) with CORS for the newsroom origin', async () => {
    const big = Buffer.concat([makePng(), Buffer.alloc(11 * 1024 * 1024 + 1024)])
    const res = await reporter.post('/api/media', { body: mediaForm(big, `${runId}-big.png`, 'image/png', `${runId} big`), origin: NEWSROOM_ORIGIN })
    expect(res.status).toBe(413)
    expect(res.headers.get('access-control-allow-origin')).toBe(NEWSROOM_ORIGIN)
  })
})
