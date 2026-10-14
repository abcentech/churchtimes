import { sql } from '@payloadcms/db-postgres'
import sharp from 'sharp'
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

// 1x1 PNG
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

type MediaDoc = { id: number; url: string; filename: string }

async function uploadMedia(token: string, label: string): Promise<MediaDoc> {
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt: `${runId} ${label}` }))
  form.set('file', new Blob([new Uint8Array(PNG_1X1)], { type: 'image/png' }), `${runId}-${label}.png`)
  const res = await api('POST', '/api/media', { token, body: form })
  expect(res.status).toBe(201)
  return res.json.doc as MediaDoc
}

/** What a reader and the database see of a media document: the served bytes plus the stored row. */
async function snapshot(m: { id: number }) {
  const row = (await f.payload.findByID({ collection: 'media', id: m.id, depth: 0, overrideAccess: true })) as unknown as Record<string, unknown>
  // Current filename (a legitimate replacement changes it, so the url captured at upload time can be stale).
  const file = await api('GET', `/api/media/file/${String(row.filename)}`)
  return {
    status: file.status,
    bytes: file.text,
    row: { filename: row.filename, filesize: row.filesize, width: row.width, height: row.height, alt: row.alt, mimeType: row.mimeType },
  }
}

/** Direct SQL: the API itself never allows an empty alt or a non-image mime type, which is the point. */
const setMediaColumn = async (id: number, column: 'alt' | 'mime_type', value: string) => {
  const db = f.payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<unknown> } }
  const col = sql.raw(`"${column}"`)
  await db.drizzle.execute(sql`UPDATE "media" SET ${col} = ${value} WHERE "id" = ${id}`)
}

async function createEvent(label: string) {
  const slug = `${runId}-${label}`
  const res = await api('POST', '/api/live-events', {
    token: f.tokens.eic,
    body: { title: `${runId} ${label}`, slug, category: f.catA.id, status: 'live' },
  })
  expect(res.status).toBe(201)
  return { id: res.json.doc.id as number, slug }
}

const postUpdate = (token: string, event: number, body: Record<string, unknown> = {}) =>
  api('POST', '/api/live-updates', { token, body: { event, body: `Update ${runId} ${Math.random()}`, ...body } })

const patch = (token: string, id: number, body: Record<string, unknown>) =>
  api('PATCH', `/api/live-updates/${id}`, { token, body })

const poll = (slug: string, query = '') => api('GET', `/api/live-events/${slug}/updates${query}`)

const imageId = (doc: { image?: unknown }) =>
  typeof doc.image === 'object' && doc.image ? (doc.image as { id: number }).id : doc.image

describe('live update images', () => {
  it('lets a reporter and an editor attach an image on create', async () => {
    const ev = await createEvent('attach')
    const m1 = await uploadMedia(f.tokens.reporter, 'reporter-photo')
    const m2 = await uploadMedia(f.tokens.eic, 'editor-photo')

    const rep = await postUpdate(f.tokens.reporter, ev.id, { image: m1.id })
    expect(rep.status).toBe(201)
    expect(rep.json.doc.status).toBe('pending')
    expect(imageId(rep.json.doc)).toBe(m1.id)

    const ed = await postUpdate(f.tokens.eic, ev.id, { image: m2.id, status: 'approved' })
    expect(ed.status).toBe(201)
    expect(ed.json.doc.status).toBe('approved')
    expect(imageId(ed.json.doc)).toBe(m2.id)

    // An update without an image still works and has none.
    const plain = await postUpdate(f.tokens.reporter, ev.id)
    expect(plain.status).toBe(201)
    expect(plain.json.doc.image ?? null).toBeNull()
  })

  it('refuses a missing media id, non-image media and media without alt text', async () => {
    const ev = await createEvent('refuse')

    const missing = await postUpdate(f.tokens.reporter, ev.id, { image: 987654321 })
    expect(missing.status).toBe(400)

    const pdf = await uploadMedia(f.tokens.reporter, 'not-an-image')
    await setMediaColumn(pdf.id, 'mime_type', 'application/pdf')
    const notImage = await postUpdate(f.tokens.reporter, ev.id, { image: pdf.id })
    expect(notImage.status).toBe(400)
    expect(notImage.text).toMatch(/JPEG, PNG or WebP/)

    const noAlt = await uploadMedia(f.tokens.reporter, 'no-alt')
    await setMediaColumn(noAlt.id, 'alt', '')
    try {
      const res = await postUpdate(f.tokens.reporter, ev.id, { image: noAlt.id })
      expect(res.status).toBe(400)
      expect(res.text).toMatch(/alt text/)

      // Same rule when attaching to an existing update.
      const ok = (await postUpdate(f.tokens.reporter, ev.id)).json.doc
      expect((await patch(f.tokens.reporter, ok.id, { image: noAlt.id })).status).toBe(400)
      expect((await patch(f.tokens.eic, ok.id, { image: noAlt.id })).status).toBe(400)
    } finally {
      await setMediaColumn(noAlt.id, 'alt', `${runId} no-alt`) // so cleanup (alt like runId) removes it
    }

    // Nothing was stored for the refused attempts.
    const stored = await f.payload.find({
      collection: 'live-updates',
      where: { and: [{ event: { equals: ev.id } }, { image: { exists: true } }] },
      overrideAccess: true,
      depth: 0,
    })
    expect(stored.totalDocs).toBe(0)
  })

  it('blocks approval of a pending update whose image lost its alt text', async () => {
    const ev = await createEvent('approve-recheck')
    const m = await uploadMedia(f.tokens.reporter, 'recheck')
    const u = (await postUpdate(f.tokens.reporter, ev.id, { image: m.id })).json.doc
    await setMediaColumn(m.id, 'alt', '')
    try {
      expect((await patch(f.tokens.eic, u.id, { status: 'approved' })).status).toBe(400)
    } finally {
      await setMediaColumn(m.id, 'alt', `${runId} recheck`)
    }
    expect((await patch(f.tokens.eic, u.id, { status: 'approved' })).status).toBe(200)
  })

  it('publishes the image in the public feed only after approval, with exactly five fields', async () => {
    const ev = await createEvent('feed')
    const m = await uploadMedia(f.tokens.reporter, 'feed-photo')
    const pending = (await postUpdate(f.tokens.reporter, ev.id, { image: m.id })).json.doc
    const textOnly = (await postUpdate(f.tokens.eic, ev.id, { status: 'approved' })).json.doc

    // Pending: nothing about the image (not the id, url or filename) reaches the anonymous feed.
    const before = await poll(ev.slug)
    expect(before.status).toBe(200)
    expect(before.json.docs.map((d: { id: number }) => d.id)).toEqual([textOnly.id])
    expect(before.json.docs[0].image).toBeNull()
    expect(before.text).not.toContain(m.filename)
    expect(before.text).not.toContain('/api/media/file/')

    // ...and the generic collection endpoint hides the pending update altogether.
    const direct = await api('GET', `/api/live-updates/${pending.id}`)
    expect([403, 404]).toContain(direct.status)
    const list = await api('GET', `/api/live-updates?where[event][equals]=${ev.id}&depth=1`)
    expect(list.text).not.toContain(m.filename)

    expect((await patch(f.tokens.eic, pending.id, { status: 'approved' })).status).toBe(200)

    const after = await poll(ev.slug)
    expect(after.json.docs.map((d: { id: number }) => d.id)).toEqual([textOnly.id, pending.id])
    const withImage = after.json.docs[1]
    expect(Object.keys(withImage).sort()).toEqual(['approvedAt', 'body', 'id', 'image', 'occurredAt', 'sequence'])
    expect(Object.keys(withImage.image).sort()).toEqual(['alt', 'height', 'mimeType', 'url', 'width'])
    expect(withImage.image).toEqual({
      url: m.url,
      alt: `${runId} feed-photo`,
      width: 1,
      height: 1,
      mimeType: 'image/png',
    })
    expect(withImage.image.url).toMatch(/^\/api\/media\/file\/[A-Za-z0-9_.-]+$/)
    expect(after.json.docs[0].image).toBeNull()
    // Staff-only data never appears.
    expect(after.text).not.toMatch(/uploadedBy|"author"|approvedBy|filename|caption|credit|sizes/)

    // Ordering, cursor and caching are unchanged.
    expect(after.json.docs.map((d: { sequence: number }) => d.sequence)).toEqual([1, 2])
    expect(after.json.nextSince).toBe(2)
    expect(after.headers.get('cache-control')).toBe('public, max-age=10')
    expect((await poll(ev.slug, '?since=1')).json.docs.map((d: { id: number }) => d.id)).toEqual([pending.id])
    expect((await poll(ev.slug, '?limit=0')).json.docs).toEqual([])
  })

  it('serves the ~800 px card variant to readers (url, width, height, mimeType of the variant), not the original', async () => {
    const ev = await createEvent('card')
    const big = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 30, g: 90, b: 160 } } }).png().toBuffer()
    const form = new FormData()
    form.set('_payload', JSON.stringify({ alt: `${runId} big-photo` }))
    form.set('file', new Blob([new Uint8Array(big)], { type: 'image/png' }), `${runId}-big-photo.png`)
    const up = await api('POST', '/api/media', { token: f.tokens.eic, body: form })
    expect(up.status).toBe(201)
    const original = up.json.doc as { id: number; url: string }
    const row = (await f.payload.findByID({ collection: 'media', id: original.id, depth: 0, overrideAccess: true })) as unknown as {
      sizes: { card: { url: string; width: number; height: number; mimeType: string } }
    }
    expect(row.sizes.card.width).toBe(800)
    expect(row.sizes.card.url).not.toBe(original.url)

    expect((await postUpdate(f.tokens.eic, ev.id, { image: original.id, status: 'approved' })).status).toBe(201)
    const feed = await poll(ev.slug)
    expect(feed.json.docs[0].image).toEqual({
      url: row.sizes.card.url,
      alt: `${runId} big-photo`,
      width: 800,
      height: 450,
      mimeType: 'image/png',
    })
    expect(Object.keys(feed.json.docs[0].image).sort()).toEqual(['alt', 'height', 'mimeType', 'url', 'width'])
    expect(feed.json.docs[0].image.url).toMatch(/^\/api\/media\/file\/[A-Za-z0-9_.-]+$/)
    // The variant is a real, smaller file; no other size leaks into the feed.
    const file = await api('GET', feed.json.docs[0].image.url)
    expect(file.status).toBe(200)
    expect(feed.text).not.toMatch(/thumbnail|hero|"sizes"/)
  })

  it('removes the image from the feed when the update is rejected after approval', async () => {
    const ev = await createEvent('reject')
    const m = await uploadMedia(f.tokens.eic, 'reject-photo')
    const u = (await postUpdate(f.tokens.eic, ev.id, { image: m.id, status: 'approved' })).json.doc
    expect((await poll(ev.slug)).json.docs[0].image.url).toBe(m.url)
    expect((await patch(f.tokens.eic, u.id, { status: 'rejected' })).status).toBe(200)
    const gone = await poll(ev.slug)
    expect(gone.json.docs).toEqual([])
    expect(gone.text).not.toContain(m.filename)
  })

  it('applies the body edit rules to the image and audits image changes', async () => {
    const ev = await createEvent('edit')
    const a = await uploadMedia(f.tokens.reporter, 'edit-a')
    const b = await uploadMedia(f.tokens.reporter, 'edit-b')

    // Reporter: may change the image of their own pending update, never once it is approved.
    const u = (await postUpdate(f.tokens.reporter, ev.id, { image: a.id })).json.doc
    expect((await patch(f.tokens.reporter, u.id, { image: b.id })).status).toBe(200)
    expect([403, 404]).toContain((await patch(f.tokens.reporter2, u.id, { image: a.id })).status) // not theirs
    expect((await patch(f.tokens.eic, u.id, { status: 'approved' })).status).toBe(200)
    expect([403, 404]).toContain((await patch(f.tokens.reporter, u.id, { image: a.id })).status)
    expect((await poll(ev.slug)).json.docs[0].image.url).toBe(b.url)

    // Editor may swap and remove it on an approved update; the public feed follows.
    expect((await patch(f.tokens.sectionEditor, u.id, { image: a.id })).status).toBe(200)
    expect((await poll(ev.slug)).json.docs[0].image.url).toBe(a.url)
    expect((await patch(f.tokens.sectionEditor, u.id, { image: null })).status).toBe(200)
    expect((await poll(ev.slug)).json.docs[0].image).toBeNull()

    const logs = await f.payload.find({
      collection: 'audit-logs',
      where: { and: [{ action: { equals: 'live-update.image' } }, { docId: { equals: String(u.id) } }] },
      overrideAccess: true,
      sort: 'createdAt',
      depth: 0,
    })
    // reporter swap (a->b), editor swap (b->a), editor removal
    expect(logs.docs.map((l) => (l.summary ?? '').replace(/^.*image /, ''))).toEqual(['replaced', 'replaced', 'removed'])

    // A trusted publisher may edit their own approved update (same as its body).
    const tp = (await postUpdate(f.tokens.trusted, ev.id, { status: 'approved' })).json.doc
    expect(tp.status).toBe('approved')
    expect((await patch(f.tokens.trusted, tp.id, { image: b.id })).status).toBe(200)
  })

  it('stops non-editors from altering media that is shown on an approved update', async () => {
    const ev = await createEvent('freeze')
    const m = await uploadMedia(f.tokens.reporter, 'freeze-photo')
    const u = (await postUpdate(f.tokens.reporter, ev.id, { image: m.id })).json.doc

    // Still pending: the uploader may edit their own media.
    const own = await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.reporter, body: { alt: `${runId} freeze v2` } })
    expect(own.status).toBe(200)

    expect((await patch(f.tokens.eic, u.id, { status: 'approved' })).status).toBe(200)
    const before = await snapshot(m)
    expect(before.status).toBe(200)
    const blocked = await api('PATCH', `/api/media/${m.id}`, {
      token: f.tokens.reporter,
      body: { alt: `${runId} freeze v3` },
    })
    expect(blocked.status).toBe(403)
    expect(blocked.text).toMatch(/live update/)
    // Replacing the file (multipart) is frozen the same way.
    const form = new FormData()
    form.set('_payload', JSON.stringify({}))
    form.set('file', new Blob([new Uint8Array(PNG_1X1)], { type: 'image/png' }), `${runId}-replacement.png`)
    const replaced = await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.reporter, body: form })
    expect(replaced.status).toBe(403)
    expect(replaced.text).toMatch(/live update/)
    // The refused replacement must not have touched the original file or the row.
    expect(await snapshot(m)).toEqual(before)
    const editor = await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.eic, body: { alt: `${runId} freeze v4` } })
    expect(editor.status).toBe(200)
    expect((await poll(ev.slug)).json.docs[0].image.alt).toBe(`${runId} freeze v4`)
  })

  it('re-stamps the publication sequence when an approved update changes image or body, so pollers get the edit', async () => {
    const ev = await createEvent('restamp')
    const m = await uploadMedia(f.tokens.eic, 'restamp-photo')
    const first = (await postUpdate(f.tokens.eic, ev.id, { status: 'approved' })).json.doc
    const second = (await postUpdate(f.tokens.eic, ev.id, { status: 'approved' })).json.doc

    const initial = await poll(ev.slug)
    expect(initial.json.nextSince).toBe(2)
    const cursor = initial.json.nextSince as number
    expect((await poll(ev.slug, `?since=${cursor}`)).json.docs).toEqual([])

    // Attach an image to the first (already delivered) update.
    expect((await patch(f.tokens.eic, first.id, { image: m.id })).status).toBe(200)
    const afterImage = await poll(ev.slug, `?since=${cursor}`)
    expect(afterImage.json.docs).toHaveLength(1)
    expect(afterImage.json.docs[0]).toMatchObject({ id: first.id, sequence: 3, image: { url: m.url } })
    expect(afterImage.json.nextSince).toBe(3)

    // Editing the body does the same; a no-op PATCH and a status-less title-only change do not.
    expect((await patch(f.tokens.eic, second.id, { body: `${runId} corrected text` })).status).toBe(200)
    const afterBody = await poll(ev.slug, '?since=3')
    expect(afterBody.json.docs.map((d: { id: number; body: string }) => [d.id, d.body])).toEqual([[second.id, `${runId} corrected text`]])
    expect(afterBody.json.docs[0].sequence).toBe(4)
    expect((await patch(f.tokens.eic, second.id, { body: `${runId} corrected text` })).status).toBe(200)
    expect((await patch(f.tokens.eic, first.id, { image: m.id })).status).toBe(200)
    expect((await poll(ev.slug, '?since=4')).json.docs).toEqual([])

    // A full read shows each update once, in publication order, with the latest content.
    const full = await poll(ev.slug)
    expect(full.json.docs.map((d: { id: number; sequence: number }) => [d.id, d.sequence])).toEqual([
      [first.id, 3],
      [second.id, 4],
    ])

    // Removing the image is an edit too.
    expect((await patch(f.tokens.eic, first.id, { image: null })).status).toBe(200)
    const removed = await poll(ev.slug, '?since=4')
    expect(removed.json.docs[0]).toMatchObject({ id: first.id, sequence: 5, image: null })

    // Pending updates keep sequence handling untouched: editing before approval does not stamp anything.
    const pending = (await postUpdate(f.tokens.reporter, ev.id)).json.doc
    expect((await patch(f.tokens.reporter, pending.id, { body: `${runId} pending edit` })).status).toBe(200)
    expect((await poll(ev.slug, '?since=5')).json.docs).toEqual([])
    expect((await patch(f.tokens.eic, pending.id, { status: 'approved' })).status).toBe(200)
    expect((await poll(ev.slug, '?since=5')).json.docs[0]).toMatchObject({ id: pending.id, sequence: 6 })
  })
})
