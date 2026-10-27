/** Public-site regression for issue #15: the documented CMS origin needs no endpoint override. */
import { expect, test } from '@playwright/test'

import { Evidence, getConfig } from './support/helpers'

const cfg = getConfig()

test('public staging configuration enables the story form for the reserved localhost CMS origin', async ({ page }, info) => {
  const ev = new Evidence(cfg, info, 'public-form-http-localhost-subdomain')
  await page.goto(`${cfg.publicGapOrigin}/#submit`)
  await expect(page.locator('#public-form')).toBeVisible()
  const notice = ((await page.locator('.form-notice').innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  const disabled = await page.locator('#send-submission').isDisabled()
  const widget = await page.locator('#turnstile-widget iframe').count()
  const status = (await page.locator('#challenge-status').innerText()).replace(/\s+/g, ' ')
  ev.note(`Public configuration: notice="${notice}" submitDisabled=${disabled} turnstileIframes=${widget} challengeStatus="${status}"`)
  await ev.shot(page, 'Public form with the documented CMS origin', { final: true })
  // What a correctly configured staging build must do:
  await expect(page.locator('#send-submission')).toBeEnabled()
})
