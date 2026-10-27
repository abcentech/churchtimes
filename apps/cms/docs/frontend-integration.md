# Frontend integration notes (newsroom UI and public site)

For: the newsroom/editor UI lane (`apps/newsroom`, `agent/gemini-ui-support`) and the public
site lane (`agent/chatgpt-frontend`). The backend contract is [api-contracts.md](api-contracts.md);
this file lists what the current consumer code needs to change to work against it.

Survey date: 13 October 2026, against `origin/agent/gemini-ui-support`, `origin/agent/chatgpt-frontend`
and the uncommitted `apps/newsroom/src/api/adapter.js` in the shared checkout. Line numbers refer to those
versions. The backend lane has not edited any frontend file.

## Launch blockers

1. **No mock fallback in live mode.** `apps/newsroom/src/api/adapter.js` falls back to localStorage and
   reports success when a live request fails (G 182-188, 249-255, 312-318, 407-412; U 410-416, 474-481,
   549-567, 668-671). A 401, 403, 400 or 409 from the CMS means the action did not happen and must be shown
   to the user. The same applies to the public submission form: a failed POST must never produce a fake
   `SUB-…` receipt.
2. **Mock login must not exist in a live build** (U 232-236 accepts any 8-character password and picks the
   role from the email prefix). Gate it behind a dev-only build flag or remove it.
3. **Public submission success:** the CMS responds `201 { ok, reference, message }`. `submit.js:201` reads
   `res.data`, which throws after the server accepted the tip. A retry then creates a duplicate (the CMS now
   answers duplicates with 409). Read `res.reference`.
4. **Public submission fields:** send `name`, `email`, `phone`, `title`, `body`, `categorySuggestion`,
   `location`, `website` (honeypot, always empty) and `turnstileToken`. Today the form sends `headline`,
   `submitterName`, `submitterEmail`, `submitterPhone`, `category`, `organization`. Email is required by the
   CMS, so the form cannot offer an email-less "anonymous" option; tell contributors their name is
   kept private by the newsroom if that is the product decision.
5. **Turnstile:** render the Cloudflare Turnstile widget with the public **site key** and send its token as
   `turnstileToken`. The secret key lives only in the CMS environment. Without a valid token the CMS returns
   400 (missing) or 403 (failed verification).
6. **`review.js:151` crash:** `art.body.slice` is undefined for CMS documents when `excerpt` is empty.

## Field mapping (put this in the adapter, not in views)

| Newsroom UI today | CMS field |
| --- | --- |
| `body` (markdown) | `content` (Lexical JSON). Convert in the adapter; never send HTML. |
| `standfirst` | `excerpt` (≤ 600 characters, plain text) |
| `category` (slug) | `category` (numeric ID). Load `GET /api/categories` once and map. |
| `featuredImage` / `author` objects | IDs. `author` is set by the server; don't send it. |
| `revisionCount`, `createdAt`, `publishedAt`, `id` in PATCH bodies | Don't send them. `publishedAt` is server-set. |
| `author.name`, `author.desk` | `bylineName` (public) or `author.name` (staff reads). There is no `desk`. |
| roles `section_editor`, `editor_in_chief`, `public` | `section-editor`, `editor-in-chief`; also handle `trusted-publisher` and `admin`. No `public` role. |
| article statuses | Add `scheduled` (with `scheduledFor`) and `archived`. |
| submission status `pending` / `approved`, field `editorNotes`, `#id` | `new`, `under_review`, `accepted`, `rejected`, `converted`; `reviewerNotes`; show `reference`. |
| submission approve/dismiss (local only) | `PATCH /api/submissions/:id { status, reviewerNotes }` |
| convert (local only, reads `res.data.id`) | `POST /api/submissions/:id/convert { category }` → `{ article: { id, slug } }` |
| live event `upcoming` / `concluded`, `location`, `description` | `draft` / `ended` (also `live`); `summary`; `category` is required |
| live update `pending_review`, `headline`, `isPinned`, `eventSlug`, `reporterName` | `pending`; send only `{ event, body, occurredAt }`. Server sets author, sequence and approval fields. |
| media `title`, `license`, `dimensions`, `filesize` | `alt`, `caption`, `credit`, `width`, `height`, `filesize`, `sizes.card.url` |
| media upload as JSON | `multipart/form-data` with `file` and `_payload` (JSON string of `alt`, `caption`, `credit`) |

## Contract v1.2 changes that affect consumers

- **Live timeline:** `sequence` and `nextSince` from `GET /api/live-events/:slug/updates` now mean *publication* order (the shape
  is unchanged). Keep using `since=<nextSince>`; key rendered items by `id` (an update that is approved again later is delivered again
  with a higher `sequence`, and a rejected one only disappears on a full reload). Do not compare this `sequence` with the `sequence`
  of `GET /api/live-updates` (creation order) in the editor UI.
- **Changing your own password or e-mail** (`PATCH /api/users/:id`) must include `currentPassword`; show a "current password" field.
  Missing → 400 (`path: "currentPassword"`), wrong → 403. Five wrong attempts lock the account for 10 minutes.
- **Corrections** are append-only: send `corrections` exactly as read (with `id`s) plus new `{ note }` entries, or omit the field; the server
  sets `correctedAt`. Only admin/editor-in-chief can edit or remove existing entries.
- **Lists:** `pagination=false` is ignored and `limit` is capped at 100 everywhere; page with `page`/`hasNextPage`.
- **Media:** reporters and trusted publishers can edit only their own uploads, and not those used by a published/scheduled article (403).
  `uploadedBy` is staff-visible only.
- **Size limits:** JSON bodies over 1 MB (media 11 MB) get `413`; a chunked body without `Content-Length` on `/api/users/*` gets `411`.
  Browser `fetch` with a string/FormData body is unaffected.

## Session and permissions

- Use `POST /api/users/login`, `GET /api/users/me` and `POST /api/users/logout` with
  `credentials: 'include'`, and take the current user from `/api/users/me`. In live mode, remove the mock user
  list and role picker (`store.js:9-28`, `main.js:53-61`).
- Button visibility is a convenience only; the CMS enforces every rule. A trusted publisher may publish their own
  article in their sections (U `adapter.js:334, 346, 523` currently never allows it).
- The newsroom dev origin `http://localhost:5174` must be listed in `CMS_CORS_ORIGINS`, `CMS_CSRF_ORIGINS` and
  `PUBLIC_SUBMISSION_ORIGINS` in the CMS `.env`.

## Live coverage

- Public timeline: `GET /api/live-events/:slug/updates?since=<nextSince>` every 15–30 seconds. Don't refetch
  the full list every 8 seconds.
- Editor queue: `GET /api/live-updates?where[event][equals]=<id>&where[status][equals]=pending`, then
  `PATCH /api/live-updates/:id { status: 'approved' | 'rejected' }`.

## Public site (`src/lib/published-articles.js`)

- The adapter matches the contract. `depth=1` on lists is supported and documented, and `author` is never
  returned to anonymous readers.
- Available but not yet rendered: `bylineName`, `corrections` (should be shown on corrected articles) and
  `featuredImage` (its `url` is relative to the CMS origin, so prefix it with the CMS base URL).

---

# Verified workflows (13 October 2026, contract v1.3)

Every row below is replayed by `tests/integration/frontend-workflows.test.ts` with the exact requests the consumer code sends
(file:line comments in the test) against the real REST handlers. Status key: **SUPPORTED** (backend and consumer agree),
**CONSUMER-MISMATCH** (backend fine, the consumer request or reader must change; the test sends the correct request) and
**BACKEND-GAP** (nothing to call). Consumer refs: PUB = `origin/feat/newsroom-mvp:src/lib/published-articles.js`; PR4 =
`origin/agent/codex-public-forms`; PR2 = `origin/agent/gemini-ui-support` (committed `adapter.js` is mock-only and sends no
credentials) plus the uncommitted `adapter.js` in the shared checkout (PR2w); PR5 = `origin/agent/homepage-advertising`.

| Workflow | Status | Evidence (describe > it) |
| --- | --- | --- |
| Public: list published (`depth=1`, `sort=-publishedAt`, pagination, `nextPage`) | SUPPORTED | public site > lists published articles / paginates |
| Public: read by slug (`where[slug][equals]`, `limit=1`); drafts never returned | SUPPORTED | public site > reads one article by slug |
| Public: Lexical content renders in the site's renderer; categories; corrections | SUPPORTED (corrections not rendered yet) | serves Lexical content / lists categories / shows corrections |
| Public: `featuredImage.url`, `sizes.card.url` (relative to the CMS unless `CMS_PUBLIC_URL` is set) | SUPPORTED (not rendered yet) | exposes featuredImage.url |
| Public: CORS from the site origin, no wildcard, errors readable | SUPPORTED (origin must be in `CMS_CORS_ORIGINS`) | answers cross-origin |
| Public: live timeline polling (`since=<nextSince>`, `Cache-Control: public, max-age=10`) | SUPPORTED (no consumer yet) | live event timeline polling |
| Tip: PR4 story payload, Turnstile, 400/403/409/413/415/429, `Retry-After` readable cross-origin | SUPPORTED by backend; PR4 CONSUMER-MISMATCH (items below) | public forms (PR #4) > all |
| Tip: PR2w payload (`categorySuggestion`, `website`) | SUPPORTED | accepts the PR #2 working-copy payload |
| Tip: PR2 committed `createPublicSubmission` (mock fields) | CONSUMER-MISMATCH | PR #2 committed adapter |
| Contact form (PR4 `#contact`, `subject`/`message`) | BACKEND-GAP: no contact endpoint; keep the form disabled | contact payload is NOT accepted |
| Newsroom: CORS preflight, login, `me`, logout from `:5174` with `credentials:'include'` | SUPPORTED (same-site deployment requirement, see below) | login / me / logout cross-origin |
| Newsroom: create draft | SUPPORTED with the contract body; PR2 sends mock fields | create draft |
| Newsroom: submit, request changes, resubmit, approve, publish, correction | SUPPORTED; PR2 patch extras (`updatedAt`, `publishedAt`) are ignored | full path |
| Newsroom: schedule, trusted-publisher own publish | SUPPORTED | schedule / trusted publisher |
| Newsroom: submission queue, reject, convert | SUPPORTED; PR2 uses `approved`/`editorNotes` and local-only convert | submission queue and conversion |
| Newsroom: live event create/update/approve | SUPPORTED; PR2 live view is local-only and omits `category` | live events and updates |
| Newsroom: media upload (multipart) + featured image | SUPPORTED; PR2 `uploadMedia` is local-only | media upload |
| Newsroom: category filter by slug (`adapter.js:415`) | CONSUMER-MISMATCH: now `400` (was 500); use the numeric ID | `tests/unit/queryGuards.test.ts` |
| Homepage advertising (PR5) | No CMS call today (static JSON bootstrap). A live feed is a BACKEND-GAP | homepage advertising |

Also run against a live `next dev` server with the **real** `published-articles.js`, `article-content.js` and
`public-submissions.js` from PR #4 and Cloudflare's real Siteverify (test secret/token): list, slug lookup and rendering work;
a submission is stored (`201`) but PR4's code reports `unconfirmed` (item 1 below).

## Deployment requirements

- **Same site for the newsroom.** The staff cookie is `SameSite=Lax`, host-only. It works from `http://localhost:5174` to
  `http://localhost:3000` (same-site). In production the newsroom UI and CMS must share a registrable domain
  (`newsroom.example.org` + `cms.example.org`) or sit behind one reverse proxy. A newsroom on `*.github.io`, `*.pages.dev` or any other
  registrable domain cannot authenticate: login returns 200 but later requests are anonymous. We do not use `SameSite=None`.
- **Origins** (all exact `scheme://host[:port]`, no wildcards): the newsroom origin in `CMS_CORS_ORIGINS` **and** `CMS_CSRF_ORIGINS`;
  the public site origin in `CMS_CORS_ORIGINS` (article/live reads) and `PUBLIC_SUBMISSION_ORIGINS` (tips). The CMS origin itself is
  always CSRF-allowed.
- **Turnstile:** register the site key for the public hostname, set `TURNSTILE_ALLOWED_HOSTNAMES` to it and, if you pin the action,
  `TURNSTILE_EXPECTED_ACTION=submit-story` (the public form sends `VITE_TURNSTILE_ACTION`, default `submit-story`; the list form is v1.3).
  Both forms send `VITE_TURNSTILE_ACTION` when it is set; only if it is unset does the contact form fall back to `submit-contact`. The CMS has no contact endpoint, so that fallback is not listed.
- Public CDN caching: API responses carry `Vary: Origin`; anonymous article lists have no `Cache-Control`, so cache them only with an
  explicit short TTL on the public hostname, never on a path that can carry the staff cookie.

## Action list per PR

**PR #4 `agent/codex-public-forms` (public forms)**
1. `src/lib/public-submissions.js:87` success check. The CMS answers `201 { ok: true, reference, message }`. Replace
   `if (result?.accepted !== true && result?.status !== 'pending') throw ...unconfirmed` with
   `if (response.status !== 201 || result?.ok !== true) throw new SubmissionError('unconfirmed')`.
2. `public-submissions.js:76-84` field errors and Turnstile. `errors` is an **array** `[{ field, message }]`, not an object: use
   `for (const e of result?.errors ?? []) if (mapping[e.field]) fields[mapping[e.field]] = ...`. There is no `code`
   (`TURNSTILE_INVALID`, line 76): a Turnstile failure is `403` (or `400` for a missing token) with `errors[0].field === 'turnstileToken'`;
   treat that as "reset the challenge". `403` for a wrong origin and `409` duplicate arrive as `{ errors: [{ message }] }` without `field`.
3. `public-submissions.js:39-43` payload: send `categorySuggestion` (not `category`); `consent` is ignored by the CMS (keep it client-side);
   `phone` is accepted (optional, up to 40 characters). Optionally send `location`.
4. Contact form: there is no CMS endpoint (`subject`/`message` are rejected with 400). Keep it disabled or mail-to until one exists.
5. `Retry-After` now works cross-origin (`Access-Control-Expose-Headers`); nothing to change in `retryDelay`.

**PR #2 `agent/gemini-ui-support` (newsroom UI)**: everything in "Launch blockers" and "Field mapping" above still applies. Verified extras:
1. The committed `adapter.js` is mock-first and sends no `credentials`; the working copy adds `credentials:'include'` for login/me/logout and
   article/submission GETs, which is correct. Every other live call (`saveArticle`, `updateArticleStatus`, `deleteArticle`) must also use
   `credentials: 'include'` and must not fall back to the mock when `!res.ok`.
2. `adapter.js:202` expects `429`/`423` for a locked account: the CMS answers `401` with "This user is locked..." (and `429` only for the
   per-IP limit). Show `errors[0].message` for both.
3. `adapter.js:415` `where[category][equals]=<slug>` is now `400`; use the numeric ID from `GET /api/categories`.
4. PATCH bodies: send only `{ status, reviewNotes }` (editor-only note) or the changed fields; `updatedAt`/`publishedAt` are ignored.
   `saveArticle` must map `body` to `content` (Lexical), `standfirst` to `excerpt`, and drop `id`/`author`/`featuredImage` objects.
5. Submissions: statuses are `new|under_review|accepted|rejected|converted` with `reviewerNotes`; convert is
   `POST /api/submissions/:id/convert { category }` and returns `{ article: { id, slug } }`.
6. Live events need `category`; live updates are `{ event, body, occurredAt }`. Media upload is multipart (`file` + `_payload`); do not set
   `Content-Type` yourself.
7. Deploy the newsroom on the same registrable domain as the CMS (see above).

**PR #5 `agent/homepage-advertising`**: no CMS dependency today and nothing breaks. `docs/advertising-contract.md` proposes
`GET /api/public/advertising`; the backend has **no advertising collection or endpoint**. A live feed would need a `campaigns` collection
(sponsor, alt, destination, schedule, priority, placements, creatives as media), an editor-only workflow, and a public read projection with
schedule enforcement and cache headers. That is a product and security decision (payments, creative approval), so it is not built here.

**Public site (`feat/newsroom-mvp`, `src/lib/published-articles.js`)**: request shape, filtering, pagination and the Lexical renderer
match the contract. Not yet used but available: `featuredImage` (prefix a relative `url` with the CMS origin unless `CMS_PUBLIC_URL` is set),
`bylineName`, `corrections`, categories and the live timeline. Add the site origin to `CMS_CORS_ORIGINS`.

## Archive SEO and discovery proof

`cms-integration-tests/public-seo-completion.spec.js` (`docs/public-seo-completion.md`) checks the public host's structured data, canonical, Open Graph, sitemap and RSS for a synthetic archive-style article against the real CMS, under both `PUBLIC_ARTICLE_PATH_TEMPLATE` values. It uses only landed fields (C2 SEO fields, `bylineName`, `publishedAt`, featured image dimensions).

## Newsroom editor dependencies

The newsroom editor (`apps/newsroom`) sends `expectedUpdatedAt` with every article content `PATCH` (a 409 means someone else changed the story, and the editor keeps the user's text), and refreshes the staff session with `POST /api/users/refresh` about every 30 minutes while a user is active. Both must keep working as documented in `api-contracts.md`.

## Public quality evidence

The combined public CMS and mobile quality evidence for Wave 3 (synthetic data only, local runs) is in `docs/evidence/wave3-public/README.md`. Its before and after quality JSON files are machine-validated; the four SEO scores in the README are manually transcribed from local Lighthouse reports and are labelled as such. It is evidence of a local audit, not of production.

## Live update photos on the public site

The public live page renders the `image` object of `GET /api/live-events/{slug}/updates` (approved photo with alt text; url, width, height). An update without alt text or with an unusable image shows no picture. A revised update (same id, higher sequence) replaces the earlier entry in place. See `docs/public-live-coverage.md`.

Public-site note: legacy article rendering now preserves spaced absolute links and bounds video link titles; see docs/public-legacy-rendering.md (this line also runs the required CMS checks).
Public-site note: the owner ads.txt record parser now rejects vertical whitespace; see docs/public-wave1-seo.md (this line also runs the required CMS checks).
Public advertising delivery (C3): the public site origin must be listed in PUBLIC_SUBMISSION_ORIGINS before VITE_PUBLIC_ADVERTISING_URL is set; see docs/public-advertising-delivery.md.
