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
