/**
 * `npm run demo [-- --reset]`: the whole system on this computer for hand testing. No Docker, no env editing.
 *
 *   embedded PostgreSQL (free port) -> migrations -> synthetic dataset (scripts/demo-seed.ts) -> CMS (next start when a
 *   production build exists, else next dev --webpack) -> newsroom app and public site (Vite builds pointed at this CMS).
 *
 * Wiring (CORS/CSRF origins, Turnstile test keys, article path) follows e2e/cross-app/support/stack.ts. Everything is local-only:
 * http://localhost, Cloudflare's always-pass Turnstile TEST keys, e-mail off. The random per-run passwords are written ONLY to
 * the login file (outside every git work tree) and are never printed. Data lives in a folder outside git, so a second run
 * keeps your data; `--reset` wipes it. Ctrl+C stops everything.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import EmbeddedPostgres from 'embedded-postgres'

import { articlePath, resolveArticlePathConfig } from '../e2e/cross-app/support/articlePath'
import { startPublicHost, startStaticServer, type StaticServer } from '../e2e/cross-app/support/static-server'
import { TURNSTILE_ACTION, TURNSTILE_TEST_SITE_KEY } from '../e2e/cross-app/support/stack'
import {
  assertOutsideRepo,
  DEMO_USERS,
  formatLoginsFile,
  generatePasswords,
  isDeletableDemoDataDir,
  parseDemoArgs,
  resolveDemoPaths,
  writeLoginsFile,
} from './demo-lib'

const here = path.dirname(fileURLToPath(import.meta.url))
const cmsRoot = path.resolve(here, '..')
const repoRoot = path.resolve(cmsRoot, '../..')
const log = (...a: unknown[]) => console.log('[demo]', ...a)
const rand = (n = 32) => randomBytes(n).toString('hex')

let pg: EmbeddedPostgres | undefined
let cms: ChildProcess | undefined
let statics: StaticServer[] = []
let stopping = false
let dataDirForCleanup = ''
const cmsTail: string[] = []

function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function shutdown(code: number): Promise<never> {
  if (stopping) process.exit(code)
  stopping = true
  console.log('\n[demo] Stopping everything...')
  await Promise.allSettled(statics.map((s) => s.close()))
  if (cms) killTree(cms.pid)
  if (pg) {
    try {
      await pg.stop()
    } catch {
      // the data folder is checked for an orphaned server on the next start
    }
  }
  try {
    fs.rmSync(path.join(dataDirForCleanup, 'running.json'), { force: true })
  } catch {
    // ignore
  }
  console.log('[demo] Stopped. Your demo data is kept; run again to continue, or add --reset for a fresh start.')
  process.exit(code)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => void shutdown(0))

const freePort = (start: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      if (p > start + 200) return reject(new Error(`No free port found from ${start} upwards.`))
      const s = net.createServer()
      s.once('error', () => tryPort(p + 1))
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(p)))
    }
    tryPort(start)
  })

async function waitHttp(url: string, timeoutMs: number, label: string): Promise<void> {
  const end = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < end) {
    if (cms && cms.exitCode !== null) throw new Error(`${label}: the CMS process stopped.\n${cmsTail.join('').slice(-2500)}`)
    try {
      const r = await fetch(url, { redirect: 'manual' })
      if (r.status < 500) return
      last = `HTTP ${r.status}`
    } catch (e) {
      last = String((e as Error).message)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`${label} did not become ready at ${url} (${last}).\n${cmsTail.join('').slice(-2500)}`)
}

function runNode(args: string[], env: NodeJS.ProcessEnv, label: string, cwd = cmsRoot, timeoutMs = 900_000): string {
  const res = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '')
  if (res.status !== 0) throw new Error(`${label} failed (exit ${res.status}):\n${out.slice(-3000)}`)
  return out
}

function preparePagesLayout(dist: string): void {
  const site = path.join(dist, 'site')
  fs.mkdirSync(site, { recursive: true })
  for (const f of fs.readdirSync(dist)) if (f !== 'index.html' && f !== 'site') fs.renameSync(path.join(dist, f), path.join(site, f))
  const entry = path.join(dist, 'index.html')
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace(/(src|href)="\.\//g, '$1="./site/'))
}

const isNodeProcess = (pid: number): boolean => {
  if (!alive(pid)) return false
  const r = process.platform === 'win32' ? spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }) : spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' })
  return /node/i.test(r.stdout ?? '')
}

/** A previous demo that was not stopped with Ctrl+C (window closed) leaves its servers running: stop them (pids are recorded in the data folder). */
function stopPreviousRun(dataDir: string): void {
  const file = path.join(dataDir, 'running.json')
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8')) as { orchestrator?: number; cms?: number }
    for (const pid of [old.cms, old.orchestrator]) {
      if (typeof pid === 'number' && pid !== process.pid && isNodeProcess(pid)) {
        log(`Stopping a previous demo that is still running (process ${pid}).`)
        killTree(pid)
      }
    }
  } catch {
    // none recorded
  }
  fs.rmSync(file, { force: true })
}

/** An embedded PostgreSQL that an earlier run left behind (window closed instead of Ctrl+C) still holds the data folder: stop it. */
function stopOrphanedPostgres(pgDir: string): void {
  const pidFile = path.join(pgDir, 'postmaster.pid')
  if (!fs.existsSync(pidFile)) return
  const pid = Number(fs.readFileSync(pidFile, 'utf8').split(/\r?\n/)[0])
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
    log(`An earlier demo database (process ${pid}) is still running on this data folder; stopping it.`)
    killTree(pid)
    const end = Date.now() + 10_000
    while (alive(pid) && Date.now() < end) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)'])
  }
  fs.rmSync(pidFile, { force: true })
}

async function main(): Promise<void> {
  const args = parseDemoArgs(process.argv.slice(2))
  if (args.help) {
    console.log('npm run demo [-- --reset] [--no-public] [--no-newsroom] [--build]\n  --reset  wipe the demo data and start fresh\n  --build  run `next build` first (slower start, much faster pages)\n  --no-public / --no-newsroom  skip that site')
    return
  }

  const { dataDir, loginsFile } = resolveDemoPaths()
  assertOutsideRepo(dataDir, 'The demo data folder', cmsRoot)
  assertOutsideRepo(loginsFile, 'The demo login file', cmsRoot)

  const freeGb = os.freemem() / 1024 ** 3
  if (freeGb < 2) log(`WARNING: only ${freeGb.toFixed(1)} GB of memory is free. Close other programs (browser tabs, Teams, Zoom) or this may be very slow or stop.`)

  dataDirForCleanup = dataDir
  const pgDir = path.join(dataDir, 'pg')
  const mediaDir = path.join(dataDir, 'media')
  const workDir = path.join(dataDir, 'seed-work')
  const buildDir = path.join(dataDir, 'build')
  if (args.reset) {
    if (!isDeletableDemoDataDir(dataDir)) throw new Error(`Refusing to delete "${dataDir}": the folder name must start with "demo" and be outside every git work tree.`)
    stopPreviousRun(dataDir)
    stopOrphanedPostgres(pgDir)
    log(`--reset: deleting ${dataDir}`)
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
  for (const d of [dataDir, mediaDir]) fs.mkdirSync(d, { recursive: true })

  // ---- 1. Database -------------------------------------------------------------------------------------------------------
  stopPreviousRun(dataDir)
  stopOrphanedPostgres(pgDir)
  const pgPort = await freePort(54340)
  const dbUser = 'churchtimes'
  const dbPass = 'churchtimes-demo-local' // loopback-only database on this computer; not a secret
  pg = new EmbeddedPostgres({ databaseDir: pgDir, user: dbUser, password: dbPass, port: pgPort, persistent: true, onLog: () => {}, onError: () => {} })
  const fresh = !fs.existsSync(path.join(pgDir, 'PG_VERSION'))
  if (fresh) await pg.initialise()
  log(`starting the database on port ${pgPort}${fresh ? ' (new)' : ''}`)
  await pg.start()
  try {
    await pg.createDatabase('churchtimes_demo')
  } catch (e) {
    if (!/already exists/i.test(String((e as Error)?.message ?? e))) throw e
  }

  // ---- 2. Ports, URLs and environment ------------------------------------------------------------------------------------
  const cmsPort = await freePort(3000)
  const newsroomPort = await freePort(5174)
  const publicPort = await freePort(newsroomPort === 5173 ? 5175 : 5173)
  const cmsUrl = `http://localhost:${cmsPort}`
  const newsroomUrl = `http://localhost:${newsroomPort}`
  const publicUrl = `http://localhost:${publicPort}`
  const articlePaths = resolveArticlePathConfig(repoRoot)

  const hasBuild = fs.existsSync(path.join(cmsRoot, '.next', 'BUILD_ID'))
  const useBuild = hasBuild && !args.build
  if (args.build) {
    log('building the CMS (next build), this takes several minutes the first time')
    runNode([path.join(cmsRoot, 'node_modules/next/dist/bin/next'), 'build'], { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: '--no-deprecation' }, 'next build', cmsRoot, 1_800_000)
  }
  const runBuild = useBuild || args.build
  const passwords = generatePasswords()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: runBuild ? 'production' : 'development',
    DATABASE_URL: `postgres://${dbUser}:${dbPass}@127.0.0.1:${pgPort}/churchtimes_demo`,
    PAYLOAD_SECRET: rand(32),
    PREVIEW_SECRET: rand(32),
    IP_HASH_SALT: rand(16),
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', // Cloudflare's documented always-pass TEST secret
    TURNSTILE_EXPECTED_ACTION: '',
    TURNSTILE_ALLOWED_HOSTNAMES: '',
    CMS_PUBLIC_URL: cmsUrl,
    PUBLIC_ARTICLE_PATH_TEMPLATE: articlePaths.articlePathTemplate,
    CMS_CORS_ORIGINS: `${newsroomUrl},${publicUrl}`,
    CMS_CSRF_ORIGINS: `${newsroomUrl},${publicUrl}`,
    PUBLIC_SUBMISSION_ORIGINS: `${newsroomUrl},${publicUrl}`,
    CMS_ALLOW_INSECURE_LOCAL_STAGING: 'true',
    ALLOW_FIRST_REGISTER: 'false',
    TRUST_PROXY: 'true',
    TRUST_PROXY_HOPS: '1',
    CLIENT_IP_HEADER: '',
    AUTH_LOGIN_RATE_LIMIT: '200',
    SUBMISSION_RATE_LIMIT: '200',
    SUBMISSION_EMAIL_RATE_LIMIT: '200',
    SMTP_HOST: '',
    SCHEDULER_ENABLED: 'true',
    SCHEDULER_INTERVAL_SECONDS: '15',
    PAYLOAD_DB_PUSH: 'false',
    MEDIA_DIR: mediaDir,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: '--no-deprecation',
  }
  delete env.STAGING_URL

  // The login file is written BEFORE anything can use the passwords, and is the only place they appear.
  writeLoginsFile(loginsFile, formatLoginsFile({ cms: cmsUrl, newsroom: args.noNewsroom ? undefined : newsroomUrl }, passwords), cmsRoot)

  // ---- 3. Migrations and data ---------------------------------------------------------------------------------------------
  const payloadBin = path.join(cmsRoot, 'node_modules/payload/bin.js')
  log('preparing the database tables')
  runNode([payloadBin, 'migrate'], env, 'payload migrate')
  log('adding demo data (first run takes 1 to 3 minutes)')
  const seedOut = runNode([payloadBin, 'run', 'scripts/demo-seed.ts'], { ...env, DEMO_WORK_DIR: workDir, DEMO_PASSWORDS_JSON: JSON.stringify(passwords) }, 'demo seed')
  for (const l of seedOut.split(/\r?\n/)) if (l.startsWith('[demo-seed]')) console.log(l)

  // ---- 4. CMS ----------------------------------------------------------------------------------------------------------------
  const nextBin = path.join(cmsRoot, 'node_modules/next/dist/bin/next')
  const nextArgs = runBuild ? ['start', '-p', String(cmsPort), '-H', '127.0.0.1'] : ['dev', '--webpack', '-p', String(cmsPort), '-H', '127.0.0.1']
  log(runBuild ? `starting the CMS from the production build on port ${cmsPort}` : `starting the CMS in development mode (no production build found) on port ${cmsPort}`)
  cms = spawn(process.execPath, [nextBin, ...nextArgs], { cwd: cmsRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const cmsLog = fs.createWriteStream(path.join(dataDir, 'cms.log'), { flags: 'w' }) // for troubleshooting; holds no passwords
  const keep = (b: Buffer) => {
    cmsLog.write(b)
    cmsTail.push(b.toString())
    if (cmsTail.length > 200) cmsTail.shift()
  }
  cms.stdout?.on('data', keep)
  cms.stderr?.on('data', keep)
  cms.on('exit', (code) => {
    if (!stopping) {
      console.error(`\n[demo] The CMS stopped by itself (exit ${code}). Last output:\n${cmsTail.join('').slice(-2500)}`)
      void shutdown(1)
    }
  })
  fs.writeFileSync(path.join(dataDir, 'running.json'), JSON.stringify({ orchestrator: process.pid, cms: cms.pid }))
  log('waiting for the CMS' + (runBuild ? '' : ' (development mode compiles on first use: 1 to 3 minutes)'))
  await waitHttp(`${cmsUrl}/api/categories?limit=1`, 900_000, 'CMS')
  for (const warm of ['/api/articles?limit=1', '/api/public/search?q=church', '/admin']) {
    await waitHttp(`${cmsUrl}${warm}`, 600_000, `CMS ${warm}`).catch(() => undefined)
  }

  // ---- 5. Newsroom app and public site ----------------------------------------------------------------------------------------
  const viteBin = path.join(repoRoot, 'node_modules/vite/bin/vite.js')
  const buildEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' }
  for (const k of Object.keys(buildEnv)) if (k.startsWith('VITE_')) delete buildEnv[k]
  let newsroomOk = false
  let publicOk = false
  if (!args.noNewsroom) {
    try {
      log('building the newsroom app')
      const dir = path.join(buildDir, 'newsroom')
      runNode([viteBin, 'build', 'apps/newsroom', '--outDir', dir, '--emptyOutDir', '--logLevel', 'warn'], { ...buildEnv, VITE_CMS_URL: cmsUrl, VITE_PUBLIC_SITE_URL: publicUrl, VITE_TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY }, 'newsroom build', repoRoot, 600_000)
      statics.push(await startStaticServer(dir, newsroomPort))
      newsroomOk = true
    } catch (e) {
      log('The newsroom app could not start:', (e as Error).message.split('\n').slice(0, 4).join(' | '))
    }
  }
  if (!args.noPublic) {
    try {
      log('building the public site')
      const dir = path.join(buildDir, 'public')
      runNode([viteBin, 'build', '--outDir', dir, '--emptyOutDir', '--logLevel', 'warn'], { ...buildEnv, VITE_PUBLIC_CMS_URL: cmsUrl, VITE_PUBLIC_SUBMISSIONS_URL: '', VITE_TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY, VITE_TURNSTILE_ACTION: TURNSTILE_ACTION }, 'public site build', repoRoot, 600_000)
      preparePagesLayout(dir)
      statics.push(await startPublicHost(repoRoot, dir, publicPort, cmsUrl, articlePaths))
      publicOk = true
    } catch (e) {
      log('The public site could not start:', (e as Error).message.split('\n').slice(0, 4).join(' | '))
    }
  }

  // ---- 6. What to open ---------------------------------------------------------------------------------------------------------
  let sample = ''
  try {
    const r = (await (await fetch(`${cmsUrl}/api/articles?limit=1&sort=-publishedAt`)).json()) as { docs?: Array<{ slug?: string }> }
    if (r.docs?.[0]?.slug) sample = r.docs[0].slug
  } catch {
    // optional
  }
  const rows: Array<[string, string]> = [
    ['CMS admin (log in here)', `${cmsUrl}/admin`],
    ['CMS API: search', `${cmsUrl}/api/public/search?q=church`],
    ['CMS API: articles', `${cmsUrl}/api/articles`],
    ['CMS API: categories', `${cmsUrl}/api/categories`],
    ...(newsroomOk ? ([['Newsroom app (staff)', newsroomUrl]] as Array<[string, string]>) : []),
    ...(publicOk ? ([['Public website', publicUrl], ...(sample ? [['Public article example', `${publicUrl}${articlePath(articlePaths, sample)}`] as [string, string]] : [])] as Array<[string, string]>) : []),
  ]
  const w = Math.max(...rows.map((r) => r[0].length))
  console.log('\n' + '='.repeat(78))
  console.log(' DEMO IS READY. Open these in your browser:')
  console.log('='.repeat(78))
  for (const [k, v] of rows) console.log(` ${k.padEnd(w)}  ${v}`)
  console.log('-'.repeat(78))
  console.log(` Logins (email + password for every role): ${loginsFile}`)
  console.log(` Emails: ${DEMO_USERS.map((u) => u.email.replace('@churchtimes.local', '')).join(', ')}  @churchtimes.local`)
  console.log(` Your data folder: ${dataDir}`)
  console.log('-'.repeat(78))
  console.log(' WHAT TO TRY')
  const todo = [
    'Log in at the admin screen and in the newsroom app as each of the five roles (open the login file for the passwords).',
    'As the reporter: write a story in the newsroom app and send it for review. As the editor-in-chief: approve and publish it.',
    'Open the review queue and approve one of the 2 "Demo in review" stories.',
    'Open the archive review screen: 5 recovered stories wait there. As the SECTION EDITOR approve one, then try to publish it as that same section editor (it is blocked). Publish it as the ADMIN (allowed).',
    'Search (public site or the search API URL above) for "church"; open a result.',
    'Upload a photo to a story (newsroom app or admin > Media) and see it on the story.',
    'Schedule a story for a few minutes ahead and watch it publish by itself (the scheduler checks every 15 seconds). One story is already scheduled for 2 days ahead.',
    'Open the three "Demo audio/video" stories (audio and video blocks; the video file is a stub and will not play).',
  ]
  todo.forEach((t, i) => console.log(` ${i + 1}. ${t}`))
  console.log('-'.repeat(78))
  console.log(' Press Ctrl+C in this window to stop everything. Next time: `npm run demo` (keeps your data) or `npm run demo -- --reset` (fresh).')
  if (!runBuild) console.log(' Tip: this is development mode, so the first click on each page is slow. `npm run demo -- --build` once makes it much faster.')
  console.log('='.repeat(78))
}

try {
  await main()
  if (!stopping && (pg || cms)) setInterval(() => {}, 1 << 30) // keep running until Ctrl+C
} catch (err) {
  console.error('\n[demo] FAILED:', err instanceof Error ? err.message : err)
  await shutdown(1)
}
