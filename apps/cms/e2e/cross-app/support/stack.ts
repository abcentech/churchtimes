/**
 * Boots / stops the disposable cross-app stack:
 *   embedded PostgreSQL -> migrations -> synthetic seed -> `next start` (existing .next build) behind a recording
 *   proxy -> Vite build of the REAL public site -> Vite build of the REAL newsroom SPA -> two static servers.
 * Everything lives in an OS temp dir that is removed on teardown. No secret is printed; secrets are random per run.
 *
 * Ports (strict, this lane only): CMS 3400 (proxy) / 3401 (next start), PostgreSQL 55435, public 5373, newsroom 5374,
 * public gap build 5375; each shifted by XAPP_PORT_OFFSET.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import EmbeddedPostgres from 'embedded-postgres'

import { startRecorder, type Recorder } from '../../browser/support/recorder'
import { webkitHttpCookieCompat } from './cookie-compat'
import { startPublicHost, startStaticServer, type StaticServer } from './static-server'

const here = path.dirname(fileURLToPath(import.meta.url))
export const cmsRoot = path.resolve(here, '../../..')
export const repoRoot = path.resolve(cmsRoot, '../..')

/** XAPP_PORT_OFFSET (0-1000, default 0) shifts every port so several checkouts can run this lane side by side. */
const PORT_OFFSET = (() => {
  const raw = process.env.XAPP_PORT_OFFSET ?? '0'
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || n > 1000) throw new Error(`XAPP_PORT_OFFSET must be an integer 0-1000, got "${raw}"`)
  return n
})()
export const PORTS = {
  cms: 3400 + PORT_OFFSET,
  cmsInternal: 3401 + PORT_OFFSET,
  pg: 55435 + PORT_OFFSET,
  public: 5373 + PORT_OFFSET,
  newsroom: 5374 + PORT_OFFSET,
  publicGap: 5375 + PORT_OFFSET,
} as const
export const HOSTS = {
  cms: `http://cms.churchtimes.localhost:${PORTS.cms}`,
  newsroom: `http://newsroom.churchtimes.localhost:${PORTS.newsroom}`,
  public: `http://www.churchtimes.localhost:${PORTS.public}`,
  /** Public site built exactly as docs/staging.md says (VITE_PUBLIC_CMS_URL only), as a regression without an endpoint override. */
  publicGap: `http://www.churchtimes.localhost:${PORTS.publicGap}`,
} as const

/** Cloudflare's documented always-pass TEST keys (public values, not secrets). */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA'
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA'
export const TURNSTILE_ACTION = 'submit-story'

export type XappConfig = {
  cmsUrl: string
  newsroomOrigin: string
  publicOrigin: string
  publicGapOrigin: string
  credentials: Record<string, { email: string; password: string; id: number; /** display name, remote mode only (optional) */ name?: string }>
  categoryId: number
  categoryTitle: string
  recorderUrl: string
  /** REMOTE mode only (XAPP_REMOTE=1, support/remote.ts): origin for Node-side API calls (the deployed CMS). Local mode derives it from recorderUrl. */
  apiBase?: string
  /** REMOTE mode only: true when running against a deployed https staging (nothing booted, no recording proxy). */
  remote?: boolean
  /** Set when `vite build apps/newsroom` failed: every newsroom journey must fail with this message. */
  newsroomBuildError?: string
  /** Prefix of every media filename the suite uploads (swept from apps/cms/media on teardown). */
  runId: string
  fixtureDir: string
  /** Absolute path of the evidence directory (docs/evidence). */
  evidenceDir: string
}

let pg: EmbeddedPostgres | undefined
let cms: ChildProcess | undefined
let recorder: Recorder | undefined
let statics: StaticServer[] = []
let tmpDir: string | undefined
let runId: string | undefined
let cmsStopping = false
const cmsTail: string[] = []

const log = (...a: unknown[]) => console.log('[xapp-stack]', ...a)
const rand = (n = 32) => randomBytes(n).toString('hex')

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

const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })

async function waitHttp(url: string, timeoutMs: number, label: string): Promise<void> {
  const end = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { redirect: 'manual' })
      if (r.status < 500) return
      last = `HTTP ${r.status}`
    } catch (e) {
      last = String((e as Error).message)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`${label} did not become ready at ${url} (${last})`)
}

function runNode(args: string[], env: NodeJS.ProcessEnv, label: string, cwd = cmsRoot, timeoutMs = 300_000): void {
  const res = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs })
  if (res.status !== 0) {
    // These tools print no secrets (we never print env or credentials).
    throw new Error(`${label} failed (exit ${res.status}):\n${(res.stdout ?? '').slice(-2500)}\n${(res.stderr ?? '').slice(-2500)}`)
  }
}

/** The same transformation tools/prepare-pages.mjs applies to repo-root/dist, applied to an arbitrary directory. */
function preparePagesLayout(dist: string): void {
  const site = path.join(dist, 'site')
  fs.mkdirSync(site, { recursive: true })
  for (const f of fs.readdirSync(dist)) if (f !== 'index.html' && f !== 'site') fs.renameSync(path.join(dist, f), path.join(site, f))
  const entry = path.join(dist, 'index.html')
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace(/(src|href)="\.\//g, '$1="./site/'))
}

export async function startStack(): Promise<XappConfig> {
  for (const p of [PORTS.cms, PORTS.cmsInternal, PORTS.pg, PORTS.public, PORTS.newsroom, PORTS.publicGap]) {
    if (!(await portFree(p))) throw new Error(`Port ${p} is already in use; stop whatever holds it and retry.`)
  }
  const nextBuildId = path.join(cmsRoot, '.next', 'BUILD_ID')
  if (!fs.existsSync(nextBuildId)) {
    throw new Error('apps/cms/.next is missing. This lane never runs `next build`: run `npm run build` in apps/cms once, then retry.')
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-e2e-xapp-'))
  runId = `xapp${Date.now().toString(36)}`
  const dbUser = 'ct_xapp'
  const dbPass = rand(12)

  log('starting embedded PostgreSQL on', PORTS.pg)
  pg = new EmbeddedPostgres({
    databaseDir: path.join(tmpDir, 'pg'),
    user: dbUser,
    password: dbPass,
    port: PORTS.pg,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase('ct_xapp')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: `postgres://${dbUser}:${dbPass}@127.0.0.1:${PORTS.pg}/ct_xapp`,
    PAYLOAD_SECRET: rand(32),
    PREVIEW_SECRET: rand(32),
    IP_HASH_SALT: rand(16),
    TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET,
    // Cloudflare's TEST secret answers success WITHOUT an `action` (and hostname "example.com"), so any non-empty
    // TURNSTILE_EXPECTED_ACTION / TURNSTILE_ALLOWED_HOSTNAMES would (correctly) fail closed. Action/hostname enforcement is
    // therefore not exercised by this lane (it is covered by the CMS unit tests with a stubbed siteverify transport).
    // The public form still sends action "submit-story" (src/forms/public-form.js default).
    TURNSTILE_EXPECTED_ACTION: '',
    TURNSTILE_ALLOWED_HOSTNAMES: '',
    CMS_PUBLIC_URL: HOSTS.cms,
    CMS_CORS_ORIGINS: `${HOSTS.newsroom},${HOSTS.public}`,
    CMS_CSRF_ORIGINS: `${HOSTS.newsroom},${HOSTS.public}`,
    PUBLIC_SUBMISSION_ORIGINS: `${HOSTS.newsroom},${HOSTS.public}`,
    CMS_ALLOW_INSECURE_LOCAL_STAGING: 'true',
    TRUST_PROXY: 'true', // required in production; browsers send no X-Forwarded-For (one shared loopback bucket)
    TRUST_PROXY_HOPS: '1',
    CLIENT_IP_HEADER: '',
    // This instance only: every browser shares one loopback bucket, so raise the in-memory limits.
    AUTH_LOGIN_RATE_LIMIT: '500',
    SUBMISSION_RATE_LIMIT: '500',
    SUBMISSION_EMAIL_RATE_LIMIT: '500',
    SMTP_HOST: '',
    SCHEDULER_ENABLED: 'true', // spec 08 needs the real in-process scheduler (2 s tick); it only touches status=scheduled articles
    SCHEDULER_INTERVAL_SECONDS: '2',
    PAYLOAD_DB_PUSH: 'false',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: '--no-deprecation',
  }
  delete env.STAGING_URL

  const payloadBin = path.join(cmsRoot, 'node_modules/payload/bin.js')
  log('applying migrations')
  runNode([payloadBin, 'migrate'], env, 'payload migrate')

  log('seeding synthetic users, category and articles')
  const seedOut = path.join(tmpDir, 'seed.json')
  runNode([payloadBin, 'run', 'e2e/browser/support/seed.ts'], { ...env, CT_SEED_OUT: seedOut }, 'seed')
  const seeded = JSON.parse(fs.readFileSync(seedOut, 'utf8')) as { credentials: XappConfig['credentials']; categoryId: number }
  fs.rmSync(seedOut, { force: true })

  log(`starting next start on ${PORTS.cmsInternal} behind the recording proxy on ${PORTS.cms}`)
  const nextBin = path.join(cmsRoot, 'node_modules/next/dist/bin/next')
  cms = spawn(process.execPath, [nextBin, 'start', '-p', String(PORTS.cmsInternal), '-H', '127.0.0.1'], {
    cwd: cmsRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  cmsTail.length = 0
  cmsStopping = false
  const keep = (b: Buffer) => {
    cmsTail.push(b.toString())
    if (cmsTail.length > 200) cmsTail.shift()
  }
  cms.stdout?.on('data', keep)
  cms.stderr?.on('data', keep)
  cms.on('exit', (code, signal) => {
    const how = signal ? `signal ${signal}` : `code ${code}`
    if (cmsStopping) log(`next start stopped by teardown (${how}; non-zero after a forced kill is expected, not a crash)`)
    else {
      log(`UNEXPECTED: next start exited on its own with ${how}`)
      log('--- next start output (tail) ---\n' + cmsTail.join('').slice(-2000))
    }
  })

  try {
    recorder = await startRecorder(PORTS.cms, PORTS.cmsInternal, webkitHttpCookieCompat)
    await waitHttp(`http://127.0.0.1:${PORTS.cms}/api/users/me`, 240_000, 'CMS')
    await waitHttp(`http://127.0.0.1:${PORTS.cms}/api/categories?limit=1`, 240_000, 'CMS categories')
  } catch (e) {
    throw new Error(`${(e as Error).message}\n--- next start output (tail) ---\n${cmsTail.join('').slice(-3000)}`)
  }

  const viteBin = path.join(repoRoot, 'node_modules/vite/bin/vite.js')
  const buildEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' }
  for (const k of Object.keys(buildEnv)) if (k.startsWith('VITE_')) delete buildEnv[k]

  log('building the REAL public site (vite build, repo root)')
  const publicDir = path.join(tmpDir, 'public')
  runNode(
    [viteBin, 'build', '--outDir', publicDir, '--emptyOutDir', '--logLevel', 'warn'],
    {
      ...buildEnv,
      VITE_PUBLIC_CMS_URL: HOSTS.cms,
      VITE_PUBLIC_SUBMISSIONS_URL: '', // Derive the endpoint from the documented CMS origin.
      VITE_TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY,
      VITE_TURNSTILE_ACTION: TURNSTILE_ACTION,
    },
    'public site build',
    repoRoot,
    600_000,
  )
  preparePagesLayout(publicDir)

  log('building the public site a second time exactly as docs/staging.md section 9 says (no-override regression)')
  const publicGapDir = path.join(tmpDir, 'public-gap')
  runNode(
    [viteBin, 'build', '--outDir', publicGapDir, '--emptyOutDir', '--logLevel', 'warn'],
    { ...buildEnv, VITE_PUBLIC_CMS_URL: HOSTS.cms, VITE_TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY },
    'public site (docs config) build',
    repoRoot,
    600_000,
  )
  preparePagesLayout(publicGapDir)

  log('building the REAL newsroom SPA (vite build apps/newsroom)')
  const newsroomDir = path.join(tmpDir, 'newsroom')
  let newsroomBuildError: string | undefined
  try {
    runNode(
      [viteBin, 'build', 'apps/newsroom', '--outDir', newsroomDir, '--emptyOutDir', '--logLevel', 'warn'],
      { ...buildEnv, VITE_CMS_URL: HOSTS.cms, VITE_PUBLIC_SITE_URL: HOSTS.public, VITE_TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY },
      'newsroom build',
      repoRoot,
      600_000,
    )
  } catch (e) {
    // A broken newsroom build must fail the newsroom journeys (loudly), not hide the public-site ones.
    newsroomBuildError = (e as Error).message.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 1500)
    log('NEWSROOM BUILD FAILED (newsroom specs will fail):', newsroomBuildError.split('\n').slice(0, 6).join(' | '))
  }

  // The public site runs on its real host (tools/serve-public.mjs). Its server-side CMS reads use the loopback name, because
  // Node does not resolve *.localhost subdomains the way Chromium's --host-resolver-rules does here.
  statics = [
    await startPublicHost(repoRoot, publicDir, PORTS.public, `http://localhost:${PORTS.cms}`),
    await startStaticServer(publicGapDir, PORTS.publicGap),
  ]
  if (!newsroomBuildError) statics.push(await startStaticServer(newsroomDir, PORTS.newsroom))

  const fixtureDir = path.join(tmpDir, 'fixtures')
  fs.mkdirSync(fixtureDir, { recursive: true })
  const evidenceDir = path.join(cmsRoot, 'docs', 'evidence')

  return {
    cmsUrl: HOSTS.cms,
    newsroomOrigin: HOSTS.newsroom,
    publicOrigin: HOSTS.public,
    publicGapOrigin: HOSTS.publicGap,
    credentials: seeded.credentials,
    categoryId: seeded.categoryId,
    categoryTitle: 'E2E News',
    recorderUrl: `http://127.0.0.1:${PORTS.cms}/__e2e/log`,
    newsroomBuildError,
    runId,
    fixtureDir,
    evidenceDir,
  }
}

export async function stopStack(): Promise<void> {
  await Promise.allSettled(statics.map((s) => s.close()))
  statics = []
  await recorder?.close()
  recorder = undefined
  if (cms) {
    const alive = cms.exitCode === null && cms.signalCode === null
    const errors = cmsTail
      .join('')
      .split(/\r?\n/)
      .filter((l) => /\b(error|fatal|unhandled|uncaught|ELIFECYCLE)\b/i.test(l)).length
    log(`next start before teardown: ${alive ? 'still running' : 'ALREADY EXITED'}; error-looking lines in its output: ${errors}`)
    cmsStopping = true
    killTree(cms.pid)
    cms = undefined
  }
  if (pg) {
    try {
      await pg.stop()
    } catch {
      // ignore
    }
    pg = undefined
  }
  if (tmpDir) {
    await new Promise((r) => setTimeout(r, 1000)) // let Windows release file handles
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch {
      log('could not remove', tmpDir)
    }
    tmpDir = undefined
  }
  if (runId) {
    // Payload stores uploads in apps/cms/media (shared with local dev); remove only this run's files.
    const media = path.join(cmsRoot, 'media')
    try {
      const prefix = runId
      const mine = fs.readdirSync(media).filter((f) => f.startsWith(prefix))
      for (const f of mine) fs.rmSync(path.join(media, f), { force: true })
      log(`removed ${mine.length} uploaded media file(s) of this run from apps/cms/media`)
    } catch {
      // no media dir
    }
    runId = undefined
  }
}
