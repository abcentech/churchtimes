/**
 * `npm run import:rehearse -- [--posts 1000] [--images 60] [--seed N] [--keep]`
 * `npm run import:rehearse -- --file <real export.xml> [--uploads <dir>] [--uploads-detail-file <path>] [--dry-run-only] [--detail-file <path>] [--keep]
 *    [--category-mode strict|rules] [--category-review <csv outside the repo>] [--link-fixes <csv or json outside the repo>]`
 * With `--uploads` the uploads folder is checked first (same counts as `import:uploads-check`; `--uploads-detail-file` receives per-file detail).
 *
 * With `--file` the same throwaway database and temp media folder are used, but the export is a REAL one given by
 * the owner (read-only, outside every repository): inspect stats, conversion stats, loader dry run and, unless
 * `--dry-run-only`, apply, second apply (must change nothing) and rollback. COUNTS ONLY are printed; `--detail-file`
 * (outside every repository) receives legacy ids of posts needing attention. Without `--uploads` every image is
 * reported as unresolved: that is expected, not a failure.
 *
 * Full rehearsal of the WordPress import on a THROWAWAY embedded PostgreSQL (free port, temp data directory) with a
 * LARGE SYNTHETIC export generated into a temp folder outside the repository: dry run, apply, second apply (must be
 * a no-op), update, rollback (dry, then apply, then again). Prints a counts-only summary with timings, peak memory
 * and database query counts. Nothing real is read; everything it writes (database, export, uploads, manifests and the
 * media folder) lives in one temp folder that is removed at the end, also on Ctrl+C. Exit code 1 when any check fails.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import sharp from 'sharp'

import { convertWxrStats, formatConvertStats } from '../src/import/convertStats'
import { formatInspectReport, inspectWxr } from '../src/import/inspect'
import { formatLinkFixes, readLinkFixesFile } from '../src/import/linkFixes'
import { resolveSiteHosts } from '../src/import/linkSiteHosts'
import { resolveArticlePathTemplate } from '../src/lib/redirectPaths'
import { formatImportReport, reconcile } from '../src/import/qa'
import { openPrivateOut, writePrivateOut } from '../src/import/privateOut'
import { isInsideRepo } from '../src/import/safePaths'
import { checkUploads, formatUploadsCheck } from '../src/import/uploadsCheck'
import { readWxrFile } from '../src/import/wxr'
import { IMAGE_DIR, imageName, largeWxr } from '../tests/fixtures/wxr/large'

// --name=value is accepted as well as --name value
const argv = process.argv.slice(2).flatMap((a) => (/^--[a-z-]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]))
const num = (name: string, dflt: number): number => {
  const i = argv.indexOf(name)
  const n = i >= 0 ? Number(argv[i + 1]) : dflt
  if (!Number.isInteger(n) || n < 1) throw new Error(`bad ${name}`)
  return n
}
const POSTS = num('--posts', 1000)
const IMAGES = num('--images', 60)
const SEED = num('--seed', 20261021)
const KEEP = argv.includes('--keep')
const strArg = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  const v = i >= 0 ? argv[i + 1] : undefined
  if (i >= 0 && (!v || v.startsWith('--'))) throw new Error(`bad ${name}`)
  return v
}
const FILE = strArg('--file')
const UPLOADS = strArg('--uploads')
const DETAIL = strArg('--detail-file')
const LINK_FIXES = strArg('--link-fixes')
const UPLOADS_DETAIL = strArg('--uploads-detail-file')
const DRY_ONLY = argv.includes('--dry-run-only')
const CATEGORY_MODE = strArg('--category-mode')
const CATEGORY_REVIEW = strArg('--category-review')
if (CATEGORY_MODE !== undefined && CATEGORY_MODE !== 'strict' && CATEGORY_MODE !== 'rules') throw new Error('bad --category-mode')

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })

// Count every query sent to PostgreSQL by this process (Payload's pool and its transaction clients).
let queries = 0
const originalQuery = pg.Client.prototype.query as (...a: unknown[]) => unknown
;(pg.Client.prototype as { query: unknown }).query = function (this: unknown, ...a: unknown[]) {
  queries++
  return originalQuery.apply(this, a)
}

type Phase = { name: string; seconds: number; queries: number; peakRssMb: number; posts: number }
const phases: Phase[] = []
const checks: Array<{ name: string; ok: boolean }> = []
const check = (name: string, ok: boolean) => checks.push({ name, ok })
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10

async function timed<T>(name: string, posts: number, fn: () => Promise<T>): Promise<T> {
  let peak = process.memoryUsage().rss
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, 100)
  const q0 = queries
  const t0 = process.hrtime.bigint()
  try {
    return await fn()
  } finally {
    clearInterval(timer)
    peak = Math.max(peak, process.memoryUsage().rss)
    phases.push({ name, seconds: Number(process.hrtime.bigint() - t0) / 1e9, queries: queries - q0, peakRssMb: mb(peak), posts })
  }
}

type Real = {
  payload: unknown
  runImport: typeof import('../src/import/run').runImport
  runRollback: typeof import('../src/import/rollback').runRollback
  readManifest: typeof import('../src/import/manifest').readManifest
  manifestOf: (n: string) => string
  mediaDir: string
}

/** The real export: counts only. Every private value stays in the file; ids go to the detail file only. */
async function realRehearsal(r: Real): Promise<number> {
  const file = path.resolve(FILE as string)
  const uploadsRoot = UPLOADS ? path.resolve(UPLOADS) : undefined
  const payload = r.payload as Parameters<typeof r.runImport>[0]
  const counter = r.payload as { count: (a: object) => Promise<{ totalDocs: number }> }
  const count = async (collection: string) => (await counter.count({ collection, overrideAccess: true })).totalDocs
  const dbCounts = async () => ({ articles: await count('articles'), comments: await count('legacy-comments'), media: await count('media'), categories: await count('categories') })
  const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b)
  const zero = { articles: 0, comments: 0, media: 0, categories: 0 }
  console.log(`Import rehearsal against a REAL export (throwaway database, counts only). Export ${mb(fs.statSync(file).size)} MB; uploads folder: ${uploadsRoot ? 'given' : 'not given (images are reported as unresolved, expected)'}`)
  console.log('')
  console.log(formatInspectReport(await inspectWxr(readWxrFile(file))))
  console.log('')
  if (uploadsRoot) {
    // Read-only: the same counts as `npm run import:uploads-check`, so the folder is judged before anything is loaded.
    let fd: number | undefined
    if (UPLOADS_DETAIL) {
      // Created exclusively (never over an existing file), not the export, not inside the uploads folder (real paths compared).
      fd = openPrivateOut(UPLOADS_DETAIL, { inputs: [file], notInside: [uploadsRoot] })
    }
    try {
      const uc = await checkUploads(uploadsRoot, file, fd === undefined ? undefined : (l) => fs.writeSync(fd as number, `${JSON.stringify(l)}
`))
      console.log(formatUploadsCheck(uc))
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
    console.log('')
  }
  const siteHosts = resolveSiteHosts(process.env)
  const linkFixes = LINK_FIXES
    ? readLinkFixesFile(LINK_FIXES, { articleTemplate: resolveArticlePathTemplate(process.env), siteHosts: new Set([siteHosts.primary, ...siteHosts.legacy]) })
    : undefined
  const conv = await timed('conversion stats', 0, () => convertWxrStats(() => readWxrFile(file), { assumeImages: false, linkFixes }))
  console.log(formatConvertStats(conv.stats))
  if (conv.linkFixes) console.log(formatLinkFixes(conv.linkFixes))
  if (DETAIL) {
    writePrivateOut(DETAIL, `${JSON.stringify(conv.detail, null, 1)}\n`, { inputs: [file], notInside: uploadsRoot ? [uploadsRoot] : [] })
    console.log('Legacy ids of posts needing attention written to the detail file.')
  }
  console.log('')
  // Failed writes: a tally of error class, code and invalid field names (never values); the post ids go to the detail file only.
  const failTally: Record<string, number> = {}
  const failedIds: number[] = []
  const progress = (line: string) => {
    const m = /^article failed: (.*) id=(-?[0-9]+|null)$/.exec(line)
    if (!m) return
    failTally[m[1]] = (failTally[m[1]] ?? 0) + 1
    if (m[2] !== 'null') failedIds.push(Number(m[2]))
  }
  const base = { file, uploadsRoot, progress, linkFixesFile: LINK_FIXES, categoryMode: CATEGORY_MODE as 'strict' | 'rules' | undefined }
  const dry = await timed('dry-run', 0, () => r.runImport(payload, { ...base, dryRun: true, categoryReviewFile: CATEGORY_REVIEW }))
  phases[phases.length - 1].posts = dry.articles.created
  console.log(formatImportReport(dry))
  check('dry run wrote nothing', same(await dbCounts(), zero))
  check('every published post accounted for', reconcile(dry).difference === 0)
  check('no conversion or write failures in the dry run', !Object.keys(dry.articles.skipped).some((k) => k === 'write-failed' || k.startsWith('conversion-')))
  if (!DRY_ONLY) {
    const total = dry.articles.created
    const applied = await timed('apply', total, () => r.runImport(payload, { ...base, manifestPath: r.manifestOf('apply'), dryRun: false }))
    const afterApply = await dbCounts()
    console.log('')
    console.log(formatImportReport(applied))
    console.log(`Failed article writes by error (class, SQLSTATE, invalid fields): ${JSON.stringify(failTally)}`)
    if (DETAIL && failedIds.length > 0) {
      const prev = JSON.parse(fs.readFileSync(DETAIL, 'utf8')) as Record<string, unknown>
      fs.writeFileSync(DETAIL, `${JSON.stringify({ ...prev, applyFailed: failedIds }, null, 1)}
`, { mode: 0o600 })
    }
    const m1 = r.readManifest(r.manifestOf('apply'))
    check('apply matches the dry run (articles, comments, media)', dry.articles.created === applied.articles.created && dry.comments.created === applied.comments.created && dry.media.created === applied.media.created)
    check('apply verified in the database', applied.verified?.articlesInDatabase === applied.articles.created && afterApply.articles === applied.articles.created)
    check('apply wrote no failed posts', !applied.articles.skipped['write-failed'])
    check('manifest complete and matches the database', m1.complete && m1.articles.created.length === afterApply.articles && m1.comments.length === afterApply.comments)
    const second = await timed('apply again', total, () => r.runImport(payload, { ...base, manifestPath: r.manifestOf('apply2'), dryRun: false }))
    const m2 = r.readManifest(r.manifestOf('apply2'))
    check('second apply changed nothing', same(await dbCounts(), afterApply) && second.articles.created === 0 && second.media.created === 0 && second.comments.created === 0)
    check('second apply manifest lists no ids', m2.articles.created.length + m2.articles.updated.length + m2.media.length + m2.comments.length + m2.categories.length + m2.audits.length === 0)
    // Search projection and provenance (counts only): reindex, row count equals published count, generic public search smoke,
    // and no archive provenance on imported rows.
    {
      const { reindexArticleSearch, searchArticles } = await import('../src/lib/articleSearch')
      const { sql } = await import('drizzle-orm')
      const db = (r.payload as unknown as { db: { drizzle: { execute: (q: unknown) => Promise<{ rows: Array<Record<string, unknown>> }> } } }).db.drizzle
      const scalar = async (q: unknown) => Number(Object.values((await db.execute(q)).rows[0])[0])
      const published = await scalar(sql`select count(*) from "articles" where "status"::text = 'published'`)
      const before = await scalar(sql`select count(*) from "article_search"`)
      const ri = await timed('search:reindex', total, () => reindexArticleSearch(r.payload as never, { batchSize: 200 }))
      const rows = await scalar(sql`select count(*) from "article_search"`)
      console.log(`Search: published ${published}, article_search rows before reindex ${before}, after ${rows}; reindex scanned ${ri.scanned}, indexed ${ri.indexed}, removed stale ${ri.removedStale}`)
      check('article_search row count equals published count', rows === published && published > 0)
      const smoke: Record<string, number> = {}
      for (const q of ['church', 'nigeria', 'bishop', 'the', 'zzqxjvk']) {
        const res = await searchArticles(r.payload as never, { q, page: 1, limit: 10 })
        smoke[q] = res.totalDocs
      }
      console.log(`Search smoke (generic queries, total hits): ${JSON.stringify(smoke)}`)
      check('search smoke: generic queries hit, nonsense query does not', smoke.church > 0 && smoke.nigeria > 0 && smoke.zzqxjvk === 0)
      const prov = await scalar(sql`select count(*) from "articles" where "provenance_import_batch" is not null or "provenance_source_url" is not null or "provenance_source_host" is not null or "provenance_capture_timestamp" is not null or "provenance_original_date" is not null or "provenance_confidence" is not null or "provenance_review_status" is not null`)
      console.log(`Imported rows carrying archive provenance: ${prov}`)
      check('no archive provenance on imported rows', prov === 0)
    }
    const rbDry = await timed('rollback dry run', total, () => r.runRollback(payload, { manifestPath: r.manifestOf('apply'), force: true, includePublished: true }))
    check('rollback dry run deleted nothing', same(await dbCounts(), afterApply))
    const rb = await timed('rollback apply', total, () => r.runRollback(payload, { manifestPath: r.manifestOf('apply'), apply: true, force: true, includePublished: true }))
    check('rollback removed every created row', same(await dbCounts(), zero))
    check('rollback matched its dry run', rbDry.articles.wouldDelete === rb.articles.deleted && rbDry.comments.wouldDelete === rb.comments.deleted)
    check('rollback had no failures', rb.articles.failed + rb.comments.failed + rb.media.failed + rb.categories.failed === 0)
    const leftover = fs.existsSync(r.mediaDir) ? fs.readdirSync(r.mediaDir) : []
    check('media files removed with their documents', leftover.length === 0)
    console.log('')
    console.log(`Imported (apply): articles ${afterApply.articles}, comments ${afterApply.comments}, media ${afterApply.media}, categories ${afterApply.categories}`)
    console.log(`Rollback: articles ${rb.articles.deleted}, comments ${rb.comments.deleted}, media ${rb.media.deleted}, categories ${rb.categories.deleted}`)
    console.log('Second apply:', JSON.stringify({ articlesCreated: second.articles.created, unchanged: second.articles.unchanged, mediaCreated: second.media.created, commentsCreated: second.comments.created, commentsExisting: second.comments.existing }))
  }
  console.log('Phase                 seconds   queries  peak RSS MB')
  for (const p of phases) console.log(`${p.name.padEnd(20)} ${p.seconds.toFixed(1).padStart(8)} ${String(p.queries).padStart(9)} ${String(p.peakRssMb).padStart(12)}`)
  console.log(`Process peak RSS: ${mb(process.resourceUsage().maxRSS * 1024)} MB`)
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  const failed = checks.filter((c) => !c.ok).length
  console.log(failed === 0 ? 'Rehearsal passed.' : `Rehearsal FAILED (${failed} checks).`)
  return failed === 0 ? 0 : 1
}

async function main(): Promise<number> {
  if (FILE) {
    if (!fs.existsSync(FILE) || !fs.statSync(FILE).isFile()) throw new Error('REHEARSAL_FILE_UNREADABLE')
    if (isInsideRepo(FILE) || (UPLOADS && isInsideRepo(UPLOADS)) || (DETAIL && isInsideRepo(DETAIL))) throw new Error('REHEARSAL_PATH_INSIDE_REPO')
    if (UPLOADS && (!fs.existsSync(UPLOADS) || !fs.statSync(UPLOADS).isDirectory())) throw new Error('REHEARSAL_UPLOADS_UNREADABLE')
    if (DETAIL && fs.existsSync(DETAIL)) throw new Error('REHEARSAL_DETAIL_EXISTS')
    if (UPLOADS_DETAIL && (isInsideRepo(UPLOADS_DETAIL) || fs.existsSync(UPLOADS_DETAIL))) throw new Error('REHEARSAL_DETAIL_EXISTS')
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-rehearse-'))
  const dataDir = path.join(tmp, 'pgdata')
  const uploads = path.join(tmp, 'uploads')
  const exportFile = path.join(tmp, 'export.xml')
  const manifests = path.join(tmp, 'manifests')
  fs.mkdirSync(manifests)
  const manifestOf = (n: string) => path.join(manifests, `${n}.jsonl`)

  const port = await freePort()
  const user = 'churchtimes'
  const password = 'churchtimes-rehearse'
  const embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: () => {},
  })
  // The media folder is INSIDE the temp folder: the rehearsal never touches the real one.
  const mediaDir = path.join(tmp, 'media')
  let payloadRef: { destroy: () => Promise<void> } | undefined
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    try {
      await payloadRef?.destroy()
    } catch {
      // ignore
    }
    try {
      await embedded.stop()
    } catch {
      // ignore
    }
    if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  // Stopping PostgreSQL under an idle pool connection emits one late socket error: harmless once cleanup has started.
  process.on('uncaughtException', (err) => {
    // pg answers 57P01 (terminating connection due to administrator command) when embedded PostgreSQL stops under an idle pooled connection.
    if (cleaned && (/Connection terminated|ECONNRESET|terminating connection/i.test(err.message) || (err as { code?: string }).code === '57P01')) return
    console.error(`REHEARSAL_FAILED ${err.name}`)
    process.exit(1)
  })
  // Ctrl+C or a termination request: stop PostgreSQL and remove the temp folder, then leave.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      void cleanup().finally(() => process.exit(130))
    })
  }
  try {
    await embedded.initialise()
    await embedded.start()
    await embedded.createDatabase('churchtimes_rehearse')
    process.env.DATABASE_URL = `postgres://${user}:${password}@127.0.0.1:${port}/churchtimes_rehearse`
    // Deterministic, obviously fake values. Never real secrets.
    Object.assign(process.env, {
      PAYLOAD_SECRET: 'rehearsal-only-payload-secret-0123456789abcdef0123',
      PREVIEW_SECRET: 'rehearsal-only-preview-secret-0123456789abcdef',
      IP_HASH_SALT: 'rehearsal-only-ip-salt-0123456789',
      SCHEDULER_ENABLED: 'false',
      PAYLOAD_DB_PUSH: 'false',
    })
    delete process.env.TURNSTILE_SECRET_KEY

    // Imported only now: payload.config.ts reads the environment when it loads.
    const { getPayload } = await import('payload')
    const { default: config } = await import('../src/payload.config')
    const { migrations } = await import('../src/migrations')
    const { runImport } = await import('../src/import/run')
    const { runRollback } = await import('../src/import/rollback')
    const { readManifest } = await import('../src/import/manifest')

    // Before Payload boots: point the media collection at a folder inside the temp folder.
    const resolved = await config
    const mediaConfig = resolved.collections.find((c) => c.slug === 'media')
    if (!mediaConfig || typeof mediaConfig.upload !== 'object') throw new Error('media collection has no upload config')
    mediaConfig.upload.staticDir = mediaDir
    fs.mkdirSync(mediaDir, { recursive: true })
    const payload = await getPayload({ config: resolved })
    payloadRef = payload
    await payload.db.migrate({ migrations: migrations as never })

    if (FILE) return await realRehearsal({ payload, runImport, runRollback, readManifest, manifestOf, mediaDir })

    // Synthetic uploads and export.
    fs.mkdirSync(path.join(uploads, ...IMAGE_DIR.split('/')), { recursive: true })
    for (let n = 0; n < IMAGES; n++) {
      const png = await sharp({ create: { width: 160, height: 100, channels: 3, background: { r: (n * 37) % 256, g: (n * 91) % 256, b: (n * 53) % 256 } } }).png().toBuffer()
      fs.writeFileSync(path.join(uploads, ...IMAGE_DIR.split('/'), imageName(n)), png)
    }
    const gen = largeWxr({ posts: POSTS, images: IMAGES, idBase: 9_000_000, prefix: 'rh', seed: SEED })
    fs.writeFileSync(exportFile, gen.xml)
    const exportMb = mb(fs.statSync(exportFile).size)
    const base = { file: exportFile, uploadsRoot: uploads }
    const total = gen.expected.importablePosts

    const count = async (collection: string) => (await payload.count({ collection: collection as never, overrideAccess: true })).totalDocs
    const dbCounts = async () => ({ articles: await count('articles'), comments: await count('legacy-comments'), media: await count('media'), categories: await count('categories') })
    const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b)

    // 1. dry run
    const dry = await timed('dry-run', total, () => runImport(payload, { ...base, dryRun: true }))
    const afterDry = await dbCounts()
    check('dry run wrote nothing', same(afterDry, { articles: 0, comments: 0, media: 0, categories: 0 }))

    // 2. apply
    const applied = await timed('apply', total, () => runImport(payload, { ...base, manifestPath: manifestOf('apply'), dryRun: false }))
    const afterApply = await dbCounts()
    const applyManifest = readManifest(manifestOf('apply'))
    check('apply matches the dry run (articles, comments, media)', dry.articles.created === applied.articles.created && dry.comments.created === applied.comments.created && dry.media.created === applied.media.created)
    check('apply verified in the database', applied.verified?.articlesInDatabase === applied.articles.created && afterApply.articles === applied.articles.created)
    check('apply wrote no failed posts', !applied.articles.skipped['write-failed'])
    check('manifest complete and matches the database', applyManifest.complete && applyManifest.articles.created.length === afterApply.articles && applyManifest.comments.length === afterApply.comments)
    check('password posts withheld', applied.articles.passwordProtected === gen.expected.passwordPosts)

    // 3. second apply: a no-op
    const second = await timed('apply again', total, () => runImport(payload, { ...base, manifestPath: manifestOf('apply2'), dryRun: false }))
    const afterSecond = await dbCounts()
    const m2 = readManifest(manifestOf('apply2'))
    check('second apply changed nothing', same(afterSecond, afterApply) && second.articles.created === 0 && second.media.created === 0 && second.comments.created === 0)
    check('second apply manifest lists no ids', m2.articles.created.length + m2.articles.updated.length + m2.media.length + m2.comments.length + m2.categories.length + m2.audits.length === 0)

    // 4. update (rewrites what nobody edited; force, because the audit rows are what marks an article as untouched)
    const updated = await timed('update', total, () => runImport(payload, { ...base, manifestPath: manifestOf('update'), dryRun: false, update: true, forceUpdate: true }))
    const afterUpdate = await dbCounts()
    check('update rewrote articles and added no rows', updated.articles.updated > 0 && same(afterUpdate, afterApply))

    // 5. rollback: dry, apply (force: the update above counts as a later edit), then again
    const rbDry = await timed('rollback dry run', total, () => runRollback(payload, { manifestPath: manifestOf('apply'), force: true, includePublished: true }))
    check('rollback dry run deleted nothing', same(await dbCounts(), afterApply))
    const rbApply = await timed('rollback apply', total, () => runRollback(payload, { manifestPath: manifestOf('apply'), apply: true, force: true, includePublished: true }))
    const afterRollback = await dbCounts()
    check('rollback removed every created row', same(afterRollback, { articles: 0, comments: 0, media: 0, categories: 0 }))
    check('rollback matched its dry run', rbDry.articles.wouldDelete === rbApply.articles.deleted && rbDry.comments.wouldDelete === rbApply.comments.deleted)
    check('rollback had no failures', rbApply.articles.failed + rbApply.comments.failed + rbApply.media.failed + rbApply.categories.failed === 0)
    const rbAgain = await timed('rollback again', total, () => runRollback(payload, { manifestPath: manifestOf('apply'), apply: true, force: true, includePublished: true }))
    check('second rollback is a no-op', rbAgain.articles.deleted + rbAgain.comments.deleted + rbAgain.media.deleted + rbAgain.categories.deleted === 0)
    const leftover = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : []
    check('media files removed with their documents', leftover.length === 0)

    // Summary: counts only.
    const sec = (p: string) => phases.find((x) => x.name === p)!
    const rate = (p: Phase) => (p.seconds > 0 ? Math.round(p.posts / p.seconds) : 0)
    console.log('Import rehearsal (synthetic data, throwaway database)')
    console.log(`Export: ${POSTS} posts requested, ${IMAGES} images, ${exportMb} MB; importable posts ${total}, password ${gen.expected.passwordPosts}, draft ${gen.expected.draftPosts}`)
    console.log(`Imported: articles ${afterApply.articles}, comments ${afterApply.comments}, media ${afterApply.media}, categories ${afterApply.categories}; skipped ${JSON.stringify(applied.articles.skipped)}`)
    console.log(`Rollback: articles ${rbApply.articles.deleted}, comments ${rbApply.comments.deleted}, media ${rbApply.media.deleted}, categories ${rbApply.categories.deleted}`)
    console.log('Phase                 seconds  posts/sec   queries  peak RSS MB')
    for (const p of phases) console.log(`${p.name.padEnd(20)} ${p.seconds.toFixed(1).padStart(8)} ${String(rate(p)).padStart(10)} ${String(p.queries).padStart(9)} ${String(p.peakRssMb).padStart(12)}`)
    console.log(`Process peak RSS: ${mb(process.resourceUsage().maxRSS * 1024)} MB; queries per article on apply: ${(sec('apply').queries / Math.max(1, afterApply.articles)).toFixed(1)}`)
    for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`)
    const failed = checks.filter((c) => !c.ok).length
    console.log(failed === 0 ? 'Rehearsal passed.' : `Rehearsal FAILED (${failed} checks).`)
    return failed === 0 ? 0 : 1
  } finally {
    await cleanup()
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Never print the message (a database error carries its query and values).
    console.error(`REHEARSAL_FAILED ${err instanceof Error ? (/^REHEARSAL_[A-Z_]+$/.test(err.message) ? err.message : err.name) : 'Error'}`)
    process.exit(1)
  },
)
