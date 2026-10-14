/**
 * Scheduled publishing, end to end with the REAL newsroom UI, the REAL in-process CMS scheduler (stack.ts sets
 * SCHEDULER_ENABLED=true, SCHEDULER_INTERVAL_SECONDS=2) and the REAL public site.
 *
 *   S1 reporter (UI): writes + submits a story; has NO schedule control, and the CMS answers 403 to a direct PATCH to `scheduled`.
 *   S2 section editor (UI): approves, tries a past time (CMS refuses, message shown, status unchanged), then schedules ~50 s ahead
 *      with the newsroom "Schedule" control. S2b checks two more CMS rules API-DRIVEN (labelled as such).
 *   S3 anonymous reader: BEFORE the time the story is absent (API, Latest list, /reports/<slug>/ = 404); after the scheduler
 *      ran it is published (publishedAt sane, audit entry by the system actor) and visible as card + SSR article page.
 */
import { expect, test } from '@playwright/test'

import { Api, Evidence, getConfig, logLine, trackCmsCalls, uniq } from './support/helpers'
import { expectLiveMode, freshContext, loginUi, logoutUi, press, requireNewsroom, slugify } from './support/newsroom'
import { expectNotOnPublicSite, expectPublishedOnPublicSite } from './support/public'
import { apiRequest, localInputValue, patchFromPage } from './support/schedule'

const cfg = getConfig()
const api = new Api(cfg)

/** How far ahead the story is scheduled. Long enough that the "not yet public" checks finish before the scheduler fires. */
const LEAD_MS = 50_000

type State = { id: number; title: string; standfirst: string; body: string; slug: string; scheduledForMs?: number }
const states = new Map<string, State>()

test.describe.configure({ mode: 'serial' })

test.describe('E. scheduled publishing: reporter blocked -> editor schedules (UI) -> scheduler publishes -> anonymous public', () => {
  test.beforeAll(() => requireNewsroom(cfg))

  test('S1 reporter (UI): writes and submits a story; no Schedule control, direct PATCH to "scheduled" is 403', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'S1-reporter-cannot-schedule')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    const id = uniq('sched').replace(/\s+/g, '-')
    const title = `Diocesan synod vote moves to evening ${id}`
    const standfirst = `Delegates will vote after evensong ${id}.`
    const body = `Synthetic report ${id}: the synod confirmed the timetable on Monday.\n\nSecond paragraph with a verified quote from the chair ${id}.`
    const future = new Date(Date.now() + 3600_000).toISOString()

    await loginUi(page, cfg, 'reporter')
    await expectLiveMode(page)
    await page.goto(`${cfg.newsroomOrigin}/#editor`)
    await expect(page.getByTestId('editor-title')).toBeVisible()
    await page.getByTestId('editor-title').fill(title)
    await page.getByTestId('editor-standfirst').fill(standfirst)
    await page.getByTestId('editor-category').selectOption({ label: cfg.categoryTitle })
    await page.getByTestId('editor-body').fill(body)
    await page.getByTestId('editor-save-draft').click()
    await expect(page).toHaveURL(/#editor\?id=\d+/)
    const articleId = Number(/id=(\d+)/.exec(page.url())![1])
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'draft')
    // draft: no scheduling control for a reporter, and the server refuses the status
    await expect(page.getByTestId('editor-schedule-panel')).toBeHidden()
    await expect(page.getByTestId('editor-schedule')).toHaveCount(0)
    const onDraft = await patchFromPage(page, cfg.cmsUrl, articleId, { status: 'scheduled', scheduledFor: future })
    expect(onDraft.status, 'reporter PATCH draft -> scheduled').toBe(403)
    expect(onDraft.message).toContain('scheduled')
    expect((await api.articleByTitle(title)).status).toBe('draft')
    await ev.shot(page, 'reporter draft: no Schedule control; direct PATCH to scheduled refused (403)')

    await page.getByTestId('editor-submit-review').click()
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'in_review')
    await expect(page.getByTestId('editor-schedule')).toHaveCount(0)
    const onReview = await patchFromPage(page, cfg.cmsUrl, articleId, { status: 'scheduled', scheduledFor: future })
    expect(onReview.status, 'reporter PATCH in_review -> scheduled').toBe(403)
    const after = await api.articleByTitle(title)
    expect(after.status).toBe('in_review')
    expect(after.scheduledFor ?? null).toBeNull()
    ev.note(`reporter direct PATCH to scheduled: draft -> ${onDraft.status} (${onDraft.message}); in_review -> ${onReview.status}; server status still in_review`)
    await ev.shot(page, 'reporter in review: still no Schedule control, PATCH 403, nothing scheduled', { final: true })
    await logoutUi(page)
    states.set(info.project.name, { id: articleId, title, standfirst, body, slug: slugify(title) })
    ev.note(`calls: ${net.summary()}`)
  })

  test('S2 section editor (UI): approves, past time is refused by the CMS, schedules ~50 s ahead with the newsroom control', async ({ page }, info) => {
    const s = states.get(info.project.name)
    if (!s) throw new Error('S1 did not complete for this project')
    const ev = new Evidence(cfg, info, 'S2-editor-schedules')
    const note = (t: string) => ev.note(t)
    const net = trackCmsCalls(page, cfg.cmsUrl)

    await loginUi(page, cfg, 'section-editor')
    await page.goto(`${cfg.newsroomOrigin}/#editor?id=${s.id}`)
    await expect(page.getByTestId('editor-title')).toHaveValue(s.title)
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'in_review')
    await press(page, page.getByTestId('editor-approve'), note)
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'approved')
    expect((await api.articleByTitle(s.title)).status).toBe('approved')

    // The control exists for this role
    await expect(page.getByTestId('editor-schedule-panel')).toBeVisible()
    await expect(page.getByTestId('editor-schedule')).toHaveText('Schedule')
    await ev.shot(page, 'section editor: story approved, Schedule control visible')

    // (a) nothing entered: client-side message, no request sent
    const before = net.filter('PATCH', '/api/articles/').length
    await page.getByTestId('editor-schedule-at').fill('')
    await press(page, page.getByTestId('editor-schedule'), note)
    await expect(page.getByTestId('editor-error')).toContainText('Pick the date and time')
    expect(net.filter('PATCH', '/api/articles/').length, 'no PATCH sent for an empty time').toBe(before)

    // (b) a time in the past: the CMS is the authority and its message is shown; status stays approved
    await page.getByTestId('editor-schedule-at').fill(localInputValue(new Date(Date.now() - 10 * 60_000)))
    await press(page, page.getByTestId('editor-schedule'), note)
    await expect(page.getByTestId('editor-error')).toContainText('scheduledFor must be in the future')
    expect(net.find('PATCH', `/api/articles/${s.id}`, 400), `calls: ${net.summary()}`).toBeTruthy()
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'approved')
    const refused = await api.articleByTitle(s.title)
    expect(refused.status).toBe('approved')
    expect(refused.scheduledFor ?? null).toBeNull()
    await ev.shot(page, 'past time: CMS refused ("must be in the future"), status still approved')

    // (c) a time ~50 s ahead: scheduled
    const target = new Date(Date.now() + LEAD_MS)
    target.setMilliseconds(0)
    await page.getByTestId('editor-schedule-at').fill(localInputValue(target))
    await press(page, page.getByTestId('editor-schedule'), note)
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'scheduled')
    await expect(page.getByTestId('editor-error')).toBeHidden()
    await expect(page.getByTestId('editor-scheduled-for')).toBeVisible()
    await expect(page.getByTestId('editor-schedule')).toHaveText('Reschedule')
    const sched = await api.articleByTitle(s.title)
    expect(sched.status).toBe('scheduled')
    expect(Math.abs(new Date(sched.scheduledFor).getTime() - target.getTime()), 'scheduledFor is the chosen time').toBeLessThan(1000)
    expect(sched.publishedAt ?? null, 'not published yet').toBeNull()
    s.scheduledForMs = new Date(sched.scheduledFor).getTime()
    ev.note(`scheduled via the newsroom UI for ${sched.scheduledFor}; server status scheduled, publishedAt null`)
    await ev.shot(page, 'scheduled from the newsroom: status Scheduled, publishes automatically', { final: true })
    await logoutUi(page)
    ev.note(`calls: ${net.summary()}`)
  })

  test('S2b API-DRIVEN (not UI): CMS rules for a missing, past or garbage scheduledFor', async ({}, info) => {
    const s = states.get(info.project.name)
    if (!s) throw new Error('S1/S2 did not complete for this project')
    const ev = new Evidence(cfg, info, 'S2b-api-scheduling-rules')
    // A second, throw-away draft so the real story's schedule is untouched.
    const title = `Scheduling rules probe ${uniq('probe')}`
    const text = { type: 'text', version: 1, text: 'probe', format: 0, detail: 0, mode: 'normal', style: '' }
    const para = { type: 'paragraph', version: 1, direction: null, format: '', indent: 0, children: [text] }
    const created = await apiRequest(cfg, api, 'section-editor', 'POST', '/api/articles', {
      title,
      category: cfg.categoryId,
      status: 'draft',
      content: { root: { type: 'root', version: 1, direction: null, format: '', indent: 0, children: [para] } },
    })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    const pid = created.json.doc.id as number
    const past = await apiRequest(cfg, api, 'section-editor', 'PATCH', `/api/articles/${pid}`, { status: 'scheduled', scheduledFor: new Date(Date.now() - 60_000).toISOString() })
    expect(past.status, 'past scheduledFor').toBe(400)
    expect(JSON.stringify(past.json)).toContain('scheduledFor must be in the future')
    const missing = await apiRequest(cfg, api, 'section-editor', 'PATCH', `/api/articles/${pid}`, { status: 'scheduled' })
    expect(missing.status, 'missing scheduledFor').toBe(400)
    expect(JSON.stringify(missing.json)).toContain('scheduledFor is required')
    const bad = await apiRequest(cfg, api, 'section-editor', 'PATCH', `/api/articles/${pid}`, { status: 'scheduled', scheduledFor: 'not-a-date' })
    expect(bad.status, 'garbage scheduledFor is refused').toBeGreaterThanOrEqual(400)
    expect((await api.articleByTitle(title)).status, 'refused schedule leaves the probe a draft').toBe('draft')
    const real = await api.articleByTitle(s.title)
    expect(['scheduled', 'published']).toContain(real.status)
    ev.note(`API-driven: past -> ${past.status}, missing -> ${missing.status}, garbage -> ${bad.status}; probe stays draft; real story status ${real.status}`)
  })

  test('S3 anonymous reader: absent before the time (API, Latest, 404), published by the scheduler afterwards (card + SSR page)', async ({ browser }, info) => {
    const s = states.get(info.project.name)
    if (!s?.scheduledForMs) throw new Error('S1/S2 did not complete for this project')
    const ctx = await freshContext(browser, info)
    const page = await ctx.newPage()
    const ev = new Evidence(cfg, info, 'S3-scheduler-publishes')
    try {
      // --- before the time
      const slugQ = `/api/articles?where[slug][equals]=${s.slug}&depth=0`
      expect((await api.get(null, slugQ)).json.docs, 'anonymous API: scheduled story is not listed').toHaveLength(0)
      expect((await api.get(null, `/api/articles/${s.id}`)).status, 'anonymous API: scheduled story by id is not readable').toBeGreaterThanOrEqual(403)
      await expectNotOnPublicSite(page, cfg, s.slug, s.title)
      await ev.shot(page, 'before the scheduled time: public site answers 404 "Article unavailable"')
      const margin = s.scheduledForMs - Date.now()
      ev.note(`absence checks finished ${Math.round(margin / 1000)} s before the scheduled time`)
      expect(margin, 'the absence checks must finish before the scheduled time (raise LEAD_MS on a slow machine)').toBeGreaterThan(2000)

      // --- the scheduler (2 s tick) publishes it
      await expect
        .poll(async () => (await api.articleByTitle(s.title))?.status, { timeout: 120_000, intervals: [1000], message: 'scheduler publishes the story' })
        .toBe('published')
      const seenAt = Date.now()
      const pub = await api.articleByTitle(s.title)
      const publishedAtMs = new Date(pub.publishedAt).getTime()
      expect(publishedAtMs, 'publishedAt is not before scheduledFor').toBeGreaterThanOrEqual(s.scheduledForMs)
      expect(publishedAtMs - s.scheduledForMs, 'published within a few scheduler ticks of the scheduled time').toBeLessThan(15_000)
      expect(publishedAtMs, 'publishedAt is not in the future').toBeLessThanOrEqual(seenAt + 1000)
      ev.note(`published by the scheduler ${publishedAtMs - s.scheduledForMs} ms after scheduledFor (publishedAt ${pub.publishedAt})`)

      // audit trail: the transition was made by the system actor
      const audit = await api.get('admin', `/api/audit-logs?where[docId][equals]=${s.id}&limit=20&depth=0&sort=createdAt`)
      const entry = (audit.json?.docs ?? []).find((d: any) => d.action === 'status-change' && d.fromStatus === 'scheduled' && d.toStatus === 'published')
      expect(entry, `audit log: ${JSON.stringify(audit.json?.docs?.map((d: any) => [d.action, d.fromStatus, d.toStatus, d.actorRole]))}`).toBeTruthy()
      expect(entry.actorRole).toBe('system')

      // --- the public site now shows it (list card + server-rendered article page); staff-only scheduledFor is not exposed
      const { cardImage } = await expectPublishedOnPublicSite(page, cfg, { title: s.title, standfirst: s.standfirst, bodyText: s.body.split('\n')[0], slug: s.slug })
      expect(cardImage).toBe(false)
      const anon = (await api.get(null, `${slugQ}&depth=1`)).json.docs[0]
      expect(anon.title).toBe(s.title)
      expect(anon).not.toHaveProperty('scheduledFor')
      await ev.shot(page, 'after the scheduler ran: anonymous public article page is live', { final: true })
      logLine(cfg, `[S3][${info.project.name}] scheduled story became public ${publishedAtMs - s.scheduledForMs} ms after its scheduled time`)
    } finally {
      await ctx.close()
    }
  })
})
