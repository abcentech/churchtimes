# Historical archive recovery coverage

Execution date: 13 October 2026 (UTC). Branch: `agent/codex-archive-recovery`, prepared from `feat/newsroom-mvp` at `ba1d653`.

Scope follows the [latest owner execution brief](https://github.com/abcentech/churchtimes/issues/13#issuecomment-6151492587): read-only historical inventory/download, public current-site inventory, private evidence and tests. This does not close the broader archive-library/import/search work in Issue #13.

## Access and method

Initial proxy probes returned `Tunnel connection failed: 403 Forbidden` before reaching the destination; local DNS resolution also failed. These were environment failures, not Internet Archive origin 403s or proof of missing captures. Required hostnames were saved additively in the cloud environment draft. A subsequent real run received HTTP 200 from CDX, Wayback replay, Wikipedia and the public current site. Archive access is currently working through the managed proxy; direct local DNS resolution is not required for those proxied requests.

CDX wildcard queries cover `.org`, `.com`, both `www` variants, subpaths and query-string post IDs. No MIME/status filter or digest collapse is applied to inventory. All returned index metadata is retained, including 404/redirect rows; HTTP-200 captures are selected for download, with unknown-status revisit records checked as fallbacks for unsaved resources. Raw Wayback `id_` response bytes are saved separately from extracted text. Exact original URL plus timestamp identifies a capture; SHA-256 deduplicates identical bytes. Successful copies never imply every article is complete.

CDX canonicalizes `www` in its URL matching: paired host queries returned identical response checksums in this run. Totals deduplicate repeated original URL/timestamp rows. Domain breakdown uses the actual original host in each returned row, not the query host. Some captures have distinct `www` original URLs; these are retained and counted under their actual hosts.

## Counts

The completed CDX inventories contain **1,152 distinct URL/timestamp rows across 676 original URLs**. Every indexed HTTP-200 original URL has been attempted; download limits were not reached. These counts describe the returned public indexes at execution time, not proof of exhaustive historical preservation.

| Original host | CDX rows | URLs | Saved records | HTML saves | Media records | Partial article candidates | Observed capture range (UTC) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `churchtimesnigeria.com` | 152 | 69 | 66 | 30 | 28 | 19 | 2011-02-07 – 2019-07-24 |
| `churchtimesnigeria.org` | 865 | 540 | 344 | 245 | 48 | 103 | 2011-05-05 – 2022-11-09 |
| `www.churchtimesnigeria.com` | 114 | 63 | 36 | 31 | 0 | 14 | 2011-05-09 – 2013-10-09 |
| `www.churchtimesnigeria.org` | 21 | 4 | 0 | 0 | 0 | 0 | 2011-06-20 – 2013-10-16 |

- **446 saved capture records**, deduplicated into **407 raw files / 10,046,674 bytes** (10.05 MB decimal). Multiple records can share identical bytes.
- **306 complete HTTP HTML payload saves**; **136 partial article candidates / 136 distinct candidate raw hashes**. Candidate identity is heuristic; this is not a deduplicated count of unique journalistic works. **0 editorially verified-full articles**.
- **76 media records**: 49 JPEG, 24 PNG, 2 GIF and 1 icon. No PDF/audio/video MIME rows were observed in the returned indexes or saved responses; this does not prove historical absence.
- **140 non-HTML resource saves**, including those media records plus XML/feeds, CSS, JavaScript and plain text.
- **308 failed capture records**: 227 origin replay 404s, 73 different-original redirects requiring review, 3 responses without a valid replay capture URL, and 5 quarantined error/MIME bodies. These are capture records, not distinct missing articles or files.
- **157 indexed HTTP-200 original URLs remain without a saved record**, despite attempts and older-version fallbacks. **0 indexed HTTP-200 URLs were left unattempted**.
- **145 unresolved literal embedded asset URLs**; some are default-port/www aliases whose bytes may already exist under another saved URL. This is not a count of definitively lost media files. **120 externally hosted asset URLs were listed but not fetched**.
- Historical CDX status counts include **77 original HTTP-404 rows**; these differ from the 227 present-day replay 404 records. They must not be added together as a missing-article total.
- Three availability operations initially failed with HTTP 429 after retries. Later availability checks succeeded; an empty closest result did not prevent retrieval of the supplied fixed capture. Interrupted operations and the corrected legacy-space URL failure remain logged. Earlier operations retain final logical outcomes; later operations also retain retry-level traces.
- **4,343 published current-site posts observed**, matching the public REST total; REST pagination completed. **7,376 current sitemap URLs observed** (mixed articles/pages/categories/etc.; not 7,376 articles). Private drafts/statuses were not requested.

Three of four exact cited URLs have saved payloads. The fourth has a saved query-string candidate linked by its archived tag page, while the exact cited slug replay returned 404. All four bodies or candidate mappings still require editorial review.

Checksummed representative citation captures (actual source bytes; no full article text is committed):

| Saved original URL | Capture timestamp | Displayed publication date | Raw bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| `http://churchtimesnigeria.org/bishop-bola-odeleke-my-experience-with-men/` | `20150227141508` | 2011-06-01 | 56,225 | `d609e86e60ecc6ccb42d8964d57ee8ed4dba2f91d5ef1e69660a93b2f99b4601` |
| `http://churchtimesnigeria.org/?p=32` | `20130907002641` | 2011-08-16 | 38,956 | `d97d8cfe4efca55ee9757c82954cf9ed556ba5f19fade8929e7659999b88ed42` |
| `http://churchtimesnigeria.org/?p=35` | `20131221015910` | 2011-08-22 | 21,350 | `7bcc3fd0108d6adf8cc2d30f237676e6a48e8f089dbb37b0d7850caaf7dc9782` |
| `http://churchtimesnigeria.org/?p=216` | `20140821160417` | 2014-05-09 | 25,925 | `a9d2e16d9d274d4b855c1f0592dea47fcf80613cfa2ffa7d3a8c72ad038c0ae0` |

No test fixture contributes to these counts. Aggregate snapshot generated at `2026-10-13T18:52:07.955190+00:00`.

## Citation and identity evidence

The downloaded Wikipedia Bola Odeleke biography contains the old `.org` article URL. The supplied fixed capture at `20150227141508` was actually retrieved, even when the availability API returned no closest result. This demonstrates why an empty availability response cannot establish archive absence.

The issue's Nairaland, book and academic citations are provenance leads; thread/book/publication URLs were not supplied and were not invented. Exact query-string article URLs `?p=32` and `?p=35` are checked through both indexed captures and availability responses. The Anglican/Ifa article's exact cited slug had no closest-capture result; a direct replay using the related tag's observed timestamp also returned origin HTTP 404. This establishes failure of that attempt, not exhaustive absence. However, the actually saved `?tag=ifa-oracle` page at `20140821063740` explicitly links that title to `http://churchtimesnigeria.org/?p=216`. The saved `?p=216` article capture at `20140821160417` contains the interview body. This is a candidate alternate original URL with direct archived linkage, not a recovered copy of the cited slug or a reconstruction. Review the mapping before canonical redirects or deduplication.

Older `.com` reporting captures explicitly contain “Church Times Nigeria: Reporting the Church in a changing world.” A later `.com` homepage capture is parked and advertises unrelated financial products. Keep these periods separate: archived branding supports historical use for reporting, not continued ownership or an assumption that every `.com` capture is journalism. No domains were directly contacted, bought or renewed.

## Private storage and integrity

Actual downloads, extracted text, raw indexes/citations, public current-site responses, per-item provenance, error logs and SHA-256 files are stored outside the Git checkout under `/workspace/churchtimes-archive-data/`. They are not committed or attached to GitHub. Git contains only tooling, tests, CI and this aggregate report.

Private export: `issue-13-20261013/private-evidence.tar.gz`, 5,132,130 bytes. Export SHA-256: `27b96fc07ca025a0e70fa0ec31295260f31f44d3c6e2b4c439438102ca0664e7`. Its sibling `.sha256` and `checksums.json` remain outside GitHub. All 787 catalogue entries passed verification.

The cloud directory is temporary private staging. Durable owner-controlled off-server storage and transfer confirmation remain outstanding. The production Truehost VPS was not used. The export package and checksum sidecar must be copied to an owner-approved private destination and verified there before treating this as a permanent backup.

## Validation and remaining work

- **38 synthetic regression tests pass** and exercise CDX pagination/checkpoints, corruption repair, archive error/MIME rejection, proxy-versus-origin errors, persisted rate limits, safe destinations/paths, legacy article extraction and public-only current-site inventory. These are mocked responses, not recovered articles.
- Dry-run performs zero network requests and zero filesystem writes.
- The public Vite build and all 20 existing frontend unit tests pass.
- Automated SHA-256 and MIME checks passed against all actual staged files before packaging. **20 representative real samples** (10 article candidates across `.org`/`.com`, 10 images) passed source/hash/extraction checks; the Bola Odeleke and post-216 byline/date/title checks also passed. These checks demonstrate actual bytes and metadata, not editorial completeness.

Raw HTML remains authoritative evidence when heuristic extraction lacks text, byline or date. Every recovered item starts `partial`; none is editorially `verified-full`. Conflicts, aliases, external/unavailable media, parked content, historical error responses, and citation-only references require review. CSS backgrounds and arbitrary JavaScript content are not extracted. Downloads over the 25 MiB response cap are rejected and logged, not truncated or counted as successful.

Backend import schemas, throwaway PostgreSQL archive import/search, title/date/WordPress-ID deduplication, curation screens and Issue #11 private WXR/database/uploads exports belong to the subsequent coordinated phase. No CMS records were imported or published. Production WordPress, main, DNS and `apps/newsroom` were unchanged.

For an interrupted or later approved-network retry, use the commands and storage precautions in [the recovery README](../tools/archive-recovery/README.md). Resume the same store to retain checksums and checkpoints; never describe failed requests or test fixtures as recovered content.
