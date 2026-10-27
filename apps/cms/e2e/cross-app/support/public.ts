import { expect, type Page } from '@playwright/test'

import { articlePath, articlePathRegExp } from './articlePath'
import type { XappConfig } from './helpers'

export type PublicExpectation = { title: string; standfirst: string; bodyText: string; imageAlt?: string; slug: string; leaked?: string[] }

/** What an anonymous reader sees on the real public site: Latest list card + article page (image rendered, no draft leakage). */
export async function expectPublishedOnPublicSite(page: Page, cfg: XappConfig, e: PublicExpectation): Promise<{ cardImage: boolean }> {
  // Diagnostics for a missing article image: every media file request that fails or answers >= 400.
  const mediaProblems: string[] = []
  page.on('requestfailed', (r) => { if (r.url().includes('/api/media/file/')) mediaProblems.push(`FAILED ${r.url()} ${r.failure()?.errorText}`) })
  page.on('response', (r) => { if (r.url().includes('/api/media/file/') && r.status() >= 400) mediaProblems.push(`${r.status()} ${r.url()}`) })
  await page.goto(`${cfg.publicOrigin}/#latest`)
  const card = page.locator(`#cms-latest .newsroom-card[data-story-slug="${e.slug}"]`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.locator('h2 a')).toHaveText(e.title)
  await expect(card).toContainText(e.standfirst)
  let cardImage = false
  if (e.imageAlt) {
    const img = card.locator('img.cms-image')
    await img.scrollIntoViewIfNeeded()
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth), { message: 'card image loads', timeout: 20_000 }).toBeGreaterThan(0)
    cardImage = true
  }

  await card.locator('h2 a').click()
  await expect(page).toHaveURL(articlePathRegExp(cfg, e.slug))
  // cold reload: the public host answers the clean URL itself (200, server-rendered title) before the SPA takes over
  const cold = await page.reload()
  expect(cold?.status(), 'clean article URL is served by the public host').toBe(200)
  const coldHtml = (await cold?.text()) ?? ''
  expect(coldHtml, 'initial HTML is server-rendered').toContain(`<h1>${e.title}</h1>`)
  const article = page.locator('#cms-report')
  await expect(article.locator('h1')).toHaveText(e.title)
  await expect(article.locator('.article-deck')).toHaveText(e.standfirst)
  await expect(article.locator('.newsroom-article-body')).toContainText(e.bodyText)
  if (e.imageAlt) {
    const img = article.locator('figure.cms-figure img.cms-image')
    try {
      await img.first().waitFor({ state: 'attached', timeout: 20_000 })
    } catch {
      const anon = await fetch(`${new URL(cfg.cmsUrl).origin}/api/articles?where[slug][equals]=${e.slug}&depth=1`).then((r) => r.json()).catch((err) => ({ error: String(err) }))
      throw new Error(
        `article hero image missing on the public page. server-rendered figure in the cold HTML: ${/<figure class="cms-figure/.test(coldHtml)}; ` +
          `media file problems seen by the browser: ${JSON.stringify(mediaProblems)}; ` +
          `anonymous API featuredImage: ${JSON.stringify(anon?.docs?.[0]?.featuredImage ?? anon)}`,
      )
    }
    await expect(img).toHaveAttribute('alt', e.imageAlt)
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth), { message: 'article hero image loads', timeout: 20_000 }).toBeGreaterThan(0)
    const src = await img.getAttribute('src')
    expect(src, 'image is served by the CMS media route').toContain(`${new URL(cfg.cmsUrl).origin}/api/media/file/`)
  }
  // no draft / staff-only content leaks into the page
  const html = await page.content()
  for (const bad of ['E2E Secret Draft Zed', 'reviewNotes', 'scheduledFor', ...(e.leaked ?? [])]) expect(html, `public page must not contain "${bad}"`).not.toContain(bad)
  return { cardImage }
}

/** The article must not be reachable on the public site by list nor by detail route. */
export async function expectNotOnPublicSite(page: Page, cfg: XappConfig, slug: string, title: string): Promise<void> {
  await page.goto(`${cfg.publicOrigin}/#latest`)
  await expect(page.locator('#cms-latest .newsroom-card').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(`#cms-latest .newsroom-card[data-story-slug="${slug}"]`)).toHaveCount(0)
  await expect(page.locator('#cms-latest')).not.toContainText(title)
  const direct = await page.goto(`${cfg.publicOrigin}${articlePath(cfg, slug)}`)
  expect(direct?.status(), 'unpublished article URL is a real 404').toBe(404)
  await expect(page.locator('body')).toContainText('Article unavailable', { timeout: 30_000 })
  expect(await page.content()).not.toContain(title)
  // legacy #report/<slug> links normalise to the clean path and stay unavailable
  await page.goto(`${cfg.publicOrigin}/#report/${slug}`)
  await expect(page).toHaveURL(articlePathRegExp(cfg, slug))
  await expect(page.locator('body')).toContainText('Article unavailable', { timeout: 30_000 })
}
