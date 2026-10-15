import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPreviewToken } from '../../src/lib/previewToken'
import { api, lexical, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Review follow-ups R1 (preview token media access, preview payload hygiene), R2 (no join subqueries on media reads),
 * R4 (replacing a media file re-delivers approved live updates), R5 (live event endedAt), R6 (refused replacement keeps
 * the old file).
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

const form = (alt: string | undefined, name: string) => {
  const fd = new FormData()
  fd.set('_payload', JSON.stringify(alt === undefined ? {} : { alt }))
  fd.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), name)
  return fd
}

async function uploadMedia(token: string, label: string): Promise<Media> {
  const res = await api('POST', '/api/media', { token, body: form(`${runId} ${label}`, `${runId}-${label}.png`) })
  expect(res.status).toBe(201)
  return rowOf(res.json.doc.id)
}

async function rowOf(id: number): Promise<Media> {
  const row = (await f.payload.findByID({ collection: 'media', id, depth: 0, overrideAccess: true })) as unknown as {
    id: number
    filename: string
    sizes: Record<string, { filename?: string | null }>
  }
  const files = [row.filename, ...Object.values(row.sizes ?? {}).map((s) => s.filename ?? '')].filter(Boolean)
  return { id: row.id, filename: row.filename, files }
}

const upload = (value: unknown) => ({ type: 'upload', relationTo: 'media', value, fields: null, format: '', version: 3 })
const withImage = (id: number) => {
  const doc = lexical() as { root: { children: unknown[] } }
  doc.root.children.push(upload(id))
  return doc
}
const getFile = (url: string, token?: string) => api('GET', url, { token })

describe('R1 preview token: media of the previewed article only', () => {
  it('serves that article\'s images (original, size variants, by id) to the token holder and nothing else', async () => {
    const featured = await uploadMedia(f.tokens.reporter, 'prev-featured')
    const body = await uploadMedia(f.tokens.reporter, 'prev-body')
    const other = await uploadMedia(f.tokens.reporter, 'prev-other')
    const art = await f.createArticle(f.tokens.reporter, { featuredImage: featured.id, content: withImage(body.id) })
    expect(art.status).toBe(201)
    const otherArt = await f.createArticle(f.tokens.reporter, { featuredImage: other.id })
    expect(otherArt.status).toBe(201)

    // Without a token the draft's images are private.
    for (const name of [...featured.files, ...body.files]) expect([403, 404]).toContain((await getFile(`/api/media/file/${name}`)).status)

    const minted = (await api('POST', `/api/articles/${art.id}/preview-token`, { token: f.tokens.reporter })).json
    const token = minted.token as string
    const enc = encodeURIComponent(token)
    const preview = await api('GET', `/api/preview/articles?token=${enc}`)
    expect(preview.status).toBe(200)

    // No staff-only data in the preview payload.
    for (const key of ['bodyMedia', 'publishedAsFeatured', 'publishedInBody', 'liveUpdateImages', 'uploadedBy', 'reviewNotes']) {
      expect(preview.text, key).not.toContain(`"${key}"`)
    }

    // Every media url (featured image, its size variants, the body image) carries the token and loads.
    const doc = preview.json.doc
    const urls: string[] = [doc.featuredImage.url, ...Object.values(doc.featuredImage.sizes as Record<string, { url?: string }>).map((s) => s.url ?? '')]
    const bodyNode = (doc.content.root.children as Array<{ type: string; value?: { url?: string } }>).find((n) => n.type === 'upload')
    expect(bodyNode?.value?.url, 'body image is populated in the preview').toBeTruthy()
    urls.push(bodyNode!.value!.url!)
    const real = urls.filter(Boolean)
    expect(real.length).toBeGreaterThanOrEqual(4) // original + thumbnail + card (+ hero) + body image
    for (const url of real) {
      expect(url, url).toContain(`preview=${enc}`)
      const res = await getFile(url)
      expect(res.status, url).toBe(200)
    }
    expect((await api('GET', `/api/media/${featured.id}?depth=0&preview=${enc}`)).status).toBe(200)

    // Scoped to this article: other media, and the same media without the token, stay private.
    for (const name of other.files) {
      expect([403, 404], name).toContain((await getFile(`/api/media/file/${name}?preview=${enc}`)).status)
    }
    expect([403, 404]).toContain((await api('GET', `/api/media/${other.id}?depth=0&preview=${enc}`)).status)
    expect([403, 404]).toContain((await getFile(`/api/media/file/${featured.filename}`)).status)

    // A token for another article does not open this one's images.
    const otherToken = encodeURIComponent((await api('POST', `/api/articles/${otherArt.id}/preview-token`, { token: f.tokens.reporter })).json.token)
    expect([403, 404]).toContain((await getFile(`/api/media/file/${featured.filename}?preview=${otherToken}`)).status)
    expect((await getFile(`/api/media/file/${other.filename}?preview=${otherToken}`)).status).toBe(200)

    // Expired, tampered and garbage tokens do nothing.
    const expired = createPreviewToken({ articleId: art.id!, ttlSeconds: 60, now: new Date(Date.now() - 3_600_000) }).token
    expect([403, 404]).toContain((await getFile(`/api/media/file/${featured.filename}?preview=${encodeURIComponent(expired)}`)).status)
    const [payloadPart, sig] = token.split('.') as [string, string]
    const tampered = `${payloadPart}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`
    expect([403, 404]).toContain((await getFile(`/api/media/file/${featured.filename}?preview=${encodeURIComponent(tampered)}`)).status)
    expect([403, 404]).toContain((await getFile(`/api/media/file/${featured.filename}?preview=garbage`)).status)
    expect([403, 404]).toContain((await getFile(`/api/media/file/${featured.filename}?preview=`)).status)
  })
})

describe('R2 media reads never evaluate join fields', () => {
  it('passes joins: false to the database for list, by-id and populated reads, and still filters', async () => {
    const m = await uploadMedia(f.tokens.reporter, 'joins')
    const hidden = await uploadMedia(f.tokens.reporter, 'joins-hidden')
    const pub = await f.createArticle(f.tokens.eic, { featuredImage: m.id, status: 'published' })
    expect(pub.status).toBe(201)

    const db = f.payload.db as unknown as Record<string, (args: Record<string, unknown>) => Promise<unknown>>
    const seen: Array<{ method: string; joins: unknown }> = []
    const originals: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {}
    for (const method of ['find', 'findOne']) {
      originals[method] = db[method]!
      db[method] = function (this: unknown, args: Record<string, unknown>) {
        if (args?.collection === 'media') seen.push({ method, joins: args.joins })
        return originals[method]!.call(db, args)
      }
    }
    try {
      const list = await api('GET', `/api/media?where[alt][like]=${runId} joins&limit=50&depth=0`)
      const byId = await api('GET', `/api/media/${m.id}?depth=0`)
      const populated = await api('GET', `/api/articles/${pub.id}?depth=1`)
      const hiddenById = await api('GET', `/api/media/${hidden.id}?depth=0`)
      // Filtering is unchanged: only the media on a published article is visible to an anonymous caller.
      expect(list.json.docs.map((d: { id: number }) => d.id)).toEqual([m.id])
      expect(byId.status).toBe(200)
      expect(populated.json.featuredImage.filename).toBe(m.filename)
      expect([403, 404]).toContain(hiddenById.status)
    } finally {
      for (const method of Object.keys(originals)) db[method] = originals[method]!
    }
    expect(seen.length).toBeGreaterThanOrEqual(3)
    for (const s of seen) expect(s, JSON.stringify(s)).toMatchObject({ joins: false })
  })
})

describe('R4 replacing the file of an image on an approved live update re-delivers the update', () => {
  it('gives the update a new publishSequence and the new url', async () => {
    const ev = await api('POST', '/api/live-events', {
      token: f.tokens.eic,
      body: { title: `${runId} r4`, slug: `${runId}-r4`, category: f.catA.id, status: 'live' },
    })
    expect(ev.status).toBe(201)
    const slug = `${runId}-r4`
    const m = await uploadMedia(f.tokens.eic, 'r4')
    const u = await api('POST', '/api/live-updates', {
      token: f.tokens.eic,
      body: { event: ev.json.doc.id, body: `${runId} update`, image: m.id, status: 'approved' },
    })
    expect(u.status).toBe(201)
    const other = await api('POST', '/api/live-updates', { token: f.tokens.eic, body: { event: ev.json.doc.id, body: `${runId} plain`, status: 'approved' } })
    expect(other.status).toBe(201)

    const first = await api('GET', `/api/live-events/${slug}/updates`)
    expect(first.json.docs.map((d: { sequence: number }) => d.sequence)).toEqual([1, 2])
    const cursor = first.json.nextSince as number
    const oldUrl = first.json.docs[0].image.url as string

    // An editor replaces the file: the filename (and so the feed url) changes.
    const replaced = await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.eic, body: form(`${runId} r4`, `${runId}-r4-new.png`) })
    expect(replaced.status).toBe(200)
    const poll = await api('GET', `/api/live-events/${slug}/updates?since=${cursor}`)
    expect(poll.json.docs).toHaveLength(1)
    expect(poll.json.docs[0]).toMatchObject({ id: u.json.doc.id, sequence: 3 })
    expect(poll.json.docs[0].image.url).not.toBe(oldUrl)
    expect((await getFile(poll.json.docs[0].image.url)).status).toBe(200)
    expect(poll.json.nextSince).toBe(3)

    // A changed alt text is re-delivered too; an edit that changes neither is not.
    expect((await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.eic, body: { alt: `${runId} r4 new alt` } })).status).toBe(200)
    const afterAlt = await api('GET', `/api/live-events/${slug}/updates?since=3`)
    expect(afterAlt.json.docs[0]).toMatchObject({ id: u.json.doc.id, sequence: 4, image: { alt: `${runId} r4 new alt` } })
    expect((await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.eic, body: { caption: 'caption only' } })).status).toBe(200)
    expect((await api('GET', `/api/live-events/${slug}/updates?since=4`)).json.docs).toEqual([])
  })
})

describe('R5 live event endedAt', () => {
  it('re-stamps endedAt on ended again and clears it while live', async () => {
    const slug = `${runId}-r5`
    const created = await api('POST', '/api/live-events', {
      token: f.tokens.eic,
      body: { title: `${runId} r5`, slug, category: f.catA.id, status: 'live' },
    })
    expect(created.status).toBe(201)
    expect(created.json.doc.endedAt ?? null).toBeNull()
    const id = created.json.doc.id as number
    const patch = (status: string, extra: Record<string, unknown> = {}) =>
      api('PATCH', `/api/live-events/${id}`, { token: f.tokens.eic, body: { status, ...extra } })

    const ended1 = (await patch('ended')).json.doc.endedAt as string
    expect(ended1).toBeTruthy()
    const live = (await patch('live')).json.doc
    expect(live.endedAt ?? null).toBeNull()
    expect(live.startedAt).toBeTruthy()
    await new Promise((r) => setTimeout(r, 30))
    const ended2 = (await patch('ended')).json.doc.endedAt as string
    expect(Date.parse(ended2)).toBeGreaterThan(Date.parse(ended1))

    // Editing an ended event keeps its endedAt; a client-supplied endedAt on the transition is respected.
    expect((await api('PATCH', `/api/live-events/${id}`, { token: f.tokens.eic, body: { summary: 'x' } })).json.doc.endedAt).toBe(ended2)
    await patch('live')
    const chosen = '2026-01-02T03:04:05.000Z'
    expect((await patch('ended', { endedAt: chosen })).json.doc.endedAt).toBe(chosen)
  })
})

describe('R6 a refused replacement keeps the old file', () => {
  it('rejects empty, blank or over-long alt before any file handling (owner and editor, non-frozen media)', async () => {
    const m = await uploadMedia(f.tokens.reporter, 'r6')
    const before = await api('GET', `/api/media/file/${m.filename}`, { token: f.tokens.reporter })
    expect(before.status).toBe(200)
    const snapshot = async () => {
      const row = (await f.payload.findByID({ collection: 'media', id: m.id, depth: 0, overrideAccess: true })) as unknown as Record<string, unknown>
      const file = await api('GET', `/api/media/file/${String(row.filename)}`, { token: f.tokens.reporter })
      return { status: file.status, bytes: file.text, filename: row.filename, filesize: row.filesize, alt: row.alt, width: row.width }
    }
    const base = await snapshot()
    expect(base.status).toBe(200)

    for (const token of [f.tokens.reporter, f.tokens.eic]) {
      for (const alt of ['', '   ', 'x'.repeat(301)]) {
        const res = await api('PATCH', `/api/media/${m.id}`, { token, body: form(alt, `${runId}-r6-new.png`) })
        expect(res.status, `alt length ${alt.length}`).toBe(400)
        expect(res.text).toMatch(/Alt text/)
        expect(await snapshot()).toEqual(base)
      }
    }

    // Without alt in the payload the stored alt applies and the replacement is fine.
    const ok = await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.reporter, body: form(undefined, `${runId}-r6-ok.png`) })
    expect(ok.status).toBe(200)
    const after = await snapshot()
    expect(after.status).toBe(200)
    expect(after.filename).not.toBe(base.filename)
  })
})
