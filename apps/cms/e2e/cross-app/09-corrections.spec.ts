/**
 * Scenario I (correction notes), REAL UI end to end. A reporter writes and submits a story, the section editor publishes it
 * from the review queue, then the editor corrects the PUBLISHED text in the newsroom:
 *   - cancelling the correction-note modal saves nothing (no PATCH, server text and corrections unchanged);
 *   - an empty / whitespace note is refused inside the modal (no PATCH);
 *   - a note saves an append-only entry, and a second correction appends without rewriting the first one;
 * an anonymous reader then sees the corrected text and a "Corrections & updates" section with each note and its date,
 * with no staff fields; and a reporter cannot edit the published story (read-only UI, direct PATCHes answer 403).
 * Real Payload + PostgreSQL, no mocks. Every story is created by this file with unique synthetic titles.
 */
import { expect, test } from '@playwright/test'

import { Api, Evidence, getConfig, trackCmsCalls, uniq } from './support/helpers'
import { freshContext, loginUi, logoutUi, requireNewsroom, slugify } from './support/newsroom'
import { PUBLIC_CORRECTION_KEYS, reporterSubmitStory, sectionEditorPublishStory } from './support/corrections'
import { expectPublishedOnPublicSite } from './support/public'

const cfg = getConfig()
const api = new Api(cfg)

type State = {
  id: number
  title: string
  slug: string
  standfirst: string
  original: string
  corrected: string
  correctedFirstLine: string
  notes: [string, string]
  publishedAt: string | null
  firstCorrectedAt?: string
  firstCorrectionId?: string
}
const states = new Map<string, State>()

const serverArticle = async (id: number): Promise<any> => (await api.get('admin', `/api/articles/${id}?depth=0`)).json
const corrections = async (id: number): Promise<any[]> => (await serverArticle(id)).corrections ?? []

test.describe.configure({ mode: 'serial' })

test.describe('I. correction notes on a published story (REAL UI)', () => {
  test.beforeAll(() => requireNewsroom(cfg))

  test('I1 reporter writes a story and submits it for review (real UI)', async ({ page }, info) => {
    const ev = new Evidence(cfg, info, 'I1-reporter-submit')
    const tag = uniq('corr').replace(/\s+/g, '-')
    const title = `Choir tour correction ${tag}`
    const standfirst = `A synthetic report used to test correction notes ${tag}.`
    const original = `Synthetic correction report ${tag}: the cathedral choir completed its tour on Saturday.\n\nSecond paragraph of the original report ${tag}.`
    const corrected = `Synthetic correction report ${tag}: the cathedral choir completed its tour on Sunday.\n\nSecond paragraph of the original report ${tag}.`

    const id = await reporterSubmitStory(page, cfg, title, standfirst, original)
    const saved = await serverArticle(id)
    expect(saved.status).toBe('in_review')
    expect(saved.title).toBe(title)
    ev.note(`article ${id} is in_review (server)`)
    await ev.shot(page, 'reporter submitted the story for review', { final: true })

    states.set(info.project.name, {
      id,
      title,
      slug: slugify(title),
      standfirst,
      original,
      corrected,
      correctedFirstLine: corrected.split('\n')[0]!,
      notes: [`Synthetic correction ${tag}: the tour date was changed to Sunday.`, `Synthetic second correction ${tag}: a paragraph was added.`],
      publishedAt: null,
    })
  })

  test('I2 section editor approves and publishes the story in the review queue (real UI)', async ({ page }, info) => {
    const s = states.get(info.project.name)
    if (!s) throw new Error('I1 did not complete for this project')
    const ev = new Evidence(cfg, info, 'I2-editor-publish')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    await sectionEditorPublishStory(page, cfg, ev, s.title)
    await expect.poll(async () => (await serverArticle(s.id)).status, { message: 'server status' }).toBe('published')
    const pub = await serverArticle(s.id)
    expect(pub.publishedAt, 'server stamps publishedAt').toBeTruthy()
    s.publishedAt = pub.publishedAt
    expect(pub.corrections ?? [], 'a freshly published story has no corrections').toHaveLength(0)
    await ev.shot(page, 'published from the review queue: server status published', { final: true })
    ev.note(`calls: ${net.summary()}`)
    await logoutUi(page)
  })

  test('I3 section editor corrects the published text: cancel saves nothing, empty note refused, note saves, second note appends', async ({ page }, info) => {
    const s = states.get(info.project.name)
    if (!s) throw new Error('I2 did not complete for this project')
    const ev = new Evidence(cfg, info, 'I3-editor-correction-note')
    const net = trackCmsCalls(page, cfg.cmsUrl)
    const modal = page.getByTestId('correction-note-form')
    const patches = () => net.filter('PATCH', `/api/articles/${s.id}`)

    await loginUi(page, cfg, 'section-editor')
    await page.goto(`${cfg.newsroomOrigin}/#editor?id=${s.id}`)
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'published')
    await expect(page.getByTestId('editor-title')).toHaveValue(s.title)
    await expect(page.getByTestId('editor-body')).toHaveJSProperty('readOnly', false)

    // --- 1. cancel: the modal opens before anything is sent, and cancelling sends nothing
    await page.getByTestId('editor-body').fill(s.corrected)
    await page.getByTestId('editor-save-draft').click()
    await expect(modal).toBeVisible()
    await expect(page.locator('#modal-heading')).toHaveText('Add a correction note')
    await ev.shot(page, 'published story edited: the correction-note modal opens before anything is saved')
    await page.locator('#ask-text-cancel').click()
    await expect(page.locator('#active-modal-overlay')).toHaveCount(0)
    expect(patches(), `cancel must not PATCH: ${net.summary()}`).toHaveLength(0)
    let server = await serverArticle(s.id)
    expect(JSON.stringify(server.content), 'server text unchanged after cancel').toContain('Saturday')
    expect(JSON.stringify(server.content)).not.toContain('Sunday')
    expect(server.corrections ?? [], 'no correction saved after cancel').toHaveLength(0)
    ev.note('cancel: no PATCH, server text and corrections unchanged')

    // --- 2. an empty (whitespace) note is refused in the modal
    await page.getByTestId('editor-save-draft').click()
    await expect(modal).toBeVisible()
    await page.getByTestId('correction-note-input').fill('   ')
    await page.getByTestId('correction-note-confirm').click()
    await expect(page.locator('#ask-text-error')).toHaveText('Please enter some text.')
    await expect(modal).toBeVisible()
    expect(patches(), 'empty note must not PATCH').toHaveLength(0)
    expect(await corrections(s.id), 'empty note saves no correction').toHaveLength(0)
    await ev.shot(page, 'empty correction note refused inside the modal; nothing saved')

    // --- 3. a real note saves the body change and one append-only entry
    await page.getByTestId('correction-note-input').fill(s.notes[0])
    await page.getByTestId('correction-note-confirm').click()
    await expect(modal).toHaveCount(0)
    await expect.poll(async () => (await corrections(s.id)).length, { message: 'one correction stored' }).toBe(1)
    await expect.poll(() => patches().some((c) => c.status === 200), { message: 'PATCH answered 200' }).toBe(true)
    server = await serverArticle(s.id)
    expect(JSON.stringify(server.content), 'corrected text saved').toContain('Sunday')
    expect(server.status).toBe('published')
    expect(server.publishedAt, 'publishedAt is not moved by a correction').toBe(s.publishedAt)
    const [c1] = await corrections(s.id)
    expect(c1.note).toBe(s.notes[0])
    expect(Number.isNaN(Date.parse(c1.correctedAt)), 'correctedAt is a server timestamp').toBe(false)
    s.firstCorrectedAt = c1.correctedAt
    s.firstCorrectionId = String(c1.id)
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'published')
    await ev.shot(page, 'correction saved: server text corrected, one correction entry with a server date')

    // --- 4. a second correction appends; the first entry is not rewritten
    await page.getByTestId('editor-body').fill(s.corrected + '\n\nA second paragraph was added during the correction.')
    await page.getByTestId('editor-save-draft').click()
    await expect(modal).toBeVisible()
    await page.getByTestId('correction-note-input').fill(s.notes[1])
    await page.getByTestId('correction-note-confirm').click()
    await expect(modal).toHaveCount(0)
    await expect.poll(async () => (await corrections(s.id)).length, { message: 'two corrections stored' }).toBe(2)
    const [a, b] = await corrections(s.id)
    expect(String(a.id), 'first entry keeps its id').toBe(s.firstCorrectionId)
    expect(a).toMatchObject({ note: s.notes[0], correctedAt: s.firstCorrectedAt })
    expect(b.note).toBe(s.notes[1])
    expect(Date.parse(b.correctedAt)).toBeGreaterThanOrEqual(Date.parse(a.correctedAt))
    ev.note(`calls: ${net.summary()}`)
    await ev.shot(page, 'second correction appended; first entry unchanged', { final: true })
    await logoutUi(page)
  })

  test('I4 anonymous reader: corrected text, "Corrections & updates" with each note and date, no staff fields', async ({ browser }, info) => {
    const s = states.get(info.project.name)
    if (!s) throw new Error('I3 did not complete for this project')
    const ctx = await freshContext(browser, info)
    const page = await ctx.newPage()
    const ev = new Evidence(cfg, info, 'I4-anonymous-corrections')
    try {
      const staffEmails = Object.values(cfg.credentials).map((c) => c.email)
      await expectPublishedOnPublicSite(page, cfg, {
        title: s.title,
        standfirst: s.standfirst,
        bodyText: s.correctedFirstLine,
        slug: s.slug,
        leaked: [...staffEmails, 'reviewNotes', 'correctionAmended', 'authorId'],
      })
      const article = page.locator('#cms-report')
      await expect(article.locator('.newsroom-article-body')).not.toContainText('completed its tour on Saturday')

      const section = article.locator('section.newsroom-corrections')
      await expect(section).toBeVisible()
      await expect(section.locator('h2')).toHaveText('Corrections & updates')
      const items = section.locator('li')
      await expect(items).toHaveCount(2)
      const anon = await api.get(null, `/api/articles?where[slug][equals]=${s.slug}&depth=1`)
      const doc = anon.json.docs[0]
      expect(doc.corrections, 'anonymous API lists both corrections').toHaveLength(2)
      for (const c of doc.corrections) {
        expect(Object.keys(c).every((k) => PUBLIC_CORRECTION_KEYS.includes(k)), 'correction carries only public fields').toBe(true)
      }
      for (const [i, note] of s.notes.entries()) {
        await expect(items.nth(i).locator('p')).toHaveText(note)
        const time = items.nth(i).locator('time')
        await expect(time).toHaveAttribute('datetime', new Date(doc.corrections[i].correctedAt).toISOString())
        await expect(time).not.toHaveText('')
      }
      await ev.shot(page, 'anonymous reader: corrected text and both corrections with dates', { final: true })

      // the server-rendered HTML (no JavaScript) also carries the corrections and the corrected text
      // Fetched from the page (same origin), not page.request: *.churchtimes.localhost only resolves inside Chromium
      // (--host-resolver-rules); Node's resolver does not map it once the machine uses another DNS (e.g. Tailscale MagicDNS).
      const ssr = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'omit', cache: 'no-store' })
        return { status: res.status, html: await res.text() }
      }, `${cfg.publicOrigin}/reports/${s.slug}/`)
      expect(ssr.status).toBe(200)
      const ssrHtml = ssr.html
      expect(ssrHtml).toContain('Corrections & updates')
      expect(ssrHtml).toContain(s.notes[0])
      expect(ssrHtml).toContain(s.notes[1])
      expect(ssrHtml).not.toContain('completed its tour on Saturday')
      ev.note('server-rendered HTML carries both corrections and the corrected text')
    } finally {
      await ctx.close()
    }
  })

  test('I5 reporter cannot edit the published story: read-only UI, direct PATCHes answer 403 (API-driven PATCH)', async ({ page }, info) => {
    const s = states.get(info.project.name)
    if (!s) throw new Error('I3 did not complete for this project')
    const ev = new Evidence(cfg, info, 'I5-reporter-published-readonly')
    await loginUi(page, cfg, 'reporter')
    await page.goto(`${cfg.newsroomOrigin}/#editor?id=${s.id}`)
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'published')
    await expect(page.getByTestId('editor-readonly-note')).toBeVisible()
    await expect(page.getByTestId('editor-title')).toHaveJSProperty('readOnly', true)
    await expect(page.getByTestId('editor-body')).toHaveJSProperty('readOnly', true)
    await expect(page.getByTestId('editor-save-draft')).toBeDisabled()
    for (const t of ['editor-submit-review', 'editor-publish', 'editor-approve', 'editor-archive']) {
      await expect(page.getByTestId(t), `${t} is not offered to a reporter`).toHaveCount(0)
    }
    await ev.shot(page, 'reporter opens the published story: read-only, no workflow buttons', { final: true })

    const refused = await page.evaluate(
      async ([cms, aid]) => {
        const send = async (body: unknown) =>
          (
            await fetch(`${cms}/api/articles/${aid}`, {
              method: 'PATCH',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
          ).status
        return {
          title: await send({ title: 'Reporter overwrite of a published story' }),
          addCorrection: await send({ corrections: [{ note: 'Reporter note that must not be saved' }] }),
          archive: await send({ status: 'archived' }),
        }
      },
      [cfg.cmsUrl, s.id] as const,
    )
    expect(refused, 'reporter PATCHes on a published story must be 403').toEqual({ title: 403, addCorrection: 403, archive: 403 })
    const server = await serverArticle(s.id)
    expect(server.title).toBe(s.title)
    expect(server.status).toBe('published')
    expect(server.corrections, 'refused correction is not stored').toHaveLength(2)
    ev.note(`reporter direct PATCH -> title ${refused.title}, correction ${refused.addCorrection}, archive ${refused.archive}; server unchanged`)
    await logoutUi(page)
  })
})
