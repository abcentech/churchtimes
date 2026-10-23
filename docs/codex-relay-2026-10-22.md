# Message to relay to Codex (paste as is)

Written for: the Codex session that owns the public site (`src/`, `index.html`, `tools/`). Date: 2026-10-22.

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

## Update 2026-10-23

For Codex. Nothing below changes your ownership of `src/`, `index.html` and `tools/`.

**What the CMS lane has done and is doing.** The CMS importer now handles the REAL export (rehearsed on a throwaway database; PR #92 is open):
4,343 published posts, 101 drafts (never imported), 1,348 approved comments, 485 pingbacks skipped, 6,142 attachments, 15 categories and one
author name (byline text only). Yoast SEO import and the uncategorised fallback chain are merged (#91), and D1 (`/{slug}/`) is merged (#90).
These are being built now, with PRs coming: a video and audio block (so `video`, `audio`, `fvplayer` and `gallery` shortcode content stops being
dropped), categorisation improvements, a link audit in the importer, an `import:uploads-check` command, and the C8 search endpoint
(`GET /api/public/search`, contract in `apps/cms/docs/api-contracts.md` when it lands). Public article JSON will gain video and audio blocks:
please make your renderer ignore unknown block types safely until you build them.

**What to do next, in this order** (full text in `docs/codex-wave5-archive-spec.md`):

1. **E1 uploads pack (`tools/uploads-pack/`).** Highest priority; it blocks the real media import. Start now.
2. **E2 archive recovery** (rebase #18, `archive-candidate/1`, dedup against the 4,343 posts). Independent of E1; start now.
3. **E3 old-host redirect map** and 4. **E4 link audit**, once the private inventory from E2 exists. D1 is settled, so E3 targets `/{slug}/`.
   E4 and the CMS's own link audit should report on the same categories; compare your counts with the CMS importer's "links" section.
5. **E5 search**: the benchmark can start now; the UI waits for the C8 endpoint.

**Agreement needed on the uploads manifest.** The CMS's `npm run import:uploads-check` and your `tools/uploads-pack` must agree on the manifest
field names. You own `uploads-pack/1`: document the exact schema (field names, types, status values, path normalisation) in `docs/uploads-pack.md`
early, as a short PR before the full tool, and do not rename fields afterwards without bumping the version. The CMS lane will read that file and
implement the check against it; tell us if a field needs to change and we will change the CMS side, not the other way round. Both tools must treat
the pack the same way: NFC-normalised relative paths under `wp-content/uploads`, SHA-256 over file bytes, MIME from magic bytes, and a refused or
quarantined status for anything executable or mismatched. Counts only in anything committed; no file names or hashes of real data in the repo.
