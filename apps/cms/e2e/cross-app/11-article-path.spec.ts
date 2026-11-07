/**
 * Article URL template (owner decision D1: articles live at `/{slug}/`) and reserved root slugs, against the real stack.
 *   - a slug equal to a public route (`contact`, `search`) cannot be created: the CMS refuses it (400, "reserved"), so
 *     `/{slug}/` can never be ambiguous with a real page; an ordinary slug is accepted;
 *   - the public host serves a published article at the configured PUBLIC_ARTICLE_PATH_TEMPLATE (default `/{slug}/`).
 * Real Payload + PostgreSQL + public host, no mocks. Synthetic data only; created articles are removed again.
 */
import { expect, test } from '@playwright/test'

import { articlePath } from './support/articlePath'
import { Api, getConfig, uniq } from './support/helpers'

const cfg = getConfig()
const api = new Api(cfg)
const base = new URL(cfg.recorderUrl).origin

const lexical = (text: string) => ({
  root: {
    type: 'root', format: '', indent: 0, version: 1, direction: 'ltr',
    children: [{ type: 'paragraph', format: '', indent: 0, version: 1, direction: 'ltr', children: [{ type: 'text', text, format: 0, mode: 'normal', style: '', detail: 0, version: 1 }] }],
  },
})

async function createArticle(slug: string, title: string, status: 'draft' | 'published' = 'draft'): Promise<{ status: number; json: any }> {
  const token = await api.login('admin')
  const res = await fetch(`${base}/api/articles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `JWT ${token}` },
    body: JSON.stringify({
      title, slug, status, category: cfg.categoryId, content: lexical(`Synthetic body for ${title}.`),
      ...(status === 'published' ? { publishedAt: new Date().toISOString() } : {}),
    }),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function removeArticle(id: number): Promise<void> {
  const token = await api.login('admin')
  await fetch(`${base}/api/articles/${id}`, { method: 'DELETE', headers: { authorization: `JWT ${token}` } })
}

test.describe('reserved root slugs (D1: /{slug}/)', () => {
  test.skip(cfg.articlePathTemplate !== '/{slug}/', 'reserved root slugs only apply under the root template /{slug}/')

  for (const reserved of ['contact', 'search']) {
    test(`an article with the slug "${reserved}" cannot be created`, async () => {
      const r = await createArticle(reserved, uniq(`E2E reserved ${reserved}`))
      if (r.status < 400 && r.json?.doc?.id) await removeArticle(r.json.doc.id)
      expect(r.status, 'a reserved slug is refused').toBe(400)
      expect(JSON.stringify(r.json)).toMatch(/reserved/i)
      const lookup = await api.get('admin', `/api/articles?where[slug][equals]=${reserved}&depth=0&limit=2`)
      expect(lookup.json?.totalDocs ?? 0, 'nothing was stored under the reserved slug').toBe(0)
    })
  }

  test('an ordinary slug is accepted', async () => {
    const slug = `e2e-path-${Date.now().toString(36)}`
    const r = await createArticle(slug, uniq('E2E ordinary slug'))
    try {
      expect(r.status).toBe(201)
      expect(r.json?.doc?.slug).toBe(slug)
    } finally {
      if (r.json?.doc?.id) await removeArticle(r.json.doc.id)
    }
  })
})

test.describe('public article URL template', () => {
  test('a published article is served by the public host at the configured template', async ({ page }) => {
    const slug = `e2e-path-${Date.now().toString(36)}`
    const title = uniq('E2E template article')
    const r = await createArticle(slug, title, 'published')
    expect(r.status).toBe(201)
    try {
      const res = await page.goto(`${cfg.publicOrigin}${articlePath(cfg, slug)}`)
      expect(res?.status()).toBe(200)
      expect(await page.content()).toContain(title)
    } finally {
      await removeArticle(r.json.doc.id)
    }
  })
})
