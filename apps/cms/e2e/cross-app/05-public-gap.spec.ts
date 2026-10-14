/**
 * KNOWN GAP in the public site (not patched here, owned by the public-site lane). `test.fail()` keeps this suite
 * green while the gap exists and turns it red ("expected to fail but passed") once the public site is fixed, which is
 * the cue to delete this file and drop the VITE_PUBLIC_SUBMISSIONS_URL workaround from support/stack.ts.
 */
import { expect, test } from '@playwright/test'

import { Evidence, getConfig } from './support/helpers'

const cfg = getConfig()

test('KNOWN GAP (public site): built as docs/staging.md section 9 says, the story form is disabled for an http://cms.churchtimes.localhost CMS', async ({ page }, info) => {
  test.fail(true, 'src/lib/public-submissions.js submissionEndpoint() only accepts http:// for the host names localhost / 127.0.0.1 / [::1]')
  const ev = new Evidence(cfg, info, 'GAP-public-form-http-localhost-subdomain')
  await page.goto(`${cfg.publicGapOrigin}/#submit`)
  await expect(page.locator('#public-form')).toBeVisible()
  const notice = ((await page.locator('.form-notice').innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  const disabled = await page.locator('#send-submission').isDisabled()
  const widget = await page.locator('#turnstile-widget iframe').count()
  const status = (await page.locator('#challenge-status').innerText()).replace(/\s+/g, ' ')
  ev.note(`GAP observed: notice="${notice}" submitDisabled=${disabled} turnstileIframes=${widget} challengeStatus="${status}"`)
  await ev.shot(page, 'GAP: form notice says online sending is not available', { final: true })
  // What a correctly configured staging build must do:
  await expect(page.locator('#send-submission')).toBeEnabled()
})
