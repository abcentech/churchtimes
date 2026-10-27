import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, lexical, newRunId, setupFixtures, type Fixtures } from './helpers'

const runId = newRunId()
let f: Fixtures

beforeAll(async () => {
  f = await setupFixtures(runId)
})

afterAll(async () => {
  await f?.cleanup()
})

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

const replaceFile = (token: string, id: number) => {
  const form = new FormData()
  form.set('_payload', JSON.stringify({}))
  form.set('file', new Blob([new Uint8Array(PNG_1X1)], { type: 'image/png' }), `${runId}-replacement.png`)
  return api('PATCH', `/api/media/${id}`, { token, body: form })
}

/** What a reader and the database see of a media document: the served bytes plus the stored row. */
async function snapshot(m: { id: number }, token?: string) {
  const row = (await f.payload.findByID({ collection: 'media', id: m.id, depth: 0, overrideAccess: true })) as unknown as Record<string, unknown>
  // Current filename (a legitimate replacement changes it, so the url captured at upload time can be stale).
  const file = await api('GET', `/api/media/file/${String(row.filename)}`, { token })
  return {
    status: file.status,
    bytes: file.text,
    row: { filename: row.filename, filesize: row.filesize, width: row.width, height: row.height, alt: row.alt, mimeType: row.mimeType },
  }
}

const setMediaColumn = async (id: number, column: 'alt' | 'mime_type', value: string) => {
  const db = f.payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<unknown> } }
  await db.drizzle.execute(sql`UPDATE "media" SET ${sql.raw(`"${column}"`)} = ${value} WHERE "id" = ${id}`)
}

/** A lexical document whose root also contains the given nodes (the shape the newsroom editor writes). */
const withNodes = (...nodes: unknown[]) => {
  const doc = lexical() as { root: { children: unknown[] } }
  doc.root.children.push(...nodes)
  return doc
}
const upload = (value: unknown, relationTo = 'media') => ({
  type: 'upload',
  relationTo,
  value,
  fields: null,
  format: '',
  version: 3,
})

const patchArticle = (token: string, id: number, body: Record<string, unknown>) =>
  api('PATCH', `/api/articles/${id}`, { token, body })
const patchMedia = (token: string, id: number, body: Record<string, unknown>) =>
  api('PATCH', `/api/media/${id}`, { token, body })

describe('article body images: validation', () => {
  it('rejects invalid upload nodes with a clear 400 and accepts valid ones', async () => {
    const notImage = await uploadMedia(f.tokens.reporter, 'not-image')
    await setMediaColumn(notImage.id, 'mime_type', 'application/pdf')
    const noAlt = await uploadMedia(f.tokens.reporter, 'no-alt')
    await setMediaColumn(noAlt.id, 'alt', '')
    const good = await uploadMedia(f.tokens.reporter, 'good')

    try {
      const bad: Array<[string, unknown, RegExp]> = [
        ['nonexistent id', upload(99999998), /does not exist/],
        ['out-of-range id', upload(99999999999), /invalid media id/],
        ['media 0', upload(0), /invalid media id/],
        ['negative id', upload(-4), /invalid media id/],
        ['string id', upload('7'), /invalid media id/],
        ['fractional id', upload(1.5), /invalid media id/],
        ['other collection', upload(good.id, 'users'), /media library/],
        ['non-image', upload(notImage.id), /JPEG, PNG or WebP/],
        ['missing alt', upload(noAlt.id), /alt text/],
        ['nested in a list', { type: 'list', children: [{ type: 'listitem', children: [upload(99999999999)] }] }, /invalid media id/],
      ]
      for (const [label, node, message] of bad) {
        const res = await f.createArticle(f.tokens.reporter, { content: withNodes(node) })
        expect(res.status, label).toBe(400)
        expect(res.text, label).toMatch(message)
        expect(res.text, label).toMatch(/body/i)
      }

      const ok = await f.createArticle(f.tokens.reporter, { content: withNodes(upload(good.id), upload({ id: good.id })) })
      expect(ok.status).toBe(201)
      const stored = (await f.payload.findByID({ collection: 'articles', id: ok.id!, depth: 0, overrideAccess: true })) as {
        bodyMedia?: number[]
      }
      expect(stored.bodyMedia).toEqual([good.id]) // derived, de-duplicated

      // Updates are validated the same way, and a rejected update changes nothing.
      expect((await patchArticle(f.tokens.reporter, ok.id!, { content: withNodes(upload(99999999999)) })).status).toBe(400)
      expect((await patchArticle(f.tokens.reporter, ok.id!, { content: withNodes(upload(noAlt.id)) })).status).toBe(400)
      expect((await patchArticle(f.tokens.reporter, ok.id!, { content: withNodes(upload(good.id)), title: `${runId} retitled` })).status).toBe(200)

      // Depth-1 reads (staff list and by id) stay healthy.
      const list = await api('GET', '/api/articles?depth=1&limit=100', { token: f.tokens.eic })
      expect(list.status).toBe(200)
      expect((await api('GET', `/api/articles/${ok.id}?depth=1`, { token: f.tokens.reporter })).status).toBe(200)
      expect((await api('GET', '/api/articles?depth=1&limit=100')).status).toBe(200)
    } finally {
      await setMediaColumn(notImage.id, 'mime_type', 'image/png')
      await setMediaColumn(noAlt.id, 'alt', `${runId} no-alt`)
    }
  })

  it('never lets a client write bodyMedia, and recomputes it from the content', async () => {
    const a = await uploadMedia(f.tokens.reporter, 'derive-a')
    const b = await uploadMedia(f.tokens.reporter, 'derive-b')
    const art = await f.createArticle(f.tokens.reporter, { content: withNodes(upload(a.id)), bodyMedia: [b.id] })
    expect(art.status).toBe(201)
    const read = () =>
      f.payload.findByID({ collection: 'articles', id: art.id!, depth: 0, overrideAccess: true }) as Promise<{
        bodyMedia?: number[]
      }>
    expect((await read()).bodyMedia).toEqual([a.id])

    expect((await patchArticle(f.tokens.reporter, art.id!, { bodyMedia: [b.id] })).status).toBe(200)
    expect((await read()).bodyMedia).toEqual([a.id])

    expect((await patchArticle(f.tokens.reporter, art.id!, { content: withNodes(upload(b.id), upload(a.id)) })).status).toBe(200)
    expect((await read()).bodyMedia?.slice().sort()).toEqual([a.id, b.id].sort())

    // Anonymous readers of a published article do not see the field.
    const pub = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), content: withNodes(upload(a.id)) })
    const anon = await api('GET', `/api/articles/${pub.id}`)
    expect(anon.status).toBe(200)
    expect(anon.json).not.toHaveProperty('bodyMedia')
  })
})

describe('article body images: media freeze after publication', () => {
  it('blocks non-editors from editing or replacing a body image of a published article', async () => {
    const m = await uploadMedia(f.tokens.reporter, 'frozen-body')
    const art = await f.seedArticle({
      status: 'published',
      publishedAt: new Date().toISOString(),
      author: f.users.reporter.id,
      content: withNodes(upload(m.id)),
    })

    const before = await snapshot(m)
    expect(before.status).toBe(200)
    const alt = await patchMedia(f.tokens.reporter, m.id, { alt: `${runId} sneaky alt` })
    expect(alt.status).toBe(403)
    expect(alt.text).toMatch(/published or scheduled article/)
    const file = await replaceFile(f.tokens.reporter, m.id)
    expect(file.status).toBe(403)
    expect(file.text).toMatch(/published or scheduled article/)
    // The refused replacement must not have touched the original file or the row.
    expect(await snapshot(m)).toEqual(before)

    // Editors may.
    expect((await patchMedia(f.tokens.sectionEditor, m.id, { alt: `${runId} editor alt` })).status).toBe(200)
    expect((await replaceFile(f.tokens.eic, m.id)).status).toBe(200)

    // Once an editor takes the image out of the published body, the uploader is free again.
    expect((await patchArticle(f.tokens.eic, art.id, {
        content: withNodes(),
        corrections: [{ note: 'Removed the photo.' }],
      })).status).toBe(200)
    expect((await patchMedia(f.tokens.reporter, m.id, { alt: `${runId} free again` })).status).toBe(200)
  })

  it('covers scheduled articles and keeps media of drafts editable', async () => {
    const m = await uploadMedia(f.tokens.reporter, 'draft-body')
    const draft = await f.seedArticle({ status: 'draft', author: f.users.reporter.id, content: withNodes(upload(m.id)) })
    expect((await patchMedia(f.tokens.reporter, m.id, { alt: `${runId} draft alt` })).status).toBe(200)
    expect((await replaceFile(f.tokens.reporter, m.id)).status).toBe(200)

    await f.payload.update({
      collection: 'articles',
      id: draft.id,
      data: { status: 'scheduled', scheduledFor: new Date(Date.now() + 86_400_000).toISOString() },
      overrideAccess: true,
      context: { seed: true },
    })
    const before = await snapshot(m, f.tokens.eic)
    expect(before.status).toBe(200)
    expect((await patchMedia(f.tokens.reporter, m.id, { alt: `${runId} scheduled alt` })).status).toBe(403)
    expect((await replaceFile(f.tokens.reporter, m.id)).status).toBe(403)
    expect(await snapshot(m, f.tokens.eic)).toEqual(before)
  })

  it('still freezes the featured image', async () => {
    const m = await uploadMedia(f.tokens.reporter, 'frozen-featured')
    await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), featuredImage: m.id })
    const before = await snapshot(m)
    expect(before.status).toBe(200)
    expect((await patchMedia(f.tokens.reporter, m.id, { alt: `${runId} nope` })).status).toBe(403)
    expect((await replaceFile(f.tokens.reporter, m.id)).status).toBe(403)
    expect(await snapshot(m)).toEqual(before) // original file still served, row unchanged
  })
})
