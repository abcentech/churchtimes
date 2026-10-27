/**
 * Scenario A, REAL UI end to end: reporter signs in on the newsroom SPA, writes a draft, uploads a featured image
 * through the media picker, submits for review; reporter is blocked from approve/publish (UI hides it AND the CMS answers
 * 403 to a direct fetch from the newsroom origin); the section editor approves and publishes in the newsroom; an anonymous
 * browser on the public site sees the article with its image. Real Payload + PostgreSQL, no mocks.
 */
import { expect, test } from '@playwright/test'

import { Api, Evidence, getConfig, logLine, makePng, trackCmsCalls, uniq } from './support/helpers'
import { expectLiveMode, freshContext, gotoView, loginUi, logoutUi, press, requireNewsroom, slugify } from './support/newsroom'
import { expectPublishedOnPublicSite } from './support/public'
import { serverLog } from './support/recorder-log'

const cfg = getConfig()
const api = new Api(cfg)

type State = { id: number; title: string; standfirst: string; body: string; slug: string; alt: string; filenamePrefix: string }
const states = new Map<string, State>()

test.describe.configure({ mode: 'serial' })

test.describe('A. reporter -> review -> editor approve + publish -> anonymous public (REAL UI)', () => {
  test.beforeAll(() => requireNewsroom(cfg))

  test('A1 reporter: login, draft with featured image upload, submit for review; approve/publish is blocked (UI hidden + direct fetch 403)', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'A1-reporter-draft-submit')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    const id = uniq('xapp').replace(/\s+/g, '-')
    const title = `Cathedral choir tours six dioceses ${id}`
    const standfirst = `The choir visited six dioceses this month ${id}.`
    const body = `Synthetic report ${id}: the cathedral choir completed its tour on Saturday.\n\nSecond paragraph with a verified quote from the precentor ${id}.`
    const alt = `Cathedral choir on stage ${id}`
    const slug = slugify(title)
    const png = makePng(cfg.fixtureDir, `${cfg.runId}-${info.project.name}-choir.png`, 960, 540)

    // --- sign in (real login form)
    await page.goto(`${cfg.newsroomOrigin}/`)
    await expect(page.getByTestId('login-view')).toBeVisible()
    await ev.shot(page, 'logged out newsroom shows only the sign-in form')
    await loginUi(page, cfg, 'reporter')
    await expectLiveMode(page)
    await expect(page.getByTestId('session-user-name')).toHaveText('E2E reporter')
    await ev.shot(page, 'reporter signed in (server-verified session, LIVE CMS banner)')

    // --- write the story
    await page.goto(`${cfg.newsroomOrigin}/#editor`)
    await expect(page.getByTestId('editor-title')).toBeVisible()
    await page.getByTestId('editor-title').fill(title)
    await page.getByTestId('editor-standfirst').fill(standfirst)
    await page.getByTestId('editor-category').selectOption({ label: cfg.categoryTitle })
    await page.getByTestId('editor-body').fill(body)

    // --- upload the featured image through the media picker (real multipart POST /api/media)
    await page.getByTestId('editor-choose-image').click()
    await expect(page.getByTestId('media-picker')).toBeVisible()
    await page.getByTestId('media-picker-upload-toggle').click()
    await page.getByTestId('media-upload-input').setInputFiles(png.file)
    await page.getByTestId('media-upload-alt').fill(alt)
    await page.getByTestId('media-upload-credit').fill('Synthetic test photographer')
    await page.getByTestId('media-upload-caption').fill('Synthetic caption')
    await page.getByTestId('media-upload-submit').click()
    const thumb = page.getByTestId('editor-featured-image-img')
    await expect(thumb).toBeVisible()
    await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth), { message: 'uploaded image displays in the editor' }).toBeGreaterThan(0)
    expect(net.find('POST', '/api/media', 201), `calls: ${net.summary()}`).toBeTruthy()
    await ev.shot(page, 'draft written, image uploaded and shown as featured photograph')

    // --- save the draft, then submit for review
    await page.getByTestId('editor-save-draft').click()
    await expect(page).toHaveURL(/#editor\?id=\d+/)
    const articleId = Number(/id=(\d+)/.exec(page.url())![1])
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'draft')
    expect(net.find('POST', '/api/articles', 201), `calls: ${net.summary()}`).toBeTruthy()
    const saved = await api.articleByTitle(title)
    expect(saved, 'draft exists in PostgreSQL').toBeTruthy()
    expect(saved.status).toBe('draft')
    expect(saved.slug).toBe(slug)
    expect(saved.excerpt).toBe(standfirst)
    expect(saved.featuredImage?.alt).toBe(alt)
    expect(saved.id).toBe(articleId)
    // draft must be invisible to the public API at this point
    expect((await api.get(null, `/api/articles?where[slug][equals]=${slug}`)).json.docs).toHaveLength(0)

    await page.getByTestId('editor-submit-review').click()
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'in_review')
    const inReview = await api.articleByTitle(title)
    expect(inReview.status).toBe('in_review')
    await ev.shot(page, 'submitted for review: server status in_review')

    // --- reporter can never approve / publish: UI does not offer it ...
    await expect(page.getByTestId('editor-publish')).toHaveCount(0)
    await expect(page.getByTestId('editor-approve')).toHaveCount(0)
    await expect(page.getByTestId('editor-archive')).toHaveCount(0)
    // ... and the CMS refuses it when asked directly from the newsroom origin with the real session cookie
    const forbidden = await page.evaluate(
      async ([cms, aid]) => {
        const out: Record<string, number> = {}
        for (const status of ['approved', 'published']) {
          const r = await fetch(`${cms}/api/articles/${aid}`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status }),
          })
          out[status] = r.status
        }
        return out
      },
      [cfg.cmsUrl, articleId] as const,
    )
    expect(forbidden, 'reporter PATCH approved/published must be 403').toEqual({ approved: 403, published: 403 })
    expect((await api.articleByTitle(title)).status).toBe('in_review')
    ev.note(`reporter direct fetch: PATCH status=approved -> ${forbidden.approved}, status=published -> ${forbidden.published}; server status still in_review`)
    await ev.shot(page, 'reporter blocked: no approve/publish buttons, direct PATCH returns 403', { final: true })

    await logoutUi(page)
    states.set(info.project.name, { id: articleId, title, standfirst, body, slug, alt, filenamePrefix: cfg.runId })
    ev.note(`calls: ${net.summary()}`)
  })

  test('A2 section editor: sees the story in the review queue, approves, publishes', async ({ page }, info) => {
    const s = states.get(info.project.name)
    if (!s) throw new Error('A1 did not complete for this project')
    const ev = new Evidence(cfg, info, 'A2-editor-approve-publish')
    const note = (t: string) => ev.note(t)
    const net = trackCmsCalls(page, cfg.cmsUrl)

    await loginUi(page, cfg, 'section-editor')
    await gotoView(page, 'review', note)
    const card = page.getByTestId('review-card').filter({ hasText: s.title })
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-status', 'in_review')
    await ev.shot(page, 'review queue lists the reporter story (In Review)')

    await press(page, card.getByTestId('review-inspect'), note)
    await expect(page.getByTestId('inspect-modal')).toBeVisible()
    await expect(page.getByTestId('inspect-body')).toContainText(s.body.split('\n')[0])
    await press(page, page.getByTestId('inspect-approve'), note)
    await expect(page.getByTestId('inspect-modal')).toBeHidden()
    expect((await api.articleByTitle(s.title)).status).toBe('approved')
    await expect(page.getByTestId('review-card').filter({ hasText: s.title })).toHaveCount(0)
    await ev.shot(page, 'approved: story left the In Review queue (server status approved)')

    await press(page, page.getByTestId('review-tab-approved'), note)
    const approved = page.getByTestId('review-card').filter({ hasText: s.title })
    await expect(approved).toBeVisible()
    await press(page, approved.getByTestId('review-inspect'), note)
    await press(page, page.getByTestId('inspect-publish'), note)
    await press(page, page.getByTestId('publish-ok'), note)
    await expect(page.getByTestId('inspect-modal')).toBeHidden()
    await expect.poll(async () => (await api.articleByTitle(s.title)).status).toBe('published')
    const published = await api.articleByTitle(s.title)
    expect(published.publishedAt, 'server stamps publishedAt').toBeTruthy()
    await ev.shot(page, 'published from the newsroom: server status published', { final: true })
    ev.note(`calls: ${net.summary()}`)
    await logoutUi(page)
  })

  test('A3 anonymous reader: article + featured image visible on the public site, no draft content, no cookie', async ({ browser }, info) => {
    const s = states.get(info.project.name)
    if (!s) throw new Error('A1/A2 did not complete for this project')
    const ctx = await freshContext(browser, info)
    const page = await ctx.newPage()
    const ev = new Evidence(cfg, info, 'A3-anonymous-public')
    // Only this test's own traffic: the proxy log is cumulative (earlier specs and projects log public-origin requests from logged-in staff contexts).
    const logStart = (await serverLog(cfg)).length
    try {
      const { cardImage } = await expectPublishedOnPublicSite(page, cfg, { title: s.title, standfirst: s.standfirst, bodyText: s.body.split('\n')[0], imageAlt: s.alt, slug: s.slug })
      expect(cardImage).toBe(true)
      await ev.shot(page, 'anonymous public article page with the uploaded featured image', { final: true })
      // Staff-only fields are absent from what the anonymous API returns
      const anon = await api.get(null, `/api/articles?where[slug][equals]=${s.slug}&depth=1`)
      const doc = anon.json.docs[0]
      expect(doc.title).toBe(s.title)
      for (const k of ['author', 'reviewNotes', 'scheduledFor']) expect(doc, `anonymous article must not expose ${k}`).not.toHaveProperty(k)
      // The seeded secret draft never shows up either
      expect(JSON.stringify((await api.get(null, '/api/articles?limit=100&depth=0')).json)).not.toContain('E2E Secret Draft Zed')
      // The public site sent no session cookie to the CMS
      const log = (await serverLog(cfg)).slice(logStart).filter((r) => r.origin === cfg.publicOrigin)
      expect(log.length).toBeGreaterThan(0)
      expect(log.every((r) => r.cookieNames.length === 0), 'public site requests carry no cookie').toBe(true)
      logLine(cfg, `[A3][${info.project.name}] ${log.length} public-origin requests reached the CMS, none with a cookie`)
    } finally {
      await ctx.close()
    }
  })
})
