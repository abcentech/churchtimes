import { expect, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test'

import type { Role, XappConfig } from './helpers'

/** A newsroom build failure must fail every newsroom journey with the build error, never silently skip. */
export function requireNewsroom(cfg: XappConfig): void {
  if (cfg.newsroomBuildError) throw new Error(`The newsroom SPA did not build, so no newsroom journey can run:\n${cfg.newsroomBuildError}`)
}

/** Context options that must be repeated for extra contexts (browser.newContext() does not inherit the project's `use`). */
export function freshContext(browser: Browser, info: TestInfo): Promise<BrowserContext> {
  const u = info.project.use as Record<string, unknown>
  const pick = ['viewport', 'userAgent', 'deviceScaleFactor', 'isMobile', 'hasTouch', 'screen'] as const
  const opts: Record<string, unknown> = {}
  for (const k of pick) if (u[k] !== undefined) opts[k] = u[k]
  return browser.newContext(opts)
}

export async function openNewsroom(page: Page, cfg: XappConfig, hash = ''): Promise<void> {
  await page.goto(`${cfg.newsroomOrigin}/${hash}`)
  await expect(page.locator('body')).toHaveAttribute('data-auth', /^(in|out)$/)
}

/** Real staff sign-in through the newsroom login form. */
export async function loginUi(page: Page, cfg: XappConfig, role: Role): Promise<void> {
  const c = cfg.credentials[role]
  await openNewsroom(page, cfg)
  await expect(page.getByTestId('login-view')).toBeVisible()
  await page.getByTestId('login-email').fill(c.email)
  await page.getByTestId('login-password').fill(c.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('session-user-role')).toHaveAttribute('data-role', role)
}

export async function logoutUi(page: Page): Promise<void> {
  await page.getByTestId('logout').click()
  await expect(page.getByTestId('login-view')).toBeVisible()
  await expect(page.locator('body')).toHaveAttribute('data-auth', 'out')
}

/** Navigate with the visible nav (desktop top bar or mobile bottom bar). */
export async function gotoView(page: Page, view: "dashboard" | "editor" | "review" | "live" | "media", note?: (t: string) => void): Promise<void> {
  await press(page, page.locator(`a[data-view-nav="${view}"]:visible`).first(), note)
  await expect(page).toHaveURL(new RegExp(`#${view}`))
}

/** The environment banner must say LIVE CMS and the legacy mock store must not exist. */
export async function expectLiveMode(page: Page): Promise<void> {
  await expect(page.locator('#mode-banner-badge')).toHaveText(/LIVE CMS/i)
  const mockStore = await page.evaluate(() => localStorage.getItem('ctn_newsroom_store_v1'))
  expect(mockStore, 'the mock localStorage store must not be used by the live newsroom').toBeNull()
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * Click, falling back to keyboard activation (focus + Enter) when a pointer click is physically blocked, e.g. by the
 * mobile horizontal-overflow defect recorded in the evidence log. A blocked click is NOT hidden: it is written to the log.
 */
export async function press(page: Page, locator: Locator, note?: (t: string) => void): Promise<void> {
  try {
    await locator.click({ timeout: 6_000 })
  } catch {
    await locator.focus()
    await page.keyboard.press('Enter')
    note?.(`pointer click was blocked on ${locator.toString()}; activated with keyboard (focus + Enter)`)
  }
}
