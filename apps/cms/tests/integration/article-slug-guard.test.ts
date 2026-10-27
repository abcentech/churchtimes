import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/** Published slugs are public addresses: only editor-in-chief/admin may change them, with a redirect and an audit entry. */
const runId = newRunId()
let f: Fixtures

beforeAll(async () => {
  delete process.env.PUBLIC_ARTICLE_PATH_TEMPLATE // default /{slug}/
  f = await setupFixtures(runId)
})

afterAll(async () => {
  await f?.payload.delete({ collection: 'redirects', where: { from: { like: runId } } as never, overrideAccess: true }).catch(() => undefined)
  await f?.payload.delete({ collection: 'redirects', where: { to: { like: runId } } as never, overrideAccess: true }).catch(() => undefined)
  await f?.cleanup()
})

const patch = (token: string, id: number, body: Record<string, unknown>) =>
  api('PATCH', `/api/articles/${id}`, { token, body })

const published = () => f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })

const redirectsFrom = async (from: string) =>
  (await f.payload.find({ collection: 'redirects', where: { from: { equals: from } }, depth: 0, overrideAccess: true })).docs as Array<Record<string, any>>

describe('slug of a published article', () => {
  it('is refused (403) for a section editor, and nothing changes', async () => {
    const a = await published()
    const res = await patch(f.tokens.sectionEditor, a.id, { slug: `${a.slug}-new` })
    expect(res.status).toBe(403)
    const stored = (await f.payload.findByID({ collection: 'articles', id: a.id, overrideAccess: true })) as { slug: string }
    expect(stored.slug).toBe(a.slug)
  })

  it('allows an unchanged slug in the same PATCH as another edit', async () => {
    const a = await published()
    const res = await patch(f.tokens.sectionEditor, a.id, { slug: a.slug, bylineName: 'Staff' })
    expect(res.status).toBe(200)
  })

  it('lets the editor-in-chief and admin change it, creating a 301 redirect and an audit entry', async () => {
    const a = await published()
    const res = await patch(f.tokens.eic, a.id, { slug: `${a.slug}-b` })
    expect(res.status).toBe(200)
    const rules = await redirectsFrom(`/${a.slug}/`)
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ to: `/${a.slug}-b/`, status: 301 })
    const audit = (await f.payload.find({
      collection: 'audit-logs',
      where: { and: [{ collection: { equals: 'articles' } }, { docId: { equals: String(a.id) } }, { action: { equals: 'article.slug-change' } }] },
      overrideAccess: true,
    })).docs
    expect(audit).toHaveLength(1)

    // second rename by an admin: the earlier rule is re-pointed, no chain
    expect((await patch(f.tokens.admin, a.id, { slug: `${a.slug}-c` })).status).toBe(200)
    expect((await redirectsFrom(`/${a.slug}/`))[0].to).toBe(`/${a.slug}-c/`)
    expect((await redirectsFrom(`/${a.slug}-b/`))[0].to).toBe(`/${a.slug}-c/`)

    // renaming back removes the rule that would shadow the live address
    expect((await patch(f.tokens.eic, a.id, { slug: a.slug })).status).toBe(200)
    expect(await redirectsFrom(`/${a.slug}/`)).toHaveLength(0)
  })

  it('is free on drafts (no redirect) and for the server-side importer', async () => {
    const d = await f.seedArticle({ status: 'draft' })
    expect((await patch(f.tokens.sectionEditor, d.id, { slug: `${d.slug}-x` })).status).toBe(200)
    expect(await redirectsFrom(`/${d.slug}/`)).toHaveLength(0)

    const a = await published()
    await f.payload.update({
      collection: 'articles',
      id: a.id,
      data: { slug: `${a.slug}-imp` } as never,
      overrideAccess: true,
      context: { import: true },
    })
    expect(await redirectsFrom(`/${a.slug}/`)).toHaveLength(0)
  })
})

describe('reserved root slugs under /{slug}/ (owner decision D1)', () => {
  it('refuses a slug that equals a real route, for a draft too', async () => {
    const d = await f.seedArticle({ status: 'draft' })
    for (const slug of ['admin', 'search', 'wp-json', 'Newsletter']) {
      const res = await patch(f.tokens.sectionEditor, d.id, { slug })
      expect(res.status, slug).toBeGreaterThanOrEqual(400)
      expect(res.status, slug).toBeLessThan(500)
    }
    const stored = (await f.payload.findByID({ collection: 'articles', id: d.id, overrideAccess: true })) as { slug: string }
    expect(stored.slug).toBe(d.slug)
  })

  it('numbers a generated slug that would be a reserved route', async () => {
    const created = await f.seedArticle({ title: 'Search', slug: '' })
    expect(created.slug).toBe('search-2')
  })
})
