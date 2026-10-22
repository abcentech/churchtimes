/**
 * `npm run perf:read -- [--posts 4346] [--comments-max 16] [--redirects 5000] [--iterations 30] [--json out.json] [--keep]`
 *
 * Measures the CMS public and admin read paths at go-live scale on a THROWAWAY embedded PostgreSQL with SYNTHETIC data
 * (the same generator as `import:rehearse`, so nothing real is read). It imports the synthetic export, adds redirect rules
 * and ad campaigns, then for every read path prints p50/p95 latency and the number of SQL queries per request, and runs
 * EXPLAIN (ANALYZE, BUFFERS) on every distinct SELECT the path sent, flagging sequential scans on large tables.
 * Exit code 1 when a path breaks its threshold (see docs/performance.md).
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
const str = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const POSTS = num('--posts', 4346)
const COMMENTS_MAX = num('--comments-max', 16)
const REDIRECTS = num('--redirects', 5000)
const ITER = num('--iterations', 30)
const IMAGES = 60
const JSON_OUT = str('--json')
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

// Count (and optionally record) every query sent to PostgreSQL by this process.
let queries = 0
let recorder: Array<{ text: string; values: unknown[] }> | null = null
const originalQuery = pg.Client.prototype.query as (...a: unknown[]) => unknown
;(pg.Client.prototype as { query: unknown }).query = function (this: unknown, ...a: unknown[]) {
  queries++
  if (recorder) {
    const first = a[0] as string | { text?: string; values?: unknown[] }
    const text = typeof first === 'string' ? first : first?.text
    const values = (typeof first === 'string' ? (a[1] as unknown[]) : (first?.values ?? (Array.isArray(a[1]) ? (a[1] as unknown[]) : undefined))) ?? []
    if (typeof text === 'string') recorder.push({ text, values: Array.isArray(values) ? values : [] })
  }
  return originalQuery.apply(this, a)
}

type PlanNode = {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  'Actual Rows'?: number
  'Actual Loops'?: number
  'Sort Method'?: string
  'Sort Space Type'?: string
  Plans?: PlanNode[]
}
type Explained = { sql: string; ms: number; nodes: string[]; seqScans: Array<{ table: string; rows: number }>; diskSort: boolean }
type Result = {
  name: string
  n: number
  p50: number
  p95: number
  max: number
  queries: number
  bytes: number
  threshold: { p95: number; queries: number }
  explained: Explained[]
  ok: boolean
}
const results: Result[] = []
let explainErrors = 0

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
const round = (n: number) => Math.round(n * 100) / 100

function walk(node: PlanNode, out: PlanNode[]) {
  out.push(node)
  for (const c of node.Plans ?? []) walk(c, out)
}

async function main(): Promise<number> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-perf-'))
  const port = await freePort()
  const user = 'churchtimes'
  const password = 'churchtimes-perf'
  const embedded = new EmbeddedPostgres({
    databaseDir: path.join(tmp, 'pgdata'),
    user,
    password,
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: () => {},
  })
  let payloadRef: { destroy: () => Promise<void> } | undefined
  let explainClient: pg.Client | undefined
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    try {
      await explainClient?.end()
    } catch {
      // ignore
    }
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
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      void cleanup().finally(() => process.exit(130))
    })
  }
  try {
    await embedded.initialise()
    await embedded.start()
    await embedded.createDatabase('churchtimes_perf')
    const dbUrl = `postgres://${user}:${password}@127.0.0.1:${port}/churchtimes_perf`
    process.env.DATABASE_URL = dbUrl
    Object.assign(process.env, {
      PAYLOAD_SECRET: 'perf-only-payload-secret-0123456789abcdef0123456',
      PREVIEW_SECRET: 'perf-only-preview-secret-0123456789abcdef01',
      IP_HASH_SALT: 'perf-only-ip-salt-0123456789',
      SCHEDULER_ENABLED: 'false',
      PAYLOAD_DB_PUSH: 'false',
      CMS_PUBLIC_URL: 'http://localhost:3000',
    })
    delete process.env.TURNSTILE_SECRET_KEY

    const { getPayload } = await import('payload')
    const { default: config } = await import('../src/payload.config')
    const { migrations } = await import('../src/migrations')
    const { runImport } = await import('../src/import/run')
    const { publicRedirectsEndpoint, resetRedirectsCache } = await import('../src/endpoints/publicRedirects')
    const { publicAdvertisingEndpoint } = await import('../src/endpoints/publicAdvertising')
    const { publicLegacyCommentsEndpoints } = await import('../src/endpoints/publicLegacyComments')

    const resolved = await config
    const mediaConfig = resolved.collections.find((c) => c.slug === 'media')
    if (!mediaConfig || typeof mediaConfig.upload !== 'object') throw new Error('media collection has no upload config')
    const mediaDir = path.join(tmp, 'media')
    mediaConfig.upload.staticDir = mediaDir
    fs.mkdirSync(mediaDir, { recursive: true })
    const payload = await getPayload({ config: resolved })
    payloadRef = payload
    await payload.db.migrate({ migrations: migrations as never })

    // ---- Synthetic import --------------------------------------------------------------------------------------
    const uploads = path.join(tmp, 'uploads')
    fs.mkdirSync(path.join(uploads, ...IMAGE_DIR.split('/')), { recursive: true })
    for (let n = 0; n < IMAGES; n++) {
      const png = await sharp({ create: { width: 160, height: 100, channels: 3, background: { r: (n * 37) % 256, g: (n * 91) % 256, b: (n * 53) % 256 } } }).png().toBuffer()
      fs.writeFileSync(path.join(uploads, ...IMAGE_DIR.split('/'), imageName(n)), png)
    }
    const gen = largeWxr({ posts: POSTS, images: IMAGES, idBase: 9_000_000, prefix: 'pf', seed: 20261021, maxComments: COMMENTS_MAX })
    const exportFile = path.join(tmp, 'export.xml')
    fs.writeFileSync(exportFile, gen.xml)
    console.error('[perf] import start')
    const t0 = Date.now()
    await runImport(payload, { file: exportFile, uploadsRoot: uploads, manifestPath: path.join(tmp, 'apply.jsonl'), dryRun: false })
    const importSeconds = (Date.now() - t0) / 1000

    console.error('[perf] import done')
    explainClient = new pg.Client({ connectionString: dbUrl })
    await explainClient.connect()
    const sql = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) =>
      (await explainClient!.query<T>(text, values)).rows

    // ---- Extra volume: redirect rules and ad campaigns ---------------------------------------------------------
    await sql(
      `INSERT INTO redirects ("from", "to", status, source, updated_at, created_at)
       SELECT '/old-perf/' || g || '/', '/new-perf-' || g || '/', 301, (CASE WHEN g % 2 = 0 THEN 'manual' ELSE 'rank-math' END)::enum_redirects_source, now(), now()
       FROM generate_series(1, $1::int) g`,
      [REDIRECTS],
    )
    const adv = (await payload.create({ collection: 'advertisers', data: { name: 'Perf Advertiser' } as never, overrideAccess: true })) as { id: number }
    for (let i = 0; i < 60; i++) {
      await payload.create({
        collection: 'ad-campaigns',
        data: { advertiser: adv.id, sponsor: `Perf sponsor ${i}`, alt: 'Perf offer', destinationUrl: 'https://example.test/offer', placements: ['homepage-billboard'], startsAt: new Date(Date.now() - 86_400_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000 * (1 + (i % 9))).toISOString(), priority: i % 100 } as never,
        overrideAccess: true,
      })
    }
    await sql(`UPDATE ad_campaigns SET status = 'approved', rights_confirmed = true, payment_status = 'paid'`)
    await sql('ANALYZE')

    const admin = (await payload.create({ collection: 'users', data: { email: 'perf-admin@test.invalid', name: 'Perf Admin', password: 'Perf-Only-Pw-0123456789!', role: 'admin' } as never, overrideAccess: true })) as { id: number; role: string }
    try { (payload.db as unknown as { pool: pg.Pool }).pool.on('error', () => {}) } catch { /* ignore */ }
    const adminUser = { ...admin, collection: 'users' }

    // ---- Facts used by the measurements ------------------------------------------------------------------------
    const counts = {
      articles: Number((await sql('SELECT count(*)::int AS n FROM articles'))[0].n),
      published: Number((await sql(`SELECT count(*)::int AS n FROM articles WHERE status = 'published'`))[0].n),
      comments: Number((await sql('SELECT count(*)::int AS n FROM legacy_comments'))[0].n),
      approvedComments: Number((await sql(`SELECT count(*)::int AS n FROM legacy_comments WHERE status = 'approved'`))[0].n),
      redirects: Number((await sql('SELECT count(*)::int AS n FROM redirects'))[0].n),
      campaigns: Number((await sql('SELECT count(*)::int AS n FROM ad_campaigns'))[0].n),
      media: Number((await sql('SELECT count(*)::int AS n FROM media'))[0].n),
    }
    const busy = (
      await sql<{ slug: string; legacy_id: number; n: number }>(
        `SELECT a.slug, a.legacy_id, count(*)::int AS n FROM legacy_comments c JOIN articles a ON a.id = c.article_id
         WHERE c.status = 'approved' AND a.status = 'published' GROUP BY a.slug, a.legacy_id ORDER BY n DESC LIMIT 1`,
      )
    )[0]
    const category = (await sql<{ id: number }>(`SELECT category_id AS id FROM articles WHERE status = 'published' GROUP BY category_id ORDER BY count(*) DESC LIMIT 1`))[0].id
    const midSlug = (await sql<{ slug: string }>(`SELECT slug FROM articles WHERE status = 'published' ORDER BY id OFFSET ${Math.floor(counts.published / 2)} LIMIT 1`))[0].slug

    const fakeReq = (query: string) =>
      ({ payload, headers: new Headers(), searchParams: new URLSearchParams(query), url: `http://localhost/?${query}` }) as never
    const handler = (e: { handler: unknown }) => e.handler as (req: never) => Promise<Response>

    console.error('[perf] seeded; measuring')
    // ---- Measurement -------------------------------------------------------------------------------------------
    async function measure(name: string, threshold: { p95: number; queries: number }, fn: () => Promise<number | undefined>, opts: { iterations?: number; before?: () => void } = {}) {
      const n = opts.iterations ?? ITER
      for (let i = 0; i < 2; i++) {
        opts.before?.()
        await fn()
      }
      const times: number[] = []
      const qs: number[] = []
      let bytes = 0
      for (let i = 0; i < n; i++) {
        opts.before?.()
        const q0 = queries
        const s = process.hrtime.bigint()
        bytes = (await fn()) ?? 0
        times.push(Number(process.hrtime.bigint() - s) / 1e6)
        qs.push(queries - q0)
      }
      // One recorded run for EXPLAIN.
      opts.before?.()
      recorder = []
      await fn()
      const sent = recorder
      recorder = null
      const seen = new Set<string>()
      const explained: Explained[] = []
      for (const q of sent) {
        if (!/^\s*select/i.test(q.text) || seen.has(q.text)) continue
        seen.add(q.text)
        try {
          const rows = await sql<{ 'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.text}`, q.values)
          const root = rows[0]['QUERY PLAN'][0]
          const nodes: PlanNode[] = []
          walk(root.Plan, nodes)
          explained.push({
            sql: q.text.replace(/\s+/g, ' ').slice(0, 220),
            ms: round(root['Execution Time']),
            nodes: [...new Set(nodes.map((x) => x['Node Type'] + (x['Relation Name'] ? ` on ${x['Relation Name']}` : '') + (x['Index Name'] ? ` (${x['Index Name']})` : '')))],
            seqScans: nodes.filter((x) => x['Node Type'] === 'Seq Scan' && x['Relation Name']).map((x) => ({ table: x['Relation Name'] as string, rows: (x['Actual Rows'] ?? 0) * (x['Actual Loops'] ?? 1) })),
            diskSort: nodes.some((x) => x['Sort Space Type'] === 'Disk'),
          })
        } catch (e) {
          if (explainErrors === 0) console.error('[perf] explain failed:', (e as Error).message.slice(0, 200), q.text.slice(0, 120))
          explainErrors++
        }
      }
      const sorted = [...times].sort((a, b) => a - b)
      const qSorted = [...qs].sort((a, b) => a - b)
      const r: Result = { name, n, p50: round(pct(sorted, 50)), p95: round(pct(sorted, 95)), max: round(sorted[sorted.length - 1]), queries: pct(qSorted, 50), bytes, threshold, explained, ok: false }
      r.ok = r.p95 <= threshold.p95 && r.queries <= threshold.queries
      results.push(r)
    }

    const pub = { overrideAccess: false } as const
    const body = async (res: Response) => (await res.text()).length

    await measure('articles list (public, depth 1, page 1, limit 20)', { p95: 100, queries: 8 }, async () => {
      const r = await payload.find({ collection: 'articles', where: { status: { equals: 'published' } }, sort: '-publishedAt', limit: 20, depth: 1, ...pub })
      return JSON.stringify(r).length
    })
    await measure('articles list (public, page 200 of limit 20)', { p95: 150, queries: 8 }, async () => {
      const r = await payload.find({ collection: 'articles', where: { status: { equals: 'published' } }, sort: '-publishedAt', limit: 20, page: 200, depth: 1, ...pub })
      return JSON.stringify(r).length
    })
    await measure('articles list by category (public, depth 1)', { p95: 100, queries: 8 }, async () => {
      const r = await payload.find({ collection: 'articles', where: { and: [{ status: { equals: 'published' } }, { category: { equals: category } }] }, sort: '-publishedAt', limit: 20, depth: 1, ...pub })
      return JSON.stringify(r).length
    })
    await measure('article by slug (public, depth 1)', { p95: 60, queries: 8 }, async () => {
      const r = await payload.find({ collection: 'articles', where: { and: [{ slug: { equals: midSlug } }, { status: { equals: 'published' } }] }, limit: 1, depth: 1, ...pub })
      return JSON.stringify(r).length
    })
    await measure('article by slug (public, depth 2)', { p95: 100, queries: 12 }, async () => {
      const r = await payload.find({ collection: 'articles', where: { and: [{ slug: { equals: midSlug } }, { status: { equals: 'published' } }] }, limit: 1, depth: 2, ...pub })
      return JSON.stringify(r).length
    })
    await measure('RSS source: latest 50, depth 1, public', { p95: 120, queries: 8 }, async () => {
      const r = await payload.find({ collection: 'articles', where: { status: { equals: 'published' } }, sort: '-publishedAt', limit: 50, depth: 1, select: { title: true, slug: true, excerpt: true, publishedAt: true, category: true } as never, ...pub })
      return JSON.stringify(r).length
    })
    const sitemapPages = Math.ceil(counts.published / 100)
    await measure(`sitemap source: slug+updatedAt, limit 100, page 1`, { p95: 60, queries: 4 }, async () => {
      const r = await payload.find({ collection: 'articles', where: { status: { equals: 'published' } }, sort: 'id', limit: 100, page: 1, depth: 0, select: { slug: true, updatedAt: true } as never, ...pub })
      return JSON.stringify(r).length
    })
    await measure(`sitemap source: slug+updatedAt, limit 100, page ${sitemapPages} (last)`, { p95: 80, queries: 4 }, async () => {
      const r = await payload.find({ collection: 'articles', where: { status: { equals: 'published' } }, sort: 'id', limit: 100, page: sitemapPages, depth: 0, select: { slug: true, updatedAt: true } as never, ...pub })
      return JSON.stringify(r).length
    })
    await measure('search: title/slug contains (public)', { p95: 150, queries: 6 }, async () => {
      const r = await payload.find({ collection: 'articles', where: { and: [{ status: { equals: 'published' } }, { or: [{ title: { like: 'story 12' } }, { slug: { like: 'story-12' } }] }] }, limit: 20, depth: 0, ...pub })
      return JSON.stringify(r).length
    })
    await measure('redirects list GET /api/public/redirects (cold build)', { p95: 1500, queries: 20 }, async () => body(await handler(publicRedirectsEndpoint)(fakeReq(''))), { iterations: 10, before: resetRedirectsCache })
    await measure('redirects list GET /api/public/redirects (warm, in-process memo)', { p95: 5, queries: 0 }, async () => body(await handler(publicRedirectsEndpoint)(fakeReq(''))))
    const comments = handler(publicLegacyCommentsEndpoints[0])
    await measure(`legacy comments by slug (busiest article, ${busy.n} comments, page 1 limit 50)`, { p95: 60, queries: 4 }, async () => body(await comments(fakeReq(`article=${busy.slug}&limit=50&page=1`))))
    await measure('legacy comments by articleLegacyId (page 1 limit 100)', { p95: 60, queries: 4 }, async () => body(await comments(fakeReq(`articleLegacyId=${busy.legacy_id}&limit=100&page=1`))))
    await measure('legacy comments by slug, last page (limit 5)', { p95: 60, queries: 4 }, async () => body(await comments(fakeReq(`article=${busy.slug}&limit=5&page=${Math.ceil(busy.n / 5)}`))))
    await measure(`public advertising feed (${counts.campaigns} campaigns)`, { p95: 60, queries: 4 }, async () => body(await handler(publicAdvertisingEndpoint)(fakeReq(''))))
    await measure('admin articles list (status in, category, -updatedAt, limit 25, depth 1)', { p95: 150, queries: 10 }, async () => {
      const r = await payload.find({ collection: 'articles', where: { and: [{ status: { in: ['draft', 'in_review', 'published'] } }, { category: { equals: category } }] }, sort: '-updatedAt', limit: 25, depth: 1, user: adminUser as never, overrideAccess: false })
      return JSON.stringify(r).length
    })
    await measure('admin articles list (status=published, -updatedAt, page 100)', { p95: 150, queries: 10 }, async () => {
      const r = await payload.find({ collection: 'articles', where: { status: { equals: 'published' } }, sort: '-updatedAt', limit: 25, page: 100, depth: 1, user: adminUser as never, overrideAccess: false })
      return JSON.stringify(r).length
    })
    await measure('admin articles search (title/slug contains)', { p95: 150, queries: 10 }, async () => {
      const r = await payload.find({ collection: 'articles', where: { or: [{ title: { like: 'story 12' } }, { slug: { like: 'story-12' } }] }, sort: '-updatedAt', limit: 25, depth: 1, user: adminUser as never, overrideAccess: false })
      return JSON.stringify(r).length
    })

    // ---- Report ------------------------------------------------------------------------------------------------
    console.log('CMS read-path performance (synthetic data, throwaway PostgreSQL, Local API / endpoint handlers, no HTTP)')
    console.log(`Data: ${JSON.stringify(counts)}; import ${importSeconds.toFixed(1)}s; iterations per path ${ITER}; node ${process.version}`)
    console.log('Path'.padEnd(78), 'p50ms'.padStart(8), 'p95ms'.padStart(8), 'max'.padStart(8), 'queries'.padStart(8), 'KB'.padStart(7), ' status')
    for (const r of results) {
      console.log(r.name.padEnd(78), String(r.p50).padStart(8), String(r.p95).padStart(8), String(r.max).padStart(8), String(r.queries).padStart(8), String(Math.round(r.bytes / 1024)).padStart(7), r.ok ? ' ok' : ` OVER (p95<=${r.threshold.p95}ms, queries<=${r.threshold.queries})`)
    }
    console.log('\nEXPLAIN (ANALYZE) of every SELECT per path (tables above 1000 rows scanned sequentially are flagged)')
    for (const r of results) {
      console.log(`\n# ${r.name}`)
      for (const e of r.explained) {
        const flag = e.seqScans.filter((s) => s.rows > 1000).map((s) => `SEQ SCAN ${s.table} (${s.rows} rows)`)
        if (e.diskSort) flag.push('SORT SPILLED TO DISK')
        console.log(`  ${String(e.ms).padStart(8)} ms  ${e.nodes.slice(0, 6).join(' | ')}${flag.length ? '   <== ' + flag.join(', ') : ''}`)
        if (flag.length || e.ms > 5) console.log(`            ${e.sql}`)
      }
    }
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ counts, importSeconds, results }, null, 2))
    const failed = results.filter((r) => !r.ok).length
    console.log(failed === 0 ? '\nAll paths within thresholds.' : `\n${failed} path(s) over threshold.`)
    return failed === 0 ? 0 : 1
  } catch (e) {
    console.error('[perf] FAILED', e instanceof Error ? e.message.slice(0, 400) : e)
    throw e
  } finally {
    await cleanup()
  }
}

process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e?.message?.slice?.(0, 200)); process.exit(1) })
main().then(
  (code) => process.exit(code),
  (err) => {
    const e = err instanceof Error ? err : new Error('unknown')
    console.error('PERF_FAILED', e.name, e.message.slice(0, 300))
    console.error(String(e.stack).split('\n').slice(1, 6).join('\n'))
    process.exit(1)
  },
)
