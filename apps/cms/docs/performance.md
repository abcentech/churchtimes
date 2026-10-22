# CMS read-path performance

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
