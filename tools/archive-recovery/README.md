# Historical archive recovery

Read-only, standard-library Python 3.10+ tooling for the [Issue #13 execution brief](https://github.com/abcentech/churchtimes/issues/13#issuecomment-6151492587). No dependency installation, CMS credentials, production access, or running services are required. Run from the existing checkout; no worktree is needed.

## Execute on an approved network

Required HTTPS destinations: `web.archive.org`, `archive.org`, `churchtimesnigeria.net`, `www.churchtimesnigeria.net`, and `en.wikipedia.org`. Keep TLS verification and the environment's managed proxy enabled. Historical `.org` / `.com` hosts are queried through Internet Archive, never fetched directly. Do not change DNS or purchase historical domains.

Select a private directory **outside every Git checkout**, on owner-controlled storage with sufficient space. Do not use the production Truehost VPS. This cloud task uses `/workspace/churchtimes-archive-data/issue-13-20261013`; that is temporary staging, not a verified durable off-server backup.

```bash
python3 tools/archive-recovery/recover.py collect --store /path/to/private/churchtimes-archive/issue-13 --dry-run
python3 tools/archive-recovery/recover.py collect --store /path/to/private/churchtimes-archive/issue-13 --delay 2 --max-pages 20 --max-captures 200
python3 tools/archive-recovery/recover.py verify --store /path/to/private/churchtimes-archive/issue-13
python3 tools/archive-recovery/recover.py package --store /path/to/private/churchtimes-archive/issue-13
```

For this session, resume using the existing staging path rather than starting a second directory:

```bash
python3 tools/archive-recovery/recover.py collect --store /workspace/churchtimes-archive-data/issue-13-20261013 --delay 2 --max-pages 20 --max-captures 200
```

`collect` exits **2** when CDX discovery is incomplete (blocked requests or bounded pagination), **0** only when all four CDX inventories are complete. This exit code is not a claim that every discovered URL was downloaded: check `download_limit_reached`, per-item failures, current-site completion and asset gaps in `coverage.json`. `verify` exits 1 on corruption. Dry-run makes no requests and writes no files; it previews initial requests, with additional pagination and media requests determined by responses.

Repeat `collect` with the same store to resume. Use `download --store ... --max-captures 400` to continue downloads without repeating discovery or current-site requests. `report` refreshes cached HTML extraction using the current parser before producing counts; it never downloads content. Increase page/capture limits as needed after inspecting storage capacity and results. Previously observed replay 404s, error bodies and redirects are retained without repeated requests; `--retry-failed` explicitly rechecks them after a meaningful archive change. Network/proxy/rate-limit failures remain retryable on resume. Embedded assets are attempted once per URL in each invocation, and exhausted indexed captures are not retried at every referring page timestamp. Default downloads try HTTP-200 captures first, fall back to older captures and unknown-status revisit records when needed, and retain index metadata for all versions. `--all-versions` downloads distinct indexed captures for conflict review; content-addressed bytes deduplicate identical payloads. Conflicting recovered versions remain separate provenance records. No automatic publication occurs.

Requests are GET-only, at least one second apart per host (default two), capped at 25 MiB per response and 20-second timeout, with up to two retries for transient failures. Proxy denials are not retried. Respectful `Retry-After` handling defers long cooldowns across resumptions. Large responses are logged as `too-large` and excluded from recovery totals. The capture cap limits each invocation, not the total size of a resumed archive; monitor capacity before raising limits.

## Evidence and provenance

Outside Git, each run stores:

- `manifest.json`: CDX resume tokens/pages, original URL/domain, original index MIME/status/digest, requested and actual capture timestamps, replay URL/status/MIME, SHA-256/size, discovery source, extraction metadata and failures. Wayback's digest is retained separately from the downloaded SHA-256.
- `indexes/`, `citations/`, `current/`: unmodified discovery response bytes. Citation pages are evidence, not recovered historical article counts. Current WP REST inventory requests only published posts with `context=view`; no admin/private endpoints, login, writes, content import or credentials.
- `raw/<sha256>.bin`: successful capture bytes (HTML/image/PDF/audio/video and other indexed payloads). Raw captures are preserved even when extraction is incomplete. Error pages, empty responses, MIME mismatches and bad PDFs are excluded; suspect bytes are quarantined.
- `extracted/`: article candidates with actual extracted title/body/byline/date/canonical, media references and reviewer placeholders. Missing authors/dates stay null. Reported dates in issue citations stay separate. HTML is parsed as data, never executed. Common WordPress article wrappers, the recovered Dominant theme’s `entry`/byline/date markers, legacy `.com` `Content` table cells, and JSON-LD are recognized; multiple-teaser listing pages are not counted as articles. Extraction is heuristic and always needs review.
- `quarantine/`: archive error bytes and corrupt prior blobs, excluded from successful recovery counts.
- `coverage.json`: actual domain/count/byte/error summary. `checksums.json`: per-file SHA-256 and bytes for evidence, captures, extraction, manifest and report. `private-evidence.tar.gz` plus `.sha256`: private export containing evidence and checksums. Packaging refuses corrupt recovered blobs.

Storage directories are created with private permissions (0700); atomically written files and export packages are 0600. Use a dedicated directory, not an existing folder containing unrelated private files: packaging includes files within evidence subdirectories. Storage and manifest paths reject Git directories, path traversal and symlink escapes. Do not commit generated evidence or upload raw captures to GitHub. Transfer the verified package to an owner-approved private archival destination and verify the sidecar SHA-256 there. Destination selection, transfer and durable-backup confirmation remain external prerequisites; no remote storage was invented or provisioned.

In-scope embedded image/media references are attempted at the actual saved page's timestamp if an indexed asset has not already been saved. Remapped Wayback URLs are unwrapped; externally hosted assets are listed and never fetched. A replay redirected to another original URL is rejected for separate review. Asset HTTP/MIME errors and referenced-but-unrecovered URLs are counted separately. Responsive `srcset` candidates are retained; CSS background assets and arbitrary JavaScript-generated content are not extracted. Large binaries and HTML-layout limitations remain explicit gaps. A successful HTML save is not proof of a complete article.

Confidence rules:

- `partial`: actual bytes retrieved; extracted content has not been reviewed for completeness.
- `citation-only`: supplied citation/capture lead with no recovered bytes.
- `missing`: a particular replay returned an observed origin 404; this does not prove every capture of the article is absent.
- `verified-full`: reserved for later editorial verification; the downloader never assigns it.
- Null confidence and `availability=unknown`: uncited capture blocked or otherwise inconclusive. Proxy tunnel HTTP 403 is recorded separately from origin HTTP status.

The `.com` association is owner-reported and unconfirmed until independent evidence can be examined. No result from the availability API means only no closest capture was reported; it does not establish exhaustive absence. Cited references without supplied URLs are not invented. Raw historical content is untrusted: review rights, bylines, dates, full text, media completeness and conflicts before any publication.

## Validation and boundaries

```bash
python3 -m unittest discover -s tools/archive-recovery/tests -v
```

Tests use synthetic responses in temporary directories. They do not recover real journalism or reach production. CI runs this suite without Internet Archive or WordPress requests.

This PR implements the assigned inventory/download phase. Payload schema/import, PostgreSQL archive search, editorial curation, URL redirects, title/date/WordPress-ID deduplication and owner-supplied WXR/DB/uploads reconciliation require the subsequent backend/Issue #11 phase. The raw evidence preserves the inputs for that work. `apps/newsroom`, CMS collections, production WordPress, main and DNS are untouched.
