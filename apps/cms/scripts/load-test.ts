/**
 * `npm run load:test -- [--db-dir DIR] [--steps 10,25,50,100] [--duration 60] [--port 3100] [--json out.json] [--md out.md]`
 *
 * HTTP load test of the public CMS read endpoints against the PRODUCTION build (`next start`) and a kept embedded
 * PostgreSQL holding the synthetic go-live dataset (~4.3k articles, 1,348 legacy comments, categories, redirects,
 * ad campaigns). Needs no external tool: the load generator is plain node:http with a keep-alive agent.
 *
 * Steps: (1) seed the database once with the rehearsal/perf harness when `--db-dir` is empty (`perf-read-paths.ts`);
 * (2) trim comments to 1,348; (3) start `next start` with production settings (PAYLOAD_DB_PUSH off, rate limits at their
 * defaults, TRUST_PROXY on and one X-Forwarded-For address per virtual user, as behind nginx); (4) run the mixed
 * workload at each concurrency; (5) probe the rate limiter from one address.
 *
 * Requires a prior `next build` in this folder (`--build` runs it; with the junctioned node_modules use `--webpack`, see
 * docs/performance.md). Closed loop: every virtual user sends the next request as soon as the last one is answered
 * (`--think-ms N` adds a pause), so the numbers are saturation capacity, not a model of human traffic.
 */
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
const cmsRoot = path.resolve(here, '..')
const argv = process.argv.slice(2)
const flag = (n: string) => argv.includes(n)
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
const STEPS = (opt('--steps') ?? '10,25,50,100').split(',').map(Number)
const DURATION = Number(opt('--duration') ?? 60)
const WARMUP = Number(opt('--warmup') ?? 10)
const THINK = Number(opt('--think-ms') ?? 0)
const COMMENTS = 1348
const DB_DIR = path.resolve(opt('--db-dir') ?? path.join(os.tmpdir(), 'ct-loadtest-db'))
const JSON_OUT = opt('--json')
const MD_OUT = opt('--md')
const PG_POOL_MAX = opt('--pg-pool-max')
const EXTRA_ENV = (opt('--env') ?? '').split(',').filter(Boolean)

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo
      s.close(() => resolve(port))
    })
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0)

// ---- Workload ---------------------------------------------------------------------------------------------------
const SEARCH_QUERIES = [
  'church', 'bishop', 'nigeria youth outreach', 'christmas service', 'anglican communion', 'synod', 'archbishop',
  'thanksgiving', 'women fellowship', 'diocese', 'prayer', 'charity', 'education', 'health clinic', 'community',
  '"grace service"', 'easter celebration -clinic', 'lagos', 'harvest', 'mission',
]
type Facts = { slugs: string[]; categories: number[]; commentSlugs: string[]; commentLegacyIds: number[] }
type Endpoint = { name: string; weight: number; build: (f: Facts, rnd: () => number) => string }
const pick = <T,>(a: T[], rnd: () => number) => a[Math.floor(rnd() * a.length)]
const LIST = '/api/articles?where[status][equals]=published&sort=-publishedAt&limit=20&depth=1'
const ALL_ENDPOINTS: Endpoint[] = [
  { name: 'article list', weight: 18, build: (_f, r) => `${LIST}&page=${r() < 0.7 ? 1 : 1 + Math.floor(r() * 30)}` },
  { name: 'article list by category', weight: 8, build: (f, r) => `${LIST}&where[category][equals]=${pick(f.categories, r)}` },
  { name: 'article by slug', weight: 30, build: (f, r) => `/api/articles?where[slug][equals]=${encodeURIComponent(pick(f.slugs, r))}&where[status][equals]=published&limit=1&depth=1` },
  { name: 'category list', weight: 5, build: () => '/api/categories?limit=100&depth=0' },
  { name: 'search', weight: 15, build: (_f, r) => `/api/public/search?q=${encodeURIComponent(pick(SEARCH_QUERIES, r))}&limit=20${r() < 0.2 ? `&page=${2 + Math.floor(r() * 3)}` : ''}` },
  { name: 'legacy comments', weight: 8, build: (f, r) => (r() < 0.7 ? `/api/legacy-comments?article=${encodeURIComponent(pick(f.commentSlugs, r))}&limit=50` : `/api/legacy-comments?articleLegacyId=${pick(f.commentLegacyIds, r)}&limit=50`) },
  { name: 'redirects', weight: 3, build: () => '/api/public/redirects' },
  { name: 'advertising', weight: 8, build: () => '/api/public/advertising' },
  { name: 'health live', weight: 3, build: () => '/api/health/live' },
  { name: 'health ready', weight: 2, build: () => '/api/health/ready' },
  // Weight 0: not in the mixed workload, selectable with --only for an isolated comparison.
  { name: 'article list (depth 0)', weight: 0, build: (_f, r) => `${LIST.replace('depth=1', 'depth=0')}&page=${r() < 0.7 ? 1 : 1 + Math.floor(r() * 30)}` },
  { name: 'article list (projection)', weight: 0, build: (_f, r) => `${LIST.replace('depth=1', 'depth=0')}&select[title]=true&select[slug]=true&select[excerpt]=true&select[publishedAt]=true&select[category]=true&select[featuredImage]=true&page=${r() < 0.7 ? 1 : 1 + Math.floor(r() * 30)}` },
]
const ONLY = (opt('--only') ?? '').split(',').filter(Boolean)
const ENDPOINTS = ONLY.length ? ALL_ENDPOINTS.filter((e) => ONLY.some((o) => e.name === o)) : ALL_ENDPOINTS.filter((e) => e.weight > 0)
if (ENDPOINTS.length === 0) throw new Error('--only matched no endpoint')
const TOTAL_WEIGHT = ENDPOINTS.reduce((a, e) => a + (ONLY.length ? 1 : e.weight), 0)
const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// ---- HTTP client -----------------------------------------------------------------------------------------------
type Sample = { ms: number; status: number; bytes: number; cache: string; err?: string }
function request(agent: http.Agent, port: number, p: string, ip: string): Promise<Sample> {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint()
    const done = (status: number, bytes: number, cache: string, err?: string) =>
      resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, status, bytes, cache, err })
    const req = http.request({ host: '127.0.0.1', port, path: p, agent, method: 'GET', headers: { 'x-forwarded-for': ip, 'accept-encoding': 'identity' }, timeout: 30_000 }, (res) => {
      let bytes = 0
      res.on('data', (c: Buffer) => (bytes += c.length))
      res.on('end', () => done(res.statusCode ?? 0, bytes, String(res.headers['cache-control'] ?? '')))
      res.on('error', (e) => done(0, bytes, '', e.message))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (e) => done(0, 0, '', e.message))
    req.end()
  })
}

// ---- Process sampling --------------------------------------------------------------------------------------------
type Proc = { cpuSeconds: number; rssMb: number }
// Asynchronous on purpose: a spawnSync here would block THIS event loop, and the stall would be counted as server latency.
const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile(cmd, args, { encoding: 'utf8', windowsHide: true }, (_e, stdout) => resolve(String(stdout ?? ''))))
async function sampleProc(pid: number): Promise<Proc | null> {
  try {
    if (process.platform === 'win32') {
      const script = `$ids=@(${pid})+@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}'|%{$_.ProcessId});$c=0;$m=0;foreach($i in $ids){$p=Get-Process -Id $i -ErrorAction SilentlyContinue;if($p){$c+=$p.TotalProcessorTime.TotalSeconds;$m+=$p.WorkingSet64}};"$c $m"`
      const [c, m] = (await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])).trim().split(' ').map(Number)
      return Number.isFinite(c) ? { cpuSeconds: c, rssMb: m / 1048576 } : null
    }
    const [rss, t] = (await run('ps', ['-o', 'rss=,cputime=', '-p', String(pid)])).trim().split(/s+/)
    const [h, m, sec] = t.split(':').map(Number)
    return { cpuSeconds: h * 3600 + m * 60 + sec, rssMb: Number(rss) / 1024 }
  } catch {
    return null
  }
}

type StepResult = {
  vus: number
  seconds: number
  requests: number
  rps: number
  errorRate: number
  rateLimited: number
  cpuPercentOfOneCore: { avg: number; max: number }
  cpuPercentOfMachine: number
  rssMb: { avg: number; max: number }
  dbConnections: { total: { avg: number; max: number }; active: { avg: number; max: number } }
  endpoints: Array<{ name: string; n: number; rps: number; p50: number; p95: number; p99: number; max: number; errors: number; rateLimited: number; kb: number; cache: string }>
  all: { p50: number; p95: number; p99: number }
}

async function runStep(port: number, vus: number, facts: Facts, serverPid: number, dbUrl: string, seconds: number): Promise<StepResult> {
  const agent = new http.Agent({ keepAlive: true, maxSockets: vus })
  const per = new Map<string, { ms: number[]; errors: number; limited: number; bytes: number; cache: string }>()
  for (const e of ENDPOINTS) per.set(e.name, { ms: [], errors: 0, limited: 0, bytes: 0, cache: '' })
  const all: number[] = []
  let stop = false
  const monitor = new pg.Client({ connectionString: dbUrl })
  await monitor.connect()
  const dbName = new URL(dbUrl).pathname.slice(1)
  const connTotal: number[] = []
  const connActive: number[] = []
  const cpu: number[] = []
  const rss: number[] = []
  let last = await sampleProc(serverPid)
  let lastT = Date.now()
  const startCpu = last?.cpuSeconds ?? 0
  const startT = Date.now()
  const sampler = (async () => {
    while (!stop) {
      await sleep(3000)
      if (stop) break
      const q = await monitor.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'active')::int AS active FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName])
      connTotal.push(q.rows[0].total)
      connActive.push(q.rows[0].active)
      const s = await sampleProc(serverPid)
      if (s && last) {
        const now = Date.now()
        cpu.push(((s.cpuSeconds - last.cpuSeconds) / ((now - lastT) / 1000)) * 100)
        rss.push(s.rssMb)
        last = s
        lastT = now
      }
    }
  })()
  const t0 = Date.now()
  const deadline = t0 + seconds * 1000
  const worker = async (id: number) => {
    const rnd = mulberry(1000 + id)
    const ip = `10.${(id >> 8) & 255}.${id & 255}.${1 + (id % 250)}`
    while (Date.now() < deadline) {
      let x = rnd() * TOTAL_WEIGHT
      let ep = ENDPOINTS[0]
      for (const e of ENDPOINTS) {
        x -= ONLY.length ? 1 : e.weight
        if (x < 0) {
          ep = e
          break
        }
      }
      const s = await request(agent, port, ep.build(facts, rnd), ip)
      const b = per.get(ep.name)!
      if (s.status === 429) b.limited++
      else if (s.status < 200 || s.status >= 400) b.errors++
      else {
        b.ms.push(s.ms)
        all.push(s.ms)
        b.bytes += s.bytes
        if (!b.cache) b.cache = s.cache
      }
      if (THINK > 0) await sleep(THINK)
    }
  }
  await Promise.all(Array.from({ length: vus }, (_, i) => worker(i)))
  const elapsed = (Date.now() - t0) / 1000
  stop = true
  await sampler
  const endCpu = (await sampleProc(serverPid))?.cpuSeconds ?? startCpu
  await monitor.end()
  agent.destroy()
  const endpoints = ENDPOINTS.map((e) => {
    const b = per.get(e.name)!
    const s = [...b.ms].sort((a, c) => a - c)
    return { name: e.name, n: s.length + b.errors + b.limited, rps: round((s.length + b.errors + b.limited) / elapsed), p50: round(pct(s, 50)), p95: round(pct(s, 95)), p99: round(pct(s, 99)), max: round(s[s.length - 1] ?? 0), errors: b.errors, rateLimited: b.limited, kb: round(s.length ? b.bytes / s.length / 1024 : 0), cache: b.cache }
  })
  const requests = endpoints.reduce((a, e) => a + e.n, 0)
  const errors = endpoints.reduce((a, e) => a + e.errors, 0)
  const limited = endpoints.reduce((a, e) => a + e.rateLimited, 0)
  const sortedAll = [...all].sort((a, b) => a - b)
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
  const mx = (a: number[]) => (a.length ? Math.max(...a) : 0)
  const wallCpu = ((endCpu - startCpu) / ((Date.now() - startT) / 1000)) * 100
  return {
    vus,
    seconds: round(elapsed),
    requests,
    rps: round(requests / elapsed),
    errorRate: round(requests - limited > 0 ? (errors / (requests - limited)) * 100 : 0, 2),
    rateLimited: limited,
    cpuPercentOfOneCore: { avg: round(wallCpu), max: round(mx(cpu)) },
    cpuPercentOfMachine: round(wallCpu / os.cpus().length),
    rssMb: { avg: round(avg(rss)), max: round(mx(rss)) },
    dbConnections: { total: { avg: round(avg(connTotal)), max: mx(connTotal) }, active: { avg: round(avg(connActive)), max: mx(connActive) } },
    endpoints,
    all: { p50: round(pct(sortedAll, 50)), p95: round(pct(sortedAll, 95)), p99: round(pct(sortedAll, 99)) },
  }
}

async function waitReady(port: number, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('next start exited early')
    const s = await request(new http.Agent(), port, '/api/health/live', '10.0.0.1')
    if (s.status === 200) return
    await sleep(1000)
  }
  throw new Error('server did not become ready in 120 s')
}

async function main(): Promise<void> {
  // ---- Database -----------------------------------------------------------------------------------------------
  if (!fs.existsSync(path.join(DB_DIR, 'pgdata', 'PG_VERSION'))) {
    console.error(`[load] seeding ${DB_DIR} with the perf harness (about 10 minutes)`)
    const r = spawnSync(process.execPath, [path.join(cmsRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(here, 'perf-read-paths.ts'), '--db-dir', DB_DIR, '--comments-max', '2', '--iterations', '1'], { cwd: cmsRoot, stdio: 'inherit' })
    if (r.status !== 0) throw new Error('seeding failed')
  }
  const port = await freePort()
  const user = 'churchtimes'
  const password = 'churchtimes-perf'
  const embedded = new EmbeddedPostgres({ databaseDir: path.join(DB_DIR, 'pgdata'), user, password, port, persistent: true, onLog: (m) => process.env.LOAD_PG_LOG && console.error("[pg]", m), onError: (m) => console.error("[pg-error]", m) })
  await embedded.start()
  const dbUrl = `postgres://${user}:${password}@127.0.0.1:${port}/churchtimes_perf`
  let server: ChildProcess | undefined
  const cleanup = async () => {
    try {
      if (server && server.exitCode === null) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'])
        else server.kill('SIGTERM')
      }
    } catch { /* ignore */ }
    try { await embedded.stop() } catch { /* ignore */ }
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void cleanup().finally(() => process.exit(130)))
  try {
    const admin = new pg.Client({ connectionString: dbUrl })
    await admin.connect()
    const have = Number((await admin.query('SELECT count(*)::int AS n FROM legacy_comments')).rows[0].n)
    if (have > COMMENTS) {
      await admin.query(`DELETE FROM legacy_comments WHERE id NOT IN (SELECT id FROM legacy_comments ORDER BY random() LIMIT ${COMMENTS})`)
    }
    await admin.query('ANALYZE')
    const counts = {
      articlesPublished: Number((await admin.query(`SELECT count(*)::int AS n FROM articles WHERE status = 'published'`)).rows[0].n),
      comments: Number((await admin.query('SELECT count(*)::int AS n FROM legacy_comments')).rows[0].n),
      categories: Number((await admin.query('SELECT count(*)::int AS n FROM categories')).rows[0].n),
      redirects: Number((await admin.query('SELECT count(*)::int AS n FROM redirects')).rows[0].n),
      campaigns: Number((await admin.query('SELECT count(*)::int AS n FROM ad_campaigns')).rows[0].n),
      media: Number((await admin.query('SELECT count(*)::int AS n FROM media')).rows[0].n),
      articleTableMb: round(Number((await admin.query(`SELECT pg_total_relation_size('articles')/1048576.0 AS mb`)).rows[0].mb)),
    }
    const facts: Facts = {
      slugs: (await admin.query(`SELECT slug FROM articles WHERE status = 'published' ORDER BY random() LIMIT 400`)).rows.map((r) => r.slug),
      categories: (await admin.query('SELECT id FROM categories')).rows.map((r) => r.id),
      commentSlugs: (await admin.query(`SELECT DISTINCT a.slug FROM legacy_comments c JOIN articles a ON a.id = c.article_id WHERE c.status = 'approved' AND a.status = 'published' LIMIT 300`)).rows.map((r) => r.slug),
      commentLegacyIds: (await admin.query(`SELECT DISTINCT a.legacy_id AS id FROM legacy_comments c JOIN articles a ON a.id = c.article_id WHERE c.status = 'approved' AND a.status = 'published' AND a.legacy_id IS NOT NULL LIMIT 300`)).rows.map((r) => r.id),
    }
    await admin.end()
    console.error('[load] dataset', JSON.stringify(counts))

    // ---- Build + server -----------------------------------------------------------------------------------------
    const nextBin = path.join(cmsRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      NODE_OPTIONS: '--no-deprecation',
      DATABASE_URL: dbUrl,
      PAYLOAD_SECRET: 'perf-only-payload-secret-0123456789abcdef0123456',
      PREVIEW_SECRET: 'perf-only-preview-secret-0123456789abcdef01',
      IP_HASH_SALT: 'perf-only-ip-salt-0123456789',
      CMS_PUBLIC_URL: 'https://cms.churchtimesnigeria.net',
      CMS_CORS_ORIGINS: 'https://www.churchtimesnigeria.net',
      CMS_CSRF_ORIGINS: 'https://www.churchtimesnigeria.net',
      PUBLIC_SUBMISSION_ORIGINS: 'https://www.churchtimesnigeria.net',
      TURNSTILE_SECRET_KEY: 'load-test-not-a-real-secret-0123456789',
      TURNSTILE_ALLOWED_HOSTNAMES: 'www.churchtimesnigeria.net',
      TURNSTILE_EXPECTED_ACTION: 'submit-story,contact-message,newsletter-subscribe',
      NEWSLETTER_TOKEN_SECRET: 'load-test-newsletter-secret-0123456789abcdef',
      CMS_ALLOW_NO_SMTP: 'true',
      PAYLOAD_DB_PUSH: 'false',
      TRUST_PROXY: 'true',
      SCHEDULER_ENABLED: 'false',
      PORT: String(await freePort()),
    }
    if (PG_POOL_MAX) env.PG_POOL_MAX = PG_POOL_MAX
    for (const kv of EXTRA_ENV) {
      const [k, ...v] = kv.split('=')
      env[k] = v.join('=')
    }
    delete env.SEARCH_RATE_LIMIT
    if (flag('--build')) {
      const r = spawnSync(process.execPath, [nextBin, 'build', ...(flag('--webpack') ? ['--webpack'] : [])], { cwd: cmsRoot, env: { ...env, DATABASE_URL: 'postgres://x:y@127.0.0.1:1/z' }, stdio: 'inherit' })
      if (r.status !== 0) throw new Error('next build failed')
    }
    if (!fs.existsSync(path.join(cmsRoot, '.next', 'BUILD_ID'))) throw new Error('no production build: run with --build (and --webpack when node_modules is a junction)')
    fs.mkdirSync(path.join(cmsRoot, 'media'), { recursive: true })
    const sport = Number(env.PORT)
    server = spawn(process.execPath, [nextBin, 'start', '-p', String(sport)], { cwd: cmsRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let serverLog = ''
    server.stdout?.on('data', (d: Buffer) => (serverLog += d.toString()))
    server.stderr?.on('data', (d: Buffer) => (serverLog += d.toString()))
    await waitReady(sport, server)
    console.error(`[load] server up on :${sport} (pid ${server.pid})`)

    const smoke = new http.Agent({ keepAlive: true, maxSockets: 1 })
    const sr = mulberry(3)
    for (const e of ENDPOINTS) {
      const u = e.build(facts, sr)
      const r = await request(smoke, sport, u, '10.250.0.2')
      if (r.status !== 200) throw new Error(`smoke test ${u} -> ${r.status} ${r.err ?? ''}
${serverLog.slice(-1500)}`)
    }
    smoke.destroy()

    // Warm-up: touch every endpoint (compiles routes, fills the redirect memo, opens the pool).
    const warm = new http.Agent({ keepAlive: true, maxSockets: 4 })
    const wr = mulberry(7)
    const t0 = Date.now()
    while (Date.now() - t0 < WARMUP * 1000) for (const e of ENDPOINTS) await request(warm, sport, e.build(facts, wr), '10.250.0.1')
    warm.destroy()

    if (opt('--hold')) {
      console.error(`[load] holding ${opt('--hold')} s: http://127.0.0.1:${sport} db ${dbUrl}`)
      await sleep(Number(opt('--hold')) * 1000)
    }

    // ---- Steps --------------------------------------------------------------------------------------------------
    const steps: StepResult[] = []
    for (const vus of STEPS) {
      console.error(`[load] ${vus} virtual users, ${DURATION} s`)
      const r = await runStep(sport, vus, facts, server.pid!, dbUrl, DURATION)
      steps.push(r)
      console.error(`[load]   ${r.rps} rps, p95 ${r.all.p95} ms, errors ${r.errorRate}%, 429 ${r.rateLimited}, cpu ${r.cpuPercentOfOneCore.avg}% of a core, rss ${r.rssMb.max} MB, db conns max ${r.dbConnections.total.max}`)
      await sleep(3000)
    }

    // ---- Rate limiter probe: one address, 70 searches inside a minute ----------------------------------------------
    const probeAgent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    let firstLimited = 0
    let retryAfter = ''
    const probeIp = '203.0.113.77'
    for (let i = 1; i <= 70; i++) {
      const s = await request(probeAgent, sport, `/api/public/search?q=probe${i}`, probeIp)
      if (s.status === 429 && !firstLimited) {
        firstLimited = i
        const raw = await new Promise<string>((res) => http.get({ host: '127.0.0.1', port: sport, path: '/api/public/search?q=probe', headers: { 'x-forwarded-for': probeIp } }, (r) => { res(String(r.headers['retry-after'] ?? '')); r.resume() }))
        retryAfter = raw
      }
    }
    probeAgent.destroy()
    const probe = { searchesBeforeFirst429: firstLimited ? firstLimited - 1 : null, retryAfter }
    console.error('[load] rate limit probe', JSON.stringify(probe))

    const machine = { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, ramGb: round(os.totalmem() / 1073741824), platform: `${os.platform()} ${os.release()}`, node: process.version }
    const out = { machine, counts, durationSeconds: DURATION, thinkMs: THINK, steps, probe, serverLogTail: serverLog.split('\n').filter((l) => /error|warn/i.test(l)).slice(-10) }
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2))
    const md: string[] = []
    md.push(`Machine: ${machine.cpus} x ${machine.cpuModel}, ${machine.ramGb} GB, ${machine.platform}, node ${machine.node}`)
    md.push(`Dataset: ${JSON.stringify(counts)}`)
    md.push('')
    md.push('| VUs | requests | RPS | p50 | p95 | p99 | error % | 429 | CPU % of 1 core (avg/max) | RSS MB (max) | DB conns (max) | DB active (max) |')
    md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const s of steps) md.push(`| ${s.vus} | ${s.requests} | ${s.rps} | ${s.all.p50} | ${s.all.p95} | ${s.all.p99} | ${s.errorRate} | ${s.rateLimited} | ${s.cpuPercentOfOneCore.avg} / ${s.cpuPercentOfOneCore.max} | ${s.rssMb.max} | ${s.dbConnections.total.max} | ${s.dbConnections.active.max} |`)
    for (const s of steps) {
      md.push('', `### ${s.vus} virtual users`, '', '| Endpoint | requests | RPS | p50 | p95 | p99 | max | errors | 429 | KB/resp | Cache-Control |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
      for (const e of s.endpoints) md.push(`| ${e.name} | ${e.n} | ${e.rps} | ${e.p50} | ${e.p95} | ${e.p99} | ${e.max} | ${e.errors} | ${e.rateLimited} | ${e.kb} | ${e.cache || '-'} |`)
    }
    if (MD_OUT) fs.writeFileSync(MD_OUT, md.join('\n'))
    console.log(md.join('\n'))
  } finally {
    await cleanup()
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('LOAD_TEST_FAILED', e instanceof Error ? e.message : JSON.stringify(e), e)
    process.exit(1)
  },
)
