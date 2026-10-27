import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SEO_DESCRIPTION_MAX, SEO_TITLE_MAX } from '../../src/lib/seoFields'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

const runId = newRunId()
let f: Fixtures

beforeAll(async () => {
  f = await setupFixtures(runId)
})

afterAll(async () => {
  await f?.cleanup()
})

const patch = (token: string, id: number, body: Record<string, unknown>) =>
  api('PATCH', `/api/articles/${id}`, { token, body })

/** The REST error for a failed field validation names the field and message. */
const fieldErrors = (res: { json: any }): string[] =>
  (res.json?.errors ?? []).flatMap((e: any) => [
    String(e.message ?? ''),
    ...((e.data?.errors ?? []) as { path?: string; message?: string }[]).map((x) => `${x.path}: ${x.message}`),
  ])

describe('C2 SEO fields: write validation', () => {
  it('stores clean text, strips markup, and stores empty as null', async () => {
    const res = await f.createArticle(f.tokens.eic, {
      seoTitle: '  Church <b>opens</b> clinic  ',
      seoDescription: 'A <i>new</i> clinic\nopens in Ibadan.',
    })
    expect(res.status).toBe(201)
    expect(res.json.doc.seoTitle).toBe('Church opens clinic')
    expect(res.json.doc.seoDescription).toBe('A new clinic opens in Ibadan.')

    const cleared = await patch(f.tokens.eic, res.id!, { seoTitle: '<b></b>', seoDescription: '' })
    expect(cleared.status).toBe(200)
    expect(cleared.json.doc.seoTitle).toBeNull()
    expect(cleared.json.doc.seoDescription).toBeNull()
  })

  it('refuses over-length values and names the field', async () => {
    const longTitle = await f.createArticle(f.tokens.eic, { seoTitle: 'a'.repeat(SEO_TITLE_MAX + 1) })
    expect(longTitle.status).toBe(400)
    expect(fieldErrors(longTitle).join(' ')).toMatch(/SEO title must be at most 70 characters/)

    const longDescription = await f.createArticle(f.tokens.eic, {
      seoDescription: 'a'.repeat(SEO_DESCRIPTION_MAX + 1),
    })
    expect(longDescription.status).toBe(400)
    expect(fieldErrors(longDescription).join(' ')).toMatch(/SEO description must be at most 200 characters/)
  })

  it('refuses Rank Math template variables', async () => {
    const res = await f.createArticle(f.tokens.eic, { seoTitle: '%title% %sep% %sitename%' })
    expect(res.status).toBe(400)
    expect(fieldErrors(res).join(' ')).toMatch(/template variables/)
  })

  it('refuses non-string values instead of dropping them', async () => {
    const res = await f.createArticle(f.tokens.eic, { seoTitle: 42 })
    expect(res.status).toBe(400)
    const obj = await f.createArticle(f.tokens.eic, { seoDescription: { a: 1 } })
    expect(obj.status).toBe(400)
  })
})

describe('C2 SEO fields: public projection', () => {
  it('shows the fields on published articles to anonymous readers, and null when unset', async () => {
    const withSeo = await f.seedArticle({
      status: 'published',
      publishedAt: new Date().toISOString(),
      seoTitle: 'Search title',
      seoDescription: 'Search description.',
    })
    const without = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })

    const one = await api('GET', `/api/articles/${withSeo.id}?depth=0`)
    expect(one.status).toBe(200)
    expect(one.json.seoTitle).toBe('Search title')
    expect(one.json.seoDescription).toBe('Search description.')

    const bySlug = await api('GET', `/api/articles?where[slug][equals]=${withSeo.slug}&depth=0`)
    expect(bySlug.json.docs[0].seoTitle).toBe('Search title')

    const unset = await api('GET', `/api/articles/${without.id}?depth=0`)
    expect(unset.status).toBe(200)
    expect(unset.json.seoTitle ?? null).toBeNull()
    expect(unset.json.seoDescription ?? null).toBeNull()
  })

  it('does not expose the fields of unpublished articles to anonymous readers', async () => {
    const draft = await f.seedArticle({ status: 'draft', seoTitle: 'Draft only title' })
    const review = await f.seedArticle({ status: 'in_review', seoDescription: 'Draft only description.' })

    expect((await api('GET', `/api/articles/${draft.id}?depth=0`)).status).toBe(404)
    expect((await api('GET', `/api/articles/${review.id}?depth=0`)).status).toBe(404)

    const list = await api('GET', '/api/articles?limit=100&depth=0')
    const text = JSON.stringify(list.json)
    expect(text).not.toContain('Draft only title')
    expect(text).not.toContain('Draft only description.')
  })
})

describe('C2 SEO fields: who may edit, and corrections', () => {
  it('lets a reporter set them while the article is a draft, but not once it is in review', async () => {
    const mine = await f.createArticle(f.tokens.reporter, {})
    expect(mine.status).toBe(201)

    const draftEdit = await patch(f.tokens.reporter, mine.id!, { seoTitle: 'Reporter title' })
    expect(draftEdit.status).toBe(200)
    expect(draftEdit.json.doc.seoTitle).toBe('Reporter title')

    const submit = await patch(f.tokens.reporter, mine.id!, { status: 'in_review' })
    expect(submit.status).toBe(200)

    const lateEdit = await patch(f.tokens.reporter, mine.id!, { seoTitle: 'Changed in review' })
    expect(lateEdit.status).toBe(403)
  })

  it('does not require a corrections entry to change only the SEO fields of a published article', async () => {
    const art = await f.seedArticle({
      status: 'published',
      publishedAt: new Date().toISOString(),
      title: `${runId} stable headline`,
    })
    const before = await f.payload.findVersions({
      collection: 'articles',
      where: { parent: { equals: art.id } },
      limit: 100,
      overrideAccess: true,
    })

    const res = await patch(f.tokens.eic, art.id, { seoTitle: 'Better search title', seoDescription: 'Better description.' })
    expect(res.status).toBe(200)
    expect(res.json.doc.seoTitle).toBe('Better search title')
    expect(res.json.doc.corrections ?? []).toHaveLength(0)

    // Still versioned like any other save of a published article.
    const after = await f.payload.findVersions({
      collection: 'articles',
      where: { parent: { equals: art.id } },
      limit: 100,
      overrideAccess: true,
    })
    expect(after.totalDocs).toBe(before.totalDocs + 1)

    // Changing the headline at the same time still needs a correction.
    const mixed = await patch(f.tokens.eic, art.id, { title: `${runId} new headline`, seoTitle: 'Another' })
    expect(mixed.status).toBe(400)
  })

  it('does not let a reporter who is not the author edit them on a published article', async () => {
    const art = await f.seedArticle({
      status: 'published',
      publishedAt: new Date().toISOString(),
      author: f.users.reporter.id,
    })
    const res = await patch(f.tokens.reporter, art.id, { seoTitle: 'Reporter edit after publication' })
    expect(res.status).toBe(403)
  })
})
