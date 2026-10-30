# Codex Wave 5: archive recovery, uploads pack, retriever and search

Status: spec for Codex (tools/, docs/, public lane). Date: 2026-10-22, updated 2026-10-23 to the merged state. Same rules as `codex-wave2-briefs.md`
("Rules for both sessions"): base `feat/newsroom-mvp`, small PRs, no `main`, no deploy, no secrets, no real personal data in the repo,
Claude reviews and the owner approves each merge. Private data (the WXR export, the uploads, recovered captures) lives outside every
Git checkout, never on the compromised old server, and only counts and hashes appear in PR text.

## 1. What exists today (read from the repository, 2026-10-22)

| Item | Where | State |
| --- | --- | --- |
| Archive recovery tool | PR #18, branch `agent/codex-archive-recovery` (last commit 13 Oct) | Open, unmerged. Python 3.10 standard library: `recover.py collect / download / report / verify / package`, GET-only, polite, resumable, SHA-256 provenance, private storage 0700/0600, unit tests on synthetic responses, `archive-recovery.yml` CI. Phase 1 only (inventory and download). |
| Coverage report | `docs/archive-coverage-report.md` on that branch | 1,152 CDX rows over 676 original URLs on the old `.org` and `.com` hosts (2011-2022); 446 saved captures (407 raw files, 10 MB); 306 HTML saves; **136 partial article candidates**; 76 media records; 308 failed captures; 157 indexed URLs without a saved record; 145 unresolved embedded assets. Current site observed: 4,343 published posts, 7,376 sitemap URLs. |
| Search intelligence roadmap | `docs/archive-search-intelligence-roadmap.md` on `agent/archive-search-intelligence` (docs only) | Private SQLite FTS5 proof of concept over the real WXR (4,343 posts indexed, 4,343 keyword candidate rows, 80-article style shortlist, 8 synthetic tests). Decision recorded: source of truth stays Payload + PostgreSQL, GIN full-text search first, pgvector later. Not integrated. |
| PR #19 | `agent/publication-archive-engine-...` | Superseded by the CMS importer (reviewed unusable). Close it. |

Not found in the repository: any archiver or retriever for the **imported** files (the 6,142 attachments of the real export), nor any
integration of recovered candidates into the CMS. If you have newer local work, push it as a PR so it can be reviewed against this spec.

## 2. What the CMS side now provides (all merged on `feat/newsroom-mvp`, updated 2026-10-23)

- Importer: `import:inspect`, `import:wxr-report`, `import:convert-wxr`, `import:wxr` (dry run by default, manifest outside the repo), `import:rollback`, `import:rehearse`, `import:uploads-check`, `import:link-audit`, `import:categorise-eval`, `import:archive-candidates`. Media resolution takes an uploads root and the WordPress `legacyPath` of each attachment; missing files are reported, not fatal.
- Media accepted by the CMS: images `.jpg`, `.jpeg`, `.png`, `.webp` (at most 10 MB, magic bytes verified, re-saved) and audio/video `.mp4`, `.m4v`, `.webm`, `.mp3`, `.m4a`, `.ogg`, `.oga` (cap `MEDIA_AV_MAX_MB`, default 100). The `audioVideo` article block (contract v1.19) carries them; the public site must render it.
- C8 `GET /api/public/search` (v1.20, PostgreSQL full-text, published only, 60 per minute per client then 429 with `Retry-After`, `Cache-Control: public, max-age=60`). `search:reindex` after deploys and archive imports.
- `archive-candidate/1` schema: `apps/cms/docs/archive-candidate-schema.md`; drafts only with provenance; review gate (409 on publish until reviewed). Contract v1.21.
- `export:media-map` (`media-map/1`) for the public host; `import:redirects` for redirect rules (format in `apps/cms/docs/import.md`).
- Real-export facts (counts only): 4,343 published posts all at `https://churchtimesnigeria.net/{slug}/`, 101 drafts, 1,348 approved
  comments (485 pingbacks skipped), **6,142 attachments**, 3,192 images in 1,735 posts, 914 posts with shortcodes, 159 YouTube references, 15 categories, 1,392 uncategorised (News fallback; opt-in rules classifier about 68% precise).
- Link audit on the real export: 530 article links resolve, 3,119 uploads links (3,105 image-wrapping anchors, dropped to the image), 16 unknown slugs, 6 odd paths, no category, tag, page, `?p=` or feed links; redirect file has 0 rules.
- Rehearsal: the real export dry run accounts for all published posts; 4,346 synthetic posts import in about 77 s on a CI runner; rollback verified.

## 3. Work packages

### E1. Uploads verification pack (highest priority, blocks the real media import)

The live uploads folder (about 4.7 GB on the compromised server) must be copied off and **verified before any file reaches the CMS**.

- Build `tools/uploads-pack/` (Node or Python standard library, your choice, no network): run against a **copy** of `wp-content/uploads`
  stored outside every checkout. Walk without following symlinks; for each file record relative path (NFC normalised, no `..`), size,
  SHA-256, sniffed type from magic bytes (not the extension), and for images width and height.
- **Accept only what the CMS accepts** (images `.jpg`, `.jpeg`, `.png`, `.webp` up to 10 MB; audio/video `.mp4`, `.m4v`, `.webm`, `.mp3`, `.m4a`, `.ogg`, `.oga`) and use the CMS reason codes where you can (`dangerous-extension`, `hidden-file`, `bad-name`, `symlink`, `hard-link`, `zero-byte`, `magic-mismatch`, `not-media`, `unsupported-type`, `too-large`). A script marker inside a valid image is a warning only; in audio/video a rejection.
- **Refuse and quarantine** (list them in the private detail file, never copy them into the pack): anything executable or scriptable
  (`.php`, `.phtml`, `.phar`, `.htaccess`, `.sh`, `.exe`, `.js`, `.html`), SVG, archives, files whose extension and magic bytes disagree, polyglots
  (an image that also parses as HTML or PHP), zero-byte files, symlinks, and names with control characters or backslashes. Optionally run
  ClamAV (`clamscan`) when installed and record the result. This directly matters because the old server was compromised.
- Reconcile with the WXR attachment list (use the same parser output as `import:wxr-report`; counts only): attachments present and
  verified, attachments missing, files present but unreferenced, WordPress size variants (`-300x200`) whose original exists or does not,
  duplicate content by hash, and attachments whose recorded `_wp_attached_file` differs only by case or encoding.
- Output (outside the repo, 0600): `uploads-pack/1` manifest JSON (path, size, sha256, mime, width, height, status) and a counts-only
  report. The CMS media importer (`apps/cms/src/import/media.ts`) takes a folder as its uploads root, and `npm run import:uploads-check` (merged) checks the folder itself; it does not read a manifest yet, so no field list is agreed. Write the first short PR as `docs/uploads-pack.md`. Document the exact
  field names in `docs/uploads-pack.md` so the CMS lane can consume them.
- Done when: unit tests with synthetic trees (including a PHP file named `.jpg`, a symlink, a polyglot, a NFC/NFD name pair), a counts-only
  report on a synthetic 5,000-file tree, and a short owner runbook (copy off the server read-only, hash, verify, transfer, compare hashes).

### E2. Archive recovery: finish and integrate (PR #18, phase 2)

- Rebase #18 onto `feat/newsroom-mvp`, keep it standard-library Python, fix review findings, and merge it first (small, isolated).
- Write the versioned output `archive-candidate/1` exactly as defined in `apps/cms/docs/archive-candidate-schema.md` (merged, strict: unknown keys reject the line; the executable form is `apps/cms/src/lib/archiveCandidate.ts`). It is JSON lines outside the repo with: title, author/byline (nullable), date (nullable),
  body HTML, canonical/original URL, host, capture timestamp, raw SHA-256, media references (with local file hash when recovered),
  confidence (`partial` / `citation-only` / `missing`, never `verified-full`), reviewer placeholders.
- **Deduplicate against the 4,343 current posts** (and the 101 drafts): by exact slug, by normalised title plus date, and by body similarity
  (shingled hash); output three lists: new candidates (not in the current site), matches (already present, so no action), and conflicts
  (same title or date but different body, for a human). Counts-only public report; details private.
- Provide a documented sample (synthetic) for the CMS importer. The CMS lane has merged the **archive-candidate importer (`npm run import:archive-candidates`), which creates DRAFT-only
  articles with provenance fields** (source URL, capture time, sha256, confidence) that editors review before anything can be published.
  Nothing recovered is ever published automatically.
- Done when: converter from `extracted/` to `archive-candidate/1` (conforming to the CMS schema doc; the CMS validator accepts your synthetic sample), dedup report on the real private store (counts only),
  tests with synthetic captures.

### E3. Old-host redirect map (reduced scope, only if the old hosts must be served, owner decision D2)

The new host serves every imported post at the same `/{slug}/` address as WordPress, so it needs no rules for its own posts, and the CMS link audit produced 0 rules for this export. What remains is the old hosts: the recovered inventory shows 676 original URLs on `churchtimesnigeria.org` and `.com` (and `www` variants), e.g. `?p=N` forms.

- From the recovery manifest and the real WXR (`wp:post_id`, slug), produce a redirect mapping file in the format that
  `npm run import:redirects` accepts (see `apps/cms/docs/import.md`): old host path (or `?p=N`) to the new `/{slug}/` article path, 301 only
  when the target exists, 410 where a capture proves the page was deleted, and a list of unmatched URLs for review.
- Counts-only report; details private. The CMS lane imports the file; the public host serves it (A9, `LEGACY_SITE_HOSTS` must include the
  old hosts).
- Done when: tests on synthetic manifests, loop and chain detection, and a dry run against the real data with counts.

### E4. Link audit (reduced: the CMS `import:link-audit` is merged; compare, do not rebuild)

- Run `npm run import:link-audit` on the real export and reconcile your counts with it (real export: 530 article links resolve, 3,119 uploads links of which 3,105 wrap an image, 16 unknown slugs, 6 odd paths, nothing else). Only the extras the CMS audit does not do remain here, counts only: whether uploads targets are in the verified pack, and image URLs on other hosts. Original scope, for reference: internal links to old paths, `/wp-content/uploads/` links (and whether the target is in the verified
  pack), links to `.org`/`.com` old hosts, links to dead or unknown hosts, `?p=N` links, `mailto`/`tel`, and image URLs on other hosts.
- Feeds the converter's slug map and the redirect map. Done when it runs on the real export in seconds and the report is committed
  (counts only) as `docs/link-audit.md`.

### E5. Search: benchmark, public UI and retriever API client

Source of truth stays Payload + PostgreSQL (your own roadmap decision). Split:

- **CMS lane (Claude) has merged** contract C8 (v1.20, `apps/cms/docs/api-contracts.md`; 60 requests per 60 s per client then `429` with `Retry-After`, `Cache-Control: public, max-age=60`, `q` up to 200 characters, `limit` up to 50). Original design: `GET /api/public/search?q=&page=&limit=&category=&year=` over published articles only, PostgreSQL
  full-text (GIN) over title, excerpt and plain article text, ranked snippets without HTML, rate limited, `Cache-Control` short, no
  drafts or withdrawn content ever, a search projection column maintained on publish/update/unpublish, migration plus performance numbers.
- **Codex builds:**
  1. A golden-query benchmark (about 100 queries with expected top results, built from your SQLite proof of concept and the real archive;
     counts and article ids only, no article text in the repo) and a script that scores the CMS endpoint against it (precision at 5, mean
     reciprocal rank, empty-result rate, latency).
  2. A lazy-loaded public search page and results component (consent-free, no third party, query not sent to analytics, within the JS
     budget, keyboard and screen-reader accessible, mobile tested).
  3. A staff-only retriever prototype (newsroom, behind staff login, read-only): find related past articles for a draft with citations to
     canonical URLs. No drafting or generation features until the owner approves providers, rights and cost.
- Open question for the owner: is `/category/{slug}/` a real public route (the importer rewrites category links to it; the export had none)?
- Done when: benchmark scores recorded, UI behind a flag with real-CMS browser tests, nothing indexes drafts.

### E6. Cleanup and housekeeping

- Close PR #19 (superseded) and stale PRs #24, #27, #31, #34 if their content is merged elsewhere; list any that still carry unmerged work.
- Update `docs/public-legacy-media-design.md` (#58) to the `media-map/1` format as merged (entries `{path,file,mime,size}` plus an `aliases` table,
  50,000 entries and 8 MiB caps, a `.sha256` file over the exact bytes), then build the A12 serving route behind a default-off flag.

## 4. Order and dependencies

1. E1 (uploads pack) and E2 phase 2 start now; they are independent and both only touch `tools/` and `docs/`.
2. E3 and E4 (both reduced) after the real private inventory exists (E2) and after the owner confirms the article path (done: `/{slug}/`).
3. E5 benchmark and UI can start now: the C8 endpoint is merged.
4. E6 any time.

## 5. Rules specific to this wave

- No file from the real export, uploads or captures is committed. Fixtures are synthetic.
- Every report in the repo is counts and hashes only. Per-file detail goes to a private path outside every checkout.
- Tools open the private source read-only and never write into it.
- Do not run any tool against the production or old server; work on copies the owner has downloaded.
