/**
 * Scenario B (newsroom half), REAL UI: the tip a reader submitted on the public site (01-public-tip.spec.ts) shows up in the
 * newsroom review queue; an editor converts it into a DRAFT; it never appears on the public site. A reporter cannot read tips.
 */
import fs from 'node:fs'

import { expect, test } from '@playwright/test'

import { Api, Evidence, getConfig, trackCmsCalls } from './support/helpers'
import { gotoView, loginUi, logoutUi, press, requireNewsroom, slugify } from './support/newsroom'
import { expectNotOnPublicSite } from './support/public'
import { serverLog } from './support/recorder-log'
import { tipFile } from './support/tip'

const cfg = getConfig()
const api = new Api(cfg)

function readTip(project: string): { reference: string; title: string; name: string; email: string } {
  const file = tipFile(cfg, project)
  if (!fs.existsSync(file)) throw new Error('The reader-tip test in 01-public-tip.spec.ts did not complete for this project, so there is no tip to review.')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test.describe('B. reader tip -> newsroom review queue -> convert to draft (REAL UI)', () => {
  test.beforeAll(() => requireNewsroom(cfg))

  test('editor sees the reader tip with its server reference in the review queue and converts it to a draft that stays unpublished', async ({ page }, info) => {
    const tip = readTip(info.project.name)
    const ev = new Evidence(cfg, info, 'B-newsroom-tip-review')
    const note = (t: string) => ev.note(t)
    const net = trackCmsCalls(page, cfg.cmsUrl)

    await loginUi(page, cfg, 'section-editor')
    await gotoView(page, 'review', note)
    await press(page, page.getByTestId('review-tab-submissions'), note)
    const card = page.getByTestId('tip-card').filter({ hasText: tip.reference })
    await expect(card).toBeVisible()
    await expect(card).toContainText(tip.title)
    await expect(card).toContainText(tip.name)
    await expect(card).toHaveAttribute('data-status', 'new')
    await ev.shot(page, `review queue lists reader tip ${tip.reference} (status NEW)`)

    await press(page, card.getByTestId('tip-convert'), note)
    await expect(page.getByTestId('tip-convert-form')).toBeVisible()
    await page.getByTestId('tip-convert-category').selectOption({ label: cfg.categoryTitle })
    await press(page, page.getByTestId('tip-convert-confirm'), note)
    await expect(page).toHaveURL(/#editor\?id=\d+/)
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'draft')
    await expect(page.getByTestId('editor-title')).toHaveValue(tip.title)
    const articleId = Number(/id=(\d+)/.exec(page.url())![1])
    expect(net.find('POST', '/api/submissions/', 201), `calls: ${net.summary()}`).toBeTruthy()
    await ev.shot(page, 'tip converted: editor opens the new DRAFT story', { final: true })

    const sub = await api.submissionByReference(tip.reference)
    expect(sub.status).toBe('converted')
    const articleRef = typeof sub.article === 'object' ? sub.article?.id : sub.article
    expect(articleRef).toBe(articleId)
    const art = await api.get('admin', `/api/articles/${articleId}?depth=0`)
    expect(art.json.status).toBe('draft')
    expect(art.json.publishedAt ?? null).toBeNull()
    ev.note(`submission ${tip.reference} -> converted, article ${articleId} status=${art.json.status}, bylineName=${JSON.stringify(art.json.bylineName ?? null)}`)

    // never public
    const anon = await api.get(null, `/api/articles/${articleId}`)
    expect(anon.status).toBe(404)
    const pub = await api.get(null, `/api/articles?where[title][equals]=${encodeURIComponent(tip.title)}`)
    expect(pub.json.docs).toHaveLength(0)
    // The staff session is live in this page. Whatever the public site sends to the CMS from here on must carry no cookie.
    const logStart = (await serverLog(cfg)).length
    await expectNotOnPublicSite(page, cfg, slugify(tip.title), tip.title)
    const fromPublic = (await serverLog(cfg)).slice(logStart).filter((r) => r.origin === cfg.publicOrigin)
    const withCookie = fromPublic.filter((r) => r.cookieNames.length > 0)
    expect(fromPublic.length, 'public site reached the CMS from the signed-in page').toBeGreaterThan(0)
    ev.note(`public site -> CMS while staff signed in: ${fromPublic.length} requests, ${withCookie.length} with a cookie${withCookie.length ? ` (${withCookie.map((r) => `${r.method} ${r.path} sec-fetch-site=${r.secFetchSite}`).join('; ')})` : ''}`)
    if (info.project.name.startsWith('webkit')) {
      // ENGINE LIMITATION, not a product bug: Playwright's Windows WebKit attaches the cookie jar to cross-origin fetch even with credentials 'omit'
      // (independent probe with a bare page and server: omit, same-origin and include all carried the cookie; Chromium and Firefox send it only for include).
      // The public site's JSON fetches (src/lib/published-articles.js, credentials: 'omit') are exactly the offenders recorded here, so only
      // these read-only API paths are tolerated on WebKit: anything else (media, writes, auth) carrying the cookie still fails.
      info.annotations.push({ type: 'webkit-windows-omit-cookie', description: `${withCookie.length} omit-fetch(es) carried the cookie: ${withCookie.map((r) => r.path.split('?')[0]).join(', ')}` })
      const unexpected = withCookie.filter((r) => !(r.method === 'GET' && /^\/api\/(articles|categories)(\?|$)/.test(r.path)))
      expect(unexpected, 'only the public site omit-fetches (read-only articles/categories) may carry the cookie on Windows WebKit').toEqual([])
    } else {
      expect(withCookie, 'public site requests carry no staff cookie even while a staff session exists').toEqual([])
    }
    await ev.shot(page, 'public site: converted tip is not published (article unavailable)')
  })

  test('reporter cannot read reader tips: UI says editors only, direct fetch is refused', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'B-reporter-tips-forbidden')
    const note = (t: string) => ev.note(t)
    await loginUi(page, cfg, 'reporter')
    await gotoView(page, 'review', note)
    await press(page, page.getByTestId('review-tab-submissions'), note)
    await expect(page.getByTestId('tips-not-permitted')).toBeVisible()
    await expect(page.getByTestId('tip-card')).toHaveCount(0)
    const status = await page.evaluate(async (cms) => (await fetch(`${cms}/api/submissions?limit=5`, { credentials: 'include' })).status, cfg.cmsUrl)
    expect([401, 403], `reporter GET /api/submissions -> ${status}`).toContain(status)
    ev.note(`reporter direct GET /api/submissions -> ${status}`)
    await ev.shot(page, 'reporter: tips tab says only editors can review tips', { final: true })
    await logoutUi(page)
  })
})
