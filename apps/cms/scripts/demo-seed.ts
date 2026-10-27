/**
 * Seeder for `npm run demo` (run by scripts/demo.ts with `payload run`; never run it by hand, never against a real database).
 *
 * EVERYTHING is invented. It reuses the synthetic export generator behind `npm run import:rehearse` and `npm run perf:read`
 * (tests/fixtures/wxr/large.ts) and the real import pipeline, so the demo exercises the same code the go-live import does.
 *
 * Env (set by demo.ts): DEMO_PASSWORDS_JSON (per-run random passwords, never logged), DEMO_WORK_DIR (outside every git work tree).
 * Idempotent: when the database already holds articles only the users, their passwords and the sections are refreshed.
 */
import fs from 'node:fs'
import path from 'node:path'

import config from '@payload-config'
import { getPayload, type Payload } from 'payload'
import sharp from 'sharp'

import { runArchiveImport } from '../src/import/archiveCandidates'
import { runImport } from '../src/import/run'
import { textToLexical } from '../src/endpoints/convertSubmission'
import { IMAGE_DIR, imageName, largeWxr } from '../tests/fixtures/wxr/large'
import { DEMO_CATEGORIES, DEMO_TARGETS, DEMO_USERS, stubMp4, tinyMp3, withRealCategories, type DemoPasswords } from './demo-lib'

const PREFIX = 'demo'
const workDir = process.env.DEMO_WORK_DIR
if (!workDir) throw new Error('DEMO_WORK_DIR is required (set by `npm run demo`).')
const passwords = JSON.parse(process.env.DEMO_PASSWORDS_JSON ?? '{}') as DemoPasswords
for (const u of DEMO_USERS) if (typeof passwords[u.key] !== 'string' || passwords[u.key].length < 12) throw new Error('DEMO_PASSWORDS_JSON is missing a password.')

const say = (m: string) => console.log(`[demo-seed] ${m}`)
type Row = Record<string, unknown> & { id: number }

async function categories(payload: Payload): Promise<Map<string, number>> {
  const ids = new Map<string, number>()
  for (const c of DEMO_CATEGORIES) {
    const found = await payload.find({ collection: 'categories', where: { slug: { equals: c.slug } }, limit: 1, overrideAccess: true })
    const doc = (found.docs[0] ?? (await payload.create({ collection: 'categories', data: { title: c.title, slug: c.slug }, overrideAccess: true }))) as unknown as Row
    ids.set(c.slug, doc.id)
  }
  return ids
}

async function users(payload: Payload, cat: Map<string, number>): Promise<Record<string, Row>> {
  const out: Record<string, Row> = {}
  for (const u of DEMO_USERS) {
    const sections = u.sections.map((s) => cat.get(s)).filter((n): n is number => n !== undefined)
    const data = { email: u.email, name: u.name, role: u.role, sections, password: passwords[u.key] } as never
    const found = await payload.find({ collection: 'users', where: { email: { equals: u.email } }, limit: 1, overrideAccess: true })
    const existing = found.docs[0] as unknown as Row | undefined
    out[u.key] = (existing
      ? await payload.update({ collection: 'users', id: existing.id, data, overrideAccess: true, context: { seed: true } })
      : await payload.create({ collection: 'users', data, overrideAccess: true, context: { seed: true } })) as unknown as Row
  }
  return out
}

async function main() {
  const payload = await getPayload({ config })
  fs.mkdirSync(workDir as string, { recursive: true })
  const cat = await categories(payload)
  const staff = await users(payload, cat)
  const admin = { ...staff.admin, collection: 'users' } as never
  say(`${DEMO_CATEGORIES.length} categories and ${DEMO_USERS.length} staff accounts ready`)

  const existing = await payload.count({ collection: 'articles', overrideAccess: true })
  if (existing.totalDocs > 0) {
    say(`database already holds ${existing.totalDocs} articles: kept as is (run with --reset for a fresh demo)`)
    await payload.destroy()
    return
  }

  // ---- 1. The synthetic archive through the real importer (articles, images, comments) -------------------------------
  const uploads = path.join(workDir as string, 'uploads')
  fs.mkdirSync(path.join(uploads, ...IMAGE_DIR.split('/')), { recursive: true })
  for (let n = 0; n < DEMO_TARGETS.images; n++) {
    const png = await sharp({ create: { width: 640, height: 400, channels: 3, background: { r: (n * 37) % 256, g: (n * 91) % 256, b: (n * 53) % 256 } } }).png().toBuffer()
    fs.writeFileSync(path.join(uploads, ...IMAGE_DIR.split('/'), imageName(n)), png)
  }
  const gen = largeWxr({ posts: DEMO_TARGETS.posts, images: DEMO_TARGETS.images, idBase: 9_000_000, prefix: PREFIX, seed: 20261021, maxComments: 6 })
  const exportFile = path.join(workDir as string, 'export.xml')
  fs.writeFileSync(exportFile, withRealCategories(gen.xml, PREFIX))
  say('importing synthetic archive (this takes a minute)')
  await runImport(payload, { file: exportFile, uploadsRoot: uploads, manifestPath: path.join(workDir as string, 'import-manifest.jsonl'), dryRun: false })

  // Spread the imported stories over all 15 sections (the generator only knows 12) and give them real-looking dates.
  const slugs = DEMO_CATEGORIES.map((c) => cat.get(c.slug) as number)
  const pool = (payload.db as unknown as { pool: { query: (t: string, v?: unknown[]) => Promise<{ rows: Array<Record<string, number>> }> } }).pool
  await pool.query(
    `UPDATE articles a SET category_id = ($1::int[])[1 + (r.n % $2::int)]
       FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM articles) r WHERE r.id = a.id`,
    [slugs, slugs.length],
  )

  // ---- 2. Audio/video articles with tiny valid files ------------------------------------------------------------------
  const upload = async (name: string, data: Buffer, mimetype: string, alt: string) =>
    (await payload.create({ collection: 'media', data: { alt }, file: { data, mimetype, name, size: data.length }, user: admin, overrideAccess: true })) as unknown as Row
  const mp3 = await upload('demo-sermon-clip.mp3', tinyMp3(), 'audio/mpeg', 'Demo sermon audio clip')
  const mp4 = await upload('demo-service-clip.mp4', stubMp4(), 'video/mp4', 'Demo service video clip')
  const av = (kind: 'audio' | 'video', media: number, title: string) => ({ type: 'block', version: 2, format: '', fields: { id: `demo${media}${kind}`, blockName: '', blockType: 'audioVideo', kind, media, title, caption: 'Demo file: not a real recording.' } })
  const withBlock = (text: string, ...blocks: unknown[]) => {
    const doc = textToLexical(text) as { root: { children: unknown[] } }
    doc.root.children.push(...blocks)
    return doc
  }
  const make = async (data: Record<string, unknown>, who: Row = staff.admin) =>
    (await payload.create({ collection: 'articles', data: data as never, user: { ...who, collection: 'users' } as never, overrideAccess: true, context: { seed: true } })) as unknown as Row
  const avSpecs: Array<[string, string, unknown]> = [
    ['Demo audio: a sermon clip', 'worship-music', av('audio', mp3.id, 'Sermon clip (audio)')],
    ['Demo video: a service highlight', 'news', av('video', mp4.id, 'Service highlight (video)')],
    ['Demo audio and video together', 'features', null],
  ]
  for (const [title, catSlug, block] of avSpecs) {
    await make({
      title,
      slug: `demo-av-${title.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`,
      category: cat.get(catSlug),
      status: 'published',
      publishedAt: new Date().toISOString(),
      content: withBlock('This demo story carries an audio or video block so you can see how media is stored and shown.', ...(block ? [block] : [av('audio', mp3.id, 'Sermon clip (audio)'), av('video', mp4.id, 'Service highlight (video)')])),
    })
  }
  say('3 audio/video stories created')

  // ---- 3. Workflow states: two in review, one scheduled, one draft, one changes-requested ----------------------------------
  const body = (t: string) => textToLexical(`${t}\n\nThis is invented demo text. Edit it, approve it, or send it back.`)
  await make({ title: 'Demo in review: diocese opens new clinic', slug: 'demo-in-review-clinic', category: cat.get('health'), status: 'in_review', content: body('A diocese opens a new clinic.'), author: staff.reporter.id }, staff.reporter)
  await make({ title: 'Demo in review: youth choir festival', slug: 'demo-in-review-choir', category: cat.get('youth'), status: 'in_review', content: body('Choirs gather for a festival.'), author: staff.reporter.id }, staff.reporter)
  await make({ title: 'Demo scheduled: harvest thanksgiving', slug: 'demo-scheduled-harvest', category: cat.get('news'), status: 'scheduled', scheduledFor: new Date(Date.now() + 2 * 86_400_000).toISOString(), content: body('Harvest thanksgiving services are planned.') })
  await make({ title: 'Demo draft: my unfinished report', slug: 'demo-draft-report', category: cat.get('news'), status: 'draft', content: body('Work in progress.'), author: staff.reporter.id }, staff.reporter)
  await make({ title: 'Demo changes requested: school appeal', slug: 'demo-changes-requested', category: cat.get('education'), status: 'changes_requested', reviewNotes: 'Please add a quote from the head teacher.', content: body('A school appeals for books.'), author: staff.reporter.id }, staff.reporter)
  say('workflow stories created (2 in review, 1 scheduled, 1 draft, 1 changes requested)')

  // ---- 4. Recovered archive drafts (archive-candidate/1 import, all pending review) ------------------------------------------
  const lines = Array.from({ length: DEMO_TARGETS.archiveDrafts }, (_, i) => {
    const n = i + 1
    return JSON.stringify({
      schema: 'archive-candidate/1',
      title: `Demo recovered story ${n}: parish news from 2014`,
      byline: 'Staff Reporter',
      date: `2014-0${n}-09`,
      bodyHtml: `<p>Recovered paragraph one for story ${n}. This text was rebuilt from an old web capture.</p><p>Second paragraph with a <a href="https://example.test/ref">link to check</a>.</p>`,
      originalUrl: `https://old-site.test/2014/0${n}/demo-recovered-${n}/`,
      canonicalUrl: null,
      host: 'old-site.test',
      captureTimestamp: '2020-01-15T10:20:30Z',
      rawSha256: Buffer.from(`demo-raw-${n}`).toString('hex').padEnd(64, '0').slice(0, 64),
      media: [],
      confidence: 'partial',
      reviewer: { assignee: null, notes: null },
    })
  })
  const candidates = path.join(workDir as string, 'archive-candidates.jsonl')
  fs.writeFileSync(candidates, lines.join('\n') + '\n')
  const manifests = path.join(workDir as string, 'archive-manifest')
  fs.mkdirSync(manifests, { recursive: true })
  const report = await runArchiveImport(payload, { file: candidates, apply: true, manifestDir: manifests, category: 'news', batch: 'demo-recovered' })
  say(`archive drafts imported: ${JSON.stringify(report.counts ?? report)}`.slice(0, 200))

  // ---- 5. Advertising and redirects ---------------------------------------------------------------------------------------
  const adv = (await payload.create({ collection: 'advertisers', data: { name: 'Demo Advertiser' } as never, overrideAccess: true })) as unknown as Row
  // Creatives must be exactly the placement size (970x250 desktop, 320x100 mobile for the homepage billboard).
  const creative = async (name: string, width: number, height: number) =>
    upload(name, await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 30 } } }).png().toBuffer(), 'image/png', `Demo advert ${width}x${height}`)
  const bbDesktop = await creative('demo-ad-970x250.png', 970, 250)
  const bbMobile = await creative('demo-ad-320x100.png', 320, 100)
  for (let i = 0; i < DEMO_TARGETS.campaigns; i++) {
    await payload.create({
      collection: 'ad-campaigns',
      data: { advertiser: adv.id, creatives: { homepageBillboard: { desktop: bbDesktop.id, mobile: bbMobile.id } }, sponsor: `Demo sponsor ${i + 1}`, alt: 'Demo offer', destinationUrl: 'https://example.test/offer', placements: ['homepage-billboard'], startsAt: new Date(Date.now() - 86_400_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000 * (3 + i)).toISOString(), priority: 10 * (i + 1) } as never,
      overrideAccess: true,
    })
  }
  await pool.query(`UPDATE ad_campaigns SET status = 'approved', rights_confirmed = true, payment_status = 'paid'`)
  await pool.query(
    `INSERT INTO redirects ("from", "to", status, source, updated_at, created_at)
     SELECT '/old-demo/' || g || '/', '/demo-av-demo-audio-a-sermon-clip/', 301, (CASE WHEN g % 2 = 0 THEN 'manual' ELSE 'rank-math' END)::enum_redirects_source, now(), now()
     FROM generate_series(1, $1::int) g`,
    [DEMO_TARGETS.redirects],
  )
  try {
    await payload.create({ collection: 'live-events', data: { title: 'Demo live event: synod opening', slug: 'demo-live-synod', summary: 'Follow the opening of the demo synod.', status: 'live', category: cat.get('news'), startedAt: new Date().toISOString() } as never, overrideAccess: true, context: { seed: true } })
  } catch (e) {
    say(`live event skipped (${e instanceof Error ? e.message.slice(0, 80) : 'error'})`)
  }

  // ---- Summary (counts only) -------------------------------------------------------------------------------------------------
  const n = async (sql: string) => Number((await pool.query(sql)).rows[0]?.n ?? 0)
  const summary = {
    publishedArticles: await n(`SELECT count(*)::int AS n FROM articles WHERE status = 'published'`),
    inReview: await n(`SELECT count(*)::int AS n FROM articles WHERE status = 'in_review'`),
    scheduled: await n(`SELECT count(*)::int AS n FROM articles WHERE status = 'scheduled'`),
    recoveredPendingReview: await n(`SELECT count(*)::int AS n FROM articles WHERE provenance_review_status = 'pending'`),
    comments: await n('SELECT count(*)::int AS n FROM legacy_comments'),
    campaigns: await n('SELECT count(*)::int AS n FROM ad_campaigns'),
    redirects: await n('SELECT count(*)::int AS n FROM redirects'),
    media: await n('SELECT count(*)::int AS n FROM media'),
  }
  say(`SUMMARY ${JSON.stringify(summary)}`)
  await payload.destroy()
}

try {
  await main()
  process.exit(0)
} catch (err) {
  console.error('[demo-seed] failed:', err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}` : err)
  process.exit(1)
}
