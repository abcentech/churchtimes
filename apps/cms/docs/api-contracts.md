# Church Times CMS — API contracts (v1)

Status: implemented on `agent/payload-core`. Extends and supersedes "API contract v0" in
`docs/newsroom-24h-sprint.md`. Breaking changes to anything in this file require a
version bump here and a note in the PR that introduces them.

- Stack: Payload CMS 3.90.2 (Next.js 16 host app) + PostgreSQL (`@payloadcms/db-postgres`).
- Base URL: `${CMS_PUBLIC_URL}` (local default `http://localhost:3000`). All REST routes live under `/api`.
- Admin UI: `/admin` (desktop and Android browsers).
- All bodies are JSON (`Content-Type: application/json`), UTF-8. Timestamps are ISO-8601 UTC strings.
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
Upload is staff-only.

### LiveEvent (`/api/live-events`) — `{ id, title, slug, summary?, status: 'draft'|'live'|'ended', category, startedAt?, endedAt? }`
Anonymous readers see only `live` and `ended` events.

### LiveUpdate (`/api/live-updates`) — `{ id, event, body, status: 'pending'|'approved'|'rejected', sequence, occurredAt, approvedAt? }`
`body` is plain text (≤ 5 000 chars). Anonymous readers see only `approved`. `sequence` is assigned by the server
(per-event, monotonically increasing) and is not client-writable.

### Submission (`/api/submissions`) — staff-only collection
`{ id, reference, name, email, phone?, title, body, categorySuggestion?, location?, status: 'new'|'under_review'|'accepted'|'rejected'|'converted', reviewerNotes?, article? }`
Never readable anonymously. Never published automatically.

### AuditLog (`/api/audit-logs`) — read: `admin`, `editor-in-chief` only. Immutable via API.
`{ id, action, collection, docId, actor?, actorRole?, fromStatus?, toStatus?, summary?, createdAt }`

## 4. Public endpoints (no credentials)

Public endpoints are called with `credentials: 'omit'`. They never return staff-only data.

### 4.1 `POST /api/public/submissions`

Creates a pending submission for the editorial review queue.

Request headers: `Content-Type: application/json` (anything else → 415). If `Origin` is sent it must be in
`PUBLIC_SUBMISSION_ORIGINS` (→ 403).

```json
{
  "name": "Ada Obi",                  // required, 2–120
  "email": "ada@example.com",         // required, valid email, ≤ 254
  "phone": "+234 800 000 0000",       // optional, ≤ 40
  "title": "Church opens clinic",     // required, 5–200
  "body": "What happened…",           // required, 30–20 000, plain text
  "categorySuggestion": "News",       // optional, ≤ 100
  "location": "Ibadan",               // optional, ≤ 120
  "website": ""                       // honeypot — must be empty or absent
}
```

Responses:
- `201 { "ok": true, "reference": "SUB-7KQ2M9XA", "message": "Received. An editor will review your submission." }`
- `400 { "ok": false, "errors": [{ "field": "email", "message": "Enter a valid email address." }] }`
- `403 { "ok": false, "errors": [{ "message": "Origin not allowed." }] }`
- `413` body larger than 64 KB · `415` wrong content type
- `429 { "ok": false, "errors": [{ "message": "Too many submissions. Try again later." }] }` with `Retry-After` seconds.

Server behaviour: strips control characters and HTML tags from all text, stores a salted SHA-256 hash of
the client IP (never the raw IP), rate limits per IP (default 5 per 15 minutes, `SUBMISSION_RATE_LIMIT`
/ `SUBMISSION_RATE_WINDOW_SECONDS`). A honeypot hit returns a normal-looking 201 but stores nothing.
Unknown fields are ignored. Status is always `new` regardless of input.

### 4.2 `GET /api/articles` (Payload REST, published only for anonymous)

Frontend adapter call (`src/lib/published-articles.js` on `agent/chatgpt-frontend`):

```
GET /api/articles?where[status][equals]=published&limit=20&depth=0&sort=-publishedAt
GET /api/articles?where[slug][equals]=<slug>&depth=1
```

Response: `{ docs: Article[], totalDocs, limit, page, totalPages, hasNextPage, hasPrevPage, nextPage, prevPage }`.
For anonymous requests the server **always** constrains results to `status = published`, regardless of
query parameters. Max `limit` is 100.

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

## 5. Authenticated endpoints (staff)

Authentication: Payload session cookie (`payload-token`, HttpOnly, `SameSite=Lax`, `Secure` in production)
from `POST /api/users/login`, or `Authorization: JWT <token>`. Cookie-authenticated mutations are only
accepted from origins listed in `CMS_CSRF_ORIGINS` (Payload `csrf` setting).

| Method & path | Purpose |
| --- | --- |
| `POST /api/users/login` · `POST /api/users/logout` · `GET /api/users/me` | Session |
| `GET/POST/PATCH/DELETE /api/<collection>[/:id]` | Payload CRUD, filtered by role access rules above |
| `POST /api/articles/:id/preview-token` | Issue a preview token for an article the caller may read. Body optional `{ "ttlSeconds": 900 }` (60–3600). Returns `{ token, expiresAt, url }`. |
| `POST /api/submissions/:id/convert` | Editors only. Creates a `draft` article (author = caller) from the submission and marks the submission `converted`. Returns `{ article: { id, slug } }`. |
| `GET /api/audit-logs` | Admin and editor-in-chief only |

Lockout: 5 failed logins lock an account for 10 minutes.

## 6. Error shape

Payload-native routes return Payload's `{ errors: [{ message, ... }] }`. Custom endpoints in §4–5 return
`{ ok: false, errors: [{ field?, message }] }`. Status codes follow HTTP semantics (400 validation, 401 unauthenticated,
403 forbidden, 404 not found, 409 conflict, 413, 415, 429).

## 7. Environment variables

See `apps/cms/.env.example`. Secrets (`PAYLOAD_SECRET`, `PREVIEW_SECRET`, `IP_HASH_SALT`, database password)
are never committed.
