import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, lexical, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Media privacy (review finding M3): anonymous readers only get media that is on the public site (featured or body
 * image of a PUBLISHED article, image of an APPROVED live update of a live/ended event). Everything else is private:
 * metadata (list + by id) and bytes (the original and every size variant under /api/media/file/<name>).
 */
const runId = newRunId()
let f: Fixtures
let png: Buffer

beforeAll(async () => {
  f = await setupFixtures(runId)
  // Big enough that Payload generates the thumbnail (400) and card (800) variants.
  png = await sharp({ create: { width: 1000, height: 600, channels: 3, background: { r: 20, g: 120, b: 80 } } }).png().toBuffer()
})

afterAll(async () => {
  await f?.cleanup()
})

type Media = { id: number; filename: string; files: string[] }

async function uploadMedia(token: string, label: string): Promise<Media> {
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt: `${runId} ${label}` }))
  form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${runId}-${label}.png`)
  const res = await api('POST', '/api/media', { token, body: form })
  expect(res.status).toBe(201)
  const row = (await f.payload.findByID({ collection: 'media', id: res.json.doc.id, depth: 0, overrideAccess: true })) as unknown as {
    id: number
    filename: string
    sizes: Record<string, { filename?: string | null }>
  }
  const files = [row.filename, ...Object.values(row.sizes ?? {}).map((s) => s.filename ?? '')].filter(Boolean)
  expect(files.length).toBeGreaterThanOrEqual(3) // original + thumbnail + card
  return { id: row.id, filename: row.filename, files }
}

const upload = (value: unknown) => ({ type: 'upload', relationTo: 'media', value, fields: null, format: '', version: 3 })
const withImage = (id: number) => {
  const doc = lexical() as { root: { children: unknown[] } }
  doc.root.children.push(upload(id))
  return doc
}

const getMeta = (m: Media, token?: string) => api('GET', `/api/media/${m.id}?depth=0`, { token })
const getFile = (name: string, token?: string) => api('GET', `/api/media/file/${name}`, { token })
const listIds = async (token?: string): Promise<number[]> => {
  const res = await api('GET', `/api/media?where[alt][like]=${runId}&limit=100&depth=0`, { token })
  expect(res.status).toBe(200)
  return res.json.docs.map((d: { id: number }) => d.id)
}

/** Every way in: by id, in the list, the original file and each size variant. */
async function expectPublic(m: Media) {
  expect((await getMeta(m)).status).toBe(200)
  expect(await listIds()).toContain(m.id)
  for (const name of m.files) expect((await getFile(name)).status).toBe(200)
}
async function expectPrivate(m: Media) {
  expect([403, 404]).toContain((await getMeta(m)).status)
  expect(await listIds()).not.toContain(m.id)
  expect((await api('GET', `/api/media?where[id][equals]=${m.id}&depth=0`)).json.docs).toEqual([])
  for (const name of m.files) expect([403, 404]).toContain((await getFile(name)).status)
  // Staff still see everything.
  expect((await getMeta(m, f.tokens.reporter2)).status).toBe(200)
  expect(await listIds(f.tokens.reporter2)).toContain(m.id)
  for (const name of m.files) expect((await getFile(name, f.tokens.reporter2)).status).toBe(200)
}

const patchArticle = (id: number, body: Record<string, unknown>) =>
  api('PATCH', `/api/articles/${id}`, { token: f.tokens.eic, body })

async function createEvent(label: string, status = 'live') {
  const slug = `${runId}-${label}`
  const res = await api('POST', '/api/live-events', {
    token: f.tokens.eic,
    body: { title: `${runId} ${label}`, slug, category: f.catA.id, status },
  })
  expect(res.status).toBe(201)
  return res.json.doc.id as number
}
const postUpdate = (token: string, event: number, body: Record<string, unknown>) =>
  api('POST', '/api/live-updates', { token, body: { event, body: `Update ${runId}`, ...body } })

describe('media privacy: articles', () => {
  it('serves the featured image of a published article to everyone, and keeps it private before and after', async () => {
    const m = await uploadMedia(f.tokens.reporter, 'featured')
    const art = await f.createArticle(f.tokens.reporter, { featuredImage: m.id })
    expect(art.status).toBe(201)
    await expectPrivate(m) // draft

    expect((await f.createArticle(f.tokens.reporter, { featuredImage: m.id, status: 'in_review' })).status).toBe(201)
    await expectPrivate(m) // in review

    const pub = await f.createArticle(f.tokens.eic, { featuredImage: m.id, status: 'published' })
    expect(pub.status).toBe(201)
    await expectPublic(m)

    // Depth-populated media inside the published article response still reaches anonymous readers.
    const anon = await api('GET', `/api/articles/${pub.id}?depth=1`)
    expect(anon.status).toBe(200)
    expect(anon.json.featuredImage).toMatchObject({ id: m.id, filename: m.filename })
    expect(anon.json.featuredImage.url).toBe(`/api/media/file/${m.filename}`)
    expect(anon.json.featuredImage).not.toHaveProperty('uploadedBy')
    expect(anon.json.featuredImage).not.toHaveProperty('publishedAsFeatured')
    expect(anon.json.featuredImage).not.toHaveProperty('publishedInBody')
    expect(anon.json.featuredImage).not.toHaveProperty('liveUpdateImages')
    // list populate the way the public site calls it
    const list = await api('GET', `/api/articles?where[status][equals]=published&where[slug][equals]=${pub.json.doc.slug}&depth=1`)
    expect(list.json.docs[0].featuredImage.filename).toBe(m.filename)

    // Used by two published articles: still listed exactly once (join must not duplicate rows).
    const pub2 = await f.createArticle(f.tokens.eic, { featuredImage: m.id, status: 'published' })
    expect(pub2.status).toBe(201)
    const ids = await listIds()
    expect(ids.filter((id) => id === m.id)).toHaveLength(1)
    const total = await api('GET', `/api/media?where[alt][like]=${runId} featured&depth=0`)
    expect(total.json.totalDocs).toBe(1)

    // Unpublish: private again, as soon as no published article uses it.
    expect((await patchArticle(pub.id!, { status: 'archived' })).status).toBe(200)
    await expectPublic(m) // pub2 still shows it
    expect((await patchArticle(pub2.id!, { status: 'archived' })).status).toBe(200)
    await expectPrivate(m)
    expect((await patchArticle(pub.id!, { status: 'published' })).status).toBe(200)
    await expectPublic(m)
  })

  it('serves a body image of a published article, and not before publication or for a scheduled article', async () => {
    const m = await uploadMedia(f.tokens.reporter, 'body')
    const draft = await f.createArticle(f.tokens.reporter, { content: withImage(m.id) })
    expect(draft.status).toBe(201)
    await expectPrivate(m)

    const when = new Date(Date.now() + 3_600_000).toISOString()
    const sched = await f.createArticle(f.tokens.eic, { content: withImage(m.id), status: 'scheduled', scheduledFor: when })
    expect(sched.status).toBe(201)
    await expectPrivate(m) // scheduled is NOT public

    const pub = await f.createArticle(f.tokens.eic, { content: withImage(m.id), status: 'published' })
    expect(pub.status).toBe(201)
    await expectPublic(m)

    // The populated upload node in the anonymous article response.
    const anon = await api('GET', `/api/articles/${pub.id}?depth=1`)
    expect(anon.status).toBe(200)
    const node = anon.json.content.root.children.find((c: { type: string }) => c.type === 'upload')
    expect(node.value).toMatchObject({ id: m.id, filename: m.filename })

    // Body images in the anonymous response of a staff-only (draft) article's neighbour are not leaked either way.
    expect((await patchArticle(pub.id!, { status: 'archived' })).status).toBe(200)
    await expectPrivate(m)
  })

  it('keeps draft-only and unreferenced uploads private (metadata, file and size variants)', async () => {
    const unused = await uploadMedia(f.tokens.reporter, 'unused')
    await expectPrivate(unused)
    const draftOnly = await uploadMedia(f.tokens.reporter, 'draft-only')
    expect((await f.createArticle(f.tokens.reporter, { featuredImage: draftOnly.id, content: withImage(draftOnly.id) })).status).toBe(201)
    await expectPrivate(draftOnly)
    // Depth-populated draft media is not exposed through a staff-visible draft to an anonymous reader (draft is 404).
    const anonList = await api('GET', `/api/articles?where[slug][like]=${runId}&depth=1`)
    expect(anonList.text).not.toContain(draftOnly.filename)
  })

  it('does not let a file route probe leak existence: private and unknown names answer alike', async () => {
    const m = await uploadMedia(f.tokens.reporter, 'probe')
    const priv = await getFile(m.filename)
    const missing = await getFile(`${runId}-does-not-exist.png`)
    expect(priv.status).toBe(missing.status)
    expect(priv.status).toBe(403)
  })
})

describe('media privacy: live updates', () => {
  it('serves the photo only once its live update is approved, and only for non-draft events', async () => {
    const ev = await createEvent('live')
    const pendingPhoto = await uploadMedia(f.tokens.reporter, 'live-pending')
    const approvedPhoto = await uploadMedia(f.tokens.reporter, 'live-approved')
    const rejectedPhoto = await uploadMedia(f.tokens.reporter, 'live-rejected')

    const pending = (await postUpdate(f.tokens.reporter, ev, { image: pendingPhoto.id })).json.doc
    const toApprove = (await postUpdate(f.tokens.reporter, ev, { image: approvedPhoto.id })).json.doc
    const toReject = (await postUpdate(f.tokens.reporter, ev, { image: rejectedPhoto.id })).json.doc
    expect(pending.status).toBe('pending')

    await expectPrivate(pendingPhoto)
    await expectPrivate(approvedPhoto)
    await expectPrivate(rejectedPhoto)

    expect((await api('PATCH', `/api/live-updates/${toApprove.id}`, { token: f.tokens.eic, body: { status: 'approved' } })).status).toBe(200)
    expect((await api('PATCH', `/api/live-updates/${toReject.id}`, { token: f.tokens.eic, body: { status: 'rejected' } })).status).toBe(200)

    await expectPublic(approvedPhoto)
    await expectPrivate(pendingPhoto)
    await expectPrivate(rejectedPhoto)

    // Un-approving (approved -> rejected) takes it private again.
    expect((await api('PATCH', `/api/live-updates/${toApprove.id}`, { token: f.tokens.eic, body: { status: 'rejected' } })).status).toBe(200)
    await expectPrivate(approvedPhoto)

    // An approved update of a DRAFT event is not public (same rule as the live feed), so neither is its photo.
    const draftEv = await createEvent('live-draft', 'draft')
    const draftEvPhoto = await uploadMedia(f.tokens.eic, 'live-draft-event')
    expect((await postUpdate(f.tokens.eic, draftEv, { image: draftEvPhoto.id, status: 'approved' })).status).toBe(201)
    await expectPrivate(draftEvPhoto)
    expect((await api('PATCH', `/api/live-events/${draftEv}`, { token: f.tokens.eic, body: { status: 'live' } })).status).toBe(200)
    await expectPublic(draftEvPhoto)
  })

  it('keeps the public live feed working (it reads the image itself) and still lists it for anonymous media reads', async () => {
    const ev = await createEvent('feed')
    const slug = `${runId}-feed`
    const m = await uploadMedia(f.tokens.eic, 'feed-photo')
    expect((await postUpdate(f.tokens.eic, ev, { image: m.id, status: 'approved' })).status).toBe(201)
    const feed = await api('GET', `/api/live-events/${slug}/updates`)
    expect(feed.status).toBe(200)
    const image = feed.json.docs[0].image as { url: string }
    expect(image.url).toMatch(/^\/api\/media\/file\//)
    expect((await api('GET', image.url)).status).toBe(200)
  })
})

describe('media privacy: staff', () => {
  it('lets every staff role read all media, including uploads used nowhere', async () => {
    const m = await uploadMedia(f.tokens.reporter, 'staff')
    for (const role of ['reporter', 'reporter2', 'sectionEditor', 'trusted', 'eic', 'admin'] as const) {
      expect((await getMeta(m, f.tokens[role])).status).toBe(200)
      expect((await getFile(m.filename, f.tokens[role])).status).toBe(200)
      expect(await listIds(f.tokens[role])).toContain(m.id)
    }
  })
})
