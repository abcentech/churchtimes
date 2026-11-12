import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, lexical, newRunId, setupFixtures, type Fixtures } from './helpers'

const runId = newRunId()
let f: Fixtures
beforeAll(async () => { f = await setupFixtures(runId) })
afterAll(async () => { await f?.cleanup() })

const content = (videoId: string) => {
  const doc = lexical() as { root: { children: unknown[] } }
  doc.root.children.push({ type: 'block', version: 2, format: '', fields: { id: 'video1', blockName: '', blockType: 'youtubeEmbed', videoId, title: 'Service' } })
  return doc
}

describe('article YouTube input', () => {
  it.each([
    'https://youtube.com/live/aB3_deF-123?si=live',
    'https://m.youtube.com/watch?v=aB3_deF-123&feature=live',
  ])('stores a live broadcast URL as its video ID: %s', async (url) => {
    const result = await f.createArticle(f.tokens.reporter, { content: content(url) })
    expect(result.status, result.text).toBe(201)
    expect(result.json.doc.content.root.children.find((n: any) => n.fields?.blockType === 'youtubeEmbed').fields.videoId).toBe('aB3_deF-123')
  })

  it('stores only the ID and parsed start when a reporter pastes a link', async () => {
    const result = await f.createArticle(f.tokens.reporter, { content: content('https://youtube.com/live/aB3_deF-123?t=1m5s&si=abc') })
    expect(result.status, JSON.stringify(result.json)).toBe(201)
    const fields = result.json.doc.content.root.children.find((n: any) => n.fields?.blockType === 'youtubeEmbed').fields
    expect(fields).toMatchObject({ videoId: 'aB3_deF-123', startSeconds: 65, title: 'Service' })
    expect(JSON.stringify(fields)).not.toContain('https://')
    const read = await api('GET', '/api/articles/' + result.id, { token: f.tokens.reporter })
    expect(read.status).toBe(200)
    expect(JSON.stringify(read.json.content)).not.toContain('https://')
  })

  it('rejects an invalid host and does not save it', async () => {
    const result = await f.createArticle(f.tokens.reporter, { content: content('https://evil.test/watch?v=aB3_deF-123') })
    expect(result.status).toBe(400)
  })
})
