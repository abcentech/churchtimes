# Church Times CMS — API contracts (v1.1)

Status: implemented on `agent/payload-core`. v1.1 adds Turnstile, duplicate detection, staff auth/session
contract and security hardening (see §9 Changelog). Extends and supersedes "API contract v0" in
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
  every save of a published article creates a version (`versions.maxPerDoc = 50`).
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
Upload is staff-only, as `multipart/form-data` (§6.3).

### LiveEvent (`/api/live-events`) — `{ id, title, slug, summary?, status: 'draft'|'live'|'ended', category, startedAt?, endedAt? }`
Anonymous readers see only `live` and `ended` events.

### LiveUpdate (`/api/live-updates`) — `{ id, event, body, status: 'pending'|'approved'|'rejected', sequence, occurredAt, approvedAt? }`
`body` is plain text (≤ 5 000 chars). Anonymous readers see only `approved`. `sequence` is assigned by the server
(per-event, monotonically increasing) and is not client-writable.

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
`PUBLIC_SUBMISSION_ORIGINS` (→ 403). Send the request with `credentials: 'omit'`.

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
- Lists are paginated: `limit` (max **100**, larger values are clamped) and `page` (1-based). Response:
  `{ docs: Article[], totalDocs, limit, page, totalPages, hasNextPage, hasPrevPage, nextPage, prevPage, pagingCounter }`.
- Filtering by category must use the category **ID**: `where[category][equals]=<id>`. Look the IDs up with
  `GET /api/categories` (`{ docs: [{ id, title, slug, description? }] }`, public, cacheable). Slug filtering on
  a populated relationship (`where[category.slug]`) is not part of this contract.
- `GET /api/articles/:id` for an unpublished article returns 404 to anonymous callers.
- Staff-only fields (`author`, `reviewNotes`, `scheduledFor`) are never returned to anonymous callers.

### 4.3 `GET /api/live-events/:slug/updates?since=<sequence>&limit=<n>`

Polling endpoint for live coverage (recommended interval: 15–30 s).

```json
{
  "event": { "id": 3, "slug": "synod-2026", "title": "Synod 2026", "status": "live" },
  "docs": [
    { "id": 41, "sequence": 7, "body": "Delegates vote…", "occurredAt": "2026-10-13T10:15:00.000Z", "approvedAt": "2026-10-13T10:16:02.000Z" }
  ],
  "nextSince": 7
}
```

- Approved updates only, ordered by `sequence` ascending, `sequence > since` (default 0), `limit` ≤ 100 (default 50).
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

`PATCH /api/users/:id` with `{ "password": "…" }` — change a password (self or admin). The policy applies (400 on failure),
and every session of that user **except the caller's own** is ended. `role` and `sections` in the body are silently
ignored unless the caller is an `admin`.

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
| `POST /api/submissions/:id/convert` | Editors only. Creates a `draft` article (author = caller) from the submission and marks the submission `converted`. Body `{ "category": <id> }`. Returns `{ article: { id, slug } }`. |
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
   - The server sets `status`, `author`, `sequence`, `approvedBy`, `approvedAt`; those fields in the body are ignored.
   - `reporter` (and out-of-scope users): always created as `pending`.
   - `admin`, `editor-in-chief`, `section-editor` of the event's category, and `trusted-publisher` of that category may send
     `"status": "approved"` to publish immediately; otherwise it is `pending`.
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

## 7. Error shape

Payload-native routes return Payload's `{ errors: [{ message, ... }] }`. Custom endpoints in §4 and §6 return
`{ ok: false, errors: [{ field?, message }] }`. Status codes follow HTTP semantics (400 validation, 401 unauthenticated,
403 forbidden, 404 not found, 409 conflict, 413, 415, 429).

## 8. Environment variables

See `apps/cms/.env.example` (annotated) and `docs/operations.md` §4. Secrets (`PAYLOAD_SECRET`, `PREVIEW_SECRET`,
`IP_HASH_SALT`, `TURNSTILE_SECRET_KEY`, `SMTP_PASS`, database password) are server-side only and never committed or
shipped to a frontend. The only value a frontend needs is the public Turnstile **site** key. In production the app
refuses to start without a valid `TURNSTILE_SECRET_KEY` and https-only `CMS_PUBLIC_URL`/CORS/CSRF settings
(`docs/security.md`).

## 9. Changelog

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
