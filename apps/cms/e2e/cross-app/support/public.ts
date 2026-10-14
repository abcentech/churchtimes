import { expect, type Page } from '@playwright/test'

import type { XappConfig } from './helpers'

export type PublicExpectation = { title: string; standfirst: string; bodyText: string; imageAlt?: string; slug: string; leaked?: string[] }

/** What an anonymous reader sees on the real public site: Latest list card + article page (image rendered, no draft leakage). */
export async function expectPublishedOnPublicSite(page: Page, cfg: XappConfig, e: PublicExpectation): Promise<{ cardImage: boolean }> {
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
  await expect(page).toHaveURL(new RegExp(`#report/${e.slug}$`))
  const article = page.locator('#cms-report')
  await expect(article.locator('h1')).toHaveText(e.title)
  await expect(article.locator('.article-deck')).toHaveText(e.standfirst)
  await expect(article.locator('.newsroom-article-body')).toContainText(e.bodyText)
  if (e.imageAlt) {
    const img = article.locator('figure.cms-figure img.cms-image')
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
  await page.goto(`${cfg.publicOrigin}/#report/${slug}`)
  await page.reload()
  await expect(page.locator('#cms-report')).toContainText('Article unavailable', { timeout: 30_000 })
}
