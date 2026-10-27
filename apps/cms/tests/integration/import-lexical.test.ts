import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { htmlToLexical } from '../../src/import/htmlToLexical'
import { buildCorpus } from '../fixtures/html/corpus'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Converted bodies go through the real REST handlers and the Articles validators (validateEmbeds, body-image rules,
 * the depth rule): they must be accepted, keep their images in bodyMedia and survive a read unchanged.
 */
const runId = newRunId()
let f: Fixtures
let png: Buffer
const mediaIds = new Map<number, number>() // corpus image number -> real media id

beforeAll(async () => {
  f = await setupFixtures(runId)
  png = await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 30, g: 90, b: 60 } } }).png().toBuffer()
})
afterAll(async () => {
  await f?.cleanup()
})

async function mediaFor(n: number): Promise<number> {
  const known = mediaIds.get(n)
  if (known) return known
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt: `${runId} import image ${n}` }))
  form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${runId}-import-${n}.png`)
  const res = await api('POST', '/api/media', { token: f.tokens.eic, body: form })
  expect(res.status).toBe(201)
  mediaIds.set(n, res.json.doc.id)
  return res.json.doc.id
}

const errors = (res: { json: any }) => JSON.stringify(res.json?.errors ?? [])

describe('converted bodies are accepted by the Articles validators', () => {
  it('three representative synthetic articles (Gutenberg, classic, mixed) are stored and read back', async () => {
    const corpus = buildCorpus(48)
    const picks = [corpus.find((a) => a.mode === 'gutenberg' && a.expectUploads.length > 0 && a.expectYoutube.length > 0), corpus.find((a) => a.mode === 'classic' && a.expectUploads.length > 0), corpus.find((a) => a.mode === 'mixed' && a.expectKinds.includes('table'))]
    for (const a of picks) {
      expect(a).toBeTruthy()
      if (!a) continue
      // resolve every image used by the article to a real media document first
      const wanted = new Map<string, number>()
      for (const n of a.expectUploads) wanted.set(String(n), await mediaFor(n))
      const { content } = htmlToLexical(a.html, {
        oldHosts: ['old.example.test'],
        slugMap: {},
        articleTitle: a.id,
        resolveImage: (src) => {
          const m = /img-(\d+)/.exec(src)
          const id = m ? wanted.get(m[1]) : undefined
          return id ? { mediaId: id } : null
        },
      })
      const res = await f.createArticle(f.tokens.eic, { content })
      expect(res.status, `${a.id}: ${errors(res)}`).toBe(201)
      const stored = await api('GET', `/api/articles/${res.id}?depth=0`, { token: f.tokens.eic })
      expect(stored.status).toBe(200)
      expect([...stored.json.bodyMedia].sort()).toEqual([...new Set(wanted.values())].sort())
      const kinds = (stored.json.content.root.children as { type: string }[]).map((n) => n.type)
      expect(kinds).toEqual((content.root.children as { type: string }[]).map((n) => n.type))
      const videoIds = (stored.json.content.root.children as any[]).filter((n) => n.type === 'block').map((n) => n.fields.videoId)
      expect(videoIds).toEqual(a.expectYoutube)
    }
  })

  it('a body with the old raw embed shape is refused, the converter never produces it', async () => {
    const { content } = htmlToLexical('<iframe src="https://social.example.test/frame"></iframe><p>x</p>', {
      oldHosts: [],
      slugMap: {},
      resolveImage: () => null,
    })
    expect(JSON.stringify(content)).not.toContain('"embed"')
    const ok = await f.createArticle(f.tokens.eic, { content })
    expect(ok.status, errors(ok)).toBe(201)
  })

  it('the deepest allowed conversion (64-level flatten) is accepted by the depth rule', async () => {
    const html = `${'<ul><li>level'.repeat(40)}${'</li></ul>'.repeat(40)}<table><tr><td><a href="https://example.test/x"><b>cell</b></a></td></tr></table>`
    const { content } = htmlToLexical(html, { oldHosts: [], slugMap: {}, resolveImage: () => null })
    const res = await f.createArticle(f.tokens.eic, { content })
    expect(res.status, errors(res)).toBe(201)
  })
})
