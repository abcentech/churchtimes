/**
 * `npm run import:rehearse -- [--posts 1000] [--images 60] [--seed N] [--keep]`
 *
 * Full rehearsal of the WordPress import on a THROWAWAY embedded PostgreSQL (free port, temp data directory) with a
 * LARGE SYNTHETIC export generated into a temp folder outside the repository: dry run, apply, second apply (must be
 * a no-op), update, rollback (dry, then apply, then again). Prints a counts-only summary with timings, peak memory
 * and database query counts. Nothing real is read; nothing outside the temp folder and the (gitignored) media folder
 * is written, and files added to the media folder are removed again. Exit code 1 when any check fails.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import sharp from 'sharp'

import { IMAGE_DIR, imageName, largeWxr } from '../tests/fixtures/wxr/large'

const argv = process.argv.slice(2)
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

async function main(): Promise<number> {
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
  let mediaDir: string | undefined
  let mediaBefore = new Set<string>()
  let payloadRef: { destroy: () => Promise<void> } | undefined
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

    const payload = await getPayload({ config })
    payloadRef = payload
    await payload.db.migrate({ migrations: migrations as never })
    mediaDir = path.resolve((payload.collections as any).media.config.upload.staticDir as string)
    mediaBefore = new Set(fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : [])

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
    const rbDry = await timed('rollback dry run', total, () => runRollback(payload, { manifestPath: manifestOf('apply'), force: true }))
    check('rollback dry run deleted nothing', same(await dbCounts(), afterApply))
    const rbApply = await timed('rollback apply', total, () => runRollback(payload, { manifestPath: manifestOf('apply'), apply: true, force: true }))
    const afterRollback = await dbCounts()
    check('rollback removed every created row', same(afterRollback, { articles: 0, comments: 0, media: 0, categories: 0 }))
    check('rollback matched its dry run', rbDry.articles.wouldDelete === rbApply.articles.deleted && rbDry.comments.wouldDelete === rbApply.comments.deleted)
    check('rollback had no failures', rbApply.articles.failed + rbApply.comments.failed + rbApply.media.failed + rbApply.categories.failed === 0)
    const rbAgain = await timed('rollback again', total, () => runRollback(payload, { manifestPath: manifestOf('apply'), apply: true, force: true }))
    check('second rollback is a no-op', rbAgain.articles.deleted + rbAgain.comments.deleted + rbAgain.media.deleted + rbAgain.categories.deleted === 0)
    const leftover = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).filter((f) => !mediaBefore.has(f)) : []
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
    try {
      await payloadRef?.destroy()
    } catch {
      // ignore
    }
    // Remove any file this run left in the media folder (a failed rollback, a crash), never one that was there before.
    if (mediaDir && fs.existsSync(mediaDir)) {
      for (const f of fs.readdirSync(mediaDir)) if (!mediaBefore.has(f)) fs.rmSync(path.join(mediaDir, f), { force: true })
    }
    try {
      await embedded.stop()
    } catch {
      // ignore
    }
    if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Never print the message (a database error carries its query and values).
    console.error(`REHEARSAL_FAILED ${err instanceof Error ? err.name : 'Error'}`)
    process.exit(1)
  },
)
