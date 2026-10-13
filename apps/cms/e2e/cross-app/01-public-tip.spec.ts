/**
 * Scenario B (reader half) and scenario C (public failures), REAL UI: the compiled public site in Chromium,
 * the real Cloudflare Turnstile widget (always-pass TEST site key), the real CMS and PostgreSQL.
 * Nothing is mocked. The one in-flight request edit in the "missing Turnstile token" test is labelled in its title.
 */
import fs from 'node:fs'

import { expect, test } from '@playwright/test'

import { Api, Evidence, getConfig, trackCmsCalls } from './support/helpers'
import { fillTip, newTip, openForm, tipFile } from './support/tip'

const cfg = getConfig()
const api = new Api(cfg)

test.describe('B. reader tip on the public site (REAL UI)', () => {
  test('reader submits a tip with the real Turnstile widget and sees the genuine server receipt', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'B-public-tip')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    const tip = newTip('tip')

    await openForm(page, cfg)
    await ev.shot(page, 'public submit form with real Turnstile widget verified')
    await fillTip(page, tip)
    await page.locator('#send-submission').click()

    const result = page.locator('#form-result')
    await expect(result).toBeVisible()
    await expect(result.getByRole('heading')).toHaveText('Your story is awaiting review.')
    const text = (await result.innerText()).replace(/\s+/g, ' ')
    const reference = /Reference:\s*(SUB-[A-Z0-9]{8})/.exec(text)?.[1]
    expect(reference, `receipt text was: ${text}`).toBeTruthy()
    await ev.shot(page, `receipt shows server reference ${reference}`, { final: true })

    // The UI really called the CMS (no mock) ...
    const post = net.find('POST', '/api/public/submissions', 201)
    expect(post, `calls: ${net.summary()}`).toBeTruthy()
    // ... and the reference on screen is the one stored by the server, as a NEW, unpublished submission.
    const stored = await api.submissionByReference(reference!)
    expect(stored, 'submission with the on-screen reference exists in PostgreSQL').toBeTruthy()
    expect(stored.status).toBe('new')
    expect(stored.title).toBe(tip.title)
    expect(stored.email).toBe(tip.email)
    expect(stored.article ?? null).toBeNull()
    ev.note(`reference ${reference} stored by CMS with status=new; UI calls: ${net.summary()}`)

    // Never public: anonymous API cannot read it, and the public feed does not list it.
    expect((await api.get(null, `/api/submissions?where[reference][equals]=${reference}`)).status).toBeGreaterThanOrEqual(401)
    const pub = await api.get(null, `/api/articles?where[title][contains]=${encodeURIComponent(tip.title)}&limit=5`)
    expect(pub.json?.docs?.length ?? 0).toBe(0)
    await page.goto(`${cfg.publicOrigin}/#latest`)
    await expect(page.locator('#cms-latest .newsroom-card').first()).toBeVisible()
    await expect(page.locator('body')).not.toContainText(tip.title)
    await ev.shot(page, 'public Latest list does not show the tip')

    fs.writeFileSync(tipFile(cfg, info.project.name), JSON.stringify({ reference, title: tip.title, email: tip.email, name: tip.name }))
  })
})

test.describe('C. public failures show real errors, never a fake receipt (REAL UI)', () => {
  test('duplicate submission: the CMS answers 409 and the form shows the duplicate error without a receipt', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'C-public-duplicate')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    const tip = newTip('dup')

    await openForm(page, cfg)
    await fillTip(page, tip)
    await page.locator('#send-submission').click()
    await expect(page.locator('#form-result')).toBeVisible()
    const first = /Reference:\s*(SUB-[A-Z0-9]{8})/.exec((await page.locator('#form-result').innerText()).replace(/\s+/g, ' '))?.[1]
    expect(first).toBeTruthy()

    // same details again (reload gives a fresh form and a fresh Turnstile token)
    await page.reload()
    await openForm(page, cfg)
    await fillTip(page, tip)
    await page.locator('#send-submission').click()

    const summary = page.locator('#form-errors')
    await expect(summary).toBeVisible()
    await expect(summary).toContainText('already received a matching submission')
    await expect(page.locator('#form-result')).toBeHidden()
    await expect(page.locator('body')).not.toContainText(/Reference:\s*SUB-/)
    expect(net.find('POST', '/api/public/submissions', 409), `calls: ${net.summary()}`).toBeTruthy()
    // form stays usable and the typed text is kept
    await expect(page.locator('#public-title')).toHaveValue(tip.title)
    await ev.shot(page, 'duplicate: real 409 shown as an error, no receipt', { final: true })

    // exactly one submission stored
    const list = await api.get('admin', `/api/submissions?where[title][equals]=${encodeURIComponent(tip.title)}&limit=5&depth=0`)
    expect(list.json.totalDocs).toBe(1)
  })

  test('HARNESS tamper: server rejects a request whose Turnstile token was blanked in flight; UI shows the error, no receipt', async ({ page }, info) => {
    // The page, widget, CMS and its answer are real; only the outgoing request body is edited (the real widget cannot be made to fail
    // with the always-pass test key). This is a transport tamper, not a mocked response.
    const ev = new Evidence(cfg, info, 'C-public-turnstile-HARNESS')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    const tip = newTip('noturn')
    await page.route('**/api/public/submissions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const body = JSON.parse(route.request().postData() ?? '{}')
      body.turnstileToken = ''
      await route.continue({ postData: JSON.stringify(body) })
    })

    await openForm(page, cfg)
    await fillTip(page, tip)
    await page.locator('#send-submission').click()

    await expect(page.locator('#form-errors')).toContainText('Verification was not accepted')
    await expect(page.locator('#form-result')).toBeHidden()
    await expect(page.locator('body')).not.toContainText(/Reference:\s*SUB-/)
    expect(net.find('POST', '/api/public/submissions', 400), `calls: ${net.summary()}`).toBeTruthy()
    await ev.shot(page, 'blank Turnstile token: CMS 400 shown as verification error', { final: true })
    const list = await api.get('admin', `/api/submissions?where[title][equals]=${encodeURIComponent(tip.title)}&limit=5&depth=0`)
    expect(list.json.totalDocs).toBe(0)
  })

  test('form validation blocks an incomplete submission client-side and sends nothing to the CMS', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'C-public-validation')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    await openForm(page, cfg)
    await page.locator('#public-name').fill('A')
    await page.locator('#send-submission').click()
    await expect(page.locator('#form-errors')).toBeVisible()
    await expect(page.locator('#error-email')).toBeVisible()
    expect(net.filter('POST', '/api/public/submissions')).toHaveLength(0)
    await expect(page.locator('#form-result')).toBeHidden()
    await ev.shot(page, 'incomplete form: field errors, nothing sent', { final: true })
  })
})
