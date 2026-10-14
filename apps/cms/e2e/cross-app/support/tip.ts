import path from 'node:path'

import { expect, type Page } from '@playwright/test'

import { uniq, waitForTurnstile, type XappConfig } from './helpers'

export const tipFile = (cfg: XappConfig, project: string) => path.join(cfg.fixtureDir, `tip-${project}.json`)

export type TipInput = { name: string; email: string; phone: string; title: string; location: string; category: string; message: string }

export function newTip(label: string): TipInput {
  const id = uniq(label).replace(/\s+/g, '-').toLowerCase()
  return {
    name: 'Ada Obi',
    email: `reader-${id}@example.org`,
    phone: '+234 800 000 0000',
    title: `Parish clinic reopens ${id}`,
    location: 'Ibadan',
    category: 'News',
    message: `Synthetic reader tip ${id}: the parish health clinic reopened on Monday after repairs, according to the vicar. This is test data.`,
  }
}

export async function fillTip(page: Page, tip: TipInput): Promise<void> {
  await page.locator('#public-name').fill(tip.name)
  await page.locator('#public-email').fill(tip.email)
  await page.locator('#public-phone').fill(tip.phone)
  await page.locator('#public-title').fill(tip.title)
  await page.locator('#public-location').fill(tip.location)
  await page.locator('#public-category').selectOption(tip.category)
  await page.locator('#public-message').fill(tip.message)
  await page.locator('#public-consent').check()
}

/** Opens the real public submit form and waits for the real Cloudflare widget (test key) to verify. */
export async function openForm(page: Page, cfg: XappConfig): Promise<void> {
  await page.goto(`${cfg.publicOrigin}/#submit`)
  await expect(page.locator('#public-form')).toBeVisible()
  // the real widget lives in an iframe served by challenges.cloudflare.com (inside a closed shadow root: check the frame list)
  await expect.poll(() => page.frames().some((f) => f.url().startsWith('https://challenges.cloudflare.com/')), { timeout: 45_000 }).toBe(true)
  await waitForTurnstile(page)
}
