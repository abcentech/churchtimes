// On-demand staging on THIS PC, published with Tailscale Funnel (free, real https on <machine>.<tailnet>.ts.net).
// Owner guide: deploy/staging/funnel/README.md
//
//   npm run staging:funnel:up                       start everything and publish the three funnels
//   npm run staging:funnel:up -- --dry-run [--host x.ts.net]   print the plan and every command, change nothing
//
// Options:
//   --host <name.ts.net>   use this MagicDNS name instead of reading it from `tailscale status` (testing)
//   --dry-run              print every command; run nothing, write nothing, touch no process
//   --no-funnel            start and test the three services on 127.0.0.1 only; no tailscale calls, no https verification
//   --test-keys            LOCAL TEST ONLY: Cloudflare's always-pass site key + a placeholder secret, nothing stored; never funnels
//   --rotate-turnstile     ask for the Turnstile keys again
//   --rebuild              force the CMS production build (otherwise reused when newer than apps/cms/src)
//   --overwrite-serve      CLEAR everything `tailscale serve` holds on ports 443/8443/10000 (all paths, TCP forwards, Funnel flags)
//                          and take them over. Funnel publishes a whole host:port, so nothing else may stay on those ports.
//
// State lives OUTSIDE the repo (see funnel-lib.mjs stateDir()). Nothing secret is printed.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  ADMIN_STEPS,
  analyzeServe,
  assertHost,
  clearPortCommands,
  ensureDir,
  explainTailscaleFailure,
  fail,
  findTailscale,
  entriesToOurPorts,
  funnelEntries,
  funnelOnCommands,
  funnelOrphans,
  isOwnProcess,
  killTree,
  loadConfig,
  loadOrCreateSecrets,
  loadOrPromptTurnstile,
  log,
  markers,
  origins,
  parseArgs,
  pathsFor,
  pidAlive,
  portInUse,
  probe,
  readJson,
  repoRoot,
  root,
  rotateLog,
  sleep,
  stateDir,
  TURNSTILE_TEST_SITE_KEY,
  tailscalePreflight,
  tsRun,
  tsServeConfig,
  tsSyntax,
  tsVersion,
  turnOffFunnels,
  waitFor,
  warn,
  writeJson,
  writePrivate,
} from './funnel-lib.mjs'

const args = parseArgs(process.argv.slice(2), {
  flags: ['dry-run', 'no-funnel', 'test-keys', 'rotate-turnstile', 'rebuild', 'overwrite-serve'],
  options: ['host'],
})
const dryRun = !!args['dry-run']
const testKeys = !!args['test-keys']
const noFunnel = !!args['no-funnel'] || testKeys
const cfg = loadConfig()
const dir = stateDir()
const p = pathsFor(dir)
const entries = funnelEntries(cfg)

const ROLES = ['admin', 'editor-in-chief', 'section-editor', 'trusted-publisher', 'reporter']
const SECRET_KEYS = new Set(['PAYLOAD_SECRET', 'PREVIEW_SECRET', 'IP_HASH_SALT', 'TURNSTILE_SECRET_KEY', 'DATABASE_URL'])
const PG_USER = 'staging'
const PG_DB = 'churchtimes_staging'
const loopback = (port) => `http://127.0.0.1:${port}`
const STAGING_BUILD_FLAGS = { CMS_HSTS_MAX_AGE: '300', CMS_NOINDEX: 'true' }
const PLACEHOLDER_HOST = 'churchtimes-staging.example-tailnet.ts.net'

const hex = (n) => randomBytes(n).toString('hex')
const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a)

// --------------------------------------------------------------------------------------------------------------------
// Environments handed to the child processes
// --------------------------------------------------------------------------------------------------------------------

function baseEnv() {
  const env = { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: '--no-deprecation', NEXT_TELEMETRY_DISABLED: '1' }
  for (const k of Object.keys(env)) if (k.startsWith('VITE_') || k.startsWith('XAPP_')) delete env[k]
  return env
}

/** The environment of the RUNNING CMS: real https origins, no insecure-staging flag. */
function cmsEnvValues({ host, secrets, turnstile }) {
  const o = origins(host)
  const origin = (list) => [...new Set(list)].join(',')
  return {
    DATABASE_URL: `postgres://${PG_USER}:${secrets.PG_PASSWORD}@127.0.0.1:${cfg.pgPort}/${PG_DB}`,
    PAYLOAD_SECRET: secrets.PAYLOAD_SECRET,
    PREVIEW_SECRET: secrets.PREVIEW_SECRET,
    IP_HASH_SALT: secrets.IP_HASH_SALT,
    TURNSTILE_SECRET_KEY: turnstile.secretKey,
    TURNSTILE_ALLOWED_HOSTNAMES: host,
    TURNSTILE_EXPECTED_ACTION: cfg.turnstileAction,
    CMS_PUBLIC_URL: o.cms,
    CMS_CORS_ORIGINS: origin([o.public, o.newsroom]),
    CMS_CSRF_ORIGINS: origin([o.newsroom, o.cms]),
    PUBLIC_SUBMISSION_ORIGINS: o.public,
    // Tailscale's serve proxy overwrites X-Forwarded-For with the real client address (one entry) = exactly one trusted hop.
    // The CMS refuses to start in production unless TRUST_PROXY is "true".
    TRUST_PROXY: 'true',
    TRUST_PROXY_HOPS: String(cfg.trustProxyHops),
    // Never set: a custom client-IP header would be spoofable (see FUNNEL_CLIENT_IP_HEADER in funnel-lib.mjs).
    CLIENT_IP_HEADER: '',
    // One shared bucket is possible if client addresses turn out not to be forwarded; the remote test run needs these as well.
    AUTH_LOGIN_RATE_LIMIT: String(cfg.authLoginRateLimit),
    AUTH_RATE_WINDOW_SECONDS: '900',
    SUBMISSION_RATE_LIMIT: String(cfg.submissionRateLimit),
    SUBMISSION_RATE_WINDOW_SECONDS: '900',
    SCHEDULER_ENABLED: 'true',
    SCHEDULER_INTERVAL_SECONDS: String(cfg.schedulerSeconds),
    PAYLOAD_DB_PUSH: 'false',
    // Uploads go to the private state folder, not into the repository checkout.
    CMS_MEDIA_DIR: p.media,
    // Browsers pin HSTS to the whole ts.net host name: keep it short. Both are compiled in at `next build` (see cmsBuildMarker).
    CMS_HSTS_MAX_AGE: STAGING_BUILD_FLAGS.CMS_HSTS_MAX_AGE,
    CMS_NOINDEX: STAGING_BUILD_FLAGS.CMS_NOINDEX,
    // Blank on purpose: never inherit these from a developer shell or apps/cms/.env.
    CMS_ALLOW_INSECURE_LOCAL_STAGING: '',
    STAGING_CREDENTIALS_FILE: '',
    SMTP_HOST: '',
    SEED_DEMO_USERS: 'false',
  }
}

/** The environment of the one-shot SEED process: loopback-only values, because the staging seed refuses anything else. */
function seedEnvValues({ secrets }) {
  const loop = [loopback(cfg.publicPort), loopback(cfg.newsroomPort), loopback(cfg.cmsPort)]
  return {
    DATABASE_URL: `postgres://${PG_USER}:${secrets.PG_PASSWORD}@127.0.0.1:${cfg.pgPort}/${PG_DB}`,
    PAYLOAD_SECRET: secrets.PAYLOAD_SECRET,
    PREVIEW_SECRET: secrets.PREVIEW_SECRET,
    IP_HASH_SALT: secrets.IP_HASH_SALT,
    TURNSTILE_SECRET_KEY: 'seed-process-never-calls-turnstile-0000',
    TURNSTILE_ALLOWED_HOSTNAMES: '',
    TURNSTILE_EXPECTED_ACTION: '',
    CMS_PUBLIC_URL: loopback(cfg.cmsPort),
    CMS_CORS_ORIGINS: loop.join(','),
    CMS_CSRF_ORIGINS: loop.join(','),
    PUBLIC_SUBMISSION_ORIGINS: loopback(cfg.publicPort),
    CMS_ALLOW_INSECURE_LOCAL_STAGING: 'true', // set for THIS short-lived process only; every origin above is loopback
    STAGING_CREDENTIALS_FILE: p.seedUsers,
    TRUST_PROXY: 'true',
    CLIENT_IP_HEADER: '',
    CMS_MEDIA_DIR: p.media,
    SCHEDULER_ENABLED: 'false',
    PAYLOAD_DB_PUSH: 'false',
    SMTP_HOST: '',
    SEED_DEMO_USERS: 'false',
  }
}

const describeEnv = (values) =>
  Object.entries(values)
    .map(([k, v]) => `    ${k}=${SECRET_KEYS.has(k) ? '<secret, not printed>' : v === '' ? '<blank on purpose>' : v}`)
    .join('\n')

// --------------------------------------------------------------------------------------------------------------------
// Dry run: print the plan and every command
// --------------------------------------------------------------------------------------------------------------------

function printDryRun() {
  const host = args.host ? assertHost(args.host.toLowerCase()) : '<machine>.<tailnet>.ts.net'
  const o = host.startsWith('<') ? origins('machine.tailnet.ts.net') : origins(host)
  const node = 'node'
  const lines = []
  const cmd = (s) => lines.push(`  $ ${s}`)
  console.log('[funnel] DRY RUN: nothing is executed, written or started.')
  console.log(`[funnel] host: ${host}${args.host ? ' (from --host)' : ' (would be read from `tailscale status --json`, Self.DNSName)'}`)
  console.log(`[funnel] state folder (outside the repo): ${dir}`)
  console.log(`[funnel] mode: ${testKeys ? 'LOCAL TEST (--test-keys, never funnels)' : noFunnel ? 'local only (--no-funnel)' : 'publish with Tailscale Funnel'}`)
  console.log('')
  if (!noFunnel) {
    console.log('1. Preflight (read-only):')
    cmd('tailscale version')
    cmd('tailscale status --json            # must be Running, MagicDNS on, HTTPS certificates on; Self.DNSName becomes the host')
    cmd('tailscale serve status --json      # refuses to touch ports 443/8443/10000 if they already serve something else')
    console.log(lines.splice(0).join('\n'))
  }
  console.log('2. State (created once, reused): secrets.json, turnstile.json (asked once), seed-users.json, staff-logins.txt, xapp-remote-credentials.json')
  console.log('3. PostgreSQL (embedded, persistent, 127.0.0.1 only):')
  cmd(`${node} ${path.relative(repoRoot, markers.postgres)}   # PG_PORT=${cfg.pgPort}, data in ${p.pgData}`)
  console.log(lines.splice(0).join('\n'))
  console.log('4. Migrate, then seed synthetic staff + fixtures on EVERY start (idempotent; separate short-lived process), then check /api/users/init and an admin login BEFORE any funnel:')
  cmd(`${node} node_modules/payload/bin.js migrate`)
  cmd(`${node} node_modules/payload/bin.js run src/seed/staging.ts   # loopback-only env, see below`)
  console.log(lines.splice(0).join('\n'))
  console.log('5. Builds (cwd apps/cms and repo root):')
  cmd(`CMS_HSTS_MAX_AGE=300 CMS_NOINDEX=true ${node} node_modules/next/dist/bin/next build   # only if apps/cms/.next is older than apps/cms/src, was not built with these switches, or --rebuild`)
  cmd(`VITE_PUBLIC_CMS_URL=${o.cms} VITE_TURNSTILE_SITE_KEY=<site key> VITE_TURNSTILE_ACTION=${cfg.turnstileAction} VITE_PUBLIC_SITE_URL= ${node} node_modules/vite/bin/vite.js build --outDir ${p.distPublic}`)
  cmd(`VITE_CMS_URL=${o.cms} VITE_PUBLIC_SITE_URL=${o.public} ${node} node_modules/vite/bin/vite.js build apps/newsroom --outDir ${p.distNewsroom}   # mock builds are refused`)
  console.log(lines.splice(0).join('\n'))
  console.log('6. Start (detached, logs in ' + p.logs + '):')
  cmd(`${node} node_modules/next/dist/bin/next start -p ${cfg.cmsPort} -H 127.0.0.1                 # CMS, production build`)
  cmd(`${node} apps/cms/scripts/funnel-serve.mjs   # FUNNEL_SERVE_MODE=public     127.0.0.1:${cfg.publicPort}  (tools/serve-public.mjs, SSR /reports/:slug/)`)
  cmd(`${node} apps/cms/scripts/funnel-serve.mjs   # FUNNEL_SERVE_MODE=newsroom   127.0.0.1:${cfg.newsroomPort}  (static, security headers)`)
  console.log(lines.splice(0).join('\n'))
  if (!noFunnel) {
    console.log('7. Funnels (refused if `tailscale serve` already holds other paths/TCP forwards on those ports, or Funnel is still on for our ports; --overwrite-serve clears the three ports first).')
    console.log('   Modern CLI shown; tailscale older than 1.52 uses `serve https:<port> / <target>` + `funnel <port> on`:')
    for (const e of entries) for (const c of funnelOnCommands('modern', e, { supportsYes: true })) cmd(`tailscale ${c.join(' ')}`)
    console.log(lines.splice(0).join('\n'))
    console.log('8. Verify over the internet path from this PC:')
    cmd(`GET ${o.public}/            -> 200, X-Robots-Tag noindex`)
    cmd(`GET ${o.newsroom}/        -> 200, X-Robots-Tag noindex`)
    cmd(`GET ${o.cms}/api/users/me   -> 200, {"user":null}`)
    console.log(lines.splice(0).join('\n'))
  } else {
    console.log('7. Funnels: skipped. Verify over http on 127.0.0.1 only.')
  }
  console.log('')
  console.log(`Public URLs: ${o.public}  (public site)   ${o.newsroom}  (newsroom)   ${o.cms}  (CMS, admin at /admin)`)
  console.log('')
  console.log('Environment of the RUNNING CMS (secrets are generated once; Turnstile secret is asked once):')
  const dummySecrets = { PG_PASSWORD: '<generated>', PAYLOAD_SECRET: '', PREVIEW_SECRET: '', IP_HASH_SALT: '' }
  console.log(describeEnv(cmsEnvValues({ host: host.startsWith('<') ? 'machine.tailnet.ts.net' : host, secrets: dummySecrets, turnstile: { secretKey: '' } })))
  console.log('')
  console.log('Environment of the one-shot SEED process (loopback only; the seed refuses anything else):')
  console.log(describeEnv(seedEnvValues({ secrets: dummySecrets })))
}

if (dryRun) {
  printDryRun()
  process.exit(0)
}

// --------------------------------------------------------------------------------------------------------------------
// Real run
// --------------------------------------------------------------------------------------------------------------------

if (testKeys && !args['no-funnel']) log('--test-keys is a local test: funnels are NEVER configured in this mode.')
if (process.env.VITE_NEWSROOM_MOCK) fail('VITE_NEWSROOM_MOCK is set in the environment: refusing to build the newsroom in mock mode.')

// 1. refuse to start twice, and never overwrite a state.json that still lists funnels
const previous = readJson(p.state)
if (
  previous &&
  Object.entries(previous.pids ?? {}).some(([name, pid]) => isOwnProcess(pid, name === 'postgres' ? markers.postgres : name === 'cms' ? markers.cms : markers.serve))
) {
  fail('The staging is already running. `npm run staging:funnel:status` shows it; `npm run staging:funnel:down` stops it.')
}
if (previous?.funnels?.length) {
  fail(
    `state.json still lists Funnel entries from an earlier run (port(s) ${previous.funnels.map((f) => f.httpsPort).join(', ')}), which may still be public. ` +
      'Run `npm run staging:funnel:down` first; it turns them off and confirms it.',
  )
}
for (const [what, port] of [
  ['public site', cfg.publicPort],
  ['newsroom', cfg.newsroomPort],
  ['CMS', cfg.cmsPort],
  ['PostgreSQL', cfg.pgPort],
]) {
  if (await portInUse(port)) fail(`Port ${port} (${what}) is already in use. Stop that program, or pick another port with the FUNNEL_*_PORT variables (README).`)
}

// 2. Tailscale preflight (read-only) before anything is created or asked.
// Even in the local modes: a Funnel entry left over from an earlier run would silently publish whatever listens on our ports.
let host = args.host ? assertHost(args.host.toLowerCase()) : null
let ts = null
const tsBin = findTailscale()
const staleCheck = async (serve) => {
  if (!serve) return
  const stale = entriesToOurPorts(serve, cfg).filter((e) => e.funnel)
  if (stale.length) {
    fail(
      `Tailscale Funnel is already ON for ${[...new Set(stale.map((e) => e.key))].join(', ')}, forwarding to this tool's local port(s) ` +
        `${[...new Set(stale.map((e) => e.localPort))].join(', ')} (left over from an earlier run). Starting now would publish the new services immediately. ` +
        'Run `npm run staging:funnel:down` first (it turns the entries off and confirms it).',
    )
  }
  for (const orphan of await funnelOrphans(serve)) {
    warn(`Funnel entry ${orphan.key} forwards to 127.0.0.1:${orphan.localPort} where nothing is listening; whatever starts there next becomes public. Check \`tailscale serve status\`.`)
  }
}
if (!noFunnel) {
  const bin = tsBin
  if (!bin) fail(`The tailscale command line tool was not found. ${ADMIN_STEPS.install}`)
  const version = tsVersion(bin)
  const pre = tailscalePreflight(bin)
  if (pre.problems.length) {
    console.error('[funnel] Tailscale is not ready:')
    for (const msg of pre.problems) console.error(`  - ${msg}`)
    process.exit(1)
  }
  // The funnels serve THIS machine's name, so a different --host would make the Turnstile hostname, the CORS origins and the builds wrong.
  if (host && host !== pre.host) fail(`--host ${host} differs from this machine's Tailscale name ${pre.host}; with funnels it must be the same (omit --host).`)
  host ??= pre.host
  if (!pre.funnelCapabilityListed) warn(`This node does not list the "funnel" capability yet. If the funnel step fails, follow: ${ADMIN_STEPS.funnel}`)
  assertHost(host)
  const helpText = tsRun(bin, ['funnel', '--help'])
  const supportsYes = /--yes\b/.test(helpText.stdout + helpText.stderr)
  ts = { bin, version, syntax: tsSyntax(version), supportsYes }
  log(`tailscale ${version.text} (${ts.syntax} CLI syntax), host ${host}`)
  const serve = tsServeConfig(bin)
  if (!serve) fail('`tailscale serve status --json` could not be read, so it is unknown what is already published. Fix the Tailscale service and re-run.')
  await staleCheck(serve)
  // Funnel publishes a WHOLE host:port. Refuse when anything of the owner's other than our own "/" proxy lives on those ports.
  const foreign = analyzeServe(serve, host, cfg).filter((e) => e.foreignReasons.length)
  if (foreign.length && !args['overwrite-serve']) {
    fail(
      `${foreign.map((e) => `port ${e.httpsPort}: ${e.foreignReasons.join(', ')}`).join('; ')} already exist in \`tailscale serve\` for ${host}. ` +
        'Funnel makes a whole host:port public (every path, not only ours), so those would become public too. Funnel can only use 443, 8443 and 10000. ' +
        'Remove them yourself (`tailscale serve status`), or pass --overwrite-serve to CLEAR everything on those three ports first.',
    )
  }
  if (args['overwrite-serve']) {
    for (const e of analyzeServe(serve, host, cfg).filter((x) => x.listed || x.foreignReasons.length)) {
      warn(`--overwrite-serve: clearing everything on port ${e.httpsPort} (${e.foreignReasons.join(', ') || 'our own earlier entry'}).`)
      for (const c of clearPortCommands(ts.syntax, e)) {
        log(`tailscale ${c.join(' ')}`)
        tsRun(bin, c, { timeoutMs: 30_000 }) // a "not found" exit is fine here; the status check below decides
      }
      const after = tsServeConfig(bin)
      if (!after || analyzeServe(after, host, cfg).find((x) => x.httpsPort === e.httpsPort)?.listed) fail(`Port ${e.httpsPort} could not be cleared; run \`tailscale serve status\` and remove it by hand.`)
    }
  }
} else {
  host ??= PLACEHOLDER_HOST
  warn(`${testKeys ? '--test-keys' : '--no-funnel'}: nothing is published; the services run on 127.0.0.1 only and the origins use the placeholder host ${host}.`)
  if (tsBin) {
    const serve = tsServeConfig(tsBin)
    if (!serve) warn('Could not read `tailscale serve status --json`; cannot check for leftover Funnel entries.')
    await staleCheck(serve)
  }
}
const o = origins(host)

// 3. state, secrets, Turnstile keys, synthetic logins
ensureDir(p.dir)
ensureDir(p.logs)
ensureDir(p.media)
ensureDir(path.dirname(p.distPublic))
const validSeedUsers = (u) => !!u?.users && ROLES.every((r) => u.users[r]?.email && u.users[r]?.password)
// An existing database whose passwords/logins were lost cannot be reached again, and fresh logins would leave the old privileged
// synthetic accounts behind with passwords nobody knows. Start clean instead.
if (fs.existsSync(p.pgData) && (!loadOrCreateSecrets(p, { create: false }) || !validSeedUsers(readJson(p.seedUsers)))) {
  fail(`The database in ${p.pgData} exists but secrets.json or seed-users.json is missing/invalid, so its logins cannot be matched. Run \`npm run staging:funnel:down -- --wipe\` and start again.`)
}
const secrets = loadOrCreateSecrets(p)
let turnstile
if (testKeys) {
  turnstile = { siteKey: TURNSTILE_TEST_SITE_KEY, secretKey: `test-keys-placeholder-${hex(12)}` }
  warn('--test-keys: Cloudflare\'s test site key is used and NOTHING is stored. The CMS secret is a placeholder (the CMS refuses Cloudflare\'s dummy secret in production mode), so tip submissions fail; everything else works.')
} else {
  turnstile = await loadOrPromptTurnstile(p, { rotate: !!args['rotate-turnstile'] }).catch((e) => fail(e instanceof Error ? e.message : String(e)))
}

let seedUsers = readJson(p.seedUsers)
if (!validSeedUsers(seedUsers)) {
  // Random per-install local part: the repository must not reveal the staff e-mail addresses (login lockout from the internet).
  seedUsers = { generatedAt: new Date().toISOString(), users: {} }
  for (const role of ROLES) seedUsers.users[role] = { email: `staging-${role}-${hex(4)}@staging.invalid`, password: `Stg-${hex(12)}`, role }
  writeJson(p.seedUsers, seedUsers)
}
const credsRemote = {
  categoryTitle: cfg.categoryTitle,
  credentials: Object.fromEntries(
    ['admin', 'reporter', 'section-editor', 'editor-in-chief'].map((r) => [r, { email: seedUsers.users[r].email, password: seedUsers.users[r].password, name: `Staging ${r}` }]),
  ),
}
writeJson(p.credentialsRemote, credsRemote)
writePrivate(
  p.credentialsHuman,
  [
    'Church Times staging: SYNTHETIC staff logins (invented accounts, no real people). Keep this file private; do not paste it anywhere.',
    '',
    `Newsroom (staff app) : ${o.newsroom}`,
    `CMS admin (Payload)  : ${o.cms}/admin`,
    `Public site          : ${o.public}`,
    '',
    ...ROLES.flatMap((r) => [`${r}`, `  email   : ${seedUsers.users[r].email}`, `  password: ${seedUsers.users[r].password}`, '']),
    'For the automated remote test run use xapp-remote-credentials.json in this same folder.',
    '',
  ].join('\n'),
)

// 4. process helpers
const state = { startedAt: new Date().toISOString(), host, mode: noFunnel ? 'local' : 'funnel', origins: o, ports: cfg, pids: {}, funnels: [], funnelSyntax: ts?.syntax ?? null, tailscaleBin: ts?.bin ?? null }
const saveState = () => writeJson(p.state, state)
const stopAll = () => {
  for (const name of ['public', 'newsroom', 'cms', 'postgres']) killTree(state.pids[name])
}
let succeeded = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (!succeeded) {
      console.error('\n[funnel] interrupted; stopping what was started.')
      stopAll()
    }
    process.exit(130)
  })
}

const run = (label, argv, env, cwd = root) => {
  log(label)
  const res = spawnSync(process.execPath, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  if (res.status !== 0) {
    console.error(`[funnel] FAILED: ${label} (exit ${res.status})`)
    console.error(String(res.stdout).split('\n').slice(-40).join('\n'))
    console.error(String(res.stderr).split('\n').slice(-40).join('\n'))
    throw new Error(`${label} failed`)
  }
}

const spawnDetached = (name, argv, env, cwd) => {
  const logFile = path.join(p.logs, `${name}.log`)
  rotateLog(logFile)
  const out = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, argv, { cwd, detached: true, windowsHide: true, stdio: ['ignore', out, out], env })
  child.unref()
  state.pids[name] = child.pid
  saveState()
  return child
}

const waitHealthy = (name, pid, url, ok, timeoutMs) =>
  waitFor(
    async () => {
      if (!pidAlive(pid)) throw Object.assign(new Error(`${name} exited; see ${path.join(p.logs, `${name}.log`)}`), { fatal: true })
      const r = await probe(url, { timeoutMs: 8000 })
      return ok(r)
    },
    { timeoutMs, what: `${name} at ${url}` },
  )

// 5. static builds helpers
const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
const distContains = (d, needle) =>
  walk(d).some((f) => /\.(js|mjs|html|css|json|txt)$/.test(f) && fs.readFileSync(f, 'utf8').includes(needle))
const distMatches = (d, re) => walk(d).some((f) => /\.(js|mjs|html|css)$/.test(f) && re.test(fs.readFileSync(f, 'utf8')))

function newestMtime(target) {
  let newest = 0
  const visit = (t) => {
    const st = fs.statSync(t)
    if (st.isDirectory()) for (const n of fs.readdirSync(t)) visit(path.join(t, n))
    else newest = Math.max(newest, st.mtimeMs)
  }
  visit(target)
  return newest
}
// `next build` compiles CMS_HSTS_MAX_AGE / CMS_NOINDEX into the response headers. A build made without them (the normal production
// one) must not be reused here, and `next build` wipes .next, so this marker only survives next to a build made by this tool.
const cmsBuildMarker = path.join(root, '.next', 'funnel-staging-build.json')
function cmsBuildFresh() {
  const id = path.join(root, '.next', 'BUILD_ID')
  if (!fs.existsSync(id)) return false
  if (JSON.stringify(readJson(cmsBuildMarker)) !== JSON.stringify(STAGING_BUILD_FLAGS)) return false
  const built = fs.statSync(id).mtimeMs
  const inputs = [path.join(root, 'src'), ...['next.config.mjs', 'package.json', 'tsconfig.json'].map((f) => path.join(root, f))].filter(fs.existsSync)
  return inputs.every((i) => newestMtime(i) <= built)
}

try {
  // ---- ads must be off (same assertion as deploy/staging/build-static.sh)
  const ads = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'data', 'advertising.json'), 'utf8'))
  if ((ads.campaigns || []).length !== 0 || ads.adsense?.enabled !== false || ads.adsense?.reviewed !== false) {
    throw new Error('src/data/advertising.json is not ads-off (campaigns must be [] and adsense disabled): refusing to build staging.')
  }

  // ---- PostgreSQL
  log(`starting embedded PostgreSQL on 127.0.0.1:${cfg.pgPort} (data: ${p.pgData})`)
  fs.rmSync(p.pgReady, { force: true })
  const pg = spawnDetached('postgres', [markers.postgres], {
    ...process.env,
    PG_DIR: p.pgData,
    PG_PORT: String(cfg.pgPort),
    PG_USER,
    PG_PASSWORD: secrets.PG_PASSWORD,
    PG_DB,
    PG_READY_FILE: p.pgReady,
  }, root)
  await waitFor(
    () => {
      if (fs.existsSync(p.pgReady)) return true
      if (!pidAlive(pg.pid)) throw Object.assign(new Error(`PostgreSQL exited; see ${path.join(p.logs, 'postgres.log')}`), { fatal: true })
      return false
    },
    { timeoutMs: 120_000, what: 'PostgreSQL to accept connections' },
  )

  // ---- migrate + seed
  const payloadBin = path.join(root, 'node_modules', 'payload', 'bin.js')
  const cmsValues = cmsEnvValues({ host, secrets, turnstile })
  run('applying migrations', [payloadBin, 'migrate'], { ...baseEnv(), ...cmsValues, SCHEDULER_ENABLED: 'false' })
  // Seeded on EVERY start (idempotent, a few seconds): an empty or reset database must never be published, because the first visitor
  // to an empty Payload creates the first admin. It also re-syncs the synthetic passwords with the credentials file.
  run('seeding synthetic staff and fixtures (separate short-lived process, loopback-only values)', [payloadBin, 'run', 'src/seed/staging.ts'], {
    ...baseEnv(),
    ...seedEnvValues({ secrets }),
  })

  // ---- CMS production build
  const nextBin = markers.cms
  if (!args.rebuild && cmsBuildFresh()) {
    log('apps/cms/.next is newer than apps/cms/src and was built with the staging switches: reusing it (--rebuild forces a new build)')
  } else {
    run('building the CMS (next build, can take several minutes)', [nextBin, 'build'], {
      ...baseEnv(),
      PAYLOAD_SECRET: 'build-only-placeholder-not-a-secret-000000000000',
      DATABASE_URL: cmsValues.DATABASE_URL,
      ...STAGING_BUILD_FLAGS, // response headers are compiled into the build
    })
    fs.writeFileSync(cmsBuildMarker, JSON.stringify(STAGING_BUILD_FLAGS) + '\n')
  }

  // ---- public site + newsroom, built for the funnel URLs
  const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  const staticEnv = { ...baseEnv(), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }
  run(
    'building the public site',
    [viteBin, 'build', '--outDir', p.distPublic, '--emptyOutDir', '--logLevel', 'warn'],
    {
      ...staticEnv,
      VITE_PUBLIC_CMS_URL: o.cms,
      VITE_PUBLIC_SITE_URL: '',
      VITE_PUBLIC_SUBMISSIONS_URL: '',
      VITE_PUBLIC_CONTACT_URL: '',
      VITE_TURNSTILE_SITE_KEY: turnstile.siteKey,
      VITE_TURNSTILE_ACTION: cfg.turnstileAction,
    },
    repoRoot,
  )
  run(
    'building the newsroom (live CMS only)',
    [viteBin, 'build', 'apps/newsroom', '--outDir', p.distNewsroom, '--emptyOutDir', '--logLevel', 'warn'],
    { ...staticEnv, VITE_CMS_URL: o.cms, VITE_PUBLIC_SITE_URL: o.public },
    repoRoot,
  )
  const checks = [
    [fs.existsSync(path.join(p.distPublic, 'index.html')), 'public index.html missing'],
    [fs.existsSync(path.join(p.distNewsroom, 'index.html')), 'newsroom index.html missing'],
    [distContains(p.distPublic, o.cms), `public build does not contain ${o.cms}`],
    [distContains(p.distNewsroom, o.cms), `newsroom build does not contain ${o.cms}`],
    [distContains(p.distPublic, turnstile.siteKey), 'public build does not contain the Turnstile site key'],
    [distContains(p.distPublic, cfg.turnstileAction), 'public build does not contain the Turnstile action'],
    [!distMatches(p.distPublic, /pagead2\.googlesyndication\.com|googletagservices|adsbygoogle\.js/) && !distMatches(p.distNewsroom, /pagead2\.googlesyndication\.com|googletagservices|adsbygoogle\.js/), 'an ad script URL is present in the build'],
    [!distMatches(p.distNewsroom, /LOCAL MOCK MODE|Development mock backend/), 'mock-mode strings found in the newsroom build'],
  ]
  for (const [ok, msg] of checks) if (!ok) throw new Error(`post-build check failed: ${msg}`)
  fs.writeFileSync(path.join(p.distPublic, 'robots.txt'), 'User-agent: *\nDisallow: /\n')
  writeJson(p.buildInfo, { builtAt: new Date().toISOString(), host, turnstileAction: cfg.turnstileAction })
  log('post-build checks passed (CMS URL, site key and action compiled in; ads off; no mock newsroom)')

  // ---- start the three services (loopback only)
  log(`starting the CMS (next start) on 127.0.0.1:${cfg.cmsPort}`)
  const cms = spawnDetached('cms', [nextBin, 'start', '-p', String(cfg.cmsPort), '-H', '127.0.0.1'], { ...baseEnv(), ...cmsValues }, root)
  const serveEnv = (mode, port, dist) => ({
    ...baseEnv(),
    FUNNEL_SERVE_MODE: mode,
    FUNNEL_SERVE_PORT: String(port),
    FUNNEL_SERVE_DIST: dist,
    FUNNEL_PUBLIC_CMS_ORIGIN: o.cms,
    FUNNEL_CMS_LOOPBACK: loopback(cfg.cmsPort),
  })
  log(`starting the public site on 127.0.0.1:${cfg.publicPort} and the newsroom on 127.0.0.1:${cfg.newsroomPort}`)
  const pub = spawnDetached('public', [markers.serve], serveEnv('public', cfg.publicPort, p.distPublic), repoRoot)
  const news = spawnDetached('newsroom', [markers.serve], serveEnv('newsroom', cfg.newsroomPort, p.distNewsroom), repoRoot)

  await waitHealthy('cms', cms.pid, `${loopback(cfg.cmsPort)}/api/users/me`, (r) => r.status === 200, 240_000)
  await waitHealthy('public', pub.pid, `${loopback(cfg.publicPort)}/`, (r) => r.status === 200, 60_000)
  await waitHealthy('newsroom', news.pid, `${loopback(cfg.newsroomPort)}/`, (r) => r.status === 200, 60_000)
  log('all three services answer on 127.0.0.1')

  // ---- the database must be initialised BEFORE anything can become public: on an empty Payload the first visitor creates the first admin
  const init = await probe(`${loopback(cfg.cmsPort)}/api/users/init`)
  let initialized = false
  try {
    initialized = JSON.parse(init.text).initialized === true
  } catch {
    // stays false
  }
  if (!initialized) throw new Error(`Refusing to continue: the CMS reports no users yet (GET /api/users/init -> HTTP ${init.status}). An empty CMS would let the first visitor become admin.`)
  const adminCreds = seedUsers.users.admin
  const adminLogin = await probe(`${loopback(cfg.cmsPort)}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminCreds.email, password: adminCreds.password }),
  })
  if (adminLogin.status !== 200) throw new Error(`Refusing to continue: the synthetic admin from seed-users.json cannot log in (HTTP ${adminLogin.status}); the credentials file and the database disagree.`)
  log('database check passed: users exist and the synthetic admin login works')

  // ---- publish the funnels
  if (!noFunnel) {
    for (const e of entries) {
      // Recorded BEFORE the command runs: if it half-succeeds, funnel-down still knows about the entry.
      state.funnels.push({ name: e.name, httpsPort: e.httpsPort, localPort: e.localPort })
      saveState()
      for (const c of funnelOnCommands(ts.syntax, e, ts)) {
        log(`tailscale ${c.join(' ')}`)
        const res = tsRun(ts.bin, c, { timeoutMs: 60_000 })
        const text = `${res.stdout}\n${res.stderr}`.trim()
        if (res.status !== 0 || res.timedOut) {
          const help = explainTailscaleFailure(text)
          throw new Error(
            `\`tailscale ${c.join(' ')}\` failed${res.timedOut ? ' (timed out; it may be waiting for you to approve something in the browser: open the link below)' : ''}:\n${text}\n${help ? `\nWhat to do: ${help}` : ''}`,
          )
        }
        if (/https?:\/\/login\.tailscale\.com\/\S+/i.test(text) && !/available on the internet|Funnel on/i.test(text)) log(text)
      }
    }
  }

  // ---- verify
  console.log('')
  const failures = []
  const expect = (label, cond, detail = '') => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
    if (!cond) failures.push(label)
  }
  const noindex = (r) => /noindex/i.test(r.headers.get('x-robots-tag') ?? '')
  const userNull = (r) => {
    try {
      return JSON.parse(r.text).user === null
    } catch {
      return false
    }
  }
  const slug = 'staging-published-1'
  log('checks on 127.0.0.1:')
  {
    const r1 = await probe(`${loopback(cfg.publicPort)}/`)
    expect(`public /  -> 200 + noindex`, r1.status === 200 && noindex(r1), `HTTP ${r1.status}`)
    const r2 = await probe(`${loopback(cfg.publicPort)}/reports/${slug}/`)
    expect(`public /reports/${slug}/ -> 200 + noindex`, r2.status === 200 && noindex(r2), `HTTP ${r2.status}`)
    const r3 = await probe(`${loopback(cfg.newsroomPort)}/`)
    expect(`newsroom / -> 200 + noindex`, r3.status === 200 && noindex(r3), `HTTP ${r3.status}`)
    const r4 = await probe(`${loopback(cfg.cmsPort)}/api/users/me`)
    expect(`CMS /api/users/me -> 200, user null`, r4.status === 200 && userNull(r4), `HTTP ${r4.status}`)
  }
  if (!noFunnel) {
    const verifyAttempts = Math.max(1, Number(process.env.FUNNEL_VERIFY_ATTEMPTS) || 18)
    log(`checks through Funnel from this PC (a first certificate can take a minute; retrying up to ${Math.round((verifyAttempts * 10) / 60)} minute(s)):`)
    const viaFunnel = async (label, url, good) => {
      let last
      for (let i = 0; i < verifyAttempts; i++) {
        last = await probe(url)
        if (good(last)) break
        await sleep(10_000)
      }
      expect(label, good(last), last.error ? last.error : `HTTP ${last.status}`)
    }
    await viaFunnel(`${o.public}/ -> 200 + noindex`, `${o.public}/`, (r) => r.status === 200 && noindex(r))
    await viaFunnel(`${o.public}/reports/${slug}/ -> 200`, `${o.public}/reports/${slug}/`, (r) => r.status === 200)
    await viaFunnel(`${o.newsroom}/ -> 200 + noindex`, `${o.newsroom}/`, (r) => r.status === 200 && noindex(r))
    await viaFunnel(`${o.cms}/api/users/me -> 200, user null`, `${o.cms}/api/users/me`, (r) => r.status === 200 && userNull(r))
  }

  succeeded = failures.length === 0
  state.ready = succeeded
  saveState()
  console.log('')
  if (failures.length) {
    console.error(`[funnel] ${failures.length} check(s) failed. The services are left running so you can look; logs: ${p.logs}`)
    console.error('[funnel] `npm run staging:funnel:status` shows the state, `npm run staging:funnel:down` stops everything.')
    succeeded = true // keep processes running for inspection
    process.exit(1)
  }
  console.log(noFunnel ? '[funnel] READY (local only, nothing is public)' : '[funnel] READY: the staging is on the internet until you run `npm run staging:funnel:down`')
  console.log(`  Public site : ${noFunnel ? loopback(cfg.publicPort) : o.public}`)
  console.log(`  Newsroom    : ${noFunnel ? loopback(cfg.newsroomPort) : o.newsroom}`)
  console.log(`  CMS / admin : ${noFunnel ? loopback(cfg.cmsPort) : o.cms}   (admin: /admin)`)
  console.log(`  Staff logins (human)           : ${p.credentialsHuman}`)
  console.log(`  XAPP_REMOTE_CREDENTIALS (JSON) : ${p.credentialsRemote}`)
  console.log(`  Logs / state                   : ${p.logs} , ${p.state}`)
  console.log('  Stop: npm run staging:funnel:down     Status: npm run staging:funnel:status')
  if (!noFunnel) {
    console.log('')
    console.log('  Remote test run (from apps/cms):')
    console.log(`    XAPP_PUBLIC_URL=${o.public} XAPP_NEWSROOM_URL=${o.newsroom} XAPP_CMS_URL=${o.cms} XAPP_REMOTE_CREDENTIALS=${quote(p.credentialsRemote)} npm run test:e2e:remote`)
  }
} catch (err) {
  console.error(`[funnel] ${err instanceof Error ? err.message : err}`)
  console.error('[funnel] startup failed; stopping what was started. Data and logs are kept (see the state folder).')
  stopAll()
  state.pids = {}
  if (!noFunnel && state.funnels.length) {
    // Turn off only the entries this run created, and keep any that cannot be confirmed off in state.json so funnel-down retries them.
    state.funnels = turnOffFunnels(ts.bin, ts.syntax, state.funnels)
    if (state.funnels.length) console.error('[funnel] WARNING: some Funnel entries could not be confirmed off. Run `npm run staging:funnel:down` (or `tailscale funnel status`).')
  }
  saveState()
  process.exit(1)
}
