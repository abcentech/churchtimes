import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, lexical, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Go-live contract C1 (legacy content shapes, CMS side): the `youtubeEmbed` block and the table nodes in
 * `articles.content` (C1.1, C1.4) and the staff-only `media.legacyPath` field (C1.2), all through the real REST
 * handlers.
 */
const runId = newRunId()
let f: Fixtures
let png: Buffer

beforeAll(async () => {
  f = await setupFixtures(runId)
  png = await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 90, g: 40, b: 120 } } }).png().toBuffer()
})

afterAll(async () => {
  await f?.cleanup()
})

const para = (text: string) => ({
  type: 'paragraph',
  format: '',
  indent: 0,
  version: 1,
  direction: 'ltr',
  textFormat: 0,
  children: [{ type: 'text', text, format: 0, detail: 0, mode: 'normal', style: '', version: 1 }],
})
const youtube = (fields: Record<string, unknown>) => ({
  type: 'block',
  version: 2,
  format: '',
  fields: { id: 'blk-1', blockName: '', blockType: 'youtubeEmbed', ...fields },
})
const table = () => ({
  type: 'table',
  version: 1,
  format: '',
  indent: 0,
  direction: 'ltr',
  children: [
    {
      type: 'tablerow',
      version: 1,
      children: [
        { type: 'tablecell', version: 1, headerState: 1, colSpan: 1, rowSpan: 1, backgroundColor: null, children: [para('Parish')] },
        { type: 'tablecell', version: 1, headerState: 1, colSpan: 1, rowSpan: 1, backgroundColor: null, children: [para('Members')] },
      ],
    },
    {
      type: 'tablerow',
      version: 1,
      children: [
        { type: 'tablecell', version: 1, headerState: 0, colSpan: 1, rowSpan: 1, backgroundColor: null, children: [para('St Example')] },
        { type: 'tablecell', version: 1, headerState: 0, colSpan: 1, rowSpan: 1, backgroundColor: null, children: [para('120')] },
      ],
    },
  ],
})
const body = (...extra: unknown[]) => {
  const doc = lexical() as { root: { children: unknown[] } }
  doc.root.children.push(...extra)
  return doc
}

const errorText = (res: { json: any }): string =>
  (res.json?.errors ?? [])
    .flatMap((e: any) => [String(e.message ?? ''), ...((e.data?.errors ?? []) as { message?: string }[]).map((x) => String(x.message))])
    .join(' | ')

const patch = (token: string, id: number, content: unknown) => api('PATCH', `/api/articles/${id}`, { token, body: { content } })

describe('C1.1 youtubeEmbed block in articles.content', () => {
  it('accepts a valid block and returns it to anonymous readers of the published article', async () => {
    const res = await f.createArticle(f.tokens.eic, {
      content: body(youtube({ videoId: 'dQw4w9WgXcQ', title: 'Harvest service' })),
    })
    expect(res.status, errorText(res)).toBe(201)
    expect(res.json.doc.status).toBe('draft')

    const pub = await api('PATCH', `/api/articles/${res.id}`, { token: f.tokens.eic, body: { status: 'published' } })
    expect(pub.status, errorText(pub)).toBe(200)

    const anon = await api('GET', `/api/articles/${res.id}?depth=0`)
    expect(anon.status).toBe(200)
    const blocks = anon.json.content.root.children.filter((n: any) => n.type === 'block')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].fields).toMatchObject({ blockType: 'youtubeEmbed', videoId: 'dQw4w9WgXcQ', title: 'Harvest service' })
  })

  it('accepts a block without a title and a reporter may write one into their own draft', async () => {
    const res = await f.createArticle(f.tokens.reporter, { content: body(youtube({ videoId: 'A-_0aZ9-_zz' })) })
    expect(res.status, errorText(res)).toBe(201)
    const again = await patch(f.tokens.reporter, res.id!, body(youtube({ videoId: 'aaaaaaaaaaa', title: 'Second' })))
    expect(again.status, errorText(again)).toBe(200)
  })

  it('refuses a malformed videoId on create and on update', async () => {
    for (const videoId of ['short', 'dQw4w9WgXcQ0', 'dQw4w9WgXc!', 'https://youtu.be/dQw4w9WgXcQ', '', 12345678901]) {
      const res = await f.createArticle(f.tokens.eic, { content: body(youtube({ videoId })) })
      expect(res.status, JSON.stringify(videoId)).toBe(400)
      expect(errorText(res)).toMatch(/video id/i)
    }
    const ok = await f.createArticle(f.tokens.eic, { content: body(youtube({ videoId: 'dQw4w9WgXcQ' })) })
    expect(ok.status).toBe(201)
    const bad = await patch(f.tokens.eic, ok.id!, body(youtube({ videoId: 'nope' })))
    expect(bad.status).toBe(400)
    const stored = await api('GET', `/api/articles/${ok.id}?depth=0`, { token: f.tokens.eic })
    expect(JSON.stringify(stored.json.content)).toContain('dQw4w9WgXcQ')
    expect(JSON.stringify(stored.json.content)).not.toContain('nope')
  })

  it('refuses an over-long or markup title', async () => {
    const long = await f.createArticle(f.tokens.eic, { content: body(youtube({ videoId: 'dQw4w9WgXcQ', title: 'x'.repeat(121) })) })
    expect(long.status).toBe(400)
    const markup = await f.createArticle(f.tokens.eic, { content: body(youtube({ videoId: 'dQw4w9WgXcQ', title: '<script>x</script>' })) })
    expect(markup.status).toBe(400)
  })

  it('refuses raw embed nodes (the old importer shape), iframe-like nodes and unknown blocks', async () => {
    const nodes: Record<string, unknown> = {
      embed: { type: 'embed', version: 1, embedType: 'iframe', url: 'https://evil.example.test/frame' },
      iframe: { type: 'iframe', version: 1, src: 'https://evil.example.test/frame' },
      'unknown block': { type: 'block', version: 2, fields: { id: 'b', blockType: 'vimeoEmbed', videoId: '123456789' } },
    }
    for (const [label, node] of Object.entries(nodes)) {
      const res = await f.createArticle(f.tokens.eic, { content: body(node) })
      expect(res.status, label).toBe(400)
      expect(errorText(res), label).toMatch(/Embeds other than YouTube are not accepted/)
    }
    // nested inside a table cell as well
    const t = table() as any
    t.children[1].children[1].children.push({ type: 'embed', url: 'https://evil.example.test/x' })
    const nested = await f.createArticle(f.tokens.eic, { content: body(t) })
    expect(nested.status).toBe(400)
  })

  it('is skipped only for trusted seed calls (same rule as the body-image check)', async () => {
    const seeded = await f.seedArticle({ content: body({ type: 'embed', url: 'https://example.test/seed' }) })
    expect(seeded.id).toBeTruthy()
    // the same body through the REST API is refused
    const viaApi = await f.createArticle(f.tokens.eic, { content: body({ type: 'embed', url: 'https://example.test/seed' }) })
    expect(viaApi.status).toBe(400)
  })
})

describe('C1.4 table nodes in articles.content', () => {
  it('stores the standard table > tablerow > tablecell shape and returns it unchanged', async () => {
    const res = await f.createArticle(f.tokens.eic, { content: body(table()) })
    expect(res.status, errorText(res)).toBe(201)
    const stored = await api('GET', `/api/articles/${res.id}?depth=0`, { token: f.tokens.eic })
    const t = stored.json.content.root.children.find((n: any) => n.type === 'table')
    expect(t).toBeTruthy()
    expect(t.children.map((r: any) => r.type)).toEqual(['tablerow', 'tablerow'])
    expect(t.children[0].children.map((c: any) => c.type)).toEqual(['tablecell', 'tablecell'])
    expect(t.children[0].children[0].headerState).toBe(1)
    expect(JSON.stringify(t)).toContain('St Example')
  })

  it('accepts a table together with a YouTube block in one body', async () => {
    const res = await f.createArticle(f.tokens.eic, { content: body(table(), youtube({ videoId: 'dQw4w9WgXcQ' })) })
    expect(res.status, errorText(res)).toBe(201)
  })
})

describe('existing body-image validation still works', () => {
  let mediaId: number
  beforeAll(async () => {
    const form = new FormData()
    form.set('_payload', JSON.stringify({ alt: `${runId} body image` }))
    form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${runId}-body.png`)
    const res = await api('POST', '/api/media', { token: f.tokens.eic, body: form })
    expect(res.status).toBe(201)
    mediaId = res.json.doc.id
  })

  const upload = (value: unknown, relationTo = 'media') => ({ type: 'upload', relationTo, value, fields: null, format: '', version: 3 })

  it('accepts a real image next to a YouTube block', async () => {
    const res = await f.createArticle(f.tokens.eic, { content: body(upload(mediaId), youtube({ videoId: 'dQw4w9WgXcQ' })) })
    expect(res.status, errorText(res)).toBe(201)
  })

  it('still refuses an out-of-range id, a missing media and a non-media relation', async () => {
    expect((await f.createArticle(f.tokens.eic, { content: body(upload(99999999999)) })).status).toBe(400)
    expect((await f.createArticle(f.tokens.eic, { content: body(upload(2147483646)) })).status).toBe(400)
    expect((await f.createArticle(f.tokens.eic, { content: body(upload(mediaId, 'users')) })).status).toBe(400)
  })
})

describe('C1.2 media.legacyPath', () => {
  const uploadMedia = async (token: string, label: string, extra: Record<string, unknown> = {}) => {
    const form = new FormData()
    form.set('_payload', JSON.stringify({ alt: `${runId} ${label}`, ...extra }))
    form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${runId}-${label}.png`)
    return api('POST', '/api/media', { token, body: form })
  }
  const stored = async (id: number) =>
    (await f.payload.findByID({ collection: 'media', id, depth: 0, overrideAccess: true })) as unknown as { legacyPath?: string | null }

  it('an editor-in-chief and an admin may write it; it is stored and returned to them', async () => {
    const eic = await uploadMedia(f.tokens.eic, 'legacy-eic', { legacyPath: '2023/10/eic.png' })
    expect(eic.status).toBe(201)
    expect((await stored(eic.json.doc.id)).legacyPath).toBe('2023/10/eic.png')
    expect(eic.json.doc.legacyPath).toBe('2023/10/eic.png')

    const admin = await uploadMedia(f.tokens.admin, 'legacy-admin', { legacyPath: '2022/01/admin.png' })
    expect(admin.status).toBe(201)
    expect((await stored(admin.json.doc.id)).legacyPath).toBe('2022/01/admin.png')

    const upd = await api('PATCH', `/api/media/${eic.json.doc.id}`, { token: f.tokens.eic, body: { legacyPath: '2023/10/renamed.png' } })
    expect(upd.status, errorText(upd)).toBe(200)
    expect((await stored(eic.json.doc.id)).legacyPath).toBe('2023/10/renamed.png')

    const read = await api('GET', `/api/media/${eic.json.doc.id}?depth=0`, { token: f.tokens.eic })
    expect(read.json.legacyPath).toBe('2023/10/renamed.png')
  })

  it('server code (Local API) may write it, which is what the importer does', async () => {
    const res = await uploadMedia(f.tokens.eic, 'legacy-local')
    const id = res.json.doc.id as number
    await f.payload.update({ collection: 'media', id, data: { legacyPath: '2019/05/local.png' }, overrideAccess: true })
    expect((await stored(id)).legacyPath).toBe('2019/05/local.png')
  })

  it('reporters and section editors cannot write it (silently ignored, nothing stored)', async () => {
    const rep = await uploadMedia(f.tokens.reporter, 'legacy-reporter', { legacyPath: '2020/01/rep.png' })
    expect(rep.status).toBe(201)
    expect((await stored(rep.json.doc.id)).legacyPath ?? null).toBeNull()

    const mine = await api('PATCH', `/api/media/${rep.json.doc.id}`, { token: f.tokens.reporter, body: { legacyPath: '2020/01/rep2.png', credit: 'x' } })
    expect(mine.status).toBe(200)
    expect((await stored(rep.json.doc.id)).legacyPath ?? null).toBeNull()

    const se = await uploadMedia(f.tokens.sectionEditor, 'legacy-section', { legacyPath: '2020/01/se.png' })
    expect(se.status).toBe(201)
    expect((await stored(se.json.doc.id)).legacyPath ?? null).toBeNull()

    const anon = await api('PATCH', `/api/media/${rep.json.doc.id}`, { body: { legacyPath: 'x/y.png' } })
    expect([401, 403]).toContain(anon.status)
  })

  it('anonymous readers and reporters never see it; editors do', async () => {
    const res = await uploadMedia(f.tokens.eic, 'legacy-read', { legacyPath: '2021/03/read.png' })
    const id = res.json.doc.id as number
    // make the media public: featured image of a published article
    const art = await f.createArticle(f.tokens.eic, { featuredImage: id })
    expect(art.status, errorText(art)).toBe(201)
    const pub = await api('PATCH', `/api/articles/${art.id}`, { token: f.tokens.eic, body: { status: 'published' } })
    expect(pub.status, errorText(pub)).toBe(200)

    const anon = await api('GET', `/api/media/${id}?depth=0`)
    expect(anon.status).toBe(200)
    expect(anon.json).not.toHaveProperty('legacyPath')
    expect(anon.text).not.toContain('2021/03/read.png')

    const anonList = await api('GET', `/api/media?where[alt][like]=${runId}&limit=100&depth=0`)
    expect(anonList.status).toBe(200)
    expect(anonList.text).not.toContain('legacyPath')

    const viaArticle = await api('GET', `/api/articles/${art.id}?depth=1`)
    expect(viaArticle.status).toBe(200)
    expect(viaArticle.text).not.toContain('2021/03/read.png')

    const reporter = await api('GET', `/api/media/${id}?depth=0`, { token: f.tokens.reporter })
    expect(reporter.status).toBe(200)
    expect(reporter.json).not.toHaveProperty('legacyPath')
    const trusted = await api('GET', `/api/media/${id}?depth=0`, { token: f.tokens.trusted })
    expect(trusted.json).not.toHaveProperty('legacyPath')

    for (const key of ['sectionEditor', 'eic', 'admin'] as const) {
      const r = await api('GET', `/api/media/${id}?depth=0`, { token: f.tokens[key] })
      expect(r.json.legacyPath, key).toBe('2021/03/read.png')
    }
  })

  it('cannot be used as a filter by callers who cannot read it', async () => {
    await uploadMedia(f.tokens.eic, 'legacy-filter', { legacyPath: '2021/04/filter.png' })
    for (const token of [undefined, f.tokens.reporter]) {
      const res = await api('GET', `/api/media?where[legacyPath][equals]=2021/04/filter.png&depth=0`, { token })
      expect([400, 403]).toContain(res.status)
    }
    const ok = await api('GET', `/api/media?where[legacyPath][equals]=2021/04/filter.png&depth=0`, { token: f.tokens.eic })
    expect(ok.status).toBe(200)
    expect(ok.json.docs).toHaveLength(1)
  })

  it('refuses malformed paths', async () => {
    for (const legacyPath of ['/2023/photo.png', '../x.png', '2023//x.png', 'wp-content/uploads/x.png']) {
      const res = await uploadMedia(f.tokens.eic, 'legacy-bad', { legacyPath })
      expect(res.status, legacyPath).toBe(400)
    }
  })

  it('keeps the existing freeze and privacy rules (a reporter still cannot edit media used by a published article)', async () => {
    const res = await uploadMedia(f.tokens.reporter, 'legacy-freeze')
    const id = res.json.doc.id as number
    const art = await f.createArticle(f.tokens.eic, { featuredImage: id })
    await api('PATCH', `/api/articles/${art.id}`, { token: f.tokens.eic, body: { status: 'published' } })
    const edit = await api('PATCH', `/api/media/${id}`, { token: f.tokens.reporter, body: { alt: `${runId} changed` } })
    expect(edit.status).toBe(403)
  })
})
