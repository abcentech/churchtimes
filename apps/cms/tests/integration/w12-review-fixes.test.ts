import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Review fixes on the waves 1-2 schema (PR #135):
 * - an AVIF original is refused whatever type it declares (image/avif or video/mp4); generated AVIF sizes still work;
 * - the photo of a PUBLIC author profile is frozen against edits by its (non-editor) uploader;
 * - changing the story type of a published article needs a corrections entry; kicker / key points do not.
 */
const runId = newRunId()
let f: Fixtures
const authorIds: number[] = []

beforeAll(async () => {
  f = await setupFixtures(runId)
})

afterAll(async () => {
  if (authorIds.length) await f.payload.delete({ collection: 'authors', where: { id: { in: authorIds } }, overrideAccess: true }).catch(() => undefined)
  await f?.cleanup()
})

const upload = async (token: string, bytes: Buffer, type: string, name: string, alt = `${runId} ${name}`) => {
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt }))
  form.set('file', new Blob([new Uint8Array(bytes)], { type }), `${runId}-${name}`)
  return api('POST', '/api/media', { token, body: form })
}

describe('AVIF originals are refused; generated AVIF sizes still work', () => {
  it('refuses a real AVIF declared as image/avif or as video/mp4, and stores nothing', async () => {
    const avif = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 10, g: 120, b: 40 } } })
      .withExif({ IFD0: { Copyright: 'secret-gps-holder' } })
      .avif()
      .toBuffer()
    for (const [type, name] of [['image/avif', 'orig.avif'], ['video/mp4', 'orig.mp4'], ['audio/mp4', 'orig.m4a']] as const) {
      const res = await upload(f.tokens.eic, avif, type, name)
      expect(res.status, `${type}: ${res.text.slice(0, 200)}`).toBe(400)
    }
    const stored = await f.payload.count({ collection: 'media', where: { mimeType: { equals: 'image/avif' } }, overrideAccess: true })
    expect(stored.totalDocs).toBe(0)
  })

  it('a JPEG upload still gets cardAvif / heroAvif sizes and keeps a JPEG original', async () => {
    const jpeg = await sharp({ create: { width: 1700, height: 900, channels: 3, background: { r: 200, g: 100, b: 50 } } }).jpeg().toBuffer()
    const res = await upload(f.tokens.eic, jpeg, 'image/jpeg', 'sizes.jpg')
    expect(res.status).toBe(201)
    expect(res.json.doc.mimeType).toBe('image/jpeg')
    expect(res.json.doc.sizes.cardAvif.mimeType).toBe('image/avif')
    expect(res.json.doc.sizes.heroAvif.mimeType).toBe('image/avif')
  })
})

describe('the photo of a public author profile is frozen for its uploader', () => {
  it('a reporter cannot change the alt text, replace the file or delete it while the profile is public', async () => {
    const png = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer()
    const created = await upload(f.tokens.reporter, png, 'image/png', 'portrait.png')
    expect(created.status).toBe(201)
    const mediaId = created.json.doc.id as number

    const author = (await f.payload.create({
      collection: 'authors',
      data: { name: `${runId} Frozen Author`, photo: mediaId, isPublic: false } as never,
      overrideAccess: true,
    })) as unknown as { id: number }
    authorIds.push(author.id)

    // Not public yet: the uploader may still fix their own picture.
    const early = await api('PATCH', `/api/media/${mediaId}`, { token: f.tokens.reporter, body: { alt: `${runId} portrait fixed` } })
    expect(early.status, early.text.slice(0, 200)).toBe(200)

    await f.payload.update({ collection: 'authors', id: author.id, data: { isPublic: true } as never, overrideAccess: true })

    const alt = await api('PATCH', `/api/media/${mediaId}`, { token: f.tokens.reporter, body: { alt: `${runId} swapped` } })
    expect(alt.status).toBe(403)
    expect(alt.text).toContain('public author profile')

    const form = new FormData()
    form.set('_payload', JSON.stringify({}))
    form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${runId}-replacement.png`)
    const replace = await api('PATCH', `/api/media/${mediaId}`, { token: f.tokens.reporter, body: form })
    expect(replace.status).toBe(403)

    expect((await api('DELETE', `/api/media/${mediaId}`, { token: f.tokens.reporter })).status).toBe(403)

    const row = (await f.payload.findByID({ collection: 'media', id: mediaId, overrideAccess: true, depth: 0 })) as unknown as { alt: string; filename: string }
    expect(row.alt).toBe(`${runId} portrait fixed`)
    expect((await api('GET', `/api/media/file/${row.filename}`)).status).toBe(200) // the public file is intact

    // An editor may still change it (editors review what readers see).
    expect((await api('PATCH', `/api/media/${mediaId}`, { token: f.tokens.sectionEditor, body: { alt: `${runId} editor alt` } })).status).toBe(200)
  })
})

describe('story type on a published article is a correctable change', () => {
  it('needs a corrections entry to change contentType; kicker and key points do not', async () => {
    const pub = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), contentType: 'sponsored' })
    const bare = await api('PATCH', `/api/articles/${pub.id}`, { token: f.tokens.eic, body: { contentType: 'news' } })
    expect(bare.status).toBe(400)
    expect(bare.text).toContain('story type')
    const stillSponsored = (await f.payload.findByID({ collection: 'articles', id: pub.id, overrideAccess: true, depth: 0 })) as unknown as { contentType: string }
    expect(stillSponsored.contentType).toBe('sponsored')

    const withNote = await api('PATCH', `/api/articles/${pub.id}`, {
      token: f.tokens.eic,
      body: { contentType: 'news', corrections: [{ note: 'This story was previously labelled Sponsored in error.' }] },
    })
    expect(withNote.status, withNote.text.slice(0, 200)).toBe(200)
    expect(withNote.json.doc.contentType).toBe('news')

    const presentation = await api('PATCH', `/api/articles/${pub.id}`, {
      token: f.tokens.eic,
      body: { kicker: 'Updated kicker', keyPoints: [{ text: 'A new key point' }] },
    })
    expect(presentation.status, presentation.text.slice(0, 200)).toBe(200)
  })

  it('a legacy row (contentType null) re-sent as news is not a change', async () => {
    const legacy = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })
    await (f.payload.db as unknown as { drizzle: { execute: (q: string) => Promise<unknown> } }).drizzle.execute(
      `UPDATE articles SET content_type = NULL WHERE id = ${Number(legacy.id)}`,
    )
    const res = await api('PATCH', `/api/articles/${legacy.id}`, { token: f.tokens.eic, body: { contentType: 'news' } })
    expect(res.status, res.text.slice(0, 200)).toBe(200)
  })
})
