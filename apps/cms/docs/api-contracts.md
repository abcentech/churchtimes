# Church Times CMS — API contracts (v1.4)

Status: implemented on `agent/payload-core`. v1.1 added Turnstile, duplicate detection, staff auth/session
contract and security hardening; v1.2 closes the verified security-review findings: media ownership, version
access, publication-ordered live feed, append-only corrections, current-password checks, list limits and request
size limits; v1.3 is the frontend contract verification (see §9 Changelog). Extends and supersedes "API contract v0" in
`docs/newsroom-24h-sprint.md`. Breaking changes to anything in this file require a
version bump here and a note in the PR that introduces them.

- Stack: Payload CMS 3.90.2 (Next.js 16 host app) + PostgreSQL (`@payloadcms/db-postgres`).
- Base URL: `${CMS_PUBLIC_URL}` (local default `http://localhost:3000`). All REST routes live under `/api`.
- Admin UI: `/admin` (desktop and Android browsers).
- All bodies are JSON (`Content-Type: application/json`), UTF-8, except media upload (`multipart/form-data`, §6.3). Timestamps are ISO-8601 UTC strings.
- Generated TypeScript types for every collection: `apps/cms/src/payload-types.ts` (`npm run generate:types`).

## 1. Roles

| Role (`users.role`) | Summary |
| --- | --- |
| `admin` | Everything, including user and role management. |
| `editor-in-chief` | Approve, publish, schedule, archive and correct any article; manage live events, submissions and categories; read audit log. |
| `section-editor` | Same as editor-in-chief but only for articles/live events whose `category` is in their `sections`. |
| `trusted-publisher` | May publish or schedule **their own** articles directly when the article's category is in their `sections`. Cannot approve other people's work. |
| `reporter` | Write drafts and submit for review. Can never approve, publish, schedule or archive — including their own work. |

`users.sections` is a list of category IDs; it only affects `section-editor` and `trusted-publisher`.
Only `admin` can change `role` or `sections` (field-level access, enforced server-side). Users cannot
escalate their own privileges.

Anonymous visitors have no account. They can only: read published articles, read categories, read
non-draft live events and their approved updates, read media, and create submissions through §4.1.

## 2. Article workflow

`articles.status` values:

```
draft ──► in_review ──► approved ──► published ──► archived
  ▲           │  ▲          │            ▲  │
  │           ▼  │          ▼            │  ▼
  └──── changes_requested   scheduled ───┘  (correction = edit while published)
```

| From → To | Who (server-enforced) |
| --- | --- |
| (create) `draft` / `in_review` | Any staff role |
| (create) `approved` | Editors in scope (admin, editor-in-chief, section-editor of the category) may create an article directly as `approved` |
| (create) `published` / `scheduled` | Editors in scope; trusted-publisher for own article in scope |
| `draft` → `in_review` | Author, editors in scope |
| `changes_requested` → `in_review` / `draft` | Author, editors in scope |
| `in_review` → `changes_requested` / `approved` | Editors in scope (never the reporter role) |
| `in_review` / `draft` → `published` / `scheduled` | Editors in scope; trusted-publisher for own article in scope |
| `approved` → `published` / `scheduled` / `in_review` | Editors in scope; trusted-publisher for own article in scope (publish/schedule only) |
| `scheduled` → `published` | Scheduler (system) when `scheduledFor <= now`; editors in scope |
| `scheduled` → `approved` / `draft` (cancel) | Editors in scope |
| `published` → `archived`, `archived` → `published` | Editors in scope |

"Editors in scope" = `admin`, `editor-in-chief`, or `section-editor` whose `sections` contains the article's category.
Any other transition is rejected with HTTP 403 (not permitted) or 400 (invalid transition). Every
transition writes an `audit-logs` entry.

Rules:
- `publishedAt` is set by the server on first transition to `published` and is not client-writable.
- `scheduled` requires `scheduledFor` in the future.
- Reporters may edit content only while their article is `draft` or `changes_requested`.
- Editing a `published` article requires an editor in scope (or the trusted-publisher author in scope)
  and **must** append a `corrections` entry when `content`, `title` or `excerpt` change materially;
  every save of a published article creates a version (`versions.maxPerDoc = 50`). "Materially" compares
  values, not serialisation: sending the same Lexical document with its keys in a different order is not a change.
- `corrections` is **append-only**. A PATCH that includes `corrections` must start with every existing entry
  unchanged (same `id`, `note` and `correctedAt`, same order); new entries go after them and may omit `id`.
  `correctedAt` of a new entry is always set by the server (a client value is ignored). Rewriting, reordering or
  removing existing entries is `400`, except for `admin` and `editor-in-chief`, who may amend history (audited as
  `correction.amend`). Only a caller who may edit the article's content may add or amend entries (otherwise `403`).
  Send `corrections` back exactly as the API returned it (including `id`s) or leave it out of the PATCH body.
- **Restoring a version** (`POST /api/articles/versions/:id`) of a published article is a full overwrite. For
  `admin` and `editor-in-chief` it is allowed without a new corrections entry and is audited as `article.restore`
  (the restored document brings its own, possibly shorter, corrections list). For everyone else the normal rules
  apply: a restore that changes the title, excerpt or content, or shortens `corrections`, is rejected with `400`;
  make the change with a normal PATCH that adds a corrections entry instead.
- `author` is set to the creating user and can only be changed by editors.

## 3. Data model (public-facing fields)

### Article (`/api/articles`)

```ts
{
  id: number
  title: string                // ≤ 240 chars
  slug: string                 // ^[a-z0-9]+(?:-[a-z0-9]+)*$, unique, ≤ 160
  excerpt?: string             // ≤ 600 chars, plain text
  content: LexicalRichText     // structured JSON, never raw HTML
  category: number | Category  // depends on `depth`
  featuredImage?: number | Media
  bylineName?: string          // display byline (legacy authors without accounts)
  status: 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'scheduled' | 'published' | 'archived'
  publishedAt?: string
  corrections?: { id: string; correctedAt: string; note: string }[]
  legacyUrl?: string           // original churchtimesnigeria.net URL (redirect mapping)
  legacyId?: number            // WordPress post ID
  createdAt: string
  updatedAt: string
}
```

Staff-only fields (never returned to anonymous readers): `author`, `reviewNotes`, `scheduledFor`.

### Category (`/api/categories`) — `{ id, title, slug, description? }`
Seeded: News, Features, Opinion, Columnists, Interviews, Business, Education, Health, Publisher's Note.

### Media (`/api/media`) — `{ id, alt, caption?, credit?, url, filename, mimeType, width, height, sizes }`
Accepted uploads: `image/jpeg`, `image/png`, `image/webp`. Max 10 MB. SVG and HTML are rejected.
Upload is staff-only, as `multipart/form-data` (§6.3). Staff-only, server-set field: `uploadedBy` (user id of the
uploader; `null` for media uploaded before v1.2). Not client-writable and never returned to anonymous readers.
Editing is restricted, see §6.3. Anonymous readers can list and fetch **all** media (known limitation,
`docs/security.md` §4).

### LiveEvent (`/api/live-events`) — `{ id, title, slug, summary?, status: 'draft'|'live'|'ended', category, startedAt?, endedAt? }`
Anonymous readers see only `live` and `ended` events.

### LiveUpdate (`/api/live-updates`) — `{ id, event, body, image?, status: 'pending'|'approved'|'rejected', sequence, occurredAt, approvedAt? }`
`body` is plain text (≤ 5 000 chars). `image` is an optional upload relationship to `media` (numeric id on write; a populated
media doc when read with `depth ≥ 1`); see §6.2 for the rules. Public pages must use the feed (§4.3), not this field. Anonymous readers see only `approved`. `sequence` is **creation order**,
assigned by the server (per event, strictly increasing) and not client-writable. A second server-owned counter,
`publishSequence` (per event, nullable until the update is first approved), records **publication order**: it is
assigned `max(publishSequence)+1` every time an update becomes `approved` (also when it is created as
`approved`). Neither counter is client-writable. The public polling endpoint (§4.3) is driven by `publishSequence`.

### Submission (`/api/submissions`) — staff-only collection
`{ id, reference, name, email, phone?, title, body, categorySuggestion?, location?, status: 'new'|'under_review'|'accepted'|'rejected'|'converted', reviewerNotes?, article? }`
Server-owned, never client-writable: `reference`, `ipHash`, `userAgent`, `contentHash` (duplicate fingerprint). Never readable
anonymously. Never published automatically: only `POST /api/submissions/:id/convert` (editors) creates a **draft** article.

### AuditLog (`/api/audit-logs`) — read: `admin`, `editor-in-chief` only. Immutable via API.
`{ id, action, collection, docId, actor?, actorRole?, fromStatus?, toStatus?, summary?, createdAt }`

## 4. Public endpoints (no credentials)

Public endpoints are called with `credentials: 'omit'`. They never return staff-only data.

### 4.1 `POST /api/public/submissions`

Creates a pending submission for the editorial review queue. Public contributors can never publish:
the submission lands as `status: "new"` in a staff-only inbox and only an editor can convert it into a
**draft** article (§6).

Request headers: `Content-Type: application/json` (anything else → 415). If `Origin` is sent it must be in
`PUBLIC_SUBMISSION_ORIGINS` (→ 403). Send the request with `credentials: 'omit'`. Every response to an allowlisted
origin carries `Access-Control-Allow-Origin` (exact echo) and `Access-Control-Expose-Headers: Retry-After` (v1.3), so a
cross-origin script can read `Retry-After` on a 429. A 403 for an origin that is not allowlisted has no CORS grant
(the browser reports a network error). If `TURNSTILE_EXPECTED_ACTION` is set (comma list, e.g. `submit-story`; it must match the public build's `VITE_TURNSTILE_ACTION`)
the widget's `action` must be one of the entries, otherwise 403.

```json
{
  "name": "Ada Obi",                  // required, 2–120
  "email": "ada@example.com",         // required, valid email, ≤ 254
  "phone": "+234 800 000 0000",       // optional, ≤ 40
  "title": "Church opens clinic",     // required, 5–200
  "body": "What happened…",           // required, 30–20 000, plain text
  "categorySuggestion": "News",       // optional, ≤ 100
  "location": "Ibadan",               // optional, ≤ 120
  "website": "",                      // honeypot — must be empty or absent
  "turnstileToken": "0.xxxx"          // REQUIRED: Cloudflare Turnstile token from the widget (≤ 2048 chars)
}
```

`turnstileToken` is the value of the widget's `cf-turnstile-response` (the alias `"cf-turnstile-response"`
is accepted as the JSON key too). Tokens are single use and expire after 5 minutes; request a fresh one
(`turnstile.reset()`) after any failed attempt. The site key used by the widget is public and lives in the
frontend; the **secret key never leaves the server** (`TURNSTILE_SECRET_KEY`).

Processing order (each step can end the request; later steps do not run):

1. Origin check → 403 · Content-Type → 415 · `Content-Length` > 64 KB → 413
2. Per-IP rate limit → 429 (`SUBMISSION_RATE_LIMIT` per `SUBMISSION_RATE_WINDOW_SECONDS`, default 5 / 15 min)
3. Body read (hard 64 KB cap → 413) and JSON parse → 400
4. Honeypot hit → normal-looking `201`, nothing stored, Turnstile not called
5. Input validation and sanitising → 400 with per-field errors
6. **Turnstile Siteverify** (server-to-server, 5 s timeout, fail closed) → 400 / 403
7. Duplicate check (same email + title + body within `SUBMISSION_DUPLICATE_WINDOW_HOURS`, default 72) → 409
8. Per-email rate limit → 429 (`SUBMISSION_EMAIL_RATE_LIMIT`, default 3 / hour)
9. Create (`status: "new"`, server-generated `reference`) → 201

Rate limiting runs before Turnstile so bots cannot burn Siteverify quota.

Responses:
- `201 { "ok": true, "reference": "SUB-7KQ2M9XA", "message": "Received. An editor will review your submission." }`
- `400 { "ok": false, "errors": [{ "field": "email", "message": "Enter a valid email address." }] }`
- `400 { "ok": false, "errors": [{ "field": "turnstileToken", "message": "Please complete the verification challenge." }] }` — token missing, empty or not a string.
- `403 { "ok": false, "errors": [{ "field": "turnstileToken", "message": "Verification failed. Please try again." }] }` — Cloudflare said no (invalid, expired, already used, wrong hostname/action), Cloudflare unreachable, timed out, or answered with an error. Cloudflare's error codes are logged server-side only. **Fail closed:** the submission is never stored in this case.
- `403 { "ok": false, "errors": [{ "message": "Origin not allowed." }] }`
- `409 { "ok": false, "errors": [{ "message": "We already received this submission." }] }`
- `413` body larger than 64 KB · `415` wrong content type
- `429 { "ok": false, "errors": [{ "message": "Too many submissions. Try again later." }] }` (per IP) or
  `"Too many submissions from this email address. Try again later."` (per email), both with `Retry-After` seconds.

Server behaviour: strips control characters and HTML tags from all text, stores a salted SHA-256 hash of
the client IP (never the raw IP) and a SHA-256 `contentHash` for duplicate detection. A honeypot hit returns a
normal-looking 201 but stores nothing. Unknown fields are ignored: `status`, `article`, `reviewerNotes`,
`reference`, `ipHash`, `contentHash` in the body have no effect. Status is always `new`.

### 4.2 Reading published content (Payload REST, no credentials)

`GET /api/articles` — published only for anonymous callers. For anonymous requests the server **always**
constrains results to `status = published`, regardless of query parameters.

```
GET /api/articles?where[status][equals]=published&limit=20&page=1&depth=1&sort=-publishedAt
GET /api/articles?where[slug][equals]=<slug>&depth=1
GET /api/articles?where[category][equals]=<categoryId>&where[status][equals]=published
GET /api/articles/<id>?depth=1
GET /api/categories?limit=100
```

- `depth=0` returns relationships as IDs (`category: 3`); `depth=1` populates them (`category: { id, title, slug }`,
  `featuredImage: { url, alt, sizes… }`). The public site uses `depth=1` to get `category.title`.
- Lists are paginated: `limit` (max **100**, larger values are clamped; `0`, negative or non-numeric values
  become the default of 10) and `page` (1-based). `pagination=false` is **ignored** for API callers: lists are
  always paginated, so `hasNextPage` stays truthful. This applies to every collection and to
  `/api/articles/versions`. Response:
  `{ docs: Article[], totalDocs, limit, page, totalPages, hasNextPage, hasPrevPage, nextPage, prevPage, pagingCounter }`.
- Filtering by category must use the category **ID**: `where[category][equals]=<id>`. Look the IDs up with
  `GET /api/categories` (`{ docs: [{ id, title, slug, description? }] }`, public, cacheable). Slug filtering on
  a populated relationship (`where[category.slug]`) is not part of this contract. Relationship filters (`category`, `featuredImage`,
  `author`, `event`, `article`, `actor`, `approvedBy`, `uploadedBy`, `sections`, `parent`; operators `equals`, `not_equals`,
  `in`, `not_in`, `all`) must carry numeric IDs: anything else (e.g. `where[category][equals]=news`) is `400
  { ok: false, errors: [{ field: "where[category][equals]", message }] }` (v1.3; it used to be a generic 500).
- `GET /api/articles/:id` for an unpublished article returns 404 to anonymous callers.
- Staff-only fields (`author`, `reviewNotes`, `scheduledFor`) are never returned to anonymous callers.

### 4.3 `GET /api/live-events/:slug/updates?since=<sequence>&limit=<n>`

Polling endpoint for live coverage (recommended interval: 15–30 s).

```json
{
  "event": { "id": 3, "slug": "synod-2026", "title": "Synod 2026", "status": "live" },
  "docs": [
    {
      "id": 41, "sequence": 7, "body": "Delegates vote…", "occurredAt": "2026-10-13T10:15:00.000Z", "approvedAt": "2026-10-13T10:16:02.000Z",
      "image": { "url": "https://cms.example.org/api/media/file/vote.jpg", "alt": "Delegates raising voting cards", "width": 1600, "height": 900, "mimeType": "image/jpeg" }
    },
    { "id": 42, "sequence": 8, "body": "Result announced.", "occurredAt": "2026-10-13T10:20:00.000Z", "approvedAt": "2026-10-13T10:20:30.000Z", "image": null }
  ],
  "nextSince": 8
}
```

- **`image`** (v1.4, additive): `null` when the update has no photo, otherwise exactly
  `{ url, alt, width, height, mimeType }`. `url` is the media URL exactly as Payload returns it for an article's
  `featuredImage.url` (absolute `${CMS_PUBLIC_URL}/api/media/file/<name>` in production, root-relative in a local setup without
  `CMS_PUBLIC_URL`, see §6.3; resolve it against the CMS origin as `src/lib/cms-media.js` does). `alt` is always non-empty; `mimeType` is `image/jpeg`, `image/png` or `image/webp`; `width`/`height` are
  positive integers (or `null` if unknown). No other media field (filename, caption, credit, sizes, uploader) is returned.
  Only approved updates are in the feed, so the image of a pending or rejected update is never exposed here. Rendering
  guidance: `apps/cms/docs/live-update-images-contract.md`.
- Approved updates only, ordered by **publication order** ascending, `sequence > since` (default 0), `limit` ≤ 100
  (default 50). The `sequence` returned here is the update's `publishSequence` (§3), **not** its creation
  sequence, and `nextSince` is the `sequence` of the last returned update. This makes the feed safe for updates that
  are approved out of order: an update created first but approved last gets the highest number and reaches every
  poller. Clients should de-duplicate and update by `id`: an update that is rejected after approval disappears from
  the feed (already-delivered copies must be removed by the client, e.g. on a full reload), and an update that is
  approved again later is delivered again with a new, higher `sequence`.
- `404` if the event does not exist or is `draft`. `400` if `since`/`limit` are not non-negative integers.
- `Cache-Control: public, max-age=10`.

### 4.4 `GET /api/preview/articles?token=<token>`

Returns a single article in any status for a valid preview token. `401` for missing, invalid or expired tokens.
Response: `{ "doc": Article }`, `Cache-Control: no-store`.

## 5. Staff authentication and sessions

Built-in Payload auth on the `users` collection plus PostgreSQL. No third-party auth provider.

| Setting | Value |
| --- | --- |
| Login identifier | email (case-insensitive) + password |
| Token | JWT signed with `PAYLOAD_SECRET`, lifetime **8 hours** (`tokenExpiration`) |
| Sessions | **Server-side** (`useSessions: true`): every login creates a row in `users_sessions`; the token carries the session id and is rejected the moment the session is deleted |
| Cookie | `payload-token`; `HttpOnly`; `SameSite=Lax`; `Secure` when `NODE_ENV=production`; `Path=/`; no `Domain` (host-only); `Expires` = token expiry |
| Header alternative | `Authorization: JWT <token>` (not CSRF-able; use for non-browser clients) |
| Lockout | 5 failed logins lock the account for 10 minutes |
| Per-IP limits | login 10 / 15 min, forgot-password 5 / 15 min, reset-password 10 / 15 min (`AUTH_*_RATE_LIMIT`) → `429` |
| Reset link | valid 1 hour, single use; at most one reset e-mail per account per 15 s |
| Password policy | 12–128 chars; not a common password; not your e-mail address or name; no leading/trailing space |
| Sign-out triggers | logout, password change, password reset, admin "revoke sessions", lockout during parallel guessing |

**CSRF.** A cookie authenticates a request only when the request's `Origin` is in the CSRF allowlist
(`CMS_PUBLIC_URL` + `CMS_CSRF_ORIGINS`); if no `Origin` is sent, the browser must send `Sec-Fetch-Site:
same-origin|same-site|none`. Otherwise the request is treated as anonymous. **CORS.** Only origins in
`CMS_CORS_ORIGINS` receive `Access-Control-Allow-Origin` (exact echo, never `*`) and
`Access-Control-Allow-Credentials: true`. Browser clients on another origin (e.g. the newsroom UI on
`http://localhost:5174`) must be in **both** lists and call with `credentials: 'include'`.

**Deployment requirement (v1.3): same site.** The cookie is `SameSite=Lax` and host-only, so a browser sends it (and accepts
it from `Set-Cookie`) only on **same-site** requests. `http://localhost:5174` → `http://localhost:3000` is same-site (ports do
not matter). In production the newsroom UI and the CMS must share a registrable domain (for example `newsroom.example.org`
and `cms.example.org`) or be served from one origin through a reverse proxy. A newsroom on another registrable domain, or on a
public-suffix host such as `*.github.io` / `*.pages.dev`, cannot log in with the cookie: login would succeed but every later
request would be anonymous. We do not relax this to `SameSite=None`. The public website needs no cookie (it calls with
`credentials: 'omit'`) and may be on any domain listed in `CMS_CORS_ORIGINS` / `PUBLIC_SUBMISSION_ORIGINS`.

### Endpoints (Payload built-ins, all under `/api/users`)

`POST /api/users/login` — body `{ "email": string, "password": string }`

```json
// 200
{ "message": "Authentication Passed", "token": "<jwt>", "exp": 1760400000,
  "user": { "id": 3, "email": "ed@example.org", "name": "Ed", "role": "editor-in-chief", "sections": [], "collection": "users" } }
```
plus `Set-Cookie: payload-token=<jwt>; Path=/; Expires=…; HttpOnly=true; SameSite=Lax[; Secure=true]`.
Never returns `hash`/`salt`.

- `401 { "errors": [{ "message": "The email or password provided is incorrect." }] }` — **identical** for a wrong
  password and an unknown email (no account enumeration).
- `401 { "errors": [{ "message": "This user is locked due to having too many failed login attempts." }] }` — returned
  for every attempt (even with the right password) while the account is locked, for 10 minutes or until an admin
  unlocks it. (This message does confirm the account exists; it only appears after 5 failures.)
- `400` `ValidationError` (same shape as below, `path: "password"`/`"email"`, "This field is required.") if email or password is missing.
- `429 { "errors": [{ "message": "Too many attempts. Try again in N minute(s)." }] }` — per-IP limit.

`GET /api/users/me` — `200 { "user": {…} | null, "collection": "users", "token"?, "exp"?, "message": "Account" }`.
An unauthenticated, expired or revoked token yields **`200` with `user: null`** (Payload convention), not 401;
clients must check `user`. Protected collections answer 401/403.

`POST /api/users/refresh` — authenticated; `200 { "message": "Token refresh successful.", "refreshedToken", "exp", "user" }`
with a fresh cookie. A revoked session cannot refresh.

`POST /api/users/logout` — authenticated; `200 { "message": "Logout successful." }`, deletes the current session
(the old token stops working at once) and clears the cookie. `?allSessions=true` ends every session of the caller.

`POST /api/users/forgot-password` — body `{ "email": string }`. Always `200 { "message": "Success" }`, whether or not
the account exists. If it exists, an e-mail with a link `${CMS_PUBLIC_URL}/admin/reset/<token>` is sent (SMTP) or
logged to the console (development, no SMTP). `429` after 5 requests per IP per 15 minutes.

`POST /api/users/reset-password` — body `{ "token": string, "password": string }` (the token from the link).
- `200 { "message": "Password reset successfully.", "token": "<jwt>", "user": {…} }` — the user is logged in, **all other sessions are
  ended**, and failed-login counters are cleared.
- `400 { "errors": [{ "name": "ValidationError", "message": "The following field is invalid: password", "data": { "collection": "users", "errors": [{ "path": "password", "message": "Password must be at least 12 characters." }] } }] }` when the policy fails (the inner `message` carries the policy reason).
- `403 { "errors": [{ "message": "Token is either invalid or has expired." }] }` — unknown, used or expired token.

`PATCH /api/users/:id` with `{ "password": "…", "currentPassword": "…" }` — change a password (self or admin). The policy
applies (400 on failure), and every session of that user **except the caller's own** is ended. `role` and `sections` in
the body are silently ignored unless the caller is an `admin`.

**Current password required (v1.2).** When the caller changes **their own** password or e-mail address (any role,
admins included), the body must carry `currentPassword`. Missing → `400` (`ValidationError`, `path: "currentPassword"`);
wrong → `403 "The current password is incorrect."`; the account is locked → `403`. Wrong values count towards the
normal lockout (5 failures lock the account for 10 minutes, then logins also fail). An admin changing someone else's
account does not need it; changing only `name` never does. `currentPassword` is a virtual field: it is never stored and
never returned. Password and e-mail changes are audited (`user.password-change`, `user.email-change`,
`user.password-reset`) without the values.

`POST /api/users/unlock` — body `{ "email" }`; **admin only** (403 otherwise).

`POST /api/users/:id/revoke-sessions` — **admin only**; deletes every session of that user (force logout everywhere).
`200 { "ok": true }`, `403` for anyone else, `404` unknown user.

`POST /api/users/first-register` — only works on an empty database (the first account is always created as
`admin`); `403` as soon as any user exists.

User management (`POST/PATCH/DELETE /api/users`) is admin-only. `editor-in-chief` can read all users but cannot create,
modify or delete them. Every other role can read and update only their own record (name, e-mail, password).

## 6. Authenticated endpoints (staff)

Send either the cookie (browser, same rules as §5) or `Authorization: JWT <token>`.

| Method & path | Purpose |
| --- | --- |
| `POST /api/users/login` · `POST /api/users/logout` · `GET /api/users/me` · `POST /api/users/refresh` | Session (§5) |
| `GET/POST/PATCH/DELETE /api/<collection>[/:id]` | Payload CRUD, filtered by role access rules above |
| `POST /api/articles/:id/preview-token` | Issue a preview token for an article the caller may read. Body optional `{ "ttlSeconds": 900 }` (60–3600). Returns `{ token, expiresAt, url }`. |
| `POST /api/submissions/:id/convert` | Editors only. Creates a `draft` article (author = caller) from the submission and marks the submission `converted`. Body `{ "category": <id> }`. Returns `{ article: { id, slug } }`. Atomic: with concurrent calls exactly one gets `201`, the others `409`; if creating the article fails nothing changes and the submission can be converted again. |
| `GET /api/articles/versions[/:id]` | Staff only (anonymous `403`). Admin and editor-in-chief see every version; others see only versions whose stored `status` is `published`, whose `author` is themselves, or (non-reporters) whose `category` is in their `sections`. Filter fields are prefixed `version.` (`where[version.status]`, `where[parent]`). |
| `GET /api/audit-logs` | Admin and editor-in-chief only |

### 6.1 Article writes

- `POST /api/articles` — fields: `title`, `slug` (optional, generated), `excerpt`, `content` (Lexical JSON),
  `category` (ID), `featuredImage` (media ID), `bylineName`, `status`, `scheduledFor`, `corrections[]`.
- `PATCH /api/articles/:id` — send **only the fields you are changing**. Editable by the author/editors as per §2:
  `title`, `slug`, `excerpt`, `content`, `category`, `featuredImage`, `bylineName`, `status`, `scheduledFor`, `corrections`.
  Editor-only: `author`, `reviewNotes` (ignored when sent by anyone else). Server-owned and **always ignored**:
  `publishedAt`, `id`, `createdAt`, `updatedAt`. A forbidden change returns 403 (not permitted) or 400 (invalid transition).
- `DELETE /api/articles/:id` — **editor-in-chief and admin only** (everyone else 403/404). Prefer `status: "archived"`
  to retire an article; delete is for mistakes.

### 6.2 Live coverage (staff workflow)

1. Editor/section-editor/trusted-publisher creates the event: `POST /api/live-events { title, category, status: "draft" }`;
   `PATCH … { status: "live" }` publishes it (only in their sections), `"ended"` closes it. Anonymous readers see only `live` and `ended`.
2. Any staff member adds an update: `POST /api/live-updates { "event": <id>, "body": "…", "occurredAt"?: ISO }`.
   - The server sets `status`, `author`, `sequence`, `publishSequence`, `approvedBy`, `approvedAt`; those fields in the body are ignored.
   - `reporter` (and out-of-scope users): always created as `pending`.
   - An update for an event outside a section-editor's sections, or for an `ended` event by anyone who is not an
     editor in scope, is rejected with **`403`** (not `400`/`404`).
   - `admin`, `editor-in-chief`, `section-editor` of the event's category, and `trusted-publisher` of that category may send
     `"status": "approved"` to publish immediately; otherwise it is `pending`.
   - Optional photo: `"image": <media id>` (upload the file first with §6.3 and use the returned `id`). The media must exist and
     be readable by the caller, be a JPEG/PNG/WebP image and have non-empty `alt`; otherwise `400` (messages: *The attached image
     does not exist or is not available to you.* / *The attached file must be a JPEG, PNG or WebP image.* / *The attached image
     needs alt text. Add a description to the image first.*). The same rules apply on `PATCH` and again when an update is
     approved. `image` follows the same edit rules as `body`: reporters only while their own update is `pending`; editors in
     scope any time; trusted publishers their own updates. `"image": null` removes it. Every change of `image` on an existing
     update is audited (`live-update.image`). The media of an approved update cannot be edited or replaced by non-editors
     (`403`).
3. Editor review queue: `GET /api/live-updates?where[event][equals]=<id>&where[status][equals]=pending&sort=sequence`
   (editors read every update; reporters/trusted-publishers see their own plus approved ones).
4. Approve or reject: `PATCH /api/live-updates/:id { "status": "approved" | "rejected" | "pending" }` — editors in scope
   (admin, editor-in-chief, section-editor for the event's category); a trusted-publisher may approve **their own** updates in their
   sections; a reporter can only edit their own `pending` updates and can never approve. Approval stamps `approvedBy`/`approvedAt`.
5. Public timeline: poll `GET /api/live-events/:slug/updates?since=<nextSince>` (§4.3) — do not list `live-updates` directly.

### 6.3 Media upload (exception to "all bodies are JSON")

`POST /api/media` is `multipart/form-data` with two parts: `file` (binary) and `_payload` (a JSON string with
`{ "alt": "…", "caption"?: "…", "credit"?: "…" }`; `alt` is required, ≤ 300 chars). Staff only. Accepted:
JPEG, PNG, WebP (content is verified against the declared type), ≤ 10 MB. Response `201 { doc, message }` where
`doc` has `id`, `alt`, `filename` (sanitised), `mimeType`, `width`, `height`, `url`, and `sizes.{thumbnail,card,hero}.url`.
`url` fields are **absolute** (`${CMS_PUBLIC_URL}/api/media/file/<name>`) whenever `CMS_PUBLIC_URL` is set (always in production);
only in a local setup without it are they root-relative (`/api/media/file/<name>`).

**Editing media (v1.2).** `PATCH /api/media/:id` (JSON for `alt`/`caption`/`credit`, or `multipart/form-data` with a
new `file` to replace the file):
- `admin`, `editor-in-chief`, `section-editor`: any media.
- Everyone else (`trusted-publisher`, `reporter`): only media they uploaded (`uploadedBy` = themselves) — other media
  answers `403`/`404` — and **not** while the media is the `featuredImage` of an article whose status is `published` or
  `scheduled` (`403`: metadata edits and file replacement there are public-facing changes; ask an editor).
- Media without `uploadedBy` (uploaded before v1.2) can only be edited by editors. `uploadedBy` cannot be changed.
- Every update is audited (`media.update`); a file replacement is audited separately (`media.replace-file`).
- The "in use" check covers `featuredImage` only, not images embedded inside the Lexical body.

## 7. Error shape

Payload-native routes return Payload's `{ errors: [{ message, ... }] }`. Custom endpoints in §4 and §6 return
`{ ok: false, errors: [{ field?, message }] }`. Status codes follow HTTP semantics (400 validation, 401 unauthenticated,
403 forbidden, 404 not found, 409 conflict, 411, 413, 415, 429).

**Request size limits (v1.2).** Every `/api/*` request is checked before it reaches a route handler (`src/proxy.ts`):
a declared `Content-Length` above **1 MB** is `413` (above **11 MB** for `/api/media`), a malformed `Content-Length` is
`400`, and a body without `Content-Length` (chunked transfer) on `POST`/`PATCH`/`PUT` to `/api/users/*` is `411`.
These responses are `{ "ok": false, "errors": [{ "message": … }] }`. Normal browser `fetch` calls send
`Content-Length`; the reverse proxy enforces a 12 MB cap in front of this (`docs/operations.md` §4.4).

## 8. Environment variables

See `apps/cms/.env.example` (annotated) and `docs/operations.md` §4. Secrets (`PAYLOAD_SECRET`, `PREVIEW_SECRET`,
`IP_HASH_SALT`, `TURNSTILE_SECRET_KEY`, `SMTP_PASS`, database password) are server-side only and never committed or
shipped to a frontend. The only value a frontend needs is the public Turnstile **site** key. In production the app
refuses to start without a valid `TURNSTILE_SECRET_KEY`, `TRUST_PROXY=true` (the app always runs behind a reverse
proxy) and https-only `CMS_PUBLIC_URL`/CORS/CSRF settings (`docs/security.md`). Client-address handling for rate
limits: `TRUST_PROXY_HOPS` (default 1) and optional `CLIENT_IP_HEADER` (`docs/operations.md` §4).

## 9. Changelog

### v1.4
Optional photo on live updates. Additive, no breaking changes.
- `live-updates.image` (upload → `media`); validation, edit rules and audit in §6.2. Public feed docs gain `image` (§4.3).
- Existing feed consumers that ignore unknown keys are unaffected; consumers that assert the exact key set must add `image`.
- Media of an approved live update is frozen for non-editors, like media of a published article (§6.3).
- Migration `20261014_203617_live_update_image` (`live_updates.image_id` + FK to `media` with `ON DELETE SET NULL`, index).
- `image` is accepted as a relationship filter name (numeric ids only), see §4.2.

### v1.3
Frontend contract verification (`tests/integration/frontend-workflows.test.ts`, matrix in `docs/frontend-integration.md`). No
breaking changes.
- `POST /api/public/submissions`: every response to an allowlisted origin now sends `Access-Control-Expose-Headers: Retry-After`
  (browsers could not read it before); `TURNSTILE_EXPECTED_ACTION` accepts a comma-separated list (§4.1).
- Non-numeric relationship filters are `400` instead of `500` (§4.2). Rejections produced by `src/proxy.ts` (413, 411, 400 and this
  one) now carry CORS headers for allowlisted origins so browsers can read them, and every `/api/*` response gains `Vary: Origin`.
- Documented: the same-site deployment requirement for the staff cookie (§5).

### v1.2
Security-review fixes (details and tests in `docs/security.md` §5). Consumer-visible changes first:
- **Live feed `sequence` now means publication order** (§3, §4.3). `GET /api/live-events/:slug/updates` filters, sorts and
  returns `publishSequence` as `sequence` and `nextSince`; the wire shape is unchanged. Previously an update approved
  after a later-created one never reached pollers that had already advanced. Existing approved updates were
  backfilled with `publishSequence = sequence`, so stored cursors stay valid. Clients should treat `id` as the key.
- **`PATCH /api/users/:id` needs `currentPassword`** when you change your own password or e-mail (§5). **Breaking for
  clients that change a password without it.**
- **`corrections` is append-only** (§2); `correctedAt` of new entries is server-set; admin/editor-in-chief can amend
  (audited `correction.amend`). Send `corrections` back unchanged or omit it. Semantically identical content no
  longer counts as a material edit. Restore of a version: §2.
- **`pagination=false` is ignored** and `limit` is clamped to 1..100 on every collection (§4.2).
- **Media**: new staff-only `uploadedBy`; non-editors can only edit their own, unreferenced media; updates audited (§6.3).
- **`GET /api/articles/versions`**: new per-role filtering (§6). Anonymous remains `403`.
- **Request size limits**: `413` / `411` / `400` from `src/proxy.ts` (§7). Proxy cap 12 MB (operations §4.4).
- Convert-submission is atomic: concurrent calls → one `201`, the rest `409` (§6).
- Contract clarifications (no code change): a live update for an out-of-scope or ended event is `403` (§6.2);
  editors in scope may create an article directly as `approved` (§2).
- Ops: `TRUST_PROXY=true` is required in production; client IP is taken from the right of `X-Forwarded-For`
  (`TRUST_PROXY_HOPS`, default 1) or from `CLIENT_IP_HEADER`. New migration `review_fixes`
  (`media.uploaded_by_id`, `live_updates.publish_sequence`, unique `(event, publish_sequence)`).

### v1.1
- §4.1 `POST /api/public/submissions` now **requires** `turnstileToken` (Cloudflare Turnstile, server-side Siteverify,
  fail closed). New responses: 400/403 with `field: "turnstileToken"`, 409 duplicate, 429 per email. Processing order
  documented. **Breaking for frontends**: every submission must include a fresh token.
- New `contentHash` on submissions (staff-readable) for duplicate detection (migration `security_hardening`).
- §4.2 documents `depth`, `page`, category-ID filtering, `GET /api/articles/:id` and `GET /api/categories`.
- New §5 staff authentication contract: 8 h server-side sessions, cookie flags, lockout, per-IP auth limits, password
  policy (min 12), reset flow (1 h link), admin revoke-sessions, `unlock` restricted to admin.
- §6 documents article PATCH fields, article delete policy, the live-update staff workflow and multipart media upload.
- Session lifetime reduced from 12 h to 8 h. Password policy now enforced on create/change/reset.
- Security response headers on every route; production startup validation of origins and secrets.

### v1.0
- Initial contract: roles, article workflow, data model, public submissions, live polling, preview tokens.
