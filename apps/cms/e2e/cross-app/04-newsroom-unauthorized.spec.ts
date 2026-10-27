/**
 * Scenario C, REAL UI: unauthenticated / revoked / forbidden paths in the newsroom SPA show the sign-in screen or a real
 * server error, never fake success. (Public-site failures are in 01-public-tip.spec.ts.)
 */
import { expect, test } from '@playwright/test'

import { lexicalBody } from '../browser/support/env'
import { Api, Evidence, getConfig, trackCmsCalls, uniq } from './support/helpers'
import { gotoView, loginUi, logoutUi, press, requireNewsroom } from './support/newsroom'

const cfg = getConfig()
const api = new Api(cfg)
const base = new URL(cfg.recorderUrl).origin

async function adminJson(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `JWT ${await api.login('admin')}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    // empty body
  }
  return { status: res.status, json }
}

test.describe('C. unauthorized and failed actions in the newsroom (REAL UI)', () => {
  test.beforeAll(() => requireNewsroom(cfg))

  test('logged-out newsroom shows only the sign-in form on every route and loads no protected data', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'C-newsroom-logged-out')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    for (const hash of ['#dashboard', '#editor', '#editor?id=1', '#review', '#media', '#live']) {
      await page.goto(`${cfg.newsroomOrigin}/${hash}`)
      await page.reload()
      await expect(page.getByTestId('login-view'), `route ${hash}`).toBeVisible()
      await expect(page.locator('body')).toHaveAttribute('data-auth', 'out')
      await expect(page.getByTestId('session-user')).toHaveCount(0)
      for (const t of ['story-list', 'review-card', 'tip-card', 'editor-title', 'media-grid']) await expect(page.getByTestId(t), `${t} on ${hash}`).toHaveCount(0)
    }
    // no protected collection was read successfully
    const protectedOk = net.calls.filter((c) => /^\/api\/(articles|submissions|media|live-)/.test(c.path) && c.status < 400)
    expect(protectedOk, `protected reads while logged out: ${JSON.stringify(protectedOk)}`).toHaveLength(0)
    // navigation chrome must not be usable while logged out
    for (const t of ['nav-review', 'nav-editor', 'nav-media', 'nav-new-story']) await expect(page.getByTestId(t), `${t} visible while logged out`).toBeHidden()
    ev.note(`logged-out CMS traffic: ${net.summary()}`)
    await ev.shot(page, 'logged out: sign-in form only', { final: true })
  })

  test('wrong password shows the server error and no session', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'C-newsroom-bad-login')
    await page.goto(`${cfg.newsroomOrigin}/`)
    await page.getByTestId('login-email').fill(cfg.credentials.reporter.email)
    await page.getByTestId('login-password').fill('definitely-not-the-password-1!')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-error')).toBeVisible()
    await expect(page.getByTestId('login-error')).toContainText(/incorrect|invalid|failed/i)
    await expect(page.getByTestId('session-user')).toHaveCount(0)
    await expect(page.locator('body')).toHaveAttribute('data-auth', 'out')
    await ev.shot(page, 'wrong password: error from the CMS, still signed out', { final: true })
  })

  test('revoked session (admin force-logout): navigating to a protected view returns to the sign-in screen', async ({ page }, info) => {
    // Payload degrades a revoked token to an ANONYMOUS request (reads answer 200 with public/empty data), so the SPA re-checks
    // GET /api/users/me on every navigation (CmsAdapter.verifySession) instead of relying on 401/403.
    const ev = new Evidence(cfg, info, 'C-newsroom-revoked-session')
    const note = (t: string) => ev.note(t)
    await loginUi(page, cfg, 'reporter')
    await gotoView(page, 'dashboard', note)
    await expect(page.getByTestId('session-user')).toBeVisible()
    await ev.shot(page, 'reporter signed in')

    const revoke = await adminJson('POST', `/api/users/${cfg.credentials.reporter.id}/revoke-sessions`)
    expect(revoke.status).toBe(200)
    // next protected action in the UI. Not gotoView(): its #review URL check races the session check's redirect to sign-in.
    await press(page, page.locator('a[data-view-nav="review"]:visible').first(), note)
    await expect(page.getByTestId('login-view')).toBeVisible()
    const stillSignedIn = await page.getByTestId('session-user').count()
    ev.note(`after revoke + navigation to Review: signed-in chrome still shown=${stillSignedIn > 0}; review tabs rendered=${await page.getByTestId('review-tab-articles_review').count()}`)
    await expect(page.getByTestId('login-view')).toBeVisible()
    await expect(page.getByTestId('login-notice')).toContainText(/session has ended|sign in again/i)
    await expect(page.locator('body')).toHaveAttribute('data-auth', 'out')
    const me = await page.evaluate(async (cms) => (await (await fetch(`${cms}/api/users/me`, { credentials: 'include' })).json()).user, cfg.cmsUrl)
    expect(me, 'server agrees: the session is gone').toBeNull()
    await ev.shot(page, 'revoked session: back at sign-in with an explanation', { final: true })
  })

  test('revoked session on a write: Save Draft after force-logout does not report success and the story is not created', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'C-newsroom-revoked-write')
    const note = (t: string) => ev.note(t)
    const title = `Revoked write ${uniq('x').replace(/s+/g, '-')}`
    await loginUi(page, cfg, 'reporter')
    await page.goto(`${cfg.newsroomOrigin}/#editor`)
    await page.getByTestId('editor-title').fill(title)
    await page.getByTestId('editor-body').fill('Synthetic body typed before the session was revoked by an admin.')
    expect((await adminJson('POST', `/api/users/${cfg.credentials.reporter.id}/revoke-sessions`)).status).toBe(200)
    await press(page, page.getByTestId('editor-save-draft'), note)
    // the UI must show either the error banner or the sign-in screen; never a success toast
    await expect(page.getByTestId('editor-error').or(page.getByTestId('login-view'))).toBeVisible()
    await expect(page.locator('.toast', { hasText: /saved successfully/i })).toHaveCount(0)
    const found = await adminJson('GET', `/api/articles?where[title][equals]=${encodeURIComponent(title)}&limit=2&depth=0`)
    expect(found.json.docs, 'no article was created by the revoked session').toHaveLength(0)
    ev.note(`revoked write: login view=${await page.getByTestId('login-view').count()} editor-error=${await page.getByTestId('editor-error').count()}`)
    await ev.shot(page, 'revoked session write: refused, nothing created', { final: true })
  })

  test('logout ends the server session: /api/users/me is anonymous and protected reads are refused', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'C-newsroom-logout')
    await loginUi(page, cfg, 'reporter')
    await logoutUi(page)
    const r = await page.evaluate(async (cms) => {
      const me = await (await fetch(`${cms}/api/users/me`, { credentials: 'include' })).json()
      const subs = await fetch(`${cms}/api/submissions?limit=1`, { credentials: 'include' })
      return { user: me.user, subs: subs.status }
    }, cfg.cmsUrl)
    expect(r.user).toBeNull()
    expect([401, 403]).toContain(r.subs)
    ev.note(`after logout: /me user=null, GET /api/submissions -> ${r.subs}`)
    await ev.shot(page, 'after logout', { final: true })
  })

  test('stale editor: a save the CMS forbids (story moved to review meanwhile) shows an error, not a success toast, and changes nothing', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'C-newsroom-forbidden-save')
    const note = (t: string) => ev.note(t)
    const title = `Stale draft ${uniq('x').replace(/\s+/g, '-')}`
    const created = await adminJson('POST', '/api/articles', {
      title,
      content: lexicalBody('Synthetic stale draft body.'),
      category: cfg.categoryId,
      status: 'draft',
      author: cfg.credentials.reporter.id,
    })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    const id = created.json.doc.id

    await loginUi(page, cfg, 'reporter')
    await page.goto(`${cfg.newsroomOrigin}/#editor?id=${id}`)
    await expect(page.getByTestId('editor-title')).toHaveValue(title)
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'draft')
    // an editor moves it to review while the reporter still has the draft open
    const moved = await adminJson('PATCH', `/api/articles/${id}`, { status: 'in_review' })
    expect(moved.status).toBe(200)

    await page.getByTestId('editor-title').fill(`${title} EDITED`)
    await press(page, page.getByTestId('editor-save-draft'), note)
    await expect(page.getByTestId('editor-error')).toBeVisible()
    const msg = (await page.getByTestId('editor-error').innerText()).trim()
    expect(msg.length).toBeGreaterThan(0)
    await expect(page.locator('.toast', { hasText: /saved successfully/i })).toHaveCount(0)
    const after = await adminJson('GET', `/api/articles/${id}?depth=0`)
    expect(after.json.title, 'the forbidden edit changed nothing').toBe(title)
    ev.note(`forbidden save shown as error: "${msg}"; server title unchanged, status=${after.json.status}`)
    await ev.shot(page, 'forbidden save: error banner, no success toast', { final: true })
  })

  test('failed image upload (not a real PNG) shows the CMS error and selects no featured image', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'C-newsroom-bad-upload')
    const note = (t: string) => ev.note(t)
    const before = await api.mediaCount(`${cfg.runId}-bad`)
    await loginUi(page, cfg, 'reporter')
    await page.goto(`${cfg.newsroomOrigin}/#editor`)
    await press(page, page.getByTestId('editor-choose-image'), note)
    await press(page, page.getByTestId('media-picker-upload-toggle'), note)
    await page.getByTestId('media-upload-input').setInputFiles({ name: `${cfg.runId}-bad.png`, mimeType: 'image/png', buffer: Buffer.from('this is plain text, not an image') })
    await page.getByTestId('media-upload-alt').fill('not an image')
    await press(page, page.getByTestId('media-upload-submit'), note)
    await expect(page.getByTestId('media-upload-error')).toBeVisible()
    await expect(page.getByTestId('media-upload-error')).not.toBeEmpty()
    await expect(page.getByTestId('editor-featured-image-img')).toHaveCount(0)
    expect(await api.mediaCount(`${cfg.runId}-bad`)).toBe(before)
    ev.note(`bad upload error shown: "${(await page.getByTestId('media-upload-error').innerText()).trim()}"; no media row created`)
    await ev.shot(page, 'bad upload: CMS rejection shown, nothing selected', { final: true })
  })
})
