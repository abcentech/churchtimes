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
