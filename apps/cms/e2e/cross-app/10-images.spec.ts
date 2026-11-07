/**
 * Images, REAL UI end to end (newsroom SPA -> real Payload + PostgreSQL -> anonymous public site / API).
 *
 *   I1 reporter: writes a story, inserts TWO uploaded images between paragraphs with the "Insert image" control
 *      (upload + alt text through the media picker), saves, reopens (the body is still editable and shows both images),
 *      submits for review.
 *   I2 section editor approves + publishes; an anonymous reader sees both figures, in order, with alt text
 *      (article page, cold reload).
 *   I3 live coverage: a reporter attaches a photo to a live update, the editor approves it; the anonymous public feed
 *      API returns the photo as { url, alt, width, height, mimeType }.
 *   I4 public #live page: the update text is shown and the update's photo is rendered with its alt text (#31).
 *   I5 after publication the reporter cannot replace or re-describe a body image (direct PATCH /api/media/<id> -> 403)
 *      and the public article still shows the original pictures.
 *
 * Synthetic data only; unique titles per run.
 */
import fs from 'node:fs'

import { expect, test, type Page } from '@playwright/test'

import { articlePath } from './support/articlePath'
import { Api, Evidence, getConfig, logLine, makePng, trackCmsCalls, uniq } from './support/helpers'
import { bodyReadingOrder, expectImagesLoaded, placeCaretAfter, uploadNodeMediaId, uploadThroughPicker } from './support/images'
import { anonymousGet, LiveApi } from './support/live'
import { expectLiveMode, freshContext, gotoView, loginUi, logoutUi, press, requireNewsroom, slugify } from './support/newsroom'
import { expectPublishedOnPublicSite } from './support/public'

const cfg = getConfig()
const api = new Api(cfg)
const live = new LiveApi(cfg)

type Story = { id: number; title: string; standfirst: string; slug: string; paragraphs: string[]; alts: string[]; mediaIds: number[]; bodyValue: string; widths: number[]; srcs?: string[] }
const stories = new Map<string, Story>()
type LiveState = { eventId: number; slug: string; title: string; body: string; alt: string; mediaId: number; updateId: number }
const lives = new Map<string, LiveState>()

const need = <T>(m: Map<string, T>, project: string, what: string): T => {
  const v = m.get(project)
  if (!v) throw new Error(`${what} did not complete for this project (serial journey)`)
  return v
}

async function mediaByAlt(alt: string): Promise<any> {
  const r = await api.get('admin', `/api/media?where[alt][equals]=${encodeURIComponent(alt)}&depth=0&limit=2`)
  expect(r.json.docs, `exactly one media record has the alt "${alt}"`).toHaveLength(1)
  return r.json.docs[0]
}

async function openLive(page: Page, eventId: number, note?: (t: string) => void) {
  await gotoView(page, 'live', note)
  await expect(page.getByTestId('live-event-select')).toBeVisible()
  await page.getByTestId('live-event-select').selectOption(String(eventId))
  await expect(page.getByTestId('live-event-banner')).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test.describe('Images in stories and live updates (REAL UI)', () => {
  test.beforeAll(() => requireNewsroom(cfg))

  test('I1 reporter: inserts two uploaded images between paragraphs of a story, saves, reopens, submits for review', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'I1-reporter-inline-images')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    const id = uniq('img').replace(/\s+/g, '-')
    const title = `Diocesan photo walk ${id}`
    const standfirst = `Two photographs inside the story body ${id}.`
    const paragraphs = [`Paragraph one ${id} opens the report.`, `Paragraph two ${id} continues it.`, `Paragraph three ${id} closes it.`]
    const alts = [`Choir procession ${id}`, `Bishop blessing the font ${id}`]
    const pngs = alts.map((_, i) => makePng(cfg.fixtureDir, `${cfg.runId}-${info.project.name}-body-${i + 1}.png`, 960 - i * 80, 540 - i * 45))

    await loginUi(page, cfg, 'reporter')
    await expectLiveMode(page)
    await page.goto(`${cfg.newsroomOrigin}/#editor`)
    await expect(page.getByTestId('editor-title')).toBeVisible()
    await page.getByTestId('editor-title').fill(title)
    await page.getByTestId('editor-standfirst').fill(standfirst)
    await page.getByTestId('editor-category').selectOption({ label: cfg.categoryTitle })
    await page.getByTestId('editor-body').fill(paragraphs.join('\n\n'))
    await expect(page.getByTestId('editor-insert-image')).toBeEnabled()
    await ev.shot(page, 'story written; Insert image is offered in the body toolbar')

    // --- image 1 after paragraph one (upload + alt through the picker)
    await placeCaretAfter(page, paragraphs[0])
    await page.getByTestId('editor-insert-image').click()
    await uploadThroughPicker(page, pngs[0].file, alts[0], { credit: 'Synthetic test photographer' })
    // --- image 2 after paragraph two (the text now contains the first token: find the caret by marker, not by offset)
    await placeCaretAfter(page, paragraphs[1])
    await page.getByTestId('editor-insert-image').click()
    await uploadThroughPicker(page, pngs[1].file, alts[1])
    expect(net.filter('POST', '/api/media').map((c) => c.status), `calls: ${net.summary()}`).toEqual([201, 201])

    const media = [await mediaByAlt(alts[0]), await mediaByAlt(alts[1])]
    const expectedBody = [
      paragraphs[0],
      `![${alts[0]}](media:${media[0].id})`,
      paragraphs[1],
      `![${alts[1]}](media:${media[1].id})`,
      paragraphs[2],
    ].join('\n\n')
    await expect(page.getByTestId('editor-body')).toHaveValue(expectedBody)
    await expect(page.getByTestId('editor-body-image')).toHaveCount(2)
    await expect(page.getByTestId('editor-body-image').nth(0)).toContainText(alts[0])
    await expect(page.getByTestId('editor-body-image').nth(1)).toContainText(alts[1])
    await expectImagesLoaded(page.locator('#preview-body-content figure img'), 2, 'preview image')
    await ev.shot(page, 'two images inserted between the paragraphs (token lines, thumbnails, reader preview)')

    // --- save: the body is stored as Lexical upload nodes, in order
    await page.getByTestId('editor-save-draft').click()
    await expect(page).toHaveURL(/#editor\?id=\d+/)
    const articleId = Number(/id=(\d+)/.exec(page.url())![1])
    const saved = await api.articleByTitle(title)
    expect(saved, 'draft exists in PostgreSQL').toBeTruthy()
    const kids = saved.content.root.children as Array<{ type: string; relationTo?: string; version?: number; value?: unknown }>
    expect(kids.map((n) => n.type)).toEqual(['paragraph', 'upload', 'paragraph', 'upload', 'paragraph'])
    const uploads = kids.filter((n) => n.type === 'upload')
    expect(uploads.map((n) => n.relationTo)).toEqual(['media', 'media'])
    expect(uploads.map(uploadNodeMediaId)).toEqual([media[0].id, media[1].id])
    logLine(cfg, `[I1][${info.project.name}] stored upload nodes: ${JSON.stringify(uploads.map((u) => ({ ...u, value: uploadNodeMediaId(u) })))}`)

    // --- reopen from the CMS: still editable (no read-only note), same two images
    await page.goto(`${cfg.newsroomOrigin}/#editor?id=${articleId}`)
    await page.reload()
    await expect(page.getByTestId('editor-title')).toHaveValue(title)
    await expect(page.getByTestId('editor-lossy-note')).toHaveCount(0)
    await expect(page.getByTestId('editor-body')).toHaveJSProperty('readOnly', false)
    await expect(page.getByTestId('editor-body')).toHaveValue(expectedBody)
    await expect(page.getByTestId('editor-body-image')).toHaveCount(2)
    await expectImagesLoaded(page.locator('#preview-body-content figure img'), 2, 'reopened preview image')
    await ev.shot(page, 'reopened story: body editable, both images listed and previewed')

    await page.getByTestId('editor-submit-review').click()
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'in_review')
    expect((await api.articleByTitle(title)).status).toBe('in_review')
    await ev.shot(page, 'submitted for review', { final: true })
    await logoutUi(page)
    stories.set(info.project.name, { id: articleId, title, standfirst, slug: slugify(title), paragraphs, alts, mediaIds: media.map((m) => m.id), bodyValue: expectedBody, widths: pngs.map((p) => p.width) })
  })

  test('I2 section editor publishes; anonymous reader sees both images in the right order with alt text (article page + reload)', async ({ page, browser }, info) => {
    const s = need(stories, info.project.name, 'I1')
    const ev = new Evidence(cfg, info, 'I2-editor-publish-public-images')
    const note = (t: string) => ev.note(t)

    await loginUi(page, cfg, 'section-editor')
    await gotoView(page, 'review', note)
    const card = page.getByTestId('review-card').filter({ hasText: s.title })
    await expect(card).toBeVisible()
    await press(page, card.getByTestId('review-inspect'), note)
    await expect(page.getByTestId('inspect-modal')).toBeVisible()
    await expect(page.getByTestId('inspect-body').getByTestId('preview-inline-image')).toHaveCount(2)
    await ev.shot(page, 'review inspect shows both images inside the body')
    await press(page, page.getByTestId('inspect-approve'), note)
    await expect(page.getByTestId('inspect-modal')).toBeHidden()
    await press(page, page.getByTestId('review-tab-approved'), note)
    const approved = page.getByTestId('review-card').filter({ hasText: s.title })
    await expect(approved).toBeVisible()
    await press(page, approved.getByTestId('review-inspect'), note)
    await press(page, page.getByTestId('inspect-publish'), note)
    await press(page, page.getByTestId('publish-ok'), note)
    await expect(page.getByTestId('inspect-modal')).toBeHidden()
    await expect.poll(async () => (await api.articleByTitle(s.title)).status).toBe('published')
    await logoutUi(page)

    const ctx = await freshContext(browser, info)
    const reader = await ctx.newPage()
    try {
      await expectPublishedOnPublicSite(reader, cfg, { title: s.title, standfirst: s.standfirst, bodyText: s.paragraphs[0], slug: s.slug })
      const expectedOrder = [
        `P:${s.paragraphs[0].slice(0, 40)}`,
        `FIG:${s.alts[0]}`,
        `P:${s.paragraphs[1].slice(0, 40)}`,
        `FIG:${s.alts[1]}`,
        `P:${s.paragraphs[2].slice(0, 40)}`,
      ]
      for (const phase of ['after the click-through and first reload', 'after another reload']) {
        const body = reader.locator('#cms-report .newsroom-article-body')
        await expect(body.locator('figure.cms-figure')).toHaveCount(2)
        expect(await bodyReadingOrder(body), `reading order ${phase}`).toEqual(expectedOrder)
        await expectImagesLoaded(body.locator('figure.cms-figure img.cms-image'), 2, `public body image (${phase})`)
        const srcs = await body.locator('figure.cms-figure img.cms-image').evaluateAll((els) => els.map((e) => e.getAttribute('src')))
        for (const src of srcs) expect(src, 'served by the CMS media route').toContain(`${new URL(cfg.cmsUrl).origin}/api/media/file/`)
        expect(new Set(srcs).size, 'two different pictures').toBe(2)
        s.srcs = srcs as string[]
        if (phase === 'after the click-through and first reload') {
          await ev.shot(reader, 'anonymous public article page with both inline images in order', { final: true })
          expect((await reader.reload())?.status()).toBe(200)
        }
      }
      // the anonymous API exposes the images as public media (no staff-only fields)
      const anon = await api.get(null, `/api/articles?where[slug][equals]=${s.slug}&depth=1`)
      const ups = (anon.json.docs[0].content.root.children as any[]).filter((n) => n.type === 'upload')
      expect(ups.map((u) => u.value?.alt)).toEqual(s.alts)
      expect(JSON.stringify(anon.json)).not.toContain('uploadedBy')
    } finally {
      await ctx.close()
    }
  })

  test('I3 live update with a photo: reporter attaches it, editor approves, the anonymous public feed returns image {url, alt, width, height, mimeType}', async ({ page, browser }, info) => {
    const ev = new Evidence(cfg, info, 'I3-live-update-photo')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    const tag = uniq('lp').replace(/\s+/g, '-')
    const title = `Photo live coverage ${tag}`
    const body = `Delegates gather for the opening session ${tag}`
    const alt = `Delegates in the synod hall ${tag}`
    const png = makePng(cfg.fixtureDir, `${cfg.runId}-${info.project.name}-live.png`, 800, 450)

    const made = await live.send('admin', 'POST', '/api/live-events', { title, category: cfg.categoryId, status: 'live' })
    expect(made.status, 'admin creates a live event').toBe(201)
    const eventId = made.json.doc.id as number
    const slug = made.json.doc.slug as string

    // --- reporter (UI): Add photo -> upload -> removable thumbnail -> post (becomes pending)
    await loginUi(page, cfg, 'reporter')
    await openLive(page, eventId, ev.note.bind(ev))
    await expect(page.getByTestId('live-add-photo')).toBeVisible()
    await page.getByTestId('live-add-photo').click()
    await uploadThroughPicker(page, png.file, alt, { credit: 'Synthetic test photographer' })
    await expectImagesLoaded(page.getByTestId('live-update-photo-draft'), 1, 'composer thumbnail')
    await expect(page.getByTestId('live-update-photo-alt')).toHaveText(alt)
    // removable before posting, then attach again from the library
    await page.getByTestId('live-remove-photo').click()
    await expect(page.getByTestId('live-update-photo-draft')).toHaveCount(0)
    await page.getByTestId('live-add-photo').click()
    await page.locator('[data-testid="media-card"]').filter({ hasText: alt }).first().click()
    await expect(page.getByTestId('live-update-photo-draft')).toBeVisible()
    await ev.shot(page, 'reporter composes a live update with a photo thumbnail')

    await page.getByTestId('live-update-body').fill(body)
    await page.getByTestId('live-update-post').click()
    await expect(page.getByTestId('live-update-body')).toHaveValue('')
    await expect(page.getByTestId('live-update-photo-draft')).toHaveCount(0)
    const pending = page.getByTestId('live-pending-card').filter({ hasText: body })
    await expect(pending).toBeVisible()
    await expectImagesLoaded(pending.getByTestId('live-update-photo'), 1, 'pending update photo')
    await expect(pending.getByTestId('live-update-photo')).toHaveAttribute('alt', alt)
    const postCalls = net.filter('POST', '/api/live-updates')
    expect(postCalls.map((c) => c.status), `calls: ${net.summary()}`).toEqual([201])

    const media = await mediaByAlt(alt)
    const rows = await live.updatesOfEvent(eventId)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('pending')
    expect(typeof rows[0].image === 'object' ? rows[0].image.id : rows[0].image, 'the update stores the media id').toBe(media.id)
    await ev.shot(page, 'pending update shows its photo in the staff list')
    await logoutUi(page)

    // --- section editor (UI): approves it; the published timeline shows the photo
    await loginUi(page, cfg, 'section-editor')
    await openLive(page, eventId, ev.note.bind(ev))
    const pendingCard = page.getByTestId('live-pending-card').filter({ hasText: body })
    await expect(pendingCard.getByTestId('live-update-photo')).toBeVisible()
    await pendingCard.getByTestId('live-approve').click()
    const published = page.getByTestId('live-update-card').filter({ hasText: body })
    await expect(published).toBeVisible()
    await expectImagesLoaded(published.getByTestId('live-update-photo'), 1, 'published update photo')
    await expect(published.getByTestId('live-update-photo')).toHaveAttribute('alt', alt)
    await ev.shot(page, 'approved: the published timeline shows the photo', { final: true })
    await logoutUi(page)

    // --- anonymous public feed API
    const ctx = await freshContext(browser, info)
    const reader = await ctx.newPage()
    await reader.goto(`${cfg.publicOrigin}/`)
    const feed = await anonymousGet(reader, cfg.cmsUrl, `/api/live-events/${slug}/updates`)
    expect(feed.status).toBe(200)
    expect(feed.json.docs).toHaveLength(1)
    const image = feed.json.docs[0].image
    expect(image, 'the public feed carries the photo of an approved update').toBeTruthy()
    expect(Object.keys(image).sort()).toEqual(['alt', 'height', 'mimeType', 'url', 'width'])
    expect(image.alt).toBe(alt)
    expect(image.mimeType).toBe('image/png')
    expect(image.width).toBe(png.width)
    expect(image.height).toBe(png.height)
    expect(String(image.url)).toMatch(/^(https?:\/\/[^/]+)?\/api\/media\/file\//)
    for (const bad of ['uploadedBy', 'e2e-reporter', 'churchtimes.invalid', 'credit']) expect(feed.text, `public feed must not contain "${bad}"`).not.toContain(bad)
    const imgUrl = String(image.url).startsWith('/') ? `${cfg.cmsUrl}${image.url}` : String(image.url)
    const loadedWidth = await reader.evaluate(
      (u) => new Promise<number>((resolve) => {
        const el = new Image()
        el.onload = () => resolve(el.naturalWidth)
        el.onerror = () => resolve(0)
        el.src = u
      }),
      imgUrl,
    )
    expect(loadedWidth, 'the photo itself is publicly readable and decodes').toBe(png.width)
    logLine(cfg, `[I3][${info.project.name}] public feed image: ${JSON.stringify(image)}`)
    await ctx.close()
    lives.set(info.project.name, { eventId, slug, title, body, alt, mediaId: media.id, updateId: rows[0].id })
  })

  // src/live/public-live-page.js renders the approved update photo (#31); the data is public (I3).
  test('I4 public #live page shows the update text and its photo with the alt text', async ({ browser }, info) => {
    const l = need(lives, info.project.name, 'I3')
    const ev = new Evidence(cfg, info, 'I4-live-public-photo')
    const ctx = await freshContext(browser, info)
    const page = await ctx.newPage()
    await page.goto(`${cfg.publicOrigin}/#live/${l.slug}`)
    const item = page.locator('#live-timeline li').filter({ hasText: l.body })
    await expect(item).toBeVisible({ timeout: 30_000 })
    ev.note('the update text is on the public page; checking its photo')
    const photo = item.locator('img')
    await expect(photo, 'the public #live item renders exactly the update photo').toHaveCount(1)
    await expect(photo).toHaveAttribute('alt', l.alt)
    await expect.poll(() => photo.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 30_000, message: 'the photo loads' }).toBeGreaterThan(0)
    await ev.shot(page, 'public #live page, update with a photo', { final: true })
    await ctx.close()
  })

  test('I5 published story: the reporter cannot replace or re-describe a body image (direct PATCH /api/media/<id> -> 403); the public article keeps the original pictures', async ({ browser }, info) => {
    const s = need(stories, info.project.name, 'I1/I2')
    if (!s.srcs) throw new Error('I2 did not record the public image sources')
    const ev = new Evidence(cfg, info, 'I5-published-body-image-freeze')
    const root = new URL(cfg.recorderUrl).origin
    const token = await api.login('reporter')
    const before = await Promise.all(s.mediaIds.map((id) => api.get('admin', `/api/media/${id}?depth=0`)))
    const replacement = makePng(cfg.fixtureDir, `${cfg.runId}-${info.project.name}-replacement.png`, 321, 123)

    for (const [i, id] of s.mediaIds.entries()) {
      // new alt text (JSON)
      const rePost = await live.send('reporter', 'PATCH', `/api/media/${id}`, { alt: `Reporter rewrote the alt text ${i}` })
      expect(rePost.status, `reporter PATCH alt of body image ${id}`).toBe(403)
      // new file (multipart, exactly what the media UI would send)
      const form = new FormData()
      form.append('_payload', JSON.stringify({ alt: before[i].json.alt }))
      form.append('file', new Blob([fs.readFileSync(replacement.file)], { type: 'image/png' }), 'replacement.png')
      const res = await fetch(`${root}/api/media/${id}`, { method: 'PATCH', headers: { authorization: `JWT ${token}` }, body: form })
      expect(res.status, `reporter PATCH new file of body image ${id}`).toBe(403)
      ev.note(`media ${id}: PATCH alt -> ${rePost.status}, PATCH file -> ${res.status}`)
    }

    // nothing changed in the CMS
    for (const [i, id] of s.mediaIds.entries()) {
      const after = await api.get('admin', `/api/media/${id}?depth=0`)
      expect(after.json.alt).toBe(before[i].json.alt)
      expect(after.json.filename).toBe(before[i].json.filename)
      expect(after.json.width).toBe(before[i].json.width)
    }

    // ... and the files are still served (a refused replacement must not delete or overwrite them): the original upload at
    // its recorded dimensions, and the exact (size-variant) file the public page links to, which keeps its own width.
    for (const [i, id] of s.mediaIds.entries()) {
      const original = await fetch(`${root}${new URL(before[i].json.url, root).pathname}`)
      const originalBytes = Buffer.from(await original.arrayBuffer())
      expect(original.status, `original file of media ${id} is still served`).toBe(200)
      expect(originalBytes.readUInt32BE(16), `original file of media ${id} still has its original width`).toBe(s.widths[i])
    }
    for (const src of s.srcs) {
      // The public page links to the 800px "card" variant (first variant >= 800px), not the original, so this file's width is
      // the variant's, stated in its own name (`<name>-<w>x<h>.png`).
      const res = await fetch(`${root}${new URL(src).pathname}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      expect(res.status, `public image file ${src} is still served`).toBe(200)
      const m = /-(\d+)x(\d+)\.png$/.exec(new URL(src).pathname)
      if (m) expect(bytes.readUInt32BE(16), `public image file ${src} still has the width in its name`).toBe(Number(m[1]))
      else expect(s.widths).toContain(bytes.readUInt32BE(16))
    }

    // the public article still shows the original pictures
    const ctx = await freshContext(browser, info)
    const reader = await ctx.newPage()
    try {
      await reader.goto(`${cfg.publicOrigin}${articlePath(cfg, s.slug)}`)
      const body = reader.locator('#cms-report .newsroom-article-body')
      await expect(body.locator('figure.cms-figure')).toHaveCount(2)
      await expectImagesLoaded(body.locator('figure.cms-figure img.cms-image'), 2, 'public body image after the refused edits')
      expect(await body.locator('figure.cms-figure img.cms-image').evaluateAll((els) => els.map((e) => e.getAttribute('src')))).toEqual(s.srcs)
      expect(await body.locator('figure.cms-figure img.cms-image').evaluateAll((els) => els.map((e) => e.getAttribute('alt')))).toEqual(s.alts)
      // (No naturalWidth check here: with srcset + sizes the browser reports the density-corrected slot width, not the file width.
      // The served bytes above already prove the original files are unchanged.)
      await ev.shot(reader, 'public article still shows the original pictures', { final: true })
    } finally {
      await ctx.close()
    }
  })
})
