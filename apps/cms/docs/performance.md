# CMS performance

## HTTP load test (production build)

Reproduce: `npm run load:test -- --db-dir <dir> --build --webpack` (the first run seeds the database with the perf harness, about 10 minutes; `--webpack` only because `node_modules` was a junction in the test worktree, a normal checkout can build with Turbopack). Options: `--steps 10,25,50,100`, `--duration 60`, `--only "<endpoint>"` (isolated endpoint, including the extra `article list (depth 0)` and `article list (projection)`), `--think-ms`, `--env K=V`. The generator is plain node:http (no external tool), closed loop with no think time, so the numbers are saturation capacity. On Windows, embedded PostgreSQL can leave an orphaned `startup` process after a run; kill it before the next run if PostgreSQL refuses to start ("pre-existing shared memory block").

Machine: 8 logical cores, Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz, 15.8 GB RAM, win32 10.0.26200, node v24.19.0. The load generator, the embedded PostgreSQL and the CMS ran on the same laptop, with other unrelated processes active, so treat absolute numbers as a floor and compare before/after only.

CMS: `next start` (NODE_ENV=production, one process), `PAYLOAD_DB_PUSH=false`, `TRUST_PROXY=true` with one X-Forwarded-For address per virtual user (as behind nginx), rate limits at defaults (search 60 per minute per address), pg pool at the default 10, scheduler off.

Dataset: 4160 published articles (6 MB table), 1348 legacy comments, 12 categories, 5000 stored redirect rules (plus derived), 60 ad campaigns, 1408 media.

Workload mix (weights): article list 18 (70 percent page 1, rest pages 2 to 30, depth 1, limit 20), list by category 8, article by slug 30, category list 5, search 15 (20 realistic queries, 20 percent page 2 to 4), legacy comments 8, redirects 3, advertising 8, health live 3, health ready 2. 60 s per step after a 10 s warm-up.

### Before the fixes (same data, same machine)

| VUs | RPS | p50 ms | p95 ms | p99 ms | error % | 429 | CPU % of 1 core | RSS MB max | DB conns max / active max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 16.8 | 476.7 | 1831.9 | 2934.7 | 0.39 | 0 | 60.4 | 372.6 | 10 / 2 |
| 25 | 19.3 | 1165.6 | 2974.7 | 3785.8 | 0.17 | 0 | 68.1 | 392.3 | 10 / 3 |
| 50 | 21.2 | 2186.1 | 4522.5 | 5062.9 | 0.75 | 0 | 67.9 | 472.6 | 10 / 3 |
| 100 | 18.4 | 6207.4 | 9427.2 | 10493.2 | 1.86 | 0 | 68.3 | 494.2 | 10 / 3 |

### After the fixes

| VUs | RPS | p50 ms | p95 ms | p99 ms | error % | 429 | CPU % of 1 core | RSS MB max | DB conns max / active max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 52.4 | 191 | 364.4 | 731.1 | 0 | 0 | 99.1 | 392.6 | 10 / 2 |
| 25 | 65 | 428.1 | 764.1 | 1079.9 | 0 | 0 | 104.3 | 511.8 | 10 / 4 |
| 50 | 67.5 | 889.6 | 1426.7 | 1928.9 | 0 | 0 | 107.9 | 511.7 | 10 / 4 |
| 100 | 55.9 | 1941.3 | 3523 | 4027.1 | 0 | 0 | 95.2 | 535 | 10 / 2 |

Error rate excludes 429s. There were no 429s in the mix because every virtual user has its own address and stays far below 60 searches a minute. Rate limiter probe from ONE address: the 61st search inside a minute is the first 429, with `Retry-After: 60`. The limiter is in process memory, so with N replicas the effective limit is 60 x N per address.

### Per endpoint, after the fixes

#### 10 virtual users

| Endpoint | requests | RPS | p50 | p95 | p99 | errors | KB/resp | Cache-Control |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| article list | 554 | 9.2 | 262.9 | 399.2 | 786.7 | 0 | 59.2 | public, max-age=60 |
| article list by category | 283 | 4.7 | 257.6 | 435.8 | 1102.6 | 0 | 62.6 | public, max-age=60 |
| article by slug | 956 | 15.8 | 230.1 | 434.6 | 747.3 | 0 | 3.7 | public, max-age=60 |
| category list | 168 | 2.8 | 78 | 159.4 | 539.2 | 0 | 2 | public, max-age=300 |
| search | 459 | 7.6 | 72.1 | 136.4 | 199.7 | 0 | 3 | public, max-age=60 |
| legacy comments | 242 | 4 | 130.7 | 260.6 | 653.7 | 0 | 0.3 | public, max-age=60 |
| redirects | 88 | 1.5 | 29.4 | 68.9 | 145.5 | 0 | 400.8 | public, max-age=300 |
| advertising | 261 | 4.3 | 78 | 136.9 | 242.3 | 0 | 0.1 | public, max-age=60 |
| health live | 83 | 1.4 | 27.5 | 61.6 | 180.6 | 0 | 0 | no-store |
| health ready | 72 | 1.2 | 31.7 | 436 | 473.2 | 0 | 0.1 | no-store |

#### 25 virtual users

| Endpoint | requests | RPS | p50 | p95 | p99 | errors | KB/resp | Cache-Control |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| article list | 726 | 12.1 | 543.7 | 885.8 | 1171.7 | 0 | 59.5 | public, max-age=60 |
| article list by category | 313 | 5.2 | 536.7 | 949 | 1124.6 | 0 | 63 | public, max-age=60 |
| article by slug | 1201 | 20 | 486.5 | 819.4 | 1157.9 | 0 | 3.7 | public, max-age=60 |
| category list | 169 | 2.8 | 146.9 | 222.5 | 592.8 | 0 | 2 | public, max-age=300 |
| search | 559 | 9.3 | 131 | 250.3 | 515.2 | 0 | 3.3 | public, max-age=60 |
| legacy comments | 324 | 5.4 | 270.5 | 432.7 | 584 | 0 | 0.3 | public, max-age=60 |
| redirects | 120 | 2 | 39.7 | 67.9 | 95.3 | 0 | 400.8 | public, max-age=300 |
| advertising | 321 | 5.3 | 129.4 | 204.5 | 324.7 | 0 | 0.1 | public, max-age=60 |
| health live | 110 | 1.8 | 40.2 | 96.6 | 399.3 | 0 | 0 | no-store |
| health ready | 72 | 1.2 | 44.3 | 686 | 1304.8 | 0 | 0.1 | no-store |

#### 50 virtual users

| Endpoint | requests | RPS | p50 | p95 | p99 | errors | KB/resp | Cache-Control |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| article list | 745 | 12.3 | 1030.8 | 1562.2 | 2210.2 | 0 | 59.5 | public, max-age=60 |
| article list by category | 320 | 5.3 | 1033.6 | 1656.8 | 2051.1 | 0 | 63 | public, max-age=60 |
| article by slug | 1260 | 20.9 | 988.7 | 1529.6 | 2260.5 | 0 | 3.7 | public, max-age=60 |
| category list | 186 | 3.1 | 293.5 | 645.5 | 701.5 | 0 | 2 | public, max-age=300 |
| search | 576 | 9.5 | 203.5 | 415.8 | 683.6 | 0 | 3.4 | public, max-age=60 |
| legacy comments | 319 | 5.3 | 563.3 | 898.9 | 1077.8 | 0 | 0.3 | public, max-age=60 |
| redirects | 130 | 2.2 | 38 | 79.8 | 107.5 | 0 | 400.8 | public, max-age=300 |
| advertising | 318 | 5.3 | 199.3 | 326.6 | 593 | 0 | 0.1 | public, max-age=60 |
| health live | 114 | 1.9 | 39.9 | 89.3 | 139.2 | 0 | 0 | no-store |
| health ready | 108 | 1.8 | 42.9 | 1110.6 | 2063 | 0 | 0.1 | no-store |

#### 100 virtual users

| Endpoint | requests | RPS | p50 | p95 | p99 | errors | KB/resp | Cache-Control |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| article list | 602 | 9.9 | 2736.9 | 3920 | 4076.2 | 0 | 59.5 | public, max-age=60 |
| article list by category | 256 | 4.2 | 2754 | 3934.7 | 4208.1 | 0 | 62.9 | public, max-age=60 |
| article by slug | 1036 | 17 | 2615.6 | 3840.3 | 4058.7 | 0 | 3.7 | public, max-age=60 |
| category list | 158 | 2.6 | 718.4 | 1263.3 | 1526.9 | 0 | 2 | public, max-age=300 |
| search | 507 | 8.3 | 470.6 | 907.1 | 1123.5 | 0 | 3.3 | public, max-age=60 |
| legacy comments | 281 | 4.6 | 1453.5 | 2208 | 2439.6 | 0 | 0.3 | public, max-age=60 |
| redirects | 118 | 1.9 | 48.8 | 159.5 | 301.8 | 0 | 400.8 | public, max-age=300 |
| advertising | 266 | 4.4 | 437.2 | 758.5 | 968.3 | 0 | 0.1 | public, max-age=60 |
| health live | 106 | 1.7 | 42.9 | 117.7 | 182.9 | 0 | 0 | no-store |
| health ready | 68 | 1.1 | 41.7 | 1683.8 | 2093.9 | 0 | 0.1 | no-store |

## Bottlenecks found

1. **The redirect list rebuild froze the whole process (fixed).** The memo expired every 10 s and requests waited for the rebuild. A rebuild costs about 2.7 s of CPU on the event loop (0.4 s loading 5,000 stored rows and 0.9 s loading 4,160 articles through Payload document hydration, 1.0 to 1.4 s in `buildRedirectMap`, pure CPU, linear), SQL itself 24 ms. Every other endpoint stalled behind it. Fix: stale-while-revalidate (an expired memo is served while one background rebuild runs; a failed rebuild still replaces the memo with the error as before) and two raw SQL loaders for the rebuild (same rows, a test proves equality). Result: 3.1x more requests at 10 users (16.8 to 52.4 RPS), p95 1831.9 to 364.4 ms, request errors 0.39 / 0.17 / 0.75 / 1.86 percent to 0 at every step (before: mostly timeouts and 500s while stalled).
2. **One Node process is the limit, not PostgreSQL.** After the fix CPU sits at about 100 percent of one core from 10 users upward and throughput plateaus at 65 to 68 RPS; above that latency grows with users (queueing, not failure: 0 errors at 100 users). SQL time per request is small: EXPLAIN of every SELECT shows 1 to 15 ms per request path (article list 15 ms of SQL against about 100 ms of request time; advertising 5 ms against 65 ms; article by slug 2 ms against 43 ms). The cost is Payload document hydration and JSON serialisation in JavaScript. The pool never exhausted: 10 connections, at most 4 active at any sample.
3. **Article list responses are 59 KB** (20 articles with their full Lexical `content`, depth 1). Clients that render cards should send `select` (title, slug, excerpt, publishedAt, category, featuredImage) and `depth=0`; compare with `--only "article list (projection)"`. The depth-1 list also pays the media read-access query (2 extra queries, about 10 ms of SQL).
4. **No missing index.** EXPLAIN shows index scans on every hot path (the article list composite index, `articles_slug_idx`, GIN on `article_search`, comments and redirect indexes). The sequential scans left are on 4,160-row tables where the planner is right to prefer them (sitemap last page 8 ms, `articles_rels` in the media access query 5 to 9 ms). **No migration was added.** Deep list pages stay linear in the offset (see Findings below).
5. **Query counts (N+1):** unchanged. Article list 7, article by slug 7, search 1, comments 4, advertising 1, redirects 0 warm; the perf harness thresholds still apply.
6. **Pool:** default 10 per process was enough. `PG_POOL_MAX` now sets it (documented in `.env.example`).
7. **Rate limiter:** fixed window per address and per process; correct under 100 concurrent users with distinct addresses, 429 after exactly 60 from one address.

## Fixes shipped with this test

- Redirect list: stale-while-revalidate plus SQL loaders (`src/endpoints/publicRedirects.ts`, `src/lib/redirectData.ts`). Tests in `tests/integration/redirects.test.ts`.
- Cache-Control on Payload's anonymous `GET /api/articles` (list) and `GET /api/categories` (`src/proxy.ts`): only without Cookie or Authorization and without `draft` or `preview`. Tests in `tests/unit/publicReadCache.test.ts`.
- `PG_POOL_MAX` environment variable.
- `scripts/load-test.ts` (`npm run load:test`).

## Recommended production sizing

Measured: about 65 mixed uncached requests per second per Node process on a 4-core laptop that was also running the generator and PostgreSQL. Plan on **about 50 uncached RPS per CMS process**.

- **CPU / replicas:** with the CDN rules below, origin traffic for public reads is a few requests per second. Start with **2 vCPU and 2 CMS processes** (one per core, behind the existing reverse proxy) plus PostgreSQL on the same host; do not run more processes than cores.
- **RAM:** about 0.55 GB RSS per process at 100 users, so 1.2 GB for two, plus PostgreSQL (shared_buffers 256 MB; the dataset is under 100 MB) and the OS: **4 GB**.
- **pg pool:** 10 per process (default) is enough (4 active at most). Keep processes x `PG_POOL_MAX` below PostgreSQL `max_connections` minus about 10 for backups and admin tools.
- **Rate limiters** are per process: with 2 replicas the search limit is 120 per minute per address. Add the limit in the reverse proxy as well if exactness matters.
- **Redirect list:** a rebuild costs 1 to 3 s of CPU on one process, at most every 10 s, and only while someone asks for it (a CDN asks once per 5 minutes). Re-measure above 15,000 rules.

## What to put behind a CDN (exact values)

Cache only 200 responses, key on the full URL including the query string and on `Origin` (`Vary: Origin` is sent), and bypass the cache when a Cookie or Authorization header is present.

| Endpoint | Cache-Control sent by the CMS | CDN rule |
| --- | --- | --- |
| `GET /api/articles?...` (anonymous list and by-slug queries) | `public, max-age=60` (new) | cache, honour origin TTL; purge on unpublish if instant takedown matters |
| `GET /api/articles/:id`, `/api/articles/count`, `/api/media/*` | none | do not cache (media files may be cached by filename) |
| `GET /api/categories` | `public, max-age=300` (new) | cache |
| `GET /api/public/search` | `public, max-age=60` | cache (the rate limit is only reached on a miss) |
| `GET /api/legacy-comments?article=...` | `public, max-age=60` | cache |
| `GET /api/public/redirects` | `public, max-age=300` plus ETag | cache; the 400 KB response, the one most worth caching |
| `GET /api/public/advertising` | `public, max-age=N`, N up to 60 (shorter near a campaign boundary) | cache, honour origin TTL exactly |
| `/api/health/live`, `/api/health/ready` | `no-store` | never cache |
| everything else under `/api` (users, submissions, contact, newsletter, admin, writes) | `no-store` or none | never cache |

---

# CMS read-path performance (in process, no HTTP)

Measured at go-live scale on synthetic data (no real personal data, throwaway PostgreSQL). The numbers are for the
database and Payload layer only (Local API and endpoint handlers called in process, no HTTP, no reverse proxy, no CDN).
Add network and Next.js overhead on top.

## How to reproduce

```sh
cd apps/cms
npm run perf:read -- --json perf.json            # about 10 minutes: imports ~4,346 synthetic posts, then measures
npm run perf:read -- --db-dir ../perf-db         # keeps the database; run it again and the import is skipped (about 3 minutes)
```

Options: `--posts 4346`, `--comments-max 16`, `--images 1500`, `--redirects 5000`, `--iterations 30`, `--sql-chars N`
(how much SQL to keep in the JSON), `--keep`. The script uses the same synthetic generator as `npm run import:rehearse`
(`tests/fixtures/wxr/large.ts`), imports it with the real importer, adds redirect rules and ad campaigns, then for every
path prints p50 / p95 / max latency and SQL queries per request, and runs `EXPLAIN (ANALYZE, BUFFERS)` on every distinct
SELECT the path sent (sequential scans over 1,000 rows or more and sorts spilled to disk are flagged). It exits 1 when a
path breaks its threshold. With `--db-dir`, pending migrations are applied to the kept database, so a new index can be
compared before and after.

## Data used

| Table | Rows |
| --- | --- |
| articles (all published) | 4,160 (4,346 requested; password-protected and draft posts are withheld by the importer) |
| legacy comments (approved) | 23,461 (the busiest article has 10) |
| media | 1,407 |
| redirect rules stored | 5,000 (plus rules derived from article `legacyUrl`) |
| ad campaigns (approved, live) | 60 |

Import of this set: about 450 to 510 s on the development machine (Windows laptop, embedded PostgreSQL).

Caveat on media: with only 60 distinct images (an early run) every image belonged to about 70 articles and the media
access check (`Media.readAccess` joins articles, body media, live updates and campaigns) cost about 110 ms per list
request. With a realistic spread (1,407 media) it costs about 1 to 3 ms. The default is therefore 1,500 images.

## Results (after the index, p50 / p95 ms, queries per request)

Single development machine, 30 iterations per path (10 for the cold redirect build). Run to run noise is about 30 percent.

| Path | p50 | p95 | Queries |
| --- | --- | --- | --- |
| Article list, public, depth 1, page 1, limit 20 | 45 | 60 | 7 |
| Article list, public, page 200 (offset 3,980) | 120 | 137 | 7 |
| Article list by category, public, depth 1 | 43 | 56 | 7 |
| Article by slug, depth 1 / depth 2 | 23 / 21 | 27 / 29 | 7 |
| RSS source (latest 50, depth 1) | 11 | 12 | 4 |
| Sitemap source (slug + updatedAt, 100 per page), page 1 / last | 9 / 13 | 14 / 16 | 2 |
| Search (title or slug contains) | 22 | 30 | 2 |
| `GET /api/public/redirects`, cold build (all 9,000+ rules) | 839 | 903 | 20 |
| `GET /api/public/redirects`, warm (in-process memo) | 1.8 | 2.7 | 0 |
| Legacy comments by article slug, page 1 / last page | 8 / 8 | 13 / 10 | 4 |
| Legacy comments by `articleLegacyId` | 8 | 11 | 4 |
| `GET /api/public/advertising` (60 campaigns) | 17 | 24 | 1 |
| Admin article list (status in, category, `-updatedAt`, depth 1) | 21 | 25 | 6 |
| Admin article list, status filter, page 100 | 80 | 90 | 6 |
| Admin search (title or slug contains) | 37 | 52 | 6 |

## Before and after the fix

| Path | Before p50 / p95 | After p50 / p95 |
| --- | --- | --- |
| Article list, public, page 1 | 244 / 347 | 45 / 60 |
| Article list, public, page 200 | 281 / 368 | 120 / 137 |
| RSS source (latest 50) | 27 / 33 | 11 / 12 |

(Final confirmation run on the shipped migration, same data, noisier machine: page 1 65 / 75, page 200 163 / 188,
RSS 15 / 18. The earlier run with 60 images showed 418 ms p50 before and 161 ms after.)

## Findings and fixes

1. **Public article list sorted every article row (fixed).** `where status = published order by published_at desc, created_at desc`
   had no usable index (the two sort keys cannot use `articles_published_at_idx`), so Postgres read all 4,160 rows,
   including the large `content` column, sorted them (spilling to disk at deep offsets) and returned 20. EXPLAIN: 173 to
   295 ms for the article query alone. Fix: Payload collection `indexes` entry `(status, publishedAt, createdAt)`, migration
   `20261022_141856_article_list_index` (`IF NOT EXISTS` up, `IF EXISTS` down). The query dropped to about 1 ms at page 1.
   Payload also creates the matching index on `_articles_v`; it is harmless (versions are capped at 50 per article).
2. **Deep pages stay linear in the offset (not changed).** Payload joins the corrections array with a lateral subquery
   that runs for every row skipped by the offset: about 20 microseconds per skipped row (page 200 is about 90 ms in the
   query). Public pages are limited to 100 per page by `clampLimit`; readers use the first pages. Not worth a custom query.
   If a crawler walks the whole archive, use the sitemap source (slug and date only, 2 queries, under 20 ms at the last page).
3. **Admin list sorted by `-updatedAt`** already uses `articles_updated_at_idx`. A second composite index was tried and
   made no difference, so it was not kept. Page 100 costs about 60 ms of the 80 (the same lateral subquery as above).
4. **Redirect list cold build** is 0.8 to 1.1 s of CPU for about 9,000 rules, the SQL itself is under 30 ms, so the time is in Payload document
   hydration and map building (not profiled further). It is rebuilt at most once every 10 s per
   process and served with `Cache-Control: public, max-age=300` and ETag/304, so no change was made. The hard cap is 20,000
   rules. Re-measure if the rule count passes 15,000.
5. **Legacy comments, redirect lookups by slug or legacy id, sitemap and RSS** all use indexes
   (`article_status_commentedAt_legacyId_idx`, `articles_slug_idx`, `articles_legacy_id_idx`, `articles_pkey`). No change.
6. **Search** (`title like`, `slug like`) is a sequential scan (about 19 ms for count at 4,160 rows). Fine at this size;
   it grows linearly. Add a `pg_trgm` index if the archive passes about 50,000 articles.
7. **Ad feed** scans at most 500 campaigns (`MAX_SCAN`) with every creative column: about 0.3 ms per campaign in
   the Payload layer. Fine for dozens of campaigns; it is cached by `Cache-Control`.

## Thresholds (what the script checks)

| Path | p95 ms | Queries |
| --- | --- | --- |
| Public article lists (page 1, by category), RSS | 100 to 120 | 8 |
| Public list, deep page 200 | 300 | 8 |
| Article by slug | 60 (depth 1), 100 (depth 2) | 8 / 12 |
| Sitemap source | 60 to 80 | 4 |
| Search | 150 | 6 |
| Redirect list, cold | 1,500 | 20 |
| Redirect list, warm | 25 | 0 |
| Legacy comments | 60 | 4 |
| Advertising feed | 100 | 4 |
| Admin lists | 150 | 10 |

A query count above the threshold means an N+1 crept in. Re-run after adding fields, relationships or access rules to
`articles`, `media` or `legacy-comments`, and after any change that adds a join to a read access check.

## Not measured

HTTP, TLS, Next.js rendering and the CDN; concurrent load (these are single-request timings); the production machine
(2 vCPU VPS, PostgreSQL on the same host: expect slower CPU-bound paths, the redirect build above all); real content
(body size, image spread); section-editor access clauses on the admin list; writes (importer speed is in `docs/import.md`).
