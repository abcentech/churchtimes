// Disposable staging environment: embedded PostgreSQL + the real production build of the CMS (`next start`)
// with synthetic fixtures. No Docker. See docs/staging.md.
//
//   npm run staging:up
//
// Env (all optional):
//   STAGING_PORT=3100 STAGING_PG_PORT=55432 STAGING_HOST=127.0.0.1   ports / bind address
//   STAGING_DIR=.staging                                              data directory (gitignored)
//   STAGING_SKIP_BUILD=1                                              reuse an existing .next build
//   STAGING_NEWSROOM_ORIGIN / STAGING_PUBLIC_ORIGIN                   frontend origins (see staging-lib.mjs)
//   STAGING_EXTRA_ORIGINS=http://a.localhost:1,...                    more loopback origins, added to every list
//   STAGING_SUBMISSION_RATE_LIMIT=3 STAGING_AUTH_LOGIN_RATE_LIMIT=200
//
// Secrets are generated fresh on every run and live only in .staging/ (gitignored). Nothing secret is printed.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  files,
  isOwnProcess,
  killTree,
  markers,
  parseEnvFile,
  pidAlive,
  portInUse,
  readJson,
  root,
  settings,
  stagingDir,
  waitFor,
} from './staging-lib.mjs'

const TURNSTILE_ALWAYS_PASS_TEST_SECRET = '1x0000000000000000000000000000000AA' // Cloudflare public test secret, not a secret
const ROLES = [
  ['admin', 'admin'],
  ['editor-in-chief', 'editor-in-chief'],
  ['section-editor', 'section-editor'],
  ['trusted-publisher', 'trusted-publisher'],
  ['reporter', 'reporter'],
]

const log = (msg) => console.log(`[staging] ${msg}`)
const secret = (bytes = 32) => randomBytes(bytes).toString('hex')
const unique = (list) => [...new Set(list.filter(Boolean))]

const cfg = settings()

// --- refuse to clobber a running environment ----------------------------------------------------------------
const previous = readJson(files.state)
if (previous && (isOwnProcess(previous.server?.pid, markers.server) || isOwnProcess(previous.postgres?.pid, markers.postgres))) {
  console.error(`[staging] An environment is already running (state: ${files.state}). Run \`npm run staging:down\` first.`)
  process.exit(1)
}
for (const [what, port] of [
  ['STAGING_PORT', cfg.port],
  ['STAGING_PG_PORT', cfg.pgPort],
]) {
  if (await portInUse(port)) {
    console.error(`[staging] ${what}=${port} is already in use. Pick another port (or stop whatever uses it).`)
    process.exit(1)
  }
}

// --- fresh data directory -----------------------------------------------------------------------------------
fs.rmSync(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
fs.mkdirSync(stagingDir, { recursive: true })

// --- generated configuration (random secrets; .staging/ is gitignored) -----------------------------------------
const cmsOrigin = `http://cms.churchtimes.localhost:${cfg.port}`
const pgUser = 'staging'
const pgPassword = secret(16)
const pgDb = 'churchtimes_staging'
const databaseUrl = `postgres://${pgUser}:${pgPassword}@127.0.0.1:${cfg.pgPort}/${pgDb}`

const alt = (origin) => {
  // http://x.churchtimes.localhost:5174 -> http://localhost:5174 and http://127.0.0.1:5174
  const u = new URL(origin)
  return [`http://localhost:${u.port}`, `http://127.0.0.1:${u.port}`]
}
const extra = (process.env.STAGING_EXTRA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const frontendOrigins = unique([
  cfg.newsroomOrigin,
  ...alt(cfg.newsroomOrigin),
  cfg.publicOrigin,
  ...alt(cfg.publicOrigin),
  'http://localhost:8080',
  ...extra,
])
const cmsOrigins = unique([cmsOrigin, `http://localhost:${cfg.port}`, `http://127.0.0.1:${cfg.port}`])

const envValues = {
  DATABASE_URL: databaseUrl,
  PAYLOAD_SECRET: secret(),
  PREVIEW_SECRET: secret(),
  IP_HASH_SALT: secret(16),
  TURNSTILE_SECRET_KEY: TURNSTILE_ALWAYS_PASS_TEST_SECRET,
  CMS_PUBLIC_URL: cmsOrigin,
  CMS_CORS_ORIGINS: unique([...frontendOrigins, ...cmsOrigins]).join(','),
  CMS_CSRF_ORIGINS: unique([...frontendOrigins, ...cmsOrigins]).join(','),
  PUBLIC_SUBMISSION_ORIGINS: frontendOrigins.join(','),
  // `next start` forces NODE_ENV=production, and production validation requires TRUST_PROXY=true. Tests isolate
  // rate-limit buckets with a single X-Forwarded-For entry (the client address a real proxy would append).
  TRUST_PROXY: 'true',
  TRUST_PROXY_HOPS: '1',
  // Honoured by the CMS only because every origin above is loopback-only (src/lib/securityConfig.ts).
  CMS_ALLOW_INSECURE_LOCAL_STAGING: 'true',
  SUBMISSION_RATE_LIMIT: cfg.submissionRateLimit,
  SUBMISSION_RATE_WINDOW_SECONDS: '900',
  SUBMISSION_EMAIL_RATE_LIMIT: '3',
  SUBMISSION_EMAIL_RATE_WINDOW_SECONDS: '3600',
  AUTH_LOGIN_RATE_LIMIT: cfg.authLoginRateLimit,
  AUTH_RATE_WINDOW_SECONDS: '900',
  SCHEDULER_ENABLED: 'true',
  SCHEDULER_INTERVAL_SECONDS: '60',
  PAYLOAD_DB_PUSH: 'false',
  // Blank on purpose: never inherit these from a developer's apps/cms/.env.
  TURNSTILE_EXPECTED_ACTION: '',
  TURNSTILE_ALLOWED_HOSTNAMES: '',
  CLIENT_IP_HEADER: '',
  SMTP_HOST: '',
  SEED_DEMO_USERS: 'false',
}
fs.writeFileSync(
  files.env,
  `# Generated by scripts/staging-up.mjs. Disposable. NEVER commit (apps/cms/.staging is gitignored).\n` +
    Object.entries(envValues)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') +
    '\n',
  { mode: 0o600 },
)

// Synthetic staff, one per role. Passwords go ONLY into credentials.json (never stdout, never logs).
const credentials = { generatedAt: new Date().toISOString(), cmsOrigin, users: {} }
for (const [key, role] of ROLES) {
  credentials.users[key] = {
    email: `staging-${key}@staging.invalid`,
    password: `Stg-${secret(12)}`,
    role,
  }
}
fs.writeFileSync(files.credentials, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 })

const childEnv = (extraEnv = {}) => ({
  ...process.env,
  ...parseEnvFile(files.env),
  NODE_ENV: 'production',
  NODE_OPTIONS: '--no-deprecation',
  NEXT_TELEMETRY_DISABLED: '1',
  STAGING_CREDENTIALS_FILE: files.credentials,
  ...extraEnv,
})

const run = (label, args, env) => {
  log(label)
  const res = spawnSync(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0) {
    // Output may include stack traces; the generated secrets are never echoed by these commands.
    console.error(`[staging] FAILED: ${label} (exit ${res.status})`)
    console.error(String(res.stdout).split('\n').slice(-40).join('\n'))
    console.error(String(res.stderr).split('\n').slice(-40).join('\n'))
    throw new Error(`${label} failed`)
  }
  return String(res.stdout)
}

const state = { startedAt: new Date().toISOString(), dir: stagingDir, postgres: {}, server: {}, urls: {} }
const saveState = () => fs.writeFileSync(files.state, JSON.stringify(state, null, 2) + '\n')

const cleanupOnFailure = () => {
  killTree(state.server.pid)
  killTree(state.postgres.pid)
}

try {
  // --- PostgreSQL ------------------------------------------------------------------------------------------
  log(`starting embedded PostgreSQL on 127.0.0.1:${cfg.pgPort}`)
  const pgOut = fs.openSync(files.pgLog, 'a')
  const pg = spawn(process.execPath, [markers.postgres], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', pgOut, pgOut],
    env: {
      ...process.env,
      PG_DIR: files.pgData,
      PG_PORT: String(cfg.pgPort),
      PG_USER: pgUser,
      PG_PASSWORD: pgPassword,
      PG_DB: pgDb,
      PG_READY_FILE: files.pgReady,
    },
  })
  pg.unref()
  state.postgres = { pid: pg.pid, port: cfg.pgPort, database: pgDb }
  saveState()
  await waitFor(
    () => {
      if (fs.existsSync(files.pgReady)) return true
      if (!pidAlive(pg.pid)) throw Object.assign(new Error('PostgreSQL exited; see .staging/postgres.log'), { fatal: true })
      return false
    },
    { timeoutMs: 120_000, what: 'PostgreSQL to accept connections' },
  )

  // --- schema + synthetic data ---------------------------------------------------------------------------------
  const payloadBin = path.join(root, 'node_modules', 'payload', 'bin.js')
  run('applying migrations', [payloadBin, 'migrate'], childEnv())
  run('seeding synthetic fixtures', [payloadBin, 'run', 'src/seed/staging.ts'], childEnv())

  // --- build ------------------------------------------------------------------------------------------------------
  const nextBin = markers.server
  if (process.env.STAGING_SKIP_BUILD === '1' && fs.existsSync(path.join(root, '.next', 'BUILD_ID'))) {
    log('STAGING_SKIP_BUILD=1 and .next exists: reusing the existing build')
  } else {
    run('building the CMS (next build, can take a few minutes)', [nextBin, 'build'], childEnv())
  }

  // --- server -------------------------------------------------------------------------------------------------------
  log(`starting next start on http://${cfg.host}:${cfg.port}`)
  const srvOut = fs.openSync(files.serverLog, 'a')
  const server = spawn(process.execPath, [nextBin, 'start', '-p', String(cfg.port), '-H', cfg.host], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', srvOut, srvOut],
    env: childEnv(),
  })
  server.unref()
  state.server = { pid: server.pid, port: cfg.port, host: cfg.host }
  saveState()

  const base = `http://${cfg.host}:${cfg.port}`
  await waitFor(
    async () => {
      if (!pidAlive(server.pid)) throw Object.assign(new Error('server exited; see .staging/server.log'), { fatal: true })
      const res = await fetch(`${base}/api/categories`, { headers: { origin: cmsOrigin } })
      return res.status === 200
    },
    { timeoutMs: 180_000, what: `${base}/api/categories to return 200` },
  )

  state.urls = {
    cms: cmsOrigin,
    cmsLoopback: base,
    admin: `${cmsOrigin}/admin`,
    api: `${cmsOrigin}/api`,
    newsroomOrigin: cfg.newsroomOrigin,
    publicOrigin: cfg.publicOrigin,
    staffCredentialsFile: path.relative(root, files.credentials),
  }
  state.ready = true
  saveState()

  console.log('')
  console.log('[staging] READY')
  console.log(`  CMS (hostname for browsers) : ${cmsOrigin}   (admin: ${cmsOrigin}/admin)`)
  console.log(`  CMS (loopback, for scripts) : ${base}`)
  console.log(`  Allowed frontend origins    : ${cfg.newsroomOrigin} (newsroom), ${cfg.publicOrigin} (public site)`)
  console.log(`  PostgreSQL                  : 127.0.0.1:${cfg.pgPort} (credentials in ${path.relative(root, files.env)})`)
  console.log(`  Staff logins                : ${path.relative(root, files.credentials)} (never printed)`)
  console.log(`  State / logs                : ${path.relative(root, files.state)}, ${path.relative(root, files.serverLog)}`)
  console.log('  Tear down                   : npm run staging:down')
} catch (err) {
  console.error(`[staging] ${err instanceof Error ? err.message : err}`)
  console.error('[staging] startup failed; stopping what was started. Logs are kept in .staging/ (run staging:down to delete).')
  cleanupOnFailure()
  process.exit(1)
}
