import { sql } from '@payloadcms/db-postgres'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetPublicReadLimiter } from '../../src/endpoints/publicNewsroom'
import { migrations } from '../../src/migrations'
import { api, lexical, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Waves 1-2 schema (docs/w12/schema-contract.md): the migration, the new article fields and their server-side limits, the
 * pull quote / gallery blocks, media lqip + AVIF sizes, author / topic profiles and their public visibility, the public
 * endpoints, site trust, and the access rules of donations, newsletter issues and the settings globals.
 */

const runId = newRunId()
let f: Fixtures
const MIGRATION = '20261030_090102_w12_newsroom_giving'

const drizzle = () => (f.payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<{ rows: any[] }> } }).drizzle
const tableExists = async (name: string) => (await drizzle().execute(sql.raw(`select to_regclass('public.${name}') as t`))).rows[0].t !== null

const ids = { authors: [] as number[], topics: [] as number[] }

beforeAll(async () => {
  f = await setupFixtures(runId)
  resetPublicReadLimiter()
})

afterAll(async () => {
  try {
    await f.payload.delete({ collection: 'articles', where: { slug: { like: runId } }, overrideAccess: true })
    if (ids.authors.length) await f.payload.delete({ collection: 'authors', where: { id: { in: ids.authors } }, overrideAccess: true })
    if (ids.topics.length) await f.payload.delete({ collection: 'topics', where: { id: { in: ids.topics } }, overrideAccess: true })
    await f.payload.updateGlobal({ slug: 'site-trust', data: { published: false } as never, overrideAccess: true })
  } catch {
    // best effort
  }
  await f?.cleanup()
})

const mkAuthor = async (data: Record<string, unknown>) => {
  const doc = (await f.payload.create({ collection: 'authors', data: { name: `${runId} author`, ...data } as never, overrideAccess: true })) as unknown as { id: number; slug: string }
  ids.authors.push(doc.id)
  return doc
}
const mkTopic = async (data: Record<string, unknown>) => {
  const doc = (await f.payload.create({ collection: 'topics', data: { name: `${runId} topic`, ...data } as never, overrideAccess: true })) as unknown as { id: number; slug: string }
  ids.topics.push(doc.id)
  return doc
}

async function uploadImage(token: string, label: string, width = 1800, height = 1000) {
  const png = await sharp({ create: { width, height, channels: 3, background: { r: 120, g: 40, b: 200 } } }).png().toBuffer()
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt: `${runId} ${label}` }))
  form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${runId}-${label}.png`)
  const res = await api('POST', '/api/media', { token, body: form })
  expect(res.status, JSON.stringify(res.json)).toBe(201)
  return res.json.doc as { id: number; url: string; filename: string; lqip?: string; sizes: Record<string, { url: string | null; mimeType: string | null; width: number | null }> }
}

const block = (fields: Record<string, unknown>) => ({ type: 'block', version: 2, format: '', fields: { id: `${runId}${Math.random().toString(16).slice(2, 10)}`, blockName: '', ...fields } })
const bodyWith = (...nodes: unknown[]) => {
  const doc = lexical() as { root: { children: unknown[] } }
  doc.root.children.push(...nodes)
  return doc
}

describe('migration 20261030 (waves 1-2) is reversible and keeps existing articles valid', () => {
  it('runs down and up on a database holding an existing article, which then reads as news', async () => {
    const legacy = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })
    const entry = migrations.find((m) => m.name === MIGRATION)
    expect(entry).toBeTruthy()
    const args = { db: drizzle(), payload: f.payload, req: {} } as never
    expect(await tableExists('authors')).toBe(true)
    await entry!.down(args)
    expect(await tableExists('authors')).toBe(false)
    expect(await tableExists('donations')).toBe(false)
    await entry!.down(args) // idempotent (IF EXISTS)
    await entry!.up(args)
    expect(await tableExists('authors')).toBe(true)
    expect(await tableExists('site_trust')).toBe(true)
    const row = (await drizzle().execute(sql`select content_type, kicker, byline_author_id from articles where id = ${legacy.id}`)).rows[0]
    expect(row).toEqual({ content_type: 'news', kicker: null, byline_author_id: null })
    const doc = (await f.payload.findByID({ collection: 'articles', id: legacy.id, depth: 0, overrideAccess: true })) as unknown as Record<string, unknown>
    expect(doc.contentType).toBe('news')
    expect(doc.keyPoints).toEqual([])
    expect(doc.topics).toEqual([])
  })
})

describe('article newsroom fields: server-side limits', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['kicker over 60', { kicker: 'k'.repeat(61) }],
    ['kicker with markup', { kicker: '<b>Exclusive</b>' }],
    ['unknown contentType', { contentType: 'advert' }],
    ['six key points', { keyPoints: Array.from({ length: 6 }, (_, i) => ({ text: `Point ${i}` })) }],
    ['key point over 200', { keyPoints: [{ text: 'p'.repeat(201) }] }],
    ['empty key point', { keyPoints: [{ text: '   ' }] }],
    ['key point with markup', { keyPoints: [{ text: 'a <script>x</script>' }] }],
    ['future update stamp', { lastSubstantiveUpdate: new Date(Date.now() + 86_400_000).toISOString() }],
    ['unknown topic', { topics: [2147483000] }],
    ['unknown byline profile', { bylineAuthor: 2147483000 }],
    ['pull quote with markup', { content: bodyWith(block({ blockType: 'pullQuote', quote: '<img src=x onerror=alert(1)>' })) }],
    ['pull quote too long', { content: bodyWith(block({ blockType: 'pullQuote', quote: 'q'.repeat(401) })) }],
    ['gallery without images', { content: bodyWith(block({ blockType: 'gallery', images: [] })) }],
    ['gallery with a url field', { content: bodyWith(block({ blockType: 'gallery', images: [{ image: 1, url: 'https://evil.test/x.png' }] })) }],
  ]
  for (const [label, data] of bad) {
    it(`refuses ${label} (400)`, async () => {
      const res = await f.createArticle(f.tokens.reporter, data)
      expect(res.status, JSON.stringify(res.json)).toBe(400)
    })
  }

  it('accepts and returns every field; a reporter cannot change them once in review, nor publish', async () => {
    const topic = await mkTopic({ name: `${runId} Persecution`, isPublic: true })
    const author = await mkAuthor({ name: `${runId} Ada Okafor`, isPublic: true })
    const stamp = new Date(Date.now() - 3_600_000).toISOString()
    const res = await f.createArticle(f.tokens.reporter, {
      kicker: '  Exclusive  ',
      contentType: 'analysis',
      keyPoints: [{ text: ' First point ' }, { text: 'Second point' }],
      lastSubstantiveUpdate: stamp,
      topics: [topic.id, topic.id],
      bylineAuthor: author.id,
      content: bodyWith(block({ blockType: 'pullQuote', quote: 'We will rebuild.', attribution: 'Bishop A' })),
    })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    const doc = res.json.doc
    expect(doc.kicker).toBe('Exclusive')
    expect(doc.contentType).toBe('analysis')
    expect(doc.keyPoints.map((k: { text: string }) => k.text)).toEqual(['First point', 'Second point'])
    expect(new Date(doc.lastSubstantiveUpdate).toISOString()).toBe(stamp)
    expect((doc.topics as unknown[]).length).toBe(1)

    const toReview = await api('PATCH', `/api/articles/${res.id}`, { token: f.tokens.reporter, body: { status: 'in_review' } })
    expect(toReview.status).toBe(200)
    const edit = await api('PATCH', `/api/articles/${res.id}`, { token: f.tokens.reporter, body: { keyPoints: [{ text: 'Changed' }] } })
    expect(edit.status).toBe(403)
    const kick = await api('PATCH', `/api/articles/${res.id}`, { token: f.tokens.reporter, body: { contentType: 'sponsored' } })
    expect(kick.status).toBe(403)
    const publish = await api('PATCH', `/api/articles/${res.id}`, { token: f.tokens.reporter, body: { status: 'published' } })
    expect(publish.status).toBe(403)
  })

  it('re-sending unchanged key points and topics (with or without row ids) is not an edit', async () => {
    const topic = await mkTopic({ name: `${runId} Same`, isPublic: true })
    const res = await f.createArticle(f.tokens.reporter, { keyPoints: [{ text: 'One' }], topics: [topic.id] })
    expect(res.status).toBe(201)
    expect((await api('PATCH', `/api/articles/${res.id}`, { token: f.tokens.reporter, body: { status: 'in_review' } })).status).toBe(200)
    const same = await api('PATCH', `/api/articles/${res.id}`, {
      token: f.tokens.reporter,
      body: { keyPoints: [{ text: 'One' }], topics: [{ id: topic.id }] },
    })
    // The reporter cannot write an in-review article at all (collection access), so this is 403/404 either way; an editor
    // re-sending the same values on a published story must not be forced to add a correction.
    expect([403, 404]).toContain(same.status)
    const pub = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), keyPoints: [{ text: 'One' }] })
    const resend = await api('PATCH', `/api/articles/${pub.id}`, { token: f.tokens.eic, body: { keyPoints: [{ text: 'One' }] } })
    expect(resend.status, JSON.stringify(resend.json)).toBe(200)
  })
})

describe('media: lqip and AVIF sizes', () => {
  it('generates a small blur placeholder and avif variants on upload; lqip is not client-writable', async () => {
    const m = await uploadImage(f.tokens.eic, 'lqip')
    expect(m.lqip).toMatch(/^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/)
    expect(m.lqip!.length).toBeLessThanOrEqual(1500)
    expect(m.sizes.cardAvif?.mimeType).toBe('image/avif')
    expect(m.sizes.cardAvif?.width).toBe(800)
    expect(m.sizes.heroAvif?.mimeType).toBe('image/avif')
    expect(m.sizes.heroAvif?.width).toBe(1600)
    expect(m.sizes.card?.mimeType).not.toBe('image/avif')
    const patch = await api('PATCH', `/api/media/${m.id}`, { token: f.tokens.admin, body: { lqip: 'data:image/png;base64,AAAA' } })
    expect(patch.status).toBe(200)
    expect(patch.json.doc.lqip).toBe(m.lqip)

    // AVIF is only a generated size: an AVIF original is still refused.
    const avif = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } }).avif().toBuffer()
    const form = new FormData()
    form.set('_payload', JSON.stringify({ alt: `${runId} avif original` }))
    form.set('file', new Blob([new Uint8Array(avif)], { type: 'image/avif' }), `${runId}-orig.avif`)
    expect((await api('POST', '/api/media', { token: f.tokens.eic, body: form })).status).toBe(400)
  })
})

describe('gallery block', () => {
  it('validates images, counts them as body media, and makes them public with the article only', async () => {
    const a = await uploadImage(f.tokens.eic, 'gal-a', 640, 480)
    const b = await uploadImage(f.tokens.eic, 'gal-b', 640, 480)
    const tooMany = await f.createArticle(f.tokens.eic, {
      content: bodyWith(block({ blockType: 'gallery', images: Array.from({ length: 13 }, () => ({ image: a.id })) })),
    })
    expect(tooMany.status).toBe(400)
    const missing = await f.createArticle(f.tokens.eic, { content: bodyWith(block({ blockType: 'gallery', images: [{ image: 2147483000 }] })) })
    expect(missing.status).toBe(400)

    const res = await f.createArticle(f.tokens.eic, {
      content: bodyWith(block({ blockType: 'gallery', images: [{ image: a.id, caption: 'The choir' }, { image: b.id }] })),
    })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    const stored = (await f.payload.findByID({ collection: 'articles', id: res.id!, depth: 0, overrideAccess: true })) as unknown as { bodyMedia: number[] }
    expect(stored.bodyMedia).toEqual(expect.arrayContaining([a.id, b.id]))
    expect((await api('GET', `/api/media/file/${a.filename}`)).status).toBe(403)
    for (const status of ['in_review', 'approved', 'published']) {
      const r = await api('PATCH', `/api/articles/${res.id}`, { token: f.tokens.eic, body: { status } })
      expect(r.status, JSON.stringify(r.json)).toBe(200)
    }
    expect((await api('GET', `/api/media/file/${a.filename}`)).status).toBe(200)
    // Contract: at depth=1 a reader gets each gallery image populated (url, alt, sizes incl. avif, lqip).
    const read = await api('GET', `/api/articles?where[id][equals]=${res.id}&depth=1`)
    const gallery = (read.json.docs[0].content.root.children as Array<{ type: string; fields?: { blockType?: string; images?: Array<{ image: any; caption?: string }> } }>).find(
      (n) => n.type === 'block' && n.fields?.blockType === 'gallery',
    )
    expect(gallery?.fields?.images?.[0]).toMatchObject({ caption: 'The choir', image: { id: a.id, alt: `${runId} gal-a`, url: expect.stringContaining('/api/media/file/') } })
    expect(gallery?.fields?.images?.[0].image.lqip).toMatch(/^data:image\/webp;base64,/)
  })
})

describe('authors and topics: who may write, what readers see', () => {
  it('reporters cannot create profiles; section editors can; only editor-in-chief deletes', async () => {
    expect((await api('POST', '/api/authors', { token: f.tokens.reporter, body: { name: `${runId} R` } })).status).toBe(403)
    const created = await api('POST', '/api/authors', { token: f.tokens.sectionEditor, body: { name: `${runId} Section Made` } })
    expect(created.status).toBe(201)
    ids.authors.push(created.json.doc.id)
    expect(created.json.doc.slug).toBe(`${runId}-section-made`)
    expect((await api('DELETE', `/api/authors/${created.json.doc.id}`, { token: f.tokens.sectionEditor })).status).toBe(403)
    const badUrl = await api('POST', '/api/authors', { token: f.tokens.eic, body: { name: `${runId} X`, socials: [{ kind: 'x', url: 'javascript:alert(1)' }] } })
    expect(badUrl.status).toBe(400)
    const longBio = await api('POST', '/api/authors', { token: f.tokens.eic, body: { name: `${runId} Y`, bio: 'b'.repeat(601) } })
    expect(longBio.status).toBe(400)
    expect((await api('POST', '/api/topics', { token: f.tokens.reporter, body: { name: `${runId} T` } })).status).toBe(403)
    const badSlug = await api('POST', '/api/topics', { token: f.tokens.eic, body: { name: `${runId} T`, slug: 'Bad Slug' } })
    expect(badSlug.status).toBe(400)
  })

  it('anonymous REST reads only public profiles and topics; hidden ones never populate into articles', async () => {
    const photo = await uploadImage(f.tokens.eic, 'portrait', 600, 600)
    const pubAuthor = await mkAuthor({ name: `${runId} Public Author`, isPublic: true, photo: photo.id, bio: 'Covers the north.' })
    const hidAuthor = await mkAuthor({ name: `${runId} Hidden Author`, isPublic: false })
    const pubTopic = await mkTopic({ name: `${runId} Public Topic`, isPublic: true })
    const hidTopic = await mkTopic({ name: `${runId} Hidden Topic`, isPublic: false })

    const list = await api('GET', `/api/authors?where[slug][like]=${runId}&limit=50`)
    expect(list.status).toBe(200)
    const slugs = list.json.docs.map((d: { slug: string }) => d.slug)
    expect(slugs).toContain(pubAuthor.slug)
    expect(slugs).not.toContain(hidAuthor.slug)
    expect((await api('GET', `/api/authors/${hidAuthor.id}`)).status).toBe(404)
    expect((await api('GET', `/api/topics/${hidTopic.id}`)).status).toBe(404)
    // The photo of a public profile is readable by anyone (author pages), with no article involved.
    expect((await api('GET', `/api/media/file/${photo.filename}`)).status).toBe(200)

    const a1 = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), bylineAuthor: pubAuthor.id, topics: [pubTopic.id, hidTopic.id] })
    const a2 = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), bylineAuthor: hidAuthor.id })
    const r1 = await api('GET', `/api/articles?where[id][equals]=${a1.id}&depth=1`)
    const d1 = r1.json.docs[0]
    expect(d1.bylineAuthor).toMatchObject({ name: `${runId} Public Author`, slug: pubAuthor.slug, isPublic: true })
    expect(d1.bylineAuthor.avatar).toMatchObject({ url: expect.stringContaining('/api/media/file/'), alt: `${runId} portrait` })
    expect(d1.bylineAuthor.bio).toBeUndefined() // defaultPopulate: card fields only
    expect(d1.topics.filter((t: unknown) => typeof t === 'object')).toEqual([expect.objectContaining({ slug: pubTopic.slug, name: `${runId} Public Topic` })])
    expect(d1.topics).toContain(hidTopic.id) // a bare id: Payload shows ids, never the hidden record
    expect(d1.contentType).toBe('news')
    const d2 = (await api('GET', `/api/articles?where[id][equals]=${a2.id}&depth=1`)).json.docs[0]
    expect(d2.bylineAuthor).toBe(hidAuthor.id)
  })
})

describe('public endpoints', () => {
  let author: { id: number; slug: string }
  let hidden: { id: number; slug: string }
  let topic: { id: number; slug: string }
  let published: { id: number; slug: string }
  let draft: { id: number; slug: string }

  beforeAll(async () => {
    author = await mkAuthor({ name: `${runId} Endpoint Author`, isPublic: true, role: 'Reporter', socials: [{ kind: 'website', url: 'https://example.org/me' }] })
    hidden = await mkAuthor({ name: `${runId} Endpoint Hidden`, isPublic: false })
    topic = await mkTopic({ name: `${runId} Endpoint Topic`, isPublic: true, kind: 'denomination', description: 'All about it.' })
    published = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString(), bylineAuthor: author.id, topics: [topic.id], kicker: 'Live', contentType: 'sponsored', keyPoints: [{ text: 'Key' }] })
    draft = await f.seedArticle({ status: 'draft', bylineAuthor: author.id, topics: [topic.id] })
  })

  it('GET /api/public/authors/:slug returns the profile and only published cards', async () => {
    const res = await api('GET', `/api/public/authors/${author.slug}`)
    expect(res.status).toBe(200)
    expect(res.json.author).toMatchObject({ name: `${runId} Endpoint Author`, slug: author.slug, role: 'Reporter', socials: [{ kind: 'website', url: 'https://example.org/me' }] })
    const cardIds = res.json.articles.map((a: { id: number }) => a.id)
    expect(cardIds).toContain(published.id)
    expect(cardIds).not.toContain(draft.id)
    const card = res.json.articles.find((a: { id: number }) => a.id === published.id)
    expect(card).toMatchObject({ status: 'published', kicker: 'Live', contentType: 'sponsored', bylineAuthor: { slug: author.slug } })
    expect(card.content).toBeUndefined()
    expect(card.author).toBeUndefined()
    expect(card.reviewNotes).toBeUndefined()
    expect(card.topics).toEqual([expect.objectContaining({ slug: topic.slug })])
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/)
  })

  it('hidden or unknown profiles are 404, also for a logged-in editor (no widening)', async () => {
    expect((await api('GET', `/api/public/authors/${hidden.slug}`)).status).toBe(404)
    expect((await api('GET', `/api/public/authors/${hidden.slug}`, { token: f.tokens.eic })).status).toBe(404)
    expect((await api('GET', '/api/public/authors/Not_A_Slug')).status).toBe(404)
    const list = await api('GET', '/api/public/authors', { token: f.tokens.eic })
    expect(list.json.docs.map((d: { slug: string }) => d.slug)).not.toContain(hidden.slug)
    const withDraft = await api('GET', `/api/public/authors/${author.slug}`, { token: f.tokens.eic })
    expect(withDraft.json.articles.map((a: { id: number }) => a.id)).not.toContain(draft.id)
  })

  it('topics list, kind filter, topic page, bad parameters and origin rules', async () => {
    const list = await api('GET', '/api/public/topics?kind=denomination')
    expect(list.status).toBe(200)
    expect(list.json.docs.map((d: { slug: string }) => d.slug)).toContain(topic.slug)
    expect((await api('GET', '/api/public/topics?kind=bogus')).status).toBe(400)
    const page = await api('GET', `/api/public/topics/${topic.slug}`)
    expect(page.status).toBe(200)
    expect(page.json.topic).toMatchObject({ name: `${runId} Endpoint Topic`, kind: 'denomination', description: 'All about it.' })
    expect(page.json.articles.map((a: { id: number }) => a.id)).toEqual([published.id])
    expect((await api('GET', `/api/public/topics/${topic.slug}?page=0`)).status).toBe(400)
    expect((await api('GET', `/api/public/topics/${topic.slug}?page=51`)).status).toBe(400)
    expect((await api('GET', '/api/public/topics', { headers: { origin: 'http://evil.test' } })).status).toBe(403)
    const allowed = await api('GET', '/api/public/topics', { headers: { origin: 'http://allowed.test' } })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://allowed.test')
  })

  it('corrections log lists published articles with their corrections', async () => {
    const corrected = await f.seedArticle({
      status: 'published',
      publishedAt: new Date().toISOString(),
      corrections: [{ note: `${runId} An earlier version misspelt the name.`, correctedAt: new Date().toISOString() }],
    })
    await f.seedArticle({ status: 'draft', corrections: [{ note: `${runId} draft note`, correctedAt: new Date().toISOString() }] })
    const res = await api('GET', '/api/public/corrections')
    expect(res.status).toBe(200)
    const entry = res.json.docs.find((d: { article: { id: number } }) => d.article.id === corrected.id)
    expect(entry.corrections).toEqual([{ note: `${runId} An earlier version misspelt the name.`, correctedAt: expect.any(String) }])
    expect(JSON.stringify(res.json)).not.toContain(`${runId} draft note`)
  })

  it('rate limits per IP (429 with Retry-After)', async () => {
    process.env.PUBLIC_READ_RATE_LIMIT = '2'
    resetPublicReadLimiter()
    try {
      const h = { 'x-forwarded-for': '203.0.113.77' }
      expect((await api('GET', '/api/public/topics', { headers: h })).status).toBe(200)
      expect((await api('GET', '/api/public/topics', { headers: h })).status).toBe(200)
      const third = await api('GET', '/api/public/topics', { headers: h })
      expect(third.status).toBe(429)
      expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
    } finally {
      delete process.env.PUBLIC_READ_RATE_LIMIT
      resetPublicReadLimiter()
    }
  })
})

describe('site trust global', () => {
  it('is hidden until published, editable by the editor-in-chief only, and refuses unsafe links', async () => {
    expect((await api('GET', '/api/globals/site-trust')).status).toBe(403)
    await f.payload.updateGlobal({ slug: 'site-trust', data: { published: false } as never, overrideAccess: true })
    expect((await api('GET', '/api/public/site-trust')).status).toBe(404)
    expect((await api('POST', '/api/globals/site-trust', { token: f.tokens.sectionEditor, body: { published: true } })).status).toBe(403)
    const unsafe = bodyWith({
      type: 'link', version: 3, format: '', indent: 0, direction: null,
      fields: { url: 'javascript:alert(1)', linkType: 'custom', newTab: false },
      children: [{ type: 'text', text: 'x', version: 1, format: 0, mode: 'normal', style: '', detail: 0 }],
    })
    expect((await api('POST', '/api/globals/site-trust', { token: f.tokens.eic, body: { editorialStandards: unsafe } })).status).toBe(400)
    const ok = await api('POST', '/api/globals/site-trust', {
      token: f.tokens.eic,
      body: { published: true, editorialStandards: lexical('We verify before we publish.'), contactEditors: 'editors@example.org' },
    })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    const pub = await api('GET', '/api/public/site-trust')
    expect(pub.status).toBe(200)
    expect(Object.keys(pub.json).sort()).toEqual(['contactEditors', 'editorialStandards', 'ethicsCorrectionsPolicy', 'ownershipFunding', 'updatedAt'])
    expect(JSON.stringify(pub.json.editorialStandards)).toContain('We verify before we publish.')
  })
})

describe('donations, newsletter issues and settings: never public, server-owned', () => {
  let donationId: number
  beforeAll(async () => {
    const d = (await f.payload.create({
      collection: 'donations',
      data: { reference: `${runId}-ref-1`, provider: 'paystack', amountMinor: 500000, currency: 'NGN', status: 'pending', email: 'giver@example.org', name: 'A Giver', consentAt: new Date().toISOString() } as never,
      overrideAccess: true,
    })) as unknown as { id: number }
    donationId = d.id
  })
  afterAll(async () => {
    await f.payload.delete({ collection: 'donations', where: { reference: { like: runId } }, overrideAccess: true }).catch(() => undefined)
    await f.payload.delete({ collection: 'newsletter-issues', where: { subject: { like: runId } }, overrideAccess: true }).catch(() => undefined)
  })

  it('donations: anonymous and reporters 403; editor-in-chief reads without personal data; admin sees it; nobody writes over REST', async () => {
    expect((await api('GET', '/api/donations')).status).toBe(403)
    expect((await api('GET', `/api/donations/${donationId}`)).status).toBe(403)
    expect((await api('GET', '/api/donations', { token: f.tokens.reporter })).status).toBe(403)
    expect((await api('GET', '/api/donations', { token: f.tokens.sectionEditor })).status).toBe(403)
    const eic = await api('GET', `/api/donations/${donationId}`, { token: f.tokens.eic })
    expect(eic.status).toBe(200)
    expect(eic.json.amountMinor).toBe(500000)
    expect(eic.json.email).toBeUndefined()
    expect(eic.json.name).toBeUndefined()
    const admin = await api('GET', `/api/donations/${donationId}`, { token: f.tokens.admin })
    expect(admin.json.email).toBe('giver@example.org')
    expect((await api('POST', '/api/donations', { token: f.tokens.admin, body: { reference: `${runId}-x`, provider: 'paystack', amountMinor: 1, currency: 'NGN' } })).status).toBe(403)
    expect((await api('PATCH', `/api/donations/${donationId}`, { token: f.tokens.admin, body: { status: 'succeeded' } })).status).toBe(403)
    expect((await api('DELETE', `/api/donations/${donationId}`, { token: f.tokens.eic })).status).toBe(403)
  })

  it('donations: the reference is unique and the amount bounded even for server code', async () => {
    await expect(
      f.payload.create({ collection: 'donations', data: { reference: `${runId}-ref-1`, provider: 'paystack', amountMinor: 100, currency: 'NGN' } as never, overrideAccess: true }),
    ).rejects.toThrow()
    await expect(
      f.payload.create({ collection: 'donations', data: { reference: `${runId}-ref-2`, provider: 'paystack', amountMinor: 1.5, currency: 'NGN' } as never, overrideAccess: true }),
    ).rejects.toThrow()
  })

  it('newsletter issues: never public, never created over REST, subject editable while draft only', async () => {
    const issue = (await f.payload.create({
      collection: 'newsletter-issues',
      data: { date: new Date().toISOString(), subject: `${runId} Daily`, status: 'draft', bodyText: 'Hello', bodyHtml: '<p>Hello</p>' } as never,
      overrideAccess: true,
    })) as unknown as { id: number }
    expect((await api('GET', '/api/newsletter-issues')).status).toBe(403)
    expect((await api('GET', '/api/newsletter-issues', { token: f.tokens.reporter })).status).toBe(403)
    expect((await api('GET', `/api/newsletter-issues/${issue.id}`, { token: f.tokens.sectionEditor })).status).toBe(200)
    expect((await api('POST', '/api/newsletter-issues', { token: f.tokens.admin, body: { subject: 'x', date: new Date().toISOString() } })).status).toBe(403)
    const edit = await api('PATCH', `/api/newsletter-issues/${issue.id}`, { token: f.tokens.eic, body: { subject: `${runId} Daily brief`, bodyHtml: '<script>x</script>', status: 'sent' } })
    expect(edit.status).toBe(200)
    expect(edit.json.doc).toMatchObject({ subject: `${runId} Daily brief`, bodyHtml: '<p>Hello</p>', status: 'draft' })
    await f.payload.update({ collection: 'newsletter-issues', id: issue.id, data: { status: 'sent' } as never, overrideAccess: true })
    expect((await api('PATCH', `/api/newsletter-issues/${issue.id}`, { token: f.tokens.eic, body: { subject: 'late' } })).status).toBe(403)
  })

  it('giving settings: editor-in-chief reads, only admin writes, amounts validated', async () => {
    expect((await api('GET', '/api/globals/giving-settings')).status).toBe(403)
    expect((await api('GET', '/api/globals/giving-settings', { token: f.tokens.sectionEditor })).status).toBe(403)
    const read = await api('GET', '/api/globals/giving-settings', { token: f.tokens.eic })
    expect(read.status).toBe(200)
    expect(read.json.enabled).toBe(false)
    expect((await api('POST', '/api/globals/giving-settings', { token: f.tokens.eic, body: { enabled: true } })).status).toBe(403)
    const badRange = await api('POST', '/api/globals/giving-settings', {
      token: f.tokens.admin,
      body: { currencies: [{ currency: 'NGN', minimum: 100000, maximum: 50000, presets: [] }] },
    })
    expect(badRange.status).toBe(400)
    const badPreset = await api('POST', '/api/globals/giving-settings', {
      token: f.tokens.admin,
      body: { currencies: [{ currency: 'NGN', minimum: 100000, maximum: 5000000, presets: [50] }] },
    })
    expect(badPreset.status).toBe(400)
    const dup = await api('POST', '/api/globals/giving-settings', {
      token: f.tokens.admin,
      body: { currencies: [{ currency: 'NGN', minimum: 100, maximum: 500 }, { currency: 'NGN', minimum: 100, maximum: 500 }] },
    })
    expect(dup.status).toBe(400)
    const ok = await api('POST', '/api/globals/giving-settings', {
      token: f.tokens.admin,
      body: { currencies: [{ currency: 'NGN', minimum: 100000, maximum: 50000000, presets: [200000, 500000, 1000000], label: 'Naira' }], causes: [{ key: 'general', label: 'Where most needed', enabled: true }] },
    })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json.result.currencies[0].presets).toEqual([200000, 500000, 1000000])
    await f.payload.updateGlobal({ slug: 'giving-settings', data: { currencies: [], causes: [] } as never, overrideAccess: true })
  })

  it('newsletter settings: defaults off with a 100/day cap; the cap is bounded', async () => {
    expect((await api('GET', '/api/globals/newsletter-settings')).status).toBe(403)
    const read = await api('GET', '/api/globals/newsletter-settings', { token: f.tokens.sectionEditor })
    expect(read.status).toBe(200)
    expect(read.json).toMatchObject({ enabled: false, dailySendCap: 100, maxStoriesPerDigest: 6 })
    expect((await api('POST', '/api/globals/newsletter-settings', { token: f.tokens.sectionEditor, body: { enabled: true } })).status).toBe(403)
    expect((await api('POST', '/api/globals/newsletter-settings', { token: f.tokens.eic, body: { dailySendCap: 1_000_000 } })).status).toBe(400)
    expect((await api('POST', '/api/globals/newsletter-settings', { token: f.tokens.eic, body: { sendHourLagos: 24 } })).status).toBe(400)
    expect((await api('POST', '/api/globals/newsletter-settings', { token: f.tokens.eic, body: { replyTo: 'not-an-email' } })).status).toBe(400)
  })
})
