# Message to relay to Codex (paste as is)

Written for: the Codex session that owns the public site (`src/`, `index.html`, `tools/`). Date: 2026-10-22, updated 2026-10-23.

---

Hi Codex. The CMS lane has merged everything you were waiting on into `feat/newsroom-mvp`. Please read `docs/codex-wave4-spec.md`
(branch `agent/claude-go-live-plan`) plus `docs/codex-wave2-review.md` and `docs/codex-wave3-review.md`; their MUST items block merges.

## What is merged on the CMS side (use these for real, not stubs)

| Contract | Endpoint or feature | Notes |
| --- | --- | --- |
| C7 redirects | `GET /api/public/redirects` | Use the test vectors in `apps/cms/tests/fixtures/` for path normalisation. |
| C5/C4 contact and newsletter | contact, subscribe, confirm, unsubscribe | 403 with `field: 'turnstileToken'` means "verify again" (keep the form values). |
| C6 legacy comments | `GET /api/legacy-comments?article=<id>&page=&limit=` | Projection includes `legacyId` and `parentLegacyId`, so threading can be restored. No emails; redact email-shaped text on display anyway. |
| C3 advertising | `GET /api/public/advertising` | Live campaigns only, `Cache-Control` at most 60 s, never wait on it for first paint, `rel="sponsored noopener noreferrer"`. In production your site origin must be in the CMS `PUBLIC_SUBMISSION_ORIGINS`. |
| A12 media map | offline `npm run export:media-map` (`media-map/1`) | Format differs from the #58 proposal (entries `{path,file,mime,size}` plus an `aliases` table, 50,000 entries and 8 MiB caps, a `.sha256` file over the exact bytes). Please update your #58 design note to match before building the serving route. Revocation is immediate under your no-store, anonymous-check-per-request design. |
| Submissions consent | `POST /api/public/submissions` accepts `consent` (boolean) and `consentTextVersion` | **Change `src/lib/public-submissions.js` (lines ~43-47) to send `consent: true` and a `consentTextVersion` string when the checkbox is ticked.** After that ships, the owner sets `SUBMISSIONS_REQUIRE_CONSENT=true`. |

## One real bug to know about

`PUBLIC_CMS_URL` (public host) and `CMS_PUBLIC_URL` (CMS) must be the same origin. The CMS stamps every media URL with `CMS_PUBLIC_URL`;
`normalizePublicMedia` (`src/lib/published-articles.js`) drops media whose origin differs from the host's `baseUrl`, so server-rendered
hero and card images silently vanish, and the SPA reuses that server JSON (`serverArticle`) instead of refetching. Suggestions: refetch on
the client when `serverArticle.featuredImage` is null, and log when the origin check drops a media record.

## What to do, in order

1. Fix the Wave 2 MUSTs and merge in this order: #41, #42, #43, #44, #50, #51, #49 (with #45 folded in), #46, #47, #48. Feature PRs must not
   commit `site/` or the script hash in `index.html`.
2. Then #57 (fold in the `OneSignalSDKWorker.js` line), #58 and #65.
3. Make #64 the single carrier: close #59 and #62 as superseded, rewrite its body, apply the #64 addendum fixes. #63 after #44/#50, #61 after
   #50, #60 last (first paint must not wait on a network call; add a stalled-chunk test).
4. Start now: A9 (real redirects), A13 (SEO), and the real-endpoint packages B4 (ads), B6/B7 (newsletter and contact), B8 (comments). A12 waits
   for your #58 update.
5. Every PR targets `feat/newsroom-mvp`. Claude reviews, the owner approves each merge. One rebuild-site PR at the very end.

## A practical CI note

`docker-smoke` and `public-quality` are required checks but only run when `apps/cms/**` (and public paths) change. If a PR of yours touches
only paths that skip a required check, GitHub will block the merge: make sure the PR touches a path those workflows watch, or tell the
owner so the filters can be widened.

## Public host settings to set (D1 is settled)

Articles are served at `/{slug}/` on `churchtimesnigeria.net` for all 4,343 published posts (owner decision D1). Set
`PUBLIC_ARTICLE_PATH_TEMPLATE=/{slug}/` on the public host. It must equal the CMS's `PUBLIC_ARTICLE_PATH_TEMPLATE`, which now defaults to `/{slug}/`
(the other accepted value is `/reports/{slug}/`; anything else stops CMS startup). Remove any assumption of `/reports/{slug}/` from the Wave 4
spec and from tests. The CMS renames an imported slug that equals a reserved root name (`admin`, `api`, `search`, and so on), so the host may
reserve those routes.

## Update 2026-10-23 (supersedes anything above that disagrees)

For Codex. Nothing below changes your ownership of `src/`, `index.html` and `tools/`. Everything listed as merged is on `feat/newsroom-mvp`
(PRs #92 to #100 and #72). Contracts: `apps/cms/docs/api-contracts.md` v1.19 to v1.21; importer: `apps/cms/docs/import.md`.

### What is merged now

**1. Audio/video block (`audioVideo`, contract v1.19).** Public article JSON now carries this block. Your renderer must draw it (and keep ignoring
unknown block types safely). Fields on `fields` of the block (read with `depth >= 1` so media is populated):

- `kind`: `"video"` or `"audio"`; `title` (accessible name, always present); `caption` (optional); `duration` (seconds, optional); `transcriptUrl` (optional link).
- `media.url` (absolute file URL on the CMS origin; never build a player URL from anything else) and `media.mimeType` (one of `video/mp4`, `video/webm`,
  `audio/mpeg`, `audio/mp4`, `audio/ogg`); `poster.url` (optional image).
- `sourceUrl`: only when there is no `media` (the importer could not find the file). It may be dead: render the title as a plain link, or nothing.
- If `media` is a bare id (not an object) the file is not public: render nothing. Use native `<video controls preload="none">` / `<audio controls>`; no third-party player.

**2. C8 public search (`GET /api/public/search`, v1.20).** Query: `q` (required, trimmed, at most 200 characters, else 400), `page` (1 to 100, default 1),
`limit` (1 to 50, default 10), `category` (slug or id; unknown gives an empty list), `year` (four digits, 1900 to 2100, else 400). Response `200`:
`{ docs: [{ id, slug, title, excerpt, snippet, publishedAt, category: { id, slug, title }, rank }], totalDocs, limit, page, totalPages, hasNextPage, hasPrevPage,
nextPage, prevPage }`. `snippet` is plain text (never markup). Published articles only. `Cache-Control: public, max-age=60` on 200 (`no-store` on errors).
Per client rate limit, default 60 per 60 seconds, then `429` with `Retry-After` (exposed to the browser): the UI must show "try again in N seconds" and not retry in a loop.
Your site origin must be in the CMS `PUBLIC_SUBMISSION_ORIGINS` (403 otherwise). Query language is PostgreSQL `websearch_to_tsquery` (quoted phrases, `or`, leading `-`),
English stemming, no accent folding. **Your benchmark script and the search UI both call this endpoint** (do not build another index). After a deploy or any archive import
the operator runs `npm run search:reindex`.

**3. Uploads check (CMS) and your E1 pack.** `npm run import:uploads-check -- --uploads <folder> --wxr <export.xml> --out <new detail.jsonl>` is merged (#93, #100).
It reads the uploads folder itself; it does NOT read a pack manifest yet. So there is **no agreed manifest field list yet**: you own `uploads-pack/1`, document it
in `docs/uploads-pack.md` first (see the to-do list), and the CMS lane will then decide whether to read your manifest or keep reading the folder. Both must reject the same
things. What the CMS importer accepts as media: images `.jpg`, `.jpeg`, `.png`, `.webp` (magic bytes must match; at most 10 MB) and audio/video `.mp4`, `.m4v`, `.webm`, `.mp3`, `.m4a`,
`.ogg`, `.oga` (cap `MEDIA_AV_MAX_MB`, default 100). Everything else is refused, by reason code, and your pack should use the same words where it can: `dangerous-extension` (php, html, js,
svg, archives, double extensions such as `x.php.jpg`), `hidden-file`, `bad-name`, `symlink`, `hard-link`, `zero-byte`, `magic-mismatch`, `not-media`, `unsupported-type` (gif, bmp, ico, avif, pdf),
`too-large`. A script marker inside a valid JPEG/PNG/WebP is only a warning (the CMS re-saves every picture); in audio/video it is a rejection (`polyglot`). Counts only in anything committed.
Owner decision pending: whether the 10 MB image cap should be larger.

**4. archive-candidate/1 (#99).** The schema is `apps/cms/docs/archive-candidate-schema.md` (the executable form is `apps/cms/src/lib/archiveCandidate.ts`; if they disagree the code wins).
Your converter must write exactly that: JSON Lines, strict keys (an unknown key rejects the line): `schema`, `title`, `byline`, `date`, `bodyHtml`, `originalUrl`, `canonicalUrl`, `host`, `captureTimestamp`,
`rawSha256`, `media[]` (`url`, `localSha256`, `mime`, `alt`), `confidence` (`partial`, `citation-only`, `missing`; `verified-full` is rejected), `reviewer`. The file lives outside every checkout. The CMS command
`npm run import:archive-candidates` makes **draft-only** articles with provenance; publishing is blocked (409) until an editor marks them reviewed (a newsroom review screen is being built).
Nothing recovered is ever published automatically. The CMS also skips duplicates by source URL, `rawSha256` and slug plus title, but you still produce your own dedup report.

**5. Link audit (#94) and what it found.** `npm run import:link-audit` is merged. On the real export the links are fine: 530 article links resolve, and 3,119 uploads links
(3,105 of them wrap an image) are dropped to the image. Only 16 links point at slugs not in the export and 6 at odd multi-segment paths. There are no category, tag, page, `?p=` or feed links, and the generated redirect
file has 0 rules. So E3 and E4 shrink a lot (see the to-do list). The owner decides about the 16 and the 6.

**6. Categories (#91, #97).** One category per article (a schema limit; tags and multi-category are an owner decision). Default `strict` chain: WordPress category, then Yoast primary, then tag map, then News. About 1,392 posts are
uncategorised; an opt-in rule classifier (`--category-mode=rules`, not the default until the owner approves) is about 68% precise and would place 672 of them, leaving 720 in News. Your site must not assume extra categories.

**7. Real-export rehearsal (#92, counts only).** 4,343 published posts, 101 drafts (never imported), 1,348 approved comments, 485 pingbacks skipped, 6,142 attachments, 15 categories, one author (byline text only),
3,192 images in 1,735 posts. The importer dry run accounts for every published post (difference 0). A synthetic 4,346-post rehearsal on a CI runner: all 15 checks pass, apply 77 s.

**8. Also merged:** article path default `/{slug}/` (#90; set `PUBLIC_ARTICLE_PATH_TEMPLATE=/{slug}/` on the public host), owner runbook and hardening docs (#72), importer compose override (#98).
Not merged yet (do not wait for them): newsroom archive review screen, staff retriever, a path-default rehearsal PR.

### To-do for Codex, in this order

1. Fix the Wave 2 MUSTs and merge as in the list above (#41 to #51), then #57, #58 (update to `media-map/1`), #65, then #64 as the single carrier. Set `PUBLIC_ARTICLE_PATH_TEMPLATE=/{slug}/`.
2. Render the `audioVideo` block (fields above), with tests for the contract's example block, a bare-id media, and a `sourceUrl`-only block.
3. **E1**: a short PR first with `docs/uploads-pack.md` (field names, types, status values, path normalisation: NFC relative paths under `wp-content/uploads`, SHA-256, MIME from magic bytes), then `tools/uploads-pack/`
   using the accept and refuse lists in item 3 above. Highest priority: it blocks the real media import.
4. **E5 search**: point your benchmark at `GET /api/public/search` (golden queries, precision at 5, MRR, empty rate, latency; ids and counts only), then build the lazy search page behind a flag. Handle 429 with `Retry-After`.
5. **E2**: rebase #18, write `archive-candidate/1` exactly per the schema doc, dedup report (counts only). Drafts only.
6. **E3 (reduced)**: only needed if the old hosts `churchtimesnigeria.org` and `.com` must be served (owner decision D2). If yes, produce `from,to,status` rules for the 676 old-host URLs in the `import:redirects` format
   (`?p=N` cannot be an exact rule: the public host resolves it through `legacyId`). The new host needs no rules for its own posts (same `/{slug}/` address). **E4 (reduced)**: do not rebuild the audit; run
   `import:link-audit` and compare your counts with item 5. Open question for the owner and you: is `/category/{slug}/` a real public route? The importer rewrites category links to it, but this export had none.
7. Close #19 and the stale PRs per E6; one rebuild-site PR at the very end.

### What Codex must NOT do

- Do not edit `apps/cms` or `apps/newsroom` (CMS lane), and do not merge anything yourself: Claude reviews, the owner approves each merge.
- Do not commit real data: no export, uploads, captures, file names or hashes of real files; counts only. Fixtures are synthetic.
- Do not run any tool against the old or production server; work on copies the owner downloaded, outside every checkout.
- Do not rename `uploads-pack/1` fields after publishing the doc without bumping the version. Do not invent another search index or a second media format.
- Do not publish recovered archive pages or write `verified-full`. Do not commit `site/` or the script hash in `index.html` in feature PRs.
- Do not send search queries to analytics, and do not load any third-party player or script for audio/video.
