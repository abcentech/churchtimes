/**
 * Boots / stops the disposable test stack: embedded PostgreSQL -> migrations -> synthetic seed ->
 * Next server, plus the three static harness servers. Everything lives in a temp directory that is
 * removed on teardown. No secret is printed; secrets are random per run and only held in memory /
 * the child process environment / a 0600 temp file.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import EmbeddedPostgres from 'embedded-postgres'

import { startHarness, type Harness } from './harness'
import { startRecorder, type Recorder } from './recorder'

const here = path.dirname(fileURLToPath(import.meta.url))
export const cmsRoot = path.resolve(here, '../../..')

export const PORTS = { cms: 3200, cmsInternal: 3201, pg: 55433, public: 5173, newsroom: 5174, evil: 5175 } as const
export const HOSTS = {
  cms: `http://cms.churchtimes.localhost:${PORTS.cms}`,
  newsroom: `http://newsroom.churchtimes.localhost:${PORTS.newsroom}`,
  public: `http://www.churchtimes.localhost:${PORTS.public}`,
  /** different site (othersite.localhost vs churchtimes.localhost) */
  evil: `http://evil.othersite.localhost:${PORTS.evil}`,
  /** SAME site as the CMS but an origin that is in no allowlist (served by the 5175 harness) */
  sibling: `http://sibling.churchtimes.localhost:${PORTS.evil}`,
} as const

export type E2EConfig = {
  mode: 'local-dev' | 'staging'
  nodeEnv: string
  cmsUrl: string
  newsroomOrigin: string
  publicOrigin: string
  evilOrigin: string
  siblingOrigin: string
  credentials: Record<string, { email: string; password: string }>
  /** Local boot only: Payload's derived JWT signing key, so tests can forge correctly-signed tokens. */
  jwtKey?: string
  /** Own boot only: where the recording proxy serves what the CMS received (absent in STAGING_URL mode). */
  recorderUrl?: string
}

type State = { dir: string; cmsPid?: number }

let pg: EmbeddedPostgres | undefined
let cms: ChildProcess | undefined
let recorder: Recorder | undefined
let harnesses: Harness[] = []
let tmpDir: string | undefined

const log = (...a: unknown[]) => console.log('[e2e-stack]', ...a)

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

function runNode(args: string[], env: NodeJS.ProcessEnv, label: string, timeoutMs = 300_000): void {
  const res = spawnSync(process.execPath, args, { cwd: cmsRoot, env, encoding: 'utf8', timeout: timeoutMs })
  if (res.status !== 0) {
    // Output of these tools contains no secrets (we never print env or credentials).
    throw new Error(
      `${label} failed (exit ${res.status}):\n${(res.stdout ?? '').slice(-2000)}\n${(res.stderr ?? '').slice(-2000)}`,
    )
  }
}

/** Build when .next is missing or older than the sources (E2E_SKIP_BUILD=1 reuses whatever is there). */
async function ensureBuild(env: NodeJS.ProcessEnv): Promise<void> {
  // Another `next build` in this directory (e.g. staging:up) holds .next/lock; never race it.
  const lock = path.join(cmsRoot, '.next', 'lock')
  for (let i = 0; fs.existsSync(lock) && i < 180; i++) {
    if (i === 0) log('another next build is running; waiting for it to finish')
    await new Promise((r) => setTimeout(r, 5000))
  }
  const buildId = path.join(cmsRoot, '.next', 'BUILD_ID')
  const newest = (dir: string): number =>
    fs.readdirSync(dir, { withFileTypes: true }).reduce((m, e) => {
      const p = path.join(dir, e.name)
      return Math.max(m, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs)
    }, 0)
  const sources = Math.max(newest(path.join(cmsRoot, 'src')), fs.statSync(path.join(cmsRoot, 'next.config.mjs')).mtimeMs)
  const built = fs.existsSync(buildId) ? fs.statSync(buildId).mtimeMs : 0
  if (process.env.E2E_SKIP_BUILD === '1' && built) return log('E2E_SKIP_BUILD=1: reusing the existing .next build')
  if (built > sources) return log('.next build is newer than src/: reusing it')
  log('building the CMS (next build)')
  runNode([path.join(cmsRoot, 'node_modules/next/dist/bin/next'), 'build'], { ...env, NODE_ENV: 'production' }, 'next build', 900_000)
}

const rand = (n = 32) => randomBytes(n).toString('hex')

export async function startStack(): Promise<E2EConfig> {
  for (const p of [PORTS.cms, PORTS.cmsInternal, PORTS.pg, PORTS.public, PORTS.newsroom, PORTS.evil]) {
    if (!(await portFree(p))) throw new Error(`Port ${p} is already in use; stop whatever holds it and retry.`)
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-e2e-browser-'))
  const dbUser = 'ct_e2e'
  const dbPass = rand(12)
  const pgDir = path.join(tmpDir, 'pg')

  log('starting embedded PostgreSQL on', PORTS.pg)
  pg = new EmbeddedPostgres({
    databaseDir: pgDir,
    user: dbUser,
    password: dbPass,
    port: PORTS.pg,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase('ct_e2e')

  // Real production build (next start forces NODE_ENV=production). Realistic http *.localhost origins are
  // only accepted via the loopback-only CMS_ALLOW_INSECURE_LOCAL_STAGING flag (src/lib/securityConfig.ts).
  const nodeEnv = 'production'
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: nodeEnv,
    DATABASE_URL: `postgres://${dbUser}:${dbPass}@127.0.0.1:${PORTS.pg}/ct_e2e`,
    PAYLOAD_SECRET: rand(32),
    PREVIEW_SECRET: rand(32),
    IP_HASH_SALT: rand(16),
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    CMS_PUBLIC_URL: HOSTS.cms,
    CMS_CORS_ORIGINS: `${HOSTS.newsroom},${HOSTS.public}`,
    CMS_CSRF_ORIGINS: `${HOSTS.newsroom},${HOSTS.public}`,
    PUBLIC_SUBMISSION_ORIGINS: `${HOSTS.newsroom},${HOSTS.public}`,
    CMS_ALLOW_INSECURE_LOCAL_STAGING: 'true',
    TRUST_PROXY: 'true', // required in production; browsers send no X-Forwarded-For (shared, larger bucket)
    TRUST_PROXY_HOPS: '1',
    AUTH_LOGIN_RATE_LIMIT: '200', // browser + Node logins share the loopback bucket (default 10 per 15 min)
    TURNSTILE_EXPECTED_ACTION: '',
    TURNSTILE_ALLOWED_HOSTNAMES: '',
    CLIENT_IP_HEADER: '',
    SMTP_HOST: '',
    SCHEDULER_ENABLED: 'false',
    PAYLOAD_DB_PUSH: 'false',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: '--no-deprecation',
  }
  delete env.STAGING_URL

  const payloadBin = path.join(cmsRoot, 'node_modules/payload/bin.js')
  await ensureBuild(env)

  log('applying migrations')
  runNode([payloadBin, 'migrate'], env, 'payload migrate')

  log('seeding synthetic users and articles')
  const seedOut = path.join(tmpDir, 'seed.json')
  runNode([payloadBin, 'run', 'e2e/browser/support/seed.ts'], { ...env, CT_SEED_OUT: seedOut }, 'seed')
  const seeded = JSON.parse(fs.readFileSync(seedOut, 'utf8')) as {
    credentials: Record<string, { email: string; password: string }>
  }
  fs.rmSync(seedOut, { force: true })

  log(`starting next start on ${PORTS.cmsInternal} behind the recording proxy on ${PORTS.cms}`)
  const nextBin = path.join(cmsRoot, 'node_modules/next/dist/bin/next')
  cms = spawn(process.execPath, [nextBin, 'start', '-p', String(PORTS.cmsInternal), '-H', '127.0.0.1'], {
    cwd: cmsRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const cmsOut: string[] = []
  const keep = (b: Buffer) => {
    cmsOut.push(b.toString())
    if (cmsOut.length > 200) cmsOut.shift()
  }
  cms.stdout?.on('data', keep)
  cms.stderr?.on('data', keep)
  cms.on('exit', (code) => log('next start exited with code', code))
  const state: State = { dir: tmpDir, cmsPid: cms.pid }
  fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(state))

  try {
    // Wait until the API and the admin login page answer.
    recorder = await startRecorder(PORTS.cms, PORTS.cmsInternal)
    await waitHttp(`http://127.0.0.1:${PORTS.cms}/api/users/me`, 240_000, 'CMS')
    await waitHttp(`http://127.0.0.1:${PORTS.cms}/admin/login`, 240_000, 'CMS admin login')
  } catch (e) {
    throw new Error(`${(e as Error).message}\n--- next start output (tail) ---\n${cmsOut.join('').slice(-3000)}`)
  }

  harnesses = await Promise.all([PORTS.public, PORTS.newsroom, PORTS.evil].map((p) => startHarness(p)))

  return {
    mode: 'local-dev',
    nodeEnv,
    cmsUrl: HOSTS.cms,
    newsroomOrigin: HOSTS.newsroom,
    publicOrigin: HOSTS.public,
    evilOrigin: HOSTS.evil,
    siblingOrigin: HOSTS.sibling,
    credentials: seeded.credentials,
    recorderUrl: `http://127.0.0.1:${PORTS.cms}/__e2e/log`,
    jwtKey: createHash('sha256')
      .update(env.PAYLOAD_SECRET as string)
      .digest('hex')
      .slice(0, 32),
  }
}

export async function startHarnessesOnly(): Promise<void> {
  for (const p of [PORTS.public, PORTS.newsroom, PORTS.evil]) {
    if (!(await portFree(p))) throw new Error(`Harness port ${p} is already in use.`)
  }
  harnesses = await Promise.all([PORTS.public, PORTS.newsroom, PORTS.evil].map((p) => startHarness(p)))
}

export async function stopStack(): Promise<void> {
  await Promise.allSettled(harnesses.map((h) => h.close()))
  harnesses = []
  await recorder?.close()
  recorder = undefined
  if (cms) {
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
    // give Windows a moment to release file handles after process death
    await new Promise((r) => setTimeout(r, 1000))
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch {
      log('could not remove', tmpDir)
    }
    tmpDir = undefined
  }
}
