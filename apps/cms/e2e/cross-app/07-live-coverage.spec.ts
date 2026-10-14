/**
 * Live coverage, REAL UI end to end (newsroom SPA -> real Payload + PostgreSQL -> anonymous public reads).
 *
 *   L1 section editor (UI): creates a live event (draft), posts an update while it is still a draft, goes live, posts two more.
 *   L2 reporter (UI): submits two updates for review; cannot manage events or approve (UI absent AND direct API refused).
 *   L3 section editor (UI): approves two pending updates in a different order than they were written, rejects one.
 *   L4 anonymous reader: public polling feed shows published updates in PUBLICATION order, no drafts / pending / rejected / staff fields.
 *   L5 section editor (UI) ends coverage; the feed stays readable; a reporter can no longer post (API-driven check).
 *   L6 public site has no live coverage page (known gap outside this lane; L6a proves the data is public, L6b documents the gap with test.fail).
 *
 * Steps are real UI unless the test name says "API-driven". Synthetic data only; unique titles per run.
 */
import { expect, test, type Page } from '@playwright/test'

import { Evidence, getConfig, logLine, trackCmsCalls, uniq } from './support/helpers'
import { anonymousGet, LiveApi } from './support/live'
import { appCookies, isRemote } from './support/remote'
import { expectLiveMode, freshContext, gotoView, loginUi, logoutUi, requireNewsroom } from './support/newsroom'

const cfg = getConfig()
const api = new LiveApi(cfg)

type State = { id: number; slug: string; title: string; ids: Record<string, number>; bodies: Record<string, string> }
const states = new Map<string, State>()
const gap = new Map<string, { title: string; body: string }>()
const st = (project: string): State => {
  const s = states.get(project)
  if (!s) throw new Error('earlier live-coverage step did not run (serial journey)')
  return s
}

const PUBLIC_UPDATE_KEYS = ['approvedAt', 'body', 'id', 'occurredAt', 'sequence']
const PUBLIC_EVENT_KEYS = ['id', 'slug', 'status', 'title']
// remote: the real staff e-mail addresses of the credentials file must not leak either
const STAFF_ONLY = ['author', 'approvedBy', 'e2e-section-editor', 'e2e-reporter', 'churchtimes.invalid', 'publishSequence', 'reviewNotes', ...(isRemote ? Object.values(cfg.credentials).map((c) => c.email) : [])]

async function openLive(page: Page, eventId: number, note?: (t: string) => void) {
  await gotoView(page, 'live', note)
  await expect(page.getByTestId('live-event-select')).toBeVisible()
  await page.getByTestId('live-event-select').selectOption(String(eventId))
  await expect(page.getByTestId('live-event-banner')).toBeVisible()
}

async function postViaUi(page: Page, body: string) {
  await page.getByTestId('live-update-body').fill(body)
  await page.getByTestId('live-update-post').click()
  await expect(page.getByTestId('live-update-body')).toHaveValue('')
}

test.describe.configure({ mode: 'serial' })

test.describe('Live coverage: editor + reporter in the newsroom, anonymous reader on the public API (REAL UI)', () => {
  test.beforeAll(() => requireNewsroom(cfg))

  test('L1 section editor: create event (draft), post while draft, Go Live, post two more; anonymous cannot see the draft event', async ({ page, browser }, info) => {
    const ev = new Evidence(cfg, info, 'L1-live-editor-posts')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    const tag = uniq('lc').replace(/\s+/g, '-')
    const title = `Synod live coverage ${tag}`
    const bodies: Record<string, string> = {
      A: `A (written while the event was still a draft) ${tag}`,
      B: `B opening prayers begin ${tag}`,
      C: `C first vote carried ${tag}`,
    }

    await loginUi(page, cfg, 'section-editor')
    await expectLiveMode(page)
    await gotoView(page, 'live', ev.note.bind(ev))
    await expect(page.getByTestId('live-new-event')).toBeVisible()
    await ev.shot(page, 'section editor opens Live Coverage (New Event offered)')

    // --- create the event through the modal
    await page.getByTestId('live-new-event').click()
    await page.getByTestId('live-event-title').fill(title)
    await page.getByTestId('live-event-category').selectOption({ label: cfg.categoryTitle })
    await page.getByTestId('live-event-summary').fill(`Synthetic summary ${tag}`)
    await page.getByTestId('live-event-create').click()
    await expect(page.getByTestId('live-event-status')).toHaveText('DRAFT')
    expect(net.find('POST', '/api/live-events', 201), `calls: ${net.summary()}`).toBeTruthy()
    const event = await api.eventByTitle(title)
    expect(event, 'event exists in PostgreSQL').toBeTruthy()
    expect(event.status).toBe('draft')
    expect(event.category).toBe(cfg.categoryId)
    await ev.shot(page, 'event created as DRAFT (Go Live offered)')

    // --- a draft event is invisible to anonymous readers (feed 404 + collection read empty)
    const readerCtx = await freshContext(browser, info)
    const reader = await readerCtx.newPage()
    await reader.goto(`${cfg.publicOrigin}/`)
    const draftFeed = await anonymousGet(reader, cfg.cmsUrl, `/api/live-events/${event.slug}/updates`)
    expect(draftFeed.status, 'draft event feed is 404 for anonymous').toBe(404)
    const draftList = await anonymousGet(reader, cfg.cmsUrl, `/api/live-events?where[slug][equals]=${event.slug}`)
    expect(draftList.json.docs, 'draft event is not listed for anonymous').toHaveLength(0)
    ev.note(`anonymous: draft feed -> ${draftFeed.status}, draft event listing -> ${draftList.json.docs.length} docs`)

    // --- update posted while the event is still a draft (the model allows it; it must stay hidden)
    await postViaUi(page, bodies.A)
    await expect(page.getByTestId('live-update-card').filter({ hasText: bodies.A })).toBeVisible()
    const draftFeed2 = await anonymousGet(reader, cfg.cmsUrl, `/api/live-events/${event.slug}/updates`)
    expect(draftFeed2.status).toBe(404)
    const leakList = await anonymousGet(reader, cfg.cmsUrl, `/api/live-updates?where[event][equals]=${event.id}`)
    expect(leakList.json.docs, 'updates of a draft event are not readable anonymously').toHaveLength(0)
    await ev.shot(page, 'update posted while draft: staff see it, anonymous still gets 404')

    // --- Go Live, then two more updates through the real form
    await page.getByTestId('live-go-live').click()
    await expect(page.getByTestId('live-event-status')).toHaveText('LIVE NOW')
    await postViaUi(page, bodies.B)
    await postViaUi(page, bodies.C)
    const cards = page.getByTestId('live-update-card')
    await expect(cards).toHaveCount(3)
    // staff timeline: newest published first
    await expect(cards.nth(0)).toContainText(bodies.C)
    await expect(cards.nth(1)).toContainText(bodies.B)
    await expect(cards.nth(2)).toContainText(bodies.A)
    expect(net.filter('POST', '/api/live-updates').map((c) => c.status), `calls: ${net.summary()}`).toEqual([201, 201, 201])
    const rows = await api.updatesOfEvent(event.id)
    expect(rows.map((r) => r.status)).toEqual(['approved', 'approved', 'approved'])
    expect(rows.map((r) => r.publishSequence)).toEqual([1, 2, 3])
    await ev.shot(page, 'event LIVE with three published updates, newest first', { final: true })

    const ids: Record<string, number> = { A: rows[0].id, B: rows[1].id, C: rows[2].id }
    states.set(info.project.name, { id: event.id, slug: event.slug, title, ids, bodies })
    await readerCtx.close()
    await logoutUi(page)
  })

  test('L2 reporter: submits updates for review; no event management, no approve (UI absent + direct API refused)', async ({ page }, info) => {
    const s = st(info.project.name)
    const ev = new Evidence(cfg, info, 'L2-live-reporter-blocked')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    const tag = s.title.split(' ').pop()!
    s.bodies.R1 = `R1 reporter note one ${tag}`
    s.bodies.R2 = `R2 reporter note two ${tag}`

    await loginUi(page, cfg, 'reporter')
    await openLive(page, s.id, ev.note.bind(ev))
    // UI: no event management, no approval
    await expect(page.getByTestId('live-new-event')).toHaveCount(0)
    await expect(page.getByTestId('live-go-live')).toHaveCount(0)
    await expect(page.getByTestId('live-end')).toHaveCount(0)
    await expect(page.getByTestId('live-update-post')).toHaveText(/Submit Update for Editorial Review/)
    await ev.shot(page, 'reporter live view: no New Event, no Go Live / End, submit-for-review wording')

    await postViaUi(page, s.bodies.R1)
    await postViaUi(page, s.bodies.R2)
    const pending = page.getByTestId('live-pending-card')
    await expect(pending).toHaveCount(2)
    await expect(page.getByTestId('live-approve')).toHaveCount(0)
    await expect(page.getByTestId('live-reject')).toHaveCount(0)
    await expect(pending.first()).toContainText('Awaiting editor')
    // reporter's own submissions are NOT on the published timeline
    await expect(page.getByTestId('live-update-card').filter({ hasText: s.bodies.R1 })).toHaveCount(0)
    expect(net.filter('POST', '/api/live-updates').map((c) => c.status)).toEqual([201, 201])
    await ev.shot(page, 'reporter submissions wait as pending, no approve / reject buttons')

    const rows = await api.updatesOfEvent(s.id)
    const r1 = rows.find((r) => r.body === s.bodies.R1)
    const r2 = rows.find((r) => r.body === s.bodies.R2)
    expect([r1?.status, r2?.status]).toEqual(['pending', 'pending'])
    expect(r1.publishSequence ?? null).toBeNull()
    s.ids.R1 = r1.id
    s.ids.R2 = r2.id

    // direct requests with the reporter's real session cookie, from the newsroom origin
    const r3Body = `R3 reporter asks to publish at once ${tag}`
    const direct = await page.evaluate(
      async ([cms, eventId, updateId, categoryId, body]) => {
        const call = async (method: string, path: string, payload: unknown) => {
          const r = await fetch(`${cms}${path}`, {
            method,
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          return { status: r.status, json: await r.json().catch(() => null) }
        }
        return {
          approveOwn: await call('PATCH', `/api/live-updates/${updateId}`, { status: 'approved' }),
          endEvent: await call('PATCH', `/api/live-events/${eventId}`, { status: 'ended' }),
          createEvent: await call('POST', '/api/live-events', { title: 'Reporter event must not exist', category: categoryId, status: 'live' }),
          postApproved: await call('POST', '/api/live-updates', { event: eventId, body, status: 'approved' }),
        }
      },
      [cfg.cmsUrl, s.id, s.ids.R1, cfg.categoryId, r3Body] as const,
    )
    expect(direct.approveOwn.status, 'reporter cannot approve even their own update').toBe(403)
    expect(direct.endEvent.status, 'reporter cannot end an event').toBe(403)
    expect(direct.createEvent.status, 'reporter cannot create an event').toBe(403)
    // asking to publish immediately is not an error: the server downgrades it to pending
    expect(direct.postApproved.status).toBe(201)
    expect(direct.postApproved.json.doc.status, 'server forces pending for a reporter').toBe('pending')
    expect(direct.postApproved.json.doc.publishSequence ?? null).toBeNull()
    s.ids.R3 = direct.postApproved.json.doc.id
    s.bodies.R3 = r3Body
    expect((await api.get('admin', `/api/live-updates/${s.ids.R1}?depth=0`)).json.status).toBe('pending')
    expect((await api.get('admin', `/api/live-events/${s.id}?depth=0`)).json.status).toBe('live')
    ev.note(
      `reporter direct fetch: PATCH approve own -> ${direct.approveOwn.status}; PATCH end event -> ${direct.endEvent.status}; POST event -> ${direct.createEvent.status}; ` +
        `POST status=approved -> ${direct.postApproved.status} stored as ${direct.postApproved.json.doc.status}`,
    )
    await ev.shot(page, 'reporter blocked: approve / end / create all 403, immediate publish downgraded to pending', { final: true })
    ev.note(`calls: ${net.summary()}`)
    await logoutUi(page)
  })

  test('L3 section editor: approves two pending updates out of writing order, rejects the third (real UI)', async ({ page }, info) => {
    const s = st(info.project.name)
    const ev = new Evidence(cfg, info, 'L3-live-editor-reviews')
    await loginUi(page, cfg, 'section-editor')
    await openLive(page, s.id, ev.note.bind(ev))
    const pending = page.getByTestId('live-pending-card')
    await expect(pending).toHaveCount(3)
    await expect(page.getByTestId('live-approve')).toHaveCount(3)
    await ev.shot(page, 'editor sees three pending updates with Approve / Reject')

    const card = (id: number) => page.locator(`[data-testid="live-pending-card"][data-update-id="${id}"]`)
    // R2 (written second) is approved FIRST, then R1: publication order differs from writing order
    await card(s.ids.R2).getByTestId('live-approve').click()
    await expect(page.getByTestId('live-update-card').filter({ hasText: s.bodies.R2 })).toBeVisible()
    await card(s.ids.R1).getByTestId('live-approve').click()
    await expect(page.getByTestId('live-update-card').filter({ hasText: s.bodies.R1 })).toBeVisible()
    await card(s.ids.R3).getByTestId('live-reject').click()
    await expect(pending).toHaveCount(0)
    await expect(page.getByTestId('live-update-card').filter({ hasText: s.bodies.R3 })).toHaveCount(0)

    // staff timeline is newest PUBLISHED first (R1 was published last), not newest written
    const cards = page.getByTestId('live-update-card')
    await expect(cards).toHaveCount(5)
    const order = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-update-id')))
    expect(order).toEqual([s.ids.R1, s.ids.R2, s.ids.C, s.ids.B, s.ids.A].map(String))

    const rows = await api.updatesOfEvent(s.id)
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(by[s.ids.R2].publishSequence).toBe(4)
    expect(by[s.ids.R1].publishSequence).toBe(5)
    expect(by[s.ids.R3].status).toBe('rejected')
    expect(by[s.ids.R3].publishSequence ?? null).toBeNull()
    expect(by[s.ids.R1].approvedBy, 'approver recorded').toBe(cfg.credentials['section-editor'].id)
    await ev.shot(page, 'R2 then R1 approved, R3 rejected: timeline in publication order', { final: true })
    await logoutUi(page)
  })

  test('L4 anonymous reader (public origin, no cookies): published updates in publication order; drafts, pending, rejected and staff fields never leak', async ({ browser }, info) => {
    const s = st(info.project.name)
    const ev = new Evidence(cfg, info, 'L4-live-anonymous-reader')
    const ctx = await freshContext(browser, info)
    const page = await ctx.newPage()
    await page.goto(`${cfg.publicOrigin}/`)
    expect(appCookies(await ctx.cookies()), 'the reader has no cookies at all').toHaveLength(0)

    const feed = await anonymousGet(page, cfg.cmsUrl, `/api/live-events/${s.slug}/updates`)
    expect(feed.status).toBe(200)
    expect(feed.cacheControl).toContain('public')
    expect(feed.json.event).toEqual({ id: s.id, slug: s.slug, title: s.title, status: 'live' })
    expect(Object.keys(feed.json.event).sort()).toEqual(PUBLIC_EVENT_KEYS)
    // publication order: A, B, C, then R2 (approved before R1), then R1
    expect(feed.json.docs.map((d: any) => d.body)).toEqual([s.bodies.A, s.bodies.B, s.bodies.C, s.bodies.R2, s.bodies.R1])
    expect(feed.json.docs.map((d: any) => d.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(feed.json.nextSince).toBe(5)
    for (const d of feed.json.docs) expect(Object.keys(d).sort()).toEqual(PUBLIC_UPDATE_KEYS)
    for (const bad of [s.bodies.R3, 'pending', 'rejected', ...STAFF_ONLY]) expect(feed.text, `public feed must not contain "${bad}"`).not.toContain(bad)
    await ev.shot(page, 'anonymous reader on the public origin (no cookies) fetches the live feed')

    // cursor + limit
    const since = await anonymousGet(page, cfg.cmsUrl, `/api/live-events/${s.slug}/updates?since=3`)
    expect(since.json.docs.map((d: any) => d.body)).toEqual([s.bodies.R2, s.bodies.R1])
    const caught = await anonymousGet(page, cfg.cmsUrl, `/api/live-events/${s.slug}/updates?since=5`)
    expect(caught.json.docs).toEqual([])
    expect(caught.json.nextSince).toBe(5)
    const limited = await anonymousGet(page, cfg.cmsUrl, `/api/live-events/${s.slug}/updates?limit=2`)
    expect(limited.json.docs.map((d: any) => d.body)).toEqual([s.bodies.A, s.bodies.B])
    expect(limited.json.nextSince).toBe(2)
    expect((await anonymousGet(page, cfg.cmsUrl, `/api/live-events/${s.slug}/updates?since=abc`)).status).toBe(400)
    expect((await anonymousGet(page, cfg.cmsUrl, `/api/live-events/no-such-event-${s.slug}/updates`)).status).toBe(404)

    // the generic collection read answers an anonymous reader with approved rows only, without staff fields
    const list = await anonymousGet(page, cfg.cmsUrl, `/api/live-updates?where[event][equals]=${s.id}&sort=publishSequence&limit=50&depth=1`)
    expect(list.status).toBe(200)
    expect(list.json.docs.map((d: any) => d.body)).toEqual([s.bodies.A, s.bodies.B, s.bodies.C, s.bodies.R2, s.bodies.R1])
    for (const d of list.json.docs) {
      expect(d.status).toBe('approved')
      expect(d, 'staff-only fields are stripped for anonymous').not.toHaveProperty('author')
      expect(d).not.toHaveProperty('approvedBy')
    }
    for (const bad of [s.bodies.R3, 'churchtimes.invalid']) expect(list.text).not.toContain(bad)
    const evList = await anonymousGet(page, cfg.cmsUrl, `/api/live-events?where[slug][equals]=${s.slug}`)
    expect(evList.json.docs).toHaveLength(1)
    expect(evList.json.docs[0].status).toBe('live')

    // anonymous writes are refused
    const writes = await page.evaluate(
      async ([cms, eventId, categoryId]) => {
        const post = (path: string, body: unknown) =>
          fetch(`${cms}${path}`, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status)
        return {
          update: await post('/api/live-updates', { event: eventId, body: 'anonymous injection', status: 'approved' }),
          event: await post('/api/live-events', { title: 'anonymous event', category: categoryId, status: 'live' }),
        }
      },
      [cfg.cmsUrl, s.id, cfg.categoryId] as const,
    )
    expect([401, 403]).toContain(writes.update)
    expect([401, 403]).toContain(writes.event)
    expect((await api.updatesOfEvent(s.id)).some((r) => r.body === 'anonymous injection')).toBe(false)
    ev.note(`anonymous writes: POST live-updates -> ${writes.update}, POST live-events -> ${writes.event}`)
    logLine(cfg, `[L4][${info.project.name}] public feed order verified: ${feed.json.docs.map((d: any) => d.sequence).join(',')}`)
    await ev.shot(page, 'anonymous checks complete (page on public origin)', { final: true })
    await ctx.close()
  })

  test('L5 editor ends coverage (UI); feed of an ended event stays public; reporter can no longer post (API-driven)', async ({ page, browser }, info) => {
    const s = st(info.project.name)
    const ev = new Evidence(cfg, info, 'L5-live-ended')
    await loginUi(page, cfg, 'section-editor')
    await openLive(page, s.id, ev.note.bind(ev))
    await page.getByTestId('live-end').click()
    await expect(page.getByTestId('live-event-status')).toContainText('ENDED')
    await expect(page.getByTestId('live-end')).toHaveCount(0)
    expect((await api.get('admin', `/api/live-events/${s.id}?depth=0`)).json.status).toBe('ended')
    await ev.shot(page, 'coverage ended in the newsroom', { final: true })

    const readerCtx = await freshContext(browser, info)
    const reader = await readerCtx.newPage()
    await reader.goto(`${cfg.publicOrigin}/`)
    const feed = await anonymousGet(reader, cfg.cmsUrl, `/api/live-events/${s.slug}/updates`)
    expect(feed.status).toBe(200)
    expect(feed.json.event.status).toBe('ended')
    expect(feed.json.docs).toHaveLength(5)
    await readerCtx.close()

    const late = await api.send('reporter', 'POST', '/api/live-updates', { event: s.id, body: 'too late' })
    expect(late.status, 'API-driven: reporter cannot post to an ended event').toBe(403)
    expect((await api.updatesOfEvent(s.id)).some((r) => r.body === 'too late')).toBe(false)
    await logoutUi(page)
  })


  // L6a: the data a public page would have to show exists and is public through the CMS (a real test, not an expected failure).
  test('L6a API-driven setup: a live event with a published update is readable through the public feed', async ({ browser }, info) => {
    const tag = uniq('gap').replace(/\s+/g, '-')
    const title = `Public gap live event ${tag}`
    const body = `Gap update ${tag}`
    const made = await api.send('admin', 'POST', '/api/live-events', { title, category: cfg.categoryId, status: 'live' })
    expect(made.status, 'admin creates a live event').toBe(201)
    const upd = await api.send('admin', 'POST', '/api/live-updates', { event: made.json.doc.id, body, status: 'approved' })
    expect(upd.status, 'admin publishes an update').toBe(201)
    const ctx = await freshContext(browser, info)
    const page = await ctx.newPage()
    await page.goto(`${cfg.publicOrigin}/`)
    const feed = await anonymousGet(page, cfg.cmsUrl, `/api/live-events/${made.json.doc.slug}/updates`)
    expect(feed.status).toBe(200)
    expect(feed.json.docs.map((d: any) => d.body)).toEqual([body])
    await ctx.close()
    gap.set(info.project.name, { title, body })
  })

  // Known gap OUTSIDE this lane (the public site belongs to another team): it has no live coverage page at all.
  // test.fail keeps the suite green while the gap exists and turns RED as soon as the page ships (then drop test.fail).
  // L6a proved the data is readable, so the only reason this can fail is the missing page.
  test('L6b public site shows live coverage to readers (GAP: no live page exists on the public site)', async ({ browser }, info) => {
    test.fail(true, 'public site (repo root src/) has no live-coverage route; see codexRequests')
    const g = gap.get(info.project.name)
    if (!g) throw new Error('L6a did not run')
    const ev = new Evidence(cfg, info, 'L6b-live-public-gap')
    const ctx = await freshContext(browser, info)
    const page = await ctx.newPage()
    await page.goto(`${cfg.publicOrigin}/#live`)
    ev.note('looking for the live event and its update on the public site at /#live')
    await ev.shot(page, 'public site #live route')
    await expect(page.locator('body')).toContainText(g.title, { timeout: 8_000 })
    await expect(page.locator('body')).toContainText(g.body, { timeout: 8_000 })
    await ctx.close()
  })
})
