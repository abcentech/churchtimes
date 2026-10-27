# Church Times CMS — API contracts (v1.26)

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
non-draft live events and their approved updates, read media that is on the public site (§3 Media), and create
submissions through §4.1.

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
  seoTitle?: string | null     // v1.8, ≤ 70 chars, plain text; null when unset (public site falls back to `title`)
  seoDescription?: string | null // v1.8, ≤ 200 chars, plain text; null when unset (falls back to `excerpt`)
  content: LexicalRichText     // structured JSON, never raw HTML
  category: number | Category  // PRIMARY category (required); depends on `depth`
  categories?: (number | Category)[]  // v1.26: ADDITIONAL categories, 0 to 5, never the primary, no duplicates; depends on `depth`
  featuredImage?: number | Media
  bylineName?: string          // display byline (legacy authors without accounts)
  status: 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'scheduled' | 'published' | 'archived'
  publishedAt?: string
  corrections?: { id: string; correctedAt: string; note: string }[]
  legacyUrl?: string           // original churchtimesnigeria.net URL (redirect mapping); server-owned: never writable through the API
  legacyId?: number            // WordPress post ID; server-owned (set by the import loader only) and UNIQUE
  createdAt: string
  updatedAt: string
}
```

**SEO fields (v1.8).** `seoTitle` and `seoDescription` are optional and public on **published** articles (like every other
non-staff field); drafts and unpublished articles are never readable anonymously, so neither are their SEO values.
On write the server strips markup and control characters, collapses the text to one line and stores an empty result as `null`.
More than 70 / 200 characters after cleaning is `400` naming the field (*SEO title must be at most 70 characters.*). A value that
contains a template variable such as `%title%` or `%sitename%` is `400` (the public site builds its own title pattern). A
non-string (number, object, array) is `400`, never silently dropped. Fallbacks are the public site's job: title tag = `seoTitle`
else `title`; meta and share-card description = `seoDescription` else `excerpt`; RSS keeps `excerpt`. There is no canonical
override: the canonical address is derived from the article path. Who may edit follows `content`: reporters only while the
article is a draft or changes are requested, editors in scope, trusted publishers for their own. Changing **only** these two
fields of a published article is **not** a material change (no `corrections` entry needed) but is still versioned.

**Additional categories (v1.26).** An article can sit in several sections. `category` stays the **primary** category: required, it
drives the canonical listing, breadcrumbs, sitemap, scoping of section editors and every existing contract, so nothing that reads
`category` changes. `categories` is an optional list of extra categories, public like `category` (published articles only), stored
in the order written. Ordering rule: the primary comes first, the complete set of an article is `[category, ...categories]`.
Server-side validation on create and every update that sends `category` or `categories` (a partial update is checked against the stored
side): at most 5 entries, no duplicates, the primary must not be listed, every id must be an existing category (*Additional categories must be existing categories.*); otherwise `400`
(*An article can have at most 5 additional categories.*, *Additional categories must not repeat a category.*, *The primary category must not also be listed in the additional categories.*).
`categories: []` clears them. Deleting a category removes it from every article's `categories` (the join rows cascade; the article stays).
Section-editor and trusted-publisher scope still follows the primary `category` only. Existing clients that ignore `categories` keep working.

Staff-only fields (never returned to anonymous readers): `author`, `reviewNotes`, `scheduledFor`, `bodyMedia`.
`bodyMedia` (v1.4) is derived by the server from the `upload` nodes of `content` (distinct media ids), never client-writable
(ignored on input), and exists so the media freeze (§6.3) can tell which media is shown in a body.
**Body images (v1.4):** every `upload` node in `content` must have `relationTo: "media"`, an integer `value` id in
1..2147483647 (or a populated media object carrying one) and reference media that exists, is JPEG/PNG/WebP and has non-empty
`alt`; otherwise `400` with a message naming the problem ("An image in the article body …"). Applies to create and to every
update that sends `content`.

### Category (`/api/categories`) — `{ id, title, slug, description? }`
Seeded: News, Features, Opinion, Columnists, Interviews, Business, Education, Health, Publisher's Note.

### Media (`/api/media`) — `{ id, alt, caption?, credit?, url, filename, mimeType, width, height, sizes }`
Accepted uploads: `image/jpeg`, `image/png`, `image/webp` (max 25 MB by default, `MEDIA_IMAGE_MAX_MB`, since v1.25) and, since v1.19, audio/video for the `audioVideo` article block: `video/mp4`, `video/webm`, `audio/mpeg`, `audio/mp4`, `audio/ogg` (max `MEDIA_AV_MAX_MB`, default 100, see v1.19). SVG, HTML, scripts and every other type are rejected.
Upload is staff-only, as `multipart/form-data` (§6.3). Staff-only, server-set field: `uploadedBy` (user id of the
uploader; `null` for media uploaded before v1.2). Not client-writable and never returned to anonymous readers.
Editing is restricted, see §6.3.
**Read access (v1.6).** Any staff role reads all media. Everyone else (anonymous, or an account without a staff role) reads a media
document, its file and every size variant only while it is shown on the public site: it is the `featuredImage` or a body
image (`bodyMedia`) of an article whose status is `published` (scheduled and archived are **not** public), or the `image` of an
`approved` live update of a `live` or `ended` event. Otherwise `GET /api/media` omits it, `GET /api/media/:id` answers `404` and
`GET /api/media/file/<name>` (variants included) answers `403`. Unpublishing an article or
un-approving an update makes its media private again immediately. Depth-populated media in a published article
(`featuredImage`, upload nodes in `content`) is unchanged for anonymous readers; media that is not public is returned as a bare id.
The public site needs no change; see §6.3.

### LiveEvent (`/api/live-events`) — `{ id, title, slug, summary?, status: 'draft'|'live'|'ended', category, startedAt?, endedAt? }`
Anonymous readers see only `live` and `ended` events. `startedAt` is server-stamped: it is set (to "now") whenever an event
is created or saved with a status other than `draft` and has no `startedAt`, so an event created directly as `ended` (or moved
`draft`/`live` -> `ended`) never has an empty `startedAt`. That matters for `sort=-startedAt`: Postgres sorts NULL first in a
descending order, which would put such events ahead of live ones. `endedAt` is stamped whenever the status becomes `ended` (also on a second `ended` after `live`, so `ended -> live -> ended` records the
new end) or is `ended` with none, and is cleared (`null`) while the status is `live` or `draft`. A value supplied by the client on the
move to `ended`, and an existing `endedAt` of an event that stays `ended`, are kept. Migration `20261014_221500_live_events_started_at_backfill` fills existing
rows (`startedAt = createdAt`, `endedAt = updatedAt` for ended rows without one).

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

### Go-live C1: legacy content shapes

Implements go-live contract C1 (CMS side) from `go-live-contracts.md`. Additive; the integrator will renumber this heading.

**YouTube block (C1.1).** The admin editor for `articles.content` has Lexical's blocks feature with one block, `youtubeEmbed`.
Serialized shape (the `version` of the wrapper is whatever Payload's block feature writes; the contract fixes the three fields):

```json
{ "type": "block", "version": 2, "format": "",
  "fields": { "id": "<block id>", "blockName": "", "blockType": "youtubeEmbed", "videoId": "dQw4w9WgXcQ", "title": "Optional short title" } }
```

- `videoId`: required, exactly 11 characters from `[A-Za-z0-9_-]`. `title`: optional plain text, at most 120 characters, no markup.
  A URL is never stored; the public renderer builds the player address from the id.
- **Server validation** runs on every write that carries `content` (create, update, restore through update), as a `beforeValidate`
  hook next to the body-image check, and is skipped only for trusted seed calls. `400` for: a malformed `youtubeEmbed` block
  (*A YouTube block has an invalid video id ...*, or a title problem), and for **any other embed**: a raw `embed` node (the
  archive importer's old `{ type: 'embed', embedType, url }` shape), an iframe-like node (`iframe`, `video`, `youtube`, `vimeo`,
  `oembed`, `audio`, `html`, `rawhtml`, `script`, `object`, `widget`, matched case-insensitively), an `inlineBlock`, or a `block`
  whose `blockType` is not `youtubeEmbed` (*Embeds other than YouTube are not accepted.*). A `youtubeEmbed` block must be a leaf:
  no children, no `url`/`href`/`src` members and no fields beyond `id`, `blockName`, `blockType`, `videoId`, `title` (`400`).
  A body nested deeper than 64 object/array levels (about 15 nested list levels) is **refused with `400`**
  (*The article body is nested too deeply ...*): the check never silently skips what it cannot inspect.
  Anonymous readers get the block as stored, on published articles only (like all of `content`).
- (v1.19) A second block, `audioVideo`, is accepted for self-hosted audio and video; see "Audio/video block" below. Everything else stays refused.
- The importer must write `youtubeEmbed` blocks for YouTube, and for anything else a paragraph with the original link text (when it
  is a safe `https:` link) or nothing, plus a QA report line. It must not write `embed` nodes.

**Audio/video block (v1.19).** The editor also registers `audioVideo`. Serialized shape (same wrapper as `youtubeEmbed`):

```json
{ "type": "block", "version": 2, "format": "",
  "fields": { "id": "<block id>", "blockName": "", "blockType": "audioVideo", "kind": "video",
              "media": 123, "poster": 124, "title": "Choir rehearsal", "caption": "Optional caption",
              "transcriptUrl": "https://example.org/transcript", "duration": 95 } }
```

- `kind`: `"video"` or `"audio"` (required). `media`: id of a Media document (an upload relation; a populated object is accepted on write), the self-hosted
  file. `sourceUrl`: legacy address, used only when no file exists (the importer could not find it); an http(s) address without credentials or a
  root-relative path, at most 2000 characters. At least one of `media` / `sourceUrl` is required. `poster`: optional image (JPEG/PNG/WebP) in Media.
  `title` (required, at most 120 characters) is the accessible name; `caption` at most 500; both plain text (no `<`, `>` or control characters).
  `transcriptUrl`: optional, same address rules as `sourceUrl`. `duration`: optional seconds, 0 to 86400. A leaf: no children, no other fields (`400`).
- **Server validation** (every write that carries `content`, skipped only for trusted seed calls): shape errors are `400` from the embed check; a `media` file
  must exist, be readable by the caller, have a non-empty `alt` (its description) and a type allowed for the kind (video: `video/mp4`, `video/webm`;
  audio: `audio/mpeg`, `audio/mp4`, `audio/ogg`); a `poster` must pass the body-image rules. `bodyMedia` also lists the `media` and `poster` ids, so the
  media freeze (§6.3) and the public read rule (§3 Media) apply to them exactly as to body images.
- **Public projection.** There is no separate endpoint: an anonymous reader of a published article gets the block as stored, and with `depth >= 1` `media` and
  `poster` are populated Media documents. The public site needs: `fields.kind`, `fields.title`, `fields.caption`, `fields.duration`, `fields.transcriptUrl`,
  `fields.media.url` (the file; absolute `${CMS_PUBLIC_URL}/api/media/file/<name>` whenever `CMS_PUBLIC_URL` is set, like every other media url),
  `fields.media.mimeType` (one of the five types), `fields.poster.url`, and `fields.sourceUrl` when there is no `media` (legacy address, may be dead: render the title as
  a plain link or nothing). If `media` comes back as a bare id the file is not public: render nothing. Files are public exactly while the article is `published`
  (unchanged: draft, scheduled, in review, archived and withdrawn articles keep them private, `403` on the file route). Never build a player URL from anything but `media.url` / `sourceUrl`.
- **Upload rules** (Media): content is verified by magic bytes (MP4 `ftyp`, WebM EBML with the `webm` doctype, MP3 ID3 or frame sync, Ogg `OggS`) and must match the
  declared type (`audio/x-m4a` is stored as `audio/mp4`, `video/x-m4v` as `video/mp4`); the file is stored unchanged (no re-encode, no size variants, `width`/`height` empty).
  Size cap: `MEDIA_AV_MAX_MB` (default 100, maximum 500), `413` above it; images use the image cap (25 MB by default since v1.25). Through `POST /api/media` a request is still bounded by the
  proxy and request-size limit (11 MB anonymous, 26 MB for verified staff since v1.25, `lib/requestLimits.ts`, `next.config.mjs`), so larger files are loaded server side (the importer, the Local API) until operations raise
  those limits together with the reverse proxy.
- **Importer.** `<video>`, `<audio>`, `<source>` and the shortcodes `[fvplayer]`, `[video]`, `[audio]` become `audioVideo` blocks (a figure around one element lends its figcaption as caption;
  `poster`/`splash` go through the image resolver). A file found by the media resolver gets `media`; otherwise the block keeps `sourceUrl` and the run report counts
  `unresolved-media` (counts only). YouTube addresses inside these tags still become `youtubeEmbed`; any other type or player page (`.mov`, `.wav`, Vimeo, ...) stays a link
  paragraph or is dropped, counted as unsupported.

**Tables (C1.4).** The editor registers Lexical's table feature (`EXPERIMENTAL_TableFeature`) on `articles.content`. Stored shape is the
standard `table` > `tablerow` > `tablecell` (`headerState` 0/1/2, `colSpan`, `rowSpan`), unchanged from what the public renderer
reads. A real-browser test (`e2e/browser/article-editor.spec.ts`) opens an article with a table and a YouTube block in the admin
editor, edits a paragraph and a cell, saves it, and compares the full stored body (row/cell structure, `headerState`, `colSpan`, `rowSpan`,
`backgroundColor`, text runs and formats, all block fields) with what was created. It runs under desktop-chrome and android-pixel7. An
image inside a table cell is validated and recorded in `bodyMedia` like any body image. There is no server-side check of table
structure beyond Payload's own.

**Media `legacyPath` (C1.2).** Optional text field on `media` (additive, indexed, migration `media_legacy_path`): the original WordPress
upload path after `/wp-content/uploads/`, normalised (`2023/10/photo.jpg`: no leading slash, no `..`, no `?`/`#`/backslash, at most 500
characters; otherwise `400`). **Staff-only:** readable by `admin`, `editor-in-chief` and `section-editor`; writable (API) by `admin` and
`editor-in-chief`; writable by server code (Local API with `overrideAccess`, which is what the importer uses). Anonymous callers,
reporters and trusted publishers never see it and cannot filter by it (`400`); a value they send is ignored. Existing media privacy,
ownership and freeze rules are unchanged. Helper functions for the importer live in `src/lib/legacyMediaPath.ts` (`legacyPathFromUrl`,
`stripSizeSuffix` for `-300x200` suffixes before the extension only, `candidatePaths` = `[exact, stripped]`: callers try the exact path
first because a real file can be called `banner-1920x1080.jpg`; `altFallback`/`resolveAlt`: alt, else caption, else
`<title> photo`, at most 300 characters).

**Import helpers (C1.3, C1.5).** Pure, database-free functions in `src/lib/legacyContent.ts` for the later importer task:
`resolveSlugCollisions` (reserved route names such as `admin` or `search` count as taken, so a colliding post gets `-2`; every valid original slug is reserved first, only true duplicates and normalised forms that collide get `-2`, `-3`,
so a duplicate never takes a slug another post owns, in any order; returns `{old,new}` pairs; slug rule and 160 characters),
`sanitizeLegacyLinks` (keep `http`, `https`, `mailto` and root-relative links; convert everything else, including a URL in any of
`fields.url`, `url`, `href`, to plain text; an old-host link is rewritten through the slug map **only** when it is a plain `/<slug>/`
address with a slug in the map and not a reserved WordPress path; `?p=ID`, `/category/...`, dated permalinks, media and unknown slugs
stay as written and are listed in `report.unmapped` with a reason; a subtree nested deeper than 64 levels is flattened to text and
reported), `stripShortcodes` (conservative: removes a closing tag only when paired with a removed opening tag, tags carrying
attributes, and case-sensitive known names such as `[gallery]`, `[video]`, `[wpforms]`, `penci-*`; keeps `[sic]`, `[co-founder]`,
`[covid-19]`, `[x1]`, `[Video]`; tidies only the whitespace touching a removal; reports every removal), `dropTemplateVariableSeo`
(Rank Math `%variable%` values become `null` plus a flag). The public host resolves `?p=ID` through `legacyId`; dated permalinks
(`/2020/05/slug/`) are not mapped by these helpers.

## 4. Public endpoints (no credentials)

Public endpoints are called with `credentials: 'omit'`. They never return staff-only data.

### 4.1 `POST /api/public/submissions`

Creates a pending submission for the editorial review queue. Public contributors can never publish:
the submission lands as `status: "new"` in a staff-only inbox and only an editor can convert it into a
**draft** article (§6).

Request headers: `Content-Type: application/json` (anything else → 415). If `Origin` is sent it must be in
`PUBLIC_SUBMISSION_ORIGINS` (→ 403). Send the request with `credentials: 'omit'`. Every response to an allowlisted
origin carries `Access-Control-Allow-Origin` (exact echo) and `Access-Control-Expose-Headers: Retry-After` (v1.3), so a
cross-origin script can read `Retry-After` on a 429 (every 429 the CMS answers carries `Retry-After` and exposes it, see "429 and
`Retry-After`" in §7). A 403 for an origin that is not allowlisted has no CORS grant
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
  "consent": true,                    // optional boolean (v1.16); required when SUBMISSIONS_REQUIRE_CONSENT=true (400, field "consent")
  "consentTextVersion": "2026-10",    // optional, ≤ 80; stored only together with consent: true
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
  `featuredImage: { url, alt, sizes… }`). The public site uses `depth=1` to get `category.title`. `categories` (v1.26) is returned the
  same way: ids at `depth=0`, `[{ id, title, slug }]` at `depth=1`, primary-first reading order `[category, ...categories]`.
- **Listing a category's articles (v1.26)** includes the ones that have it as an additional category: `where[categories][in]=<id>` (or
  `[equals]`) matches only articles that carry it as an additional category; for "primary OR additional" use the `or` form
  `where[or][0][category][equals]=<id>&where[or][1][categories][equals]=<id>&where[status][equals]=published`. `categories` is a
  relationship filter like `category`: numeric ids only, anything else is `400`.
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
  **Size served (v1.5):** `url`, `width`, `height` and `mimeType` describe the ~800 px wide `card` variant of the upload (see
  `imageSizes` in `Media.ts`), not the original (which can be up to 25 MB). When the media has no `card` variant (Payload does not
  enlarge an image that is already narrower than 800 px, and media that predates the size has none) or the variant is not a usable
  media URL / image type, the original upload is used instead. `alt` always comes from the media document.
  Only approved updates are in the feed, and (v1.6) the media collection is private for anything that is not on the public site
  (§3 Media), so the file of a pending or rejected photo cannot be fetched either, even by someone who knows its URL. Rendering guidance: `apps/cms/docs/live-update-images-contract.md`.
- Approved updates only, ordered by **publication order** ascending, `sequence > since` (default 0), `limit` ≤ 100
  (default 50). The `sequence` returned here is the update's `publishSequence` (§3), **not** its creation
  sequence, and `nextSince` is the `sequence` of the last returned update. This makes the feed safe for updates that
  are approved out of order: an update created first but approved last gets the highest number and reaches every
  poller. Clients should de-duplicate and update by `id`: an update that is rejected after approval disappears from
  the feed (already-delivered copies must be removed by the client, e.g. on a full reload), and an update that is
  approved again later is delivered again with a new, higher `sequence`.
- **Edits of an approved update (v1.4).** When the `body` or `image` of an update that *stays* `approved` is changed, the server
  assigns it a new, higher `publishSequence`, exactly as an approval does. A poller with `since=<old cursor>` therefore receives
  the corrected update again: **same `id`, higher `sequence`, new content** (including `image: null` when the photo was removed).
  Clients must treat `id` as the key and **replace** the item they hold (and re-position it by the new `sequence`); ignoring a
  known `id` hides the edit until a full reload. A PATCH that changes neither field (or only other fields) does not re-stamp.
  The same re-delivery happens when an editor replaces the **file** (new `image.url`) or changes the **alt text** of a media that an
  approved update uses (v1.7).
  Not covered: deleting a media document that an approved update uses (`ON DELETE SET NULL`) fires no hook, so the feed
  drops the image on the next full read but pollers with a newer cursor are not re-sent the update, and no
  `live-update.image` audit entry is written; only the media delete itself is audited (`delete`, collection `media`).
- `404` if the event does not exist or is `draft`. `400` if `since`/`limit` are not non-negative integers.
- `Cache-Control: public, max-age=10`.

### 4.4 `GET /api/preview/articles?token=<token>`

Returns a single article in any status for a valid preview token. `401` for missing, invalid or expired tokens.
Response: `{ "doc": Article }`, `Cache-Control: no-store`. Staff-only data is not returned (`reviewNotes`, `author`, `scheduledFor`,
`bodyMedia`, and on populated media `uploadedBy` and the access-only join fields).

**Images in a preview (v1.7).** Draft images are private (§3 Media), so every media URL in the response (`featuredImage.url`,
`featuredImage.sizes.*.url`, and the `value.url` of body upload nodes) is returned with `?preview=<token>` appended. The media read
access (`GET /api/media/file/<name>`, `GET /api/media/:id`) accepts that parameter and then also allows the **featured image and body
images of that one article** (any status), nothing else: the article id comes from the signed token (HMAC, constant-time comparison,
expiry enforced); a token for another article, an expired, tampered or empty token grants nothing (`403`/`404` as for anonymous). Use the
returned URLs as they are; do not cache them beyond the token's lifetime.

### Go-live C5: contact

`POST /api/public/contact` stores a reader's message in the staff-only `contact-messages` collection (separate from story
submissions, so the editorial queue stays editorial) and e-mails staff. Anonymous, credential-free, same rules as §4.1:
`Origin` must be in `PUBLIC_SUBMISSION_ORIGINS` (403; allowlisted origins get an exact `Access-Control-Allow-Origin` echo and
`Access-Control-Expose-Headers: Retry-After`), `Content-Type: application/json` (415), body at most **16 KB** (413), `OPTIONS` preflight answered.

```json
{ "name": "Ada Obi", "email": "ada@example.test", "topic": "general",
  "message": "Plain text, 20 to 5000 characters.", "website": "", "turnstileToken": "0.xxxx" }
```

- `name` 2 to 120; `email` valid (lower-cased on store); `topic` one of `general`, `advertising`, `corrections`, `tips`, `other`;
  `message` 20 to 5 000 characters of plain text (HTML tags and control characters are stripped before the length is judged).
- Turnstile action **`contact-message`**. It must be listed in `TURNSTILE_EXPECTED_ACTION` when that variable is set. The endpoint
  also pins the token to its own action: a valid token minted for another form's action (for example `newsletter-subscribe`) is `403`.
- Processing order: origin, content type, declared size, per-IP limit, capped body read and JSON parse, honeypot, validation,
  Turnstile, duplicate, per-address limit, write, notification. Rate limiting precedes Turnstile so bots cannot burn Siteverify quota.
- Limits: per IP `CONTACT_RATE_LIMIT` (5) per `CONTACT_RATE_WINDOW_SECONDS` (900); per address 3 per hour (counted for verified,
  non-duplicate messages); the same address with the same message (case and whitespace insensitive) within 72 h is `409`. Every `429`
  carries `Retry-After` and exposes it.
- A non-empty `website` (honeypot) returns the normal `201` with a throw-away reference, stores nothing, sends nothing, skips Siteverify.

Responses:
- `201 { "ok": true, "reference": "MSG-7KQ2M9XA", "message": "Received. We will reply by email." }`. The reference is `MSG-` plus exactly 8
  characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`.
- `400 { ok:false, errors:[{ field, message }] }` (validation, bad JSON, missing Turnstile token) · `403` (origin, Turnstile) ·
  `409` duplicate · `413` · `415` · `429` · `500` store failed.

Notification: one e-mail to `CONTACT_NOTIFY_TO` (comma list, server-side, validated at startup in production, **never returned
to a client or written to logs**), `Reply-To` = the sender's address, plain-text body. CR, LF and other control characters are removed
from every header-bound value. The mail is queued **after** the `201` (a hanging SMTP server never delays the answer, so a retry cannot hit a false `409`;
SMTP timeouts are 10 s connect, 10 s greeting, 20 s socket) and `notifyStatus` is updated when it finishes. The message is stored **before** any mail is attempted: if SMTP or `CONTACT_NOTIFY_TO` is missing, or sending
fails, the message is still stored, the answer is still the normal `201`, the failure is logged (reference only) and the row shows
`notifyStatus` = `failed` or `not-configured` to staff.

`contact-messages` (`/api/contact-messages`, staff-only: `admin` and `editor-in-chief`; never anonymous): `reference`, `name`, `email`,
`topic`, `message`, `status` (`new`, `read`, `replied`, `spam`), `notifyStatus` (`sent`, `failed`, `not-configured`), `ipHash`,
`userAgent`, `contentHash`. Only `status` is editable over REST; rows cannot be created over REST; raw IP addresses are never stored.

### Go-live C4: newsletter

The CMS stores consent and subscribers; it does **not** send newsletters. Three anonymous endpoints (same rules as §4.1: `Origin` in
`PUBLIC_SUBMISSION_ORIGINS` or 403, JSON only or 415, `OPTIONS` preflights, `Access-Control-Expose-Headers: Retry-After`) plus staff tools.

**`POST /api/public/newsletter/subscribe`** (body cap 8 KB, Turnstile action `newsletter-subscribe`, pinned to this endpoint)

```json
{ "email": "reader@example.test", "name": "Optional name", "consent": true,
  "source": "footer", "website": "", "turnstileToken": "0.xxxx" }
```
- `email` valid, at most 254, lower-cased. `name` optional, 2 to 120; **a missing field, `null` and an empty string all mean "no name"**.
  `consent` must be literally `true`. `source` is required and one of `footer`, `article`, `home`, `other`.
- Order: origin, content type, size, **503 check**, per-IP limit, body, honeypot, validation, Turnstile, per-address limit, write.
  Limits: per IP `NEWSLETTER_RATE_LIMIT` (5) per `NEWSLETTER_RATE_WINDOW_SECONDS` (900); per address 3 per hour, counted for every verified
  attempt whatever the address's state. Both `429` with `Retry-After`.
- **Double opt-in.** A new address is stored `pending` with the SHA-256 of a random token (the token is never stored), expiring in 72 h, and the
  CMS e-mails `${PUBLIC_SITE_URL}/newsletter/confirm?token=...` (a public-site page, never an API URL; `PUBLIC_SITE_URL` is https-only in production).
  The mail is queued after the answer is built, so response time does not reveal whether the address existed.
- **Neutral answer.** A new, an already-pending and an already-confirmed address all get the byte-identical
  `202 { "ok": true, "message": "If this address can be subscribed, we sent a confirmation email." }`. Pending: a fresh link replaces the old one.
  Confirmed: nothing is sent or changed. An **imported row with no proven opt-in** (stored `pending`, `importedFrom = mailchimp-import-no-optin-time`) is
  treated like any pending row (a fresh link; confirming records fresh consent now, under the wording version the person was shown). **Unsubscribed or bounced: not re-added**; the row keeps its status, the same answer is returned, and a
  fresh confirmation link is mailed. Opening it is the only way back (it also records fresh consent). A mail failure is logged and still answers `202`.
- **Mail-bombing guards.** Beyond the 3 per hour per address: a resend cooldown `NEWSLETTER_RESEND_COOLDOWN_SECONDS` (600; inside it nothing is sent and the
  earlier link stays valid), a daily cap `NEWSLETTER_MAX_CONFIRM_MAILS_PER_DAY` (5 per rolling 24 h), and `bounced` addresses are never mailed automatically.
  Every refused case returns the same neutral `202`. Timestamps and counters live on the subscriber row (internal, never in a response).
- Timing note: response bodies are byte-identical for every state, but database work still differs slightly by subscriber state; the mail is queued after
  the answer so SMTP time does not leak.
- A honeypot hit returns the normal `202` and stores nothing.
- `503 { "ok": false, "errors": [{ "message": "Sign-up is unavailable." }] }` and nothing stored when, in production, SMTP is not configured or
  `PUBLIC_SITE_URL` is missing or not https.
- A person erased earlier who signs up again is a fresh double opt-in (new `pending` row); the erase record stays.

**`POST /api/public/newsletter/confirm`** and **`POST /api/public/newsletter/unsubscribe`**: body `{ "token": "..." }` (cap 2 KB), no Turnstile (the token
is the proof), per-IP limit `NEWSLETTER_TOKEN_RATE_LIMIT` (20) per window. **POST only: any other method is `405` with `Allow: POST, OPTIONS`**, so mail
scanners that pre-fetch links change nothing.
- confirm: single-use random token, valid 72 h, matched by its SHA-256. One conditional `UPDATE` (id, token hash, observed status and expiry in the
  `WHERE`, token cleared in the same statement) sets `confirmed` and `confirmedAt`; of simultaneous confirms exactly one wins and writes the one audit row.
- unsubscribe: HMAC-SHA256-signed token `u1.<subscriber id>.<signature>` (key `NEWSLETTER_TOKEN_SECRET`, constant-time comparison, no expiry so every
  future newsletter can carry a working link). Sets `unsubscribed` and `unsubscribedAt`. Idempotent; an erased subscriber stays erased.
- Both answer `200 { "ok": true }`. Any invalid, expired, used, forged or unknown token is the same `400 { "ok": false, "errors": [{ "message": "This link is no longer valid." }] }`.

**Staff data.** `subscribers` (`/api/subscribers`, **`admin` only** for read and update (the editor-in-chief cannot read subscriber data); never anonymous, never in a public response): `email` (unique,
lower-cased), `name?`, `status` (`pending`, `confirmed`, `unsubscribed`, `bounced`, `erased`), `source`, `consentTextVersion`, `consentAt`, `confirmedAt?`,
`unsubscribedAt?`, `ipHash`, `importedFrom?` (`web`, `mailchimp-import`, `mailchimp-import-no-optin-time`); `confirmTokenHash` and `confirmTokenExpiresAt` exist but are invisible over REST
and in the admin UI. Nothing can be created or deleted over REST; over REST an admin may only move a status to `unsubscribed` or `bounced` (`confirmed` can
only come from the double opt-in link or the import). Such a change is audited (`subscriber.status-change`), stamps `unsubscribedAt` and clears any pending confirmation token.
- **`GET /api/subscribers/:id/subject-data`** (`admin` only, audited as `subscriber.subject-export` without the address, `no-store`): everything held about one person for a
  data-subject access request (no token hashes or mail counters); an erased row is `404`.
- **`GET /api/subscribers/export?status=confirmed`**: CSV for `admin` only (401 anonymous, 403 others), `status` one of `pending`, `confirmed`
  (default), `unsubscribed`, `bounced` (else 400), `Cache-Control: no-store`, audited (`subscriber.export`, count only). Columns: `email,name,status,source,consentAt,confirmedAt,unsubscribedAt,importedFrom`.
  A cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`.
- **`POST /api/subscribers/:id/erase`** (`admin` only, audited): the address becomes `erased:<HMAC-SHA256 keyed with IP_HASH_SALT>`, the name, IP hash and token
  are cleared, `status` is `erased`. The row is a suppression record that the importer honours. Erasure does **not** touch `contact-messages` from the same
  address (an admin deletes those manually), and rotating `IP_HASH_SALT` breaks the suppression match.
- **Import CLI** `npm run import:subscribers -- --file <csv> [--apply] [--assume-subscribed]` (server-side only, no endpoint). Dry run by default; output is
  counts only, never an address. The file must be outside the repository. Header names are matched loosely (`Email Address`, `First Name`, `Last Name`,
  `OPTIN_TIME`, `CONFIRM_TIME`, `Status`, `UNSUB_TIME`, `CLEAN_TIME`). Times must be exactly `YYYY-MM-DD HH:MM:SS` (UTC); any other shape, an impossible date or a
  future time counts as no time.
  - `subscribed` with an `OPTIN_TIME`: stored `confirmed`, `importedFrom = mailchimp-import`, `consentAt` = `OPTIN_TIME`, `confirmedAt` = `CONFIRM_TIME` **only** (null when absent; never copied from `OPTIN_TIME`).
  - `subscribed` with **no valid `OPTIN_TIME`** (no proof of consent): stored **`pending`**, `consentAt` and `confirmedAt` null, `importedFrom = mailchimp-import-no-optin-time`. Such a row is
    excluded from every send and from `GET /api/subscribers/export?status=confirmed` until the person confirms (re-permission below).
  - `unsubscribed` or `cleaned` rows, and files with `UNSUB_TIME` / `CLEAN_TIME` columns, are imported as **blocking rows** (`unsubscribed` / `bounced`, `unsubscribedAt` set). An existing
    confirmed or pending row that the export lists as unsubscribed or cleaned is moved to that status. Other existing rows and erased addresses are never overwritten.
  - No Status column: refused unless `--assume-subscribed` (the "Subscribed" segment export), except UNSUB_TIME / CLEAN_TIME files which are always blocking.
  - An `--apply` run writes one audit row `subscriber.import` (counts, file SHA-256, operator name; no personal data). A path inside the repository is refused. Errors print only class and code.
- **Re-permission** `npm run newsletter:reconfirm -- --dry-run|--apply [--limit N] [--deadline YYYY-MM-DD] [--throttle-ms N]` (server-side, dry run by default, `--dry-run` with `--apply` is an error). For
  the `pending` rows imported without an opt-in time and never mailed only: creates a confirmation token (valid until the end of the deadline day UTC, default 30 days), sets
  `consentTextVersion = mailchimp-reconfirm-v1` and sends ONE plain-text mail through the configured mailer (throttled, default 1 s). Resumable (a row is stamped before sending; a failed send clears
  the stamp so the next run retries it; 5 consecutive failures stop the run). Counts-only output and audit row (`subscriber.reconfirm-run`); no address or token is printed or logged.
  Opening the link sets `confirmed`, `consentAt` = now and keeps the `mailchimp-reconfirm-v1` version, so consent is provable.
- **Purge** `npm run newsletter:purge-unconfirmed -- --deadline YYYY-MM-DD --dry-run|--apply [--limit N] [--include-unsent]`: refuses until the deadline has passed. Reduces still-`pending` imported rows that were mailed
  (with `--include-unsent` also those never mailed) to the salted-hash suppression record (as erase). Dry run by default; audited (`subscriber.purge-unconfirmed`, counts only).
- Provider sync (Mailchimp API) is **not implemented** and off.

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
- `429 { "errors": [{ "message": "Too many attempts. Try again in N minute(s)." }] }` — per-IP limit, with `Retry-After: <seconds>` and
  `Access-Control-Expose-Headers: Retry-After` (v1.5; Payload adds `Access-Control-Allow-Origin` for `CMS_CORS_ORIGINS`).

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
- **Approve what you saw (v1.6).** `PATCH /api/articles/:id` and `PATCH /api/live-updates/:id` (§6.2) accept an optional
  `expectedUpdatedAt` (ISO-8601 string: the `updatedAt` of the version the user reviewed). If it is present and the stored
  `updatedAt` is a different instant, the request is refused with **`409`**
  `{ "errors": [{ "message": "This item changed after you opened it. Reload and review it again." }] }` and nothing is written
  (no status change, no `reviewNotes`, no audit entry). The comparison is made inside the update's own transaction on the
  row-locked document, so two editors acting on the same version cannot both succeed (the second gets `409`). The field is
  never stored and never returned. Absent or `null` means no check (existing API clients are unchanged); a value that is not an
  ISO date string is `400`. Send it with every approve / publish / request-changes (and reject) action. Not supported on bulk
  updates (`400`). Order of checks: a malformed `expectedUpdatedAt` is `400` first (it is validated in `beforeOperation`, before access, so even an
  unauthorised caller sees that `400`); then collection access (`403`/`404`); then the version check (`409`), which runs before the workflow/role checks.
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
     does not exist or is not available to you.* / *The attached image must be a JPEG, PNG or WebP image.* / *The attached image
     needs alt text. Add a description to the image first.*). The same rules apply on `PATCH` and again when an update is
     approved. `image` follows the same edit rules as `body`: reporters only while their own update is `pending`; editors in
     scope any time; trusted publishers their own updates. `"image": null` removes it. Every change of `image` on an existing
     update is audited (`live-update.image`). The media of an approved update cannot be edited or replaced by non-editors
     (`403`, both for metadata `PATCH` and for a multipart file replacement). Changing `body` or `image` of an approved update
     re-stamps `publishSequence` (§4.3).
3. Editor review queue: `GET /api/live-updates?where[event][equals]=<id>&where[status][equals]=pending&sort=sequence`
   (editors read every update; reporters/trusted-publishers see their own plus approved ones).
4. Approve or reject: `PATCH /api/live-updates/:id { "status": "approved" | "rejected" | "pending", "expectedUpdatedAt"?: ISO }` (v1.6: `409` when the update changed since that version, §6.1) — editors in scope
   (admin, editor-in-chief, section-editor for the event's category); a trusted-publisher may approve **their own** updates in their
   sections; a reporter can only edit their own `pending` updates and can never approve. Approval stamps `approvedBy`/`approvedAt`.
5. Public timeline: poll `GET /api/live-events/:slug/updates?since=<nextSince>` (§4.3) — do not list `live-updates` directly.

### 6.3 Media upload (exception to "all bodies are JSON")

`POST /api/media` is `multipart/form-data` with two parts: `file` (binary) and `_payload` (a JSON string with
`{ "alt": "…", "caption"?: "…", "credit"?: "…" }`; `alt` is required, ≤ 300 chars). Staff only. Accepted:
JPEG, PNG, WebP (content is verified against the declared type), ≤ 25 MB (`MEDIA_IMAGE_MAX_MB`; anonymous submitters are still held to the 11 MB request limit). Response `201 { doc, message }` where
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
- A multipart `PATCH` that carries `alt` must carry a non-blank `alt` of at most 300 characters (`400` otherwise, nothing changes: the
  old file is kept). Omit `alt` to keep the stored one.
- Replacing the file (or changing the `alt`) of a media that is the image of an approved live update gives that update a new
  `publishSequence` (§4.3), so pollers receive the new `image.url`. Applies to editors (non-editors are frozen out, above).
- The "in use" freeze (v1.4) covers: the `featuredImage` **and the body images** (`Articles.bodyMedia`, §2) of an article whose
  status is `published` or `scheduled`, and the `image` of an `approved` live update. It applies to metadata edits and to
  multipart file replacement alike (`403`); editors are exempt. It is evaluated at edit time, so removing the image from the
  body (an editor edit) lifts it.
- **Read access (v1.6).** `GET /api/media`, `GET /api/media/:id` and `GET /api/media/file/<name>` (originals and the
  `thumbnail`/`card`/`hero` variants) answer: any staff role, everything; everyone else, only media that is the featured or a body
  image of a **published** article, or the image of an **approved** update of a `live`/`ended` event (§3 Media). Draft,
  in-review, approved-but-unpublished, scheduled and archived articles, pending/rejected updates and unreferenced uploads are
  private (`404` on the document, `403` on the file, the same answer whether or not the file exists). The rule is evaluated per
  request in SQL, so there is no cache of "public" state to invalidate; `/api/media/file/*` responses for public media are
  unchanged. **Caching:** do not put a long-lived shared cache in front of `/api/media/file/*` without revalidation: a file
  stops being public when its article is unpublished. A media file that was public stays reachable by anyone who has already
  downloaded it, obviously. Note the freeze above still includes `scheduled` articles (their media is frozen but private).

### Go-live A12: legacy media map (offline export)

Not an HTTP endpoint. The public host must serve `/wp-content/uploads/*` from an exact, privately provisioned map, with no anonymous
media scan and no staff credential on the public host. The CMS side is an offline export run by the owner:
`npm run export:media-map -- [--out <file>] [--aliases <json>] [--detail-file <path>]` (`apps/cms/src/lib/mediaMapExport.ts`, `mediaMapData.ts`, `mediaMapCli.ts`).

- **Privacy.** A media is exported only if an ANONYMOUS reader can read it at export time under the media read rule (§3: media of a published
  article, an approved live update of a live/ended event, a delivered ad creative). The exporter asks the CMS with `overrideAccess: false`
  and no user, so drafts, in-review, scheduled, archived/withdrawn and unreferenced media are never listed. `legacyPath` (staff-only) is
  read by a trusted second read of every media that has one. The file carries no ids, alt, caption, credit, uploader or any staff field, and no
  count of private media (that count, `notAnonymous`, is printed by the CLI only).
- **Format** (`media-map/1`, JSON, UTF-8): `{ version, generatedAt, counts: { entries, aliases }, contentSha256, entries, aliases }`.
  `entries[]` = `{ path, file, mime, size }`: `path` is the legacy path after `/wp-content/uploads/` (NFC, percent-decoded once, no duplicate,
  leading or trailing slash, no `.`/`..`, case-sensitive, exact match); `file` is the CMS public file URL path, matching
  `^/api/media/file/[A-Za-z0-9][A-Za-z0-9._-]*$`; `mime` is `image/jpeg|png|webp`; `size` is bytes. Sorted by `path` in code-unit order.
  `aliases[]` = `{ alias, path }`, sorted by `alias`.
  **This differs from the flat proposal in PR #58** (`entries[{legacyPath, mediaPath, mimeType}]` with aliases as ordinary entries, plus `revision`):
  #58 must be updated to this contract, or the host must adapt. The host must validate every entry at load itself (`validateMediaMapBody` is a reference).
- **Limits** (aligned with #58): at most 50,000 entries counting map entries plus aliases, and 8 MiB serialised. The export fails with
  `media-map-too-many-entries` / `media-map-too-large` and writes nothing.
- **Aliases.** A size-suffix alias (`photo-300x200.jpg` -> `photo.jpg`) exists only when it is recorded in the owner's `--aliases` JSON
  (`[{ "alias": ..., "path": ... }]`) AND the alias equals the original with exactly one `-WxH` suffix before the extension AND the original is an
  exported entry AND no media at all (exported or not) claims the alias as its own exact path. Otherwise it is dropped and itemised in the detail file.
  The host tries the exact entry first, then the alias; it never strips suffixes itself.
- **Ambiguity.** Two media (any visibility: draft, private, withdrawn included) claiming one normalised path are ambiguous: neither is exported.
- **Digests.** `file-sha256` is the sha256 of the EXACT bytes of the map file; it is the provisioning check, printed by the CLI and written next to
  the map as `<out>.sha256` (`<hex>  <file name>`, `sha256sum -c` compatible). `contentSha256` (inside the file) is only a stable content id: it ignores
  `generatedAt` and formatting, so the same content gives the same id on every run. The digest detects accidental damage; it is not a signature.
- **CLI.** Without `--out` it is a dry run printing counts and both digests only. `--out` and `--detail-file` must be outside the repository
  (refused with exit 2, also when reached through a symlink or junction). Files are written to a temp file in the target folder, then renamed over the
  target, mode `0600` (no effect on Windows: protect the folder with its permissions there). `--detail-file` itemises ambiguities and rejected aliases
  (it names paths and media ids). Output never prints a path or file name.
- **Withdrawal.** The public host is designed (#58) as no-store with an anonymous CMS check on every request, so revocation is immediate: once media
  stops being anonymously readable the CMS file URL answers 403/404 and the host serves 404, before any re-export. Re-export (and replacing the map
  atomically) then removes the entry and the alias, so it stops being mapped at all. Notes: an ad creative stops being public when its campaign
  ends; media still used by another published article stays public and stays mapped. Images already downloaded cannot be recalled. If a bounded
  cache is ever introduced the staleness window is export time + host reload + cache lifetime; #58 keeps no-store.
- Not covered: aliases are not recorded on the media document (no schema change); the owner supplies them. `HEAD`/range behaviour belongs to the host.

### 6.4 Staff related articles

`POST /api/staff/related-articles`: finds past **published** articles related to a draft or to free text, with citations. Read-only, **no generation**
(it returns existing articles and their canonical addresses, nothing is written or summarised by a model). Contract and notes for consumers:
`docs/staff-retriever.md`.

- **Auth.** Staff session only (cookie or `Authorization: JWT`); any staff role (`reporter` and above; there is no lower role). Anonymous: `401`.
  Cookie sessions are CSRF-checked by Payload (an `Origin` outside the CSRF list is treated as anonymous: `401`).
- **Body** (JSON, at most 256 KiB, else `413`): `{ "text"?: string, "articleId"?: number | string, "limit"?: integer }`. At least one of `text` and `articleId`.
  `limit` default 10, **maximum 20** (larger values are clamped; non-integers `400`). With `articleId` the draft (title, excerpt, body) is loaded with the
  caller's own access rules (`404` when it does not exist or is not readable by them) and **excluded** from the results. When both are given, `text`
  drives the query and the article is still excluded.
- **Query derivation.** Input is capped at 20,000 characters (`truncated: true` when cut). Terms are the title (weighted x3), the first 1,000 characters
  and the rest of the body, lowercased, letters/digits only, 3-30 characters, English stopwords and bare numbers removed, top 24 by frequency. The query is
  `to_tsquery('english', 't1 | t2 | ...')` (OR semantics); input never reaches PostgreSQL as tsquery syntax.
- **Response `200`**: `{ "ok": true, "results": [...], "limit": n, "truncated": bool }`, each result
  `{ id, title, slug, canonicalPath, canonicalUrl, publishedAt, snippet, score, matchedTerms }`. `canonicalPath` follows `PUBLIC_ARTICLE_PATH_TEMPLATE`;
  `canonicalUrl` is `PUBLIC_SITE_URL` (else the `CMS_PUBLIC_URL` origin) plus the path, `null` when neither is configured. `snippet` is plain text, at
  most 240 characters; `score` is `ts_rank` (higher is better, 4 decimals); `matchedTerms` are the query terms (stemmed match) found in the article.
  Only `published` articles with `publishedAt` in the past appear; drafts, in-review, scheduled and archived (withdrawn) never do.
- **Headers.** Every response (including errors) is `Cache-Control: private, no-store`.
- **Limits.** Per-user rate limit `STAFF_RELATED_RATE_LIMIT` (default 30) per `STAFF_RELATED_RATE_WINDOW_SECONDS` (default 60): `429` + `Retry-After`.
  Not audited; the submitted text is never logged (errors log class name and SQLSTATE only).

## 7. Error shape

Payload-native routes return Payload's `{ errors: [{ message, ... }] }`. Custom endpoints in §4 and §6 return
`{ ok: false, errors: [{ field?, message }] }`. Status codes follow HTTP semantics (400 validation, 401 unauthenticated,
403 forbidden, 404 not found, 409 conflict, 411, 413, 415, 429).

**Request size limits (v1.2).** Every `/api/*` request is checked before it reaches a route handler (`src/proxy.ts`):
a declared `Content-Length` above **1 MB** is `413` (above **11 MB** for `/api/media`), a malformed `Content-Length` is
`400`, and a body without `Content-Length` (chunked transfer) on `POST`/`PATCH`/`PUT` to `/api/users/*` is `411`.
These responses are `{ "ok": false, "errors": [{ "message": … }] }`. Normal browser `fetch` calls send
`Content-Length`; the reverse proxy enforces a 28 MB cap in front of this (`docs/operations.md` §4.4).

**429 and `Retry-After` (v1.5).** The CMS answers 429 in exactly three places, and each sends `Retry-After: <whole seconds, >= 1>` plus
`Access-Control-Expose-Headers: Retry-After` (the header is not CORS-safelisted, so without the expose header a cross-origin
script reads `null`): `POST /api/public/submissions` per IP and per e-mail (§4.1; `lib/rateLimit.ts` supplies the seconds),
and the per-IP `login` / `forgot-password` / `reset-password` limits (`lib/authRateLimit.ts`, merged into Payload's error response via
`req.responseHeaders`; the `Access-Control-Allow-Origin` grant comes from `CMS_CORS_ORIGINS` as for every Payload route).
Not rate limited, so no 429: the anonymous live feed `GET /api/live-events/:slug/updates` (cheap, read-only, answered with
`Cache-Control: public, max-age=10` so a CDN absorbs polling) and all other reads. A locked staff account is a `401`, not a `429`.

### Go-live C7: redirects

Implements `go-live-contracts.md` C7 (exact-match redirects for the old WordPress addresses). Pattern rules (`/category/*`, `/tag/*`,
`/page/N/`, `/feed/`, AMP variants, `/?p=ID`) stay with the public host.

**The single normalisation contract** (`src/lib/redirectPaths.ts`: `normalizePath` for stored values, `normalizeRequestPath` for a raw
request target). The CMS applies it to every `from`, `to` and `legacyUrl`, to the addresses in `check:redirects`, and the public host must
apply the same function to the request path (query string and fragment removed first) before its exact lookup. Test vectors for both
sides: `apps/cms/tests/fixtures/redirect-normalisation.json` (`normalize`, `reject`, `request`). The canonical form: leading `/`; trailing
`/` unless the last segment has a file extension; each segment decoded from UTF-8 (raw characters and percent escapes alike),
Unicode **NFC**-normalised and re-encoded, so every character except `A-Z a-z 0-9 - . _ ~` is UTF-8 percent-encoded with **upper-case** hex
(`/café/`, `/cafe%CC%81/`, `/caf%c3%a9/` are one key; `'` becomes `%27`; `%41` becomes `A`); case preserved. Rejected (never repaired), which
is exactly what the public host treats as junk: scheme or host, `//` prefix, backslash, raw whitespace, control characters raw or encoded
(C0, DEL, C1, U+2028, U+2029), the encoded characters `%2F` `%5C` `%25` `%23`, bytes that are not valid UTF-8 (`/%C3/`), a segment that starts
like a scheme (`tel:`, `mailto:`, `javascript:`, `data:`, `http(s):`, and any `name:` first segment), `?`, `#`, `*`, dot segments, empty
segments, more than 300 characters. A request path that fails normalisation has no rule (404).

**`redirects` collection** (`/api/redirects`): read, create, update and delete = `admin` and `editor-in-chief` only (anonymous and every
other role 403). Every write is audited (`redirect.create`, `redirect.update`, `redirect.delete`; a bulk import writes one `redirect.import`).
Fields: `from` (canonical, unique, not `/`), `to` (canonical path, or `https://` URL whose host is in `REDIRECT_ALLOWED_HOSTS`; absent for
410), `status` (301 default, 302, 410), `source` (`manual` default, `rank-math`, `legacy-url`), `note`. Writes (serialised by an advisory
lock) are refused with 400 naming the conflicting rule for: a loop; a duplicate address; a `manual` row that chains (either direction),
that points at a gone (410) address, or whose absolute target path is itself a rule; and any address that is the current public address of a
published article. A **manual row overrides** the rule an article derives for the same address; other sources may not. `rank-math` and
`legacy-url` rows may chain (flattened, or made 410, at generation).

**Derived rules**: each **published** article with a `legacyUrl` yields `from` = path of `legacyUrl`, `to` = the article path from
`PUBLIC_ARTICLE_PATH_TEMPLATE` (**`/{slug}/` default**, owner decision D1: the same address WordPress used; or `/reports/{slug}/`; any other value stops startup). Nothing is emitted when `from`
equals `to`, the article is not published, the `legacyUrl` has a query string or is the root, or its host is not in `LEGACY_SITE_HOSTS`
(default `churchtimesnigeria.net,www.churchtimesnigeria.net`; a bare path is accepted). Existing rules and the write hook compare canonical paths
over all published articles (no substring search, no limit).

**`GET /api/public/redirects`** (anonymous; GET and HEAD):

```json
{ "version": "sha256:…", "generatedAt": "2026-10-16T00:00:00Z", "count": 2, "rules": [
  { "from": "/old-slug/", "to": "/new-slug/", "status": 301, "source": "legacy-url" },
  { "from": "/retired/", "to": null, "status": 410, "source": "manual" } ] }
```

Sorted by `from`; `version` = sha256 of the canonical JSON of `rules`; a `410` has `"to": null`. Headers: `ETag: "<version>"`,
`Cache-Control: public, max-age=300`, `Vary: Origin`; `If-None-Match` (strong, weak, list or `*`) answers `304`. `Origin`, when sent, must be in
`PUBLIC_SUBMISSION_ORIGINS` (403); allowlisted origins get an exact `Access-Control-Allow-Origin` echo and `Access-Control-Expose-Headers: ETag`.
No staff data and nothing from an unpublished article. Rebuilt at most once per 10 s per process.
**Data never causes a 500.** At generation: a staff row beats a derived rule for the same address (counted); the lowest article id wins a
duplicate `legacyUrl`; an invalid stored row, a loop (every rule on it and every chain into it), or an absolute target that is another rule's
address is dropped; a chain is flattened; a rule whose target is a gone address becomes a 410 itself (status 302 if any hop is 302). The result
satisfies the public host's rule: no emitted `to` equals another emitted `from`. Counts only go to the server log. **500 only** for a bad
configuration (`PUBLIC_ARTICLE_PATH_TEMPLATE`, `REDIRECT_ALLOWED_HOSTS`, `LEGACY_SITE_HOSTS`) or when **20,000 rules** or **5 MB** is exceeded
(never truncated); the log carries an error code, never an address.

**Commands** (from `apps/cms`; they print counts and error codes only, never an address or rule label):

- `npm run export:redirects -- --out <file> [--detail-file <path>]` writes exactly the JSON the endpoint serves (generated artifact, never committed).
- `npm run check:redirects -- --urls <file> [--detail-file <path>]` reads old addresses (one per line, `#` comments; at most 5 MB and 100,000
  lines), looks each up with the normalisation contract above, and prints counts: resolved (301 / 302 / 410 / live article) and unresolved
  (no rule / query-only / invalid). Exit 1 if anything is unresolved, 2 for a usage or file error. On failure it prints `error=<code>`
  (`config`, `too-many-rules`, `too-large`, `internal-error`) only.
- `--detail-file` writes the rule labels (which are old addresses) of dropped or overridden items, or the error message, to a path that must be
  **outside the repository** (otherwise exit 2).
- `npm run import:redirects -- --file <csv> [--apply]`: header `from,to,status` (`status` optional, default 301; `to` empty for 410; at most
  20,000 rows). Dry run unless `--apply`; rows get `source = rank-math`. Skipped and counted: invalid from/to/status, `*` patterns, duplicates,
  already stored, address owned by an article rule or live article, loops, absolute target that is a rule. A row whose target is a gone
  address is written as a 410 (counted).

Environment: `PUBLIC_ARTICLE_PATH_TEMPLATE`, `REDIRECT_ALLOWED_HOSTS` (**must equal the public host's `PUBLIC_REDIRECT_ALLOWED_HOSTS`; the
host also needs `PUBLIC_SITE_URL`**), `LEGACY_SITE_HOSTS` (`docs/operations.md`). Migration `20261017_095306_redirects` (table `redirects`,
enum `enum_redirects_source`, locked-documents relation column), reversible (down then up is tested).

### Go-live C3: advertising

Implements `go-live-contracts.md` C3 (delivery side of the public advertising contract).

**Staff collections** (`admin` and `editor-in-chief` only; no other role, never anonymous; every write audited):

- `advertisers` (`/api/advertisers`): `name`, `contactName?`, `contactEmail?`, `notes?`. Never public. Audit rows carry the name only. An advertiser that
  still has campaigns cannot be deleted (`409`).
- `ad-campaigns` (`/api/ad-campaigns`): `advertiser` (required), `sponsor` (1 to 100), `alt` (1 to 240), `destinationUrl` (absolute `https:`, no credentials,
  at most 500), `placements` (`homepage-billboard`, `article-inline`, `mobile-banner`), `creatives` (group `homepageBillboard`/`articleInline`/`mobileBanner`, each
  with `desktop`/`mobile` media; `mobileBanner` has `mobile` only), `startsAt`/`endsAt` (timezone required, `endsAt` after `startsAt`), `priority` (integer 0 to 100),
  `status` (`draft`, `pending_approval`, `approved`, `paused`, `cancelled`), `rightsConfirmed`, `paymentStatus` (`unpaid`, `invoiced`, `paid`, `waived`).
  Server-owned (client values ignored): `approvedBy`, `approvedAt`, `creativeMedia` (media ids of the selected placements' creatives). `sponsor` and `alt` are
  stripped of markup; over-long values are `400`, not truncated.
- **Creative checks** (on create, when the creatives or placements actually change, and on entering `approved`; never when pausing, cancelling or editing
  other fields, so a corrupt file cannot trap a live campaign): JPEG, PNG or WebP; exactly 970x250 / 320x100 (billboard),
  728x90 / 320x100 (article-inline), 320x50 (mobile-banner, no desktop); file at most 500 KB (512,000 bytes); animated PNG and WebP are `400`. The sizes are read
  from the media document.
- **Approval gate** (`400` listing every problem): `rightsConfirmed = true`, at least one placement, a creative for every required slot of every selected
  placement, `startsAt`/`endsAt` set, and, while `ADS_REQUIRE_PAYMENT` is not `false`, `paymentStatus` of `paid` or `waived`. `waived` can only be set by `admin`
  (`403` otherwise; an editor-in-chief may still edit other fields of a campaign an admin waived). On approval `approvedBy`/`approvedAt` are set from the caller.
  **Approve what you saw:** moving a campaign to `approved` through the API requires `expectedUpdatedAt` (the `updatedAt` of the version reviewed): `400` when
  missing, `409` when the campaign changed since (same mechanism as articles, §6.1; the check locks the row), so a concurrent edit of the public text cannot be
  approved unseen. Trusted server code without a user is exempt. `priority` must be a whole number (`400` otherwise); `destinationUrl` is stored normalised (`href`).
- **Re-approval:** an `approved` campaign that stays `approved` in a request that changes a public field (`sponsor`, `alt`, `destinationUrl`, `placements`,
  `creatives`, `startsAt`, `endsAt`, `priority`), or after which the gate no longer holds (payment lapsed, rights unticked), becomes `pending_approval`
  (`approvedBy`/`approvedAt` cleared). It must be approved again in a separate request. Changing `advertiser`, `status` to `paused`/`cancelled`, etc. does not.
- **Audit** (`audit-logs`): `ad-campaign.create`, `ad-campaign.status` (`fromStatus`, `toStatus`, `details.reason` when the server moved it back to pending),
  `ad-campaign.update` (names of the changed fields only, never values), `ad-campaign.delete`; `advertiser.create|update|delete`. An `approved` campaign cannot be
  deleted (`409`: pause or cancel it first).
- **Media freeze:** the media of an `approved` campaign cannot have its details edited by a non-editor (`403`), like the media of a published article. Stricter,
  for every role (editors, admin and server code with a request included): the **file** of a media that is a creative of an `approved` or `pending_approval`
  campaign cannot be replaced (`403`, single and bulk). Upload a new media and repoint the campaign (an approved campaign then returns to `pending_approval`).
  A creative of a draft, paused or cancelled campaign can be replaced; it is checked again if the campaign is approved. **Advertiser link:** `ad_campaigns.advertiser_id`
  is `NOT NULL` with the generated `ON DELETE SET NULL`; the hook refuses deleting an advertiser that has campaigns (`409`) and a direct SQL delete fails on the
  not-null constraint, so campaigns are never orphaned.

**`GET /api/public/advertising`** (anonymous, `credentials: 'omit'`, read-only; HEAD and OPTIONS also answered). Body exactly:
`{ "campaigns": [ { id: "ac_<id>", status: "active", sponsor, alt, destinationUrl, startsAt, endsAt, priority, placements, creatives } ], "adsense": { enabled, reviewed } }`
with `creatives[placement].desktop|mobile = { src, width, height }`. `src` is `<origin of CMS_PUBLIC_URL, else Payload serverURL>/api/media/file/<filename>`, never derived from the request (Host header); with neither
configured and a campaign to deliver the endpoint answers `503` (`no-store`). Production already requires `CMS_PUBLIC_URL`. Times are ISO UTC and `destinationUrl` is
re-validated (https, no credentials) when the response is built.

- **Delivered** only when `status = approved`, `rightsConfirmed`, `paymentStatus` paid/waived (while `ADS_REQUIRE_PAYMENT`) and `startsAt <= now < endsAt`
  (start inclusive, end exclusive, evaluated on the server's clock). Highest `priority` first, then oldest id; at most 100. The object is built from a whitelist:
  advertiser, payment status, approval data, rights flag, notes and contact data are never in the response. A campaign missing a required creative is skipped.
- `adsense.enabled` / `adsense.reviewed` come from `PUBLIC_ADSENSE_ENABLED` / `PUBLIC_ADSENSE_REVIEWED` (only `true`, any case, is true). The CMS never
  serves a publisher id or script.
- **Caching:** `Cache-Control: public, max-age=N`, `N = min(60, whole seconds, rounded down, to the next start or end of an approved, paid campaign)`; 60 when
  there is none. A paused or cancelled campaign can be shown for up to 60 s more (plus CDN delay). `ETag` (content hash) is sent and a forwarded
  `If-None-Match` gets `304`, for CDNs only: the route exposes no response header to cross-origin scripts (no `Access-Control-Expose-Headers`, so the ETag is unreadable) and
  its CORS answer does not list `If-None-Match` as an allowed request header (Payload's wrapper adds its own generic `Access-Control-Allow-Headers`, which does not
  include it), so a cross-origin browser cannot make a conditional request and relies on `max-age`.
  No rate limit, no `429`, no tracking.
- **Origin:** when `Origin` is sent it must be in `PUBLIC_SUBMISSION_ORIGINS` (`403`, `Cache-Control: no-store`); allowlisted origins get an exact
  `Access-Control-Allow-Origin` echo and `Vary: Origin`. No credentials are ever allowed for this route.
- **Media privacy (extends §3 Media read access):** a creative file and its media document are readable anonymously only while a campaign using it is delivered
  (same predicate as above, evaluated per request in SQL through the `ad-campaigns.creativeMedia` relation, so no cache to invalidate). Draft, pending,
  paused, cancelled, not-yet-started, ended and unpaid campaigns keep their creatives private (`403` on the file, `404` on the document). Only the creatives of the
  **selected** placements count.
  - *File route vs feed:* the feed also skips a campaign that is missing a required creative or has a bad address, while the file rule is the SQL predicate
    only. The two differ only for rows written around the hooks (they cannot be created through the API); such a creative file is readable but not advertised.
  - *Caching of the files:* the CMS sets no `Cache-Control` on `/api/media/file/*` (Payload's `modifyResponseHeaders` sees no document, so it cannot tell a creative from
    an article image). A creative file can therefore stay in a browser or CDN cache after its campaign ends, exactly like a public article image after unpublishing
    (§6.3 note on caching). The feed is what stops advertising it; do not put a long-lived shared cache in front of `/api/media/file/*` without revalidation.

Environment: `ADS_REQUIRE_PAYMENT`, `PUBLIC_ADSENSE_ENABLED`, `PUBLIC_ADSENSE_REVIEWED`. Migration `20261020_144045_ad_campaigns` (tables `advertisers`, `ad_campaigns`,
`ad_campaigns_placements`, `ad_campaigns_rels`, three enums, locked-documents columns); reversible and repeatable (tested).

### Go-live C6: legacy comments archive

Implements `go-live-contracts.md` C6: the approved WordPress comments, read-only, shown under migrated articles. There are no new comments.

**`legacy-comments` collection.** Fields: `article` (relation, required), `authorName` (1 to 120, plain text), `content` (1 to 5,000, plain text),
`commentedAt`, `legacyId` (WordPress comment id, unique), `parentLegacyId?`, `status` (`approved` | `hidden`). **No commenter email, website or IP
exists in the collection**, in any response, or in the audit log; the importer helper drops them before anything is written.
Access: create is refused for every API caller (the importer uses the server-side Local API); update is limited to editors in scope
(admin, editor-in-chief, section-editor for articles in their sections) and, by field-level access, to `status` only (hide or restore, audited as
`legacy-comment.hide` / `legacy-comment.restore`; `article`, text, date and ids cannot be changed, so a comment cannot be moved to another article);
delete is admin only (audited as `legacy-comment.delete`). Anonymous callers (and non-editor staff) only ever read `approved` comments of
`published` articles, also on `GET /api/legacy-comments/:id` and `/count`; a section editor reads those plus every comment of articles in their
sections (the same shape as article read access). `status` is returned to staff only. Anonymous `GET /:id` still returns `createdAt` and
`updatedAt` (harmless import timestamps; they are not hidden).

**`GET /api/legacy-comments?article=<id|slug>`** (anonymous; also HEAD, trailing slash accepted). This collection endpoint replaces Payload's
generic list route on that path, so a caller cannot choose fields, filters or sorting. **The renderer's request form is accepted:**
`GET /api/legacy-comments?where[article][equals]=12&sort=commentedAt&limit=100&page=1&depth=0` is an alias for `article=12`; every other
`where` key, `sort`, `select` and `depth` is ignored (the sort is always `commentedAt`, then `legacyId`, oldest first).

| Query | Meaning |
| --- | --- |
| `article` (or `where[article][equals]`) | numeric value: the article id **first** (if an article has that id, no slug is tried, so `article=2024` never reaches another article's slug); otherwise the slug of a **published** article |
| `articleLegacyId` | alternative to `article`: the WordPress post id (`articles.legacyId`) |
| `limit` | 1 to 100, default 50; larger is clamped to 100; invalid becomes 50 |
| `page` | 1 to 10,000, default 1 |

`200 { docs: [{ id, legacyId, parentLegacyId, authorName, commentedAt, content }], totalDocs, limit, page, totalPages, hasNextPage, hasPrevPage,
nextPage, prevPage }` (`nextPage` and `prevPage` are page numbers or `null`). **`legacyId` is part of the public projection** (with `parentLegacyId`
it is how a client builds threads; neither is private). `content` is plain text with line breaks only. `400` when neither `article` nor
`articleLegacyId` is given (or `articleLegacyId` is not a number); `403` for an `Origin` not in `PUBLIC_SUBMISSION_ORIGINS` (compared
case-insensitively). An unknown or unpublished article is `200` with an empty list (the endpoint does not reveal unpublished slugs).
`Cache-Control: public, max-age=60` (short, so a hidden comment leaves caches quickly; the contract names no value), `Vary: Origin`, exact
`Access-Control-Allow-Origin` echo for allowlisted origins, `OPTIONS` preflight. Errors use `Cache-Control: no-store`.

**Text rules** (`src/lib/legacyComments.ts`): on import, HTML and scripts are stripped, `&amp; &quot; &apos; &nbsp;` and numeric references are
decoded **once** (never `<` or `>`, so output cannot contain markup), control characters, lone surrogates, noncharacters and bidirectional marks
(U+061C, U+200B, U+200E/F, U+202A-E, U+2060-9, U+FEFF) are removed (ZWJ and ZWNJ kept) and the text is cleaned again after decoding. The write hook
and the public output re-clean **without decoding** (so `&amp;lt;` stays `&lt;`) and never re-clean on update. Email addresses typed into the
text (also full-width forms, found on the NFKC-folded text) become `[email removed]`; the pattern is bounded (local part 1-64, domain 1-253,
top-level label 2-63) and runs over the 5,000-character cap plus a margin, then the cap is applied again. A name that is an email address, a
web address (scheme, `www.`) or a bare host name (`example.com`) becomes `Anonymous`, as does an empty name. Length caps cut at a code-point boundary.

**Deleting an article that has archived comments is refused with `409`** (*This article has N archived comments. Archive the article instead,
or ask an admin to delete its comments first.*), by a `beforeDelete` hook on `articles`. Refusing is safer than deleting: the comments are
archive data and the relation is required, so silently removing them for an editor would lose data, and letting the database refuse gave a 500.

**Importer helper** `toLegacyCommentData(wxrComment, articleId)` returns `{ ok: true, data, truncated, dateFromLocal }` or `{ ok: false, reason }`
(`unapproved`, `spam`, `trash`, `pingback`, `trackback`, `other-type`, `bad-id`, `bad-date`, `empty`). Only `comment_approved = 1` with an empty or
`comment` type is kept; the GMT date is preferred. Migration `20261019_230557_legacy_comments` (table, enum, composite index
`(article_id, status, commented_at, legacy_id)` for the public list), reversible (down, up, down is tested). **Production needs a UTF8 database**
(`docs/operations.md`).

### Go-live C8: public search

`GET /api/public/search?q=&page=&limit=&category=&year=` (anonymous, read-only; also HEAD and an OPTIONS preflight). Published articles only: the
search reads a projection table (`article_search`) that holds nothing else, and the endpoint also requires `status = published` and
`publishedAt <= now`, so drafts, in-review, approved, scheduled, archived (withdrawn) and future-dated articles are never returned.

| Query | Meaning |
| --- | --- |
| `q` | required; whitespace-trimmed, control characters and lone surrogates removed; at most 200 characters (`400` when empty, missing or longer) |
| `page` | 1 to 100, default 1 (larger is clamped, invalid becomes 1) |
| `limit` | 1 to 20, default 10 (larger is clamped to `SEARCH_MAX_LIMIT`, default 20, at most 100; invalid becomes 10) |
| `category` | category slug, or its numeric id; matches an article whose primary OR additional category it is (v1.26); an unknown category gives an empty list |
| `year` | four-digit year of `publishedAt` (UTC), 1900 to 2100; anything else is `400` |

`200 { docs: [{ id, slug, title, excerpt, snippet, publishedAt, category: { id, slug, title }, categories: [{ id, slug, title }], rank }], totalDocs, totalCapped, limit, page, totalPages, hasNextPage,
hasPrevPage, nextPage, prevPage }`. **`totalDocs` is capped (v1.23):** counting stops after 1000 matches (`SEARCH_COUNT_CAP`, default 1000), so `totalDocs` is never more than 1000 and `totalCapped: true` means "more than that exist" (read `totalDocs: 1000, totalCapped: true` as "1000+"). `totalPages` is `null` while `totalCapped` is true (the real number of pages is unknown; there is no misleading lower bound), a number otherwise; while capped, `hasNextPage` / `nextPage` stay true as long as the page is full (up to page 100), and a page past the real end returns an empty `docs`. `snippet` is a plain-text extract of the article body around the match (about 30 words, at most 240
characters, no markup: `<` and `>` never appear; JSON-escaped like every field), falling back to the excerpt. The result carries no staff fields.
Order: `rank` descending (title weight A, excerpt B, body C, `ts_rank`), then `publishedAt` descending, then id. Page numbers past the
end return an empty `docs` with the (capped) `totalDocs`. Snippets are cut from the first 20,000 characters of the body.

**Query language.** `q` is parsed by PostgreSQL `websearch_to_tsquery` (never `to_tsquery`), passed as a bound parameter: words are AND-ed,
`"quoted phrases"`, `or` and a leading `-` work, and every other punctuation (`& | ! : * ( )`, quotes) is harmless. A query made only of stop-words or
punctuation returns `200` with an empty list. The raw `q` is not logged.

**Language configuration: `english`**, chosen deliberately: the archive is English-language Nigerian news, stemming lets "elections" find "election",
and stop-words (the, of, and) do not dominate. Names are stemmed identically at index and query time, so they still find themselves. `simple` would
miss plurals. `unaccent` is not used (the extension is not guaranteed in the test cluster or every production image); accented letters therefore
match only themselves.

**Transport.** `Cache-Control: public, max-age=60` on `200` ONLY when exactly one public origin is configured in `PUBLIC_SUBMISSION_ORIGINS`: every `200` then carries that same `Access-Control-Allow-Origin` whatever Origin the request sent, so all responses for a URL are identical and a shared cache cannot replay one caller's grant to another (Cloudflare's default cache ignores `Vary: Origin`; any other Origin gets an uncached `403`, so the cache cannot be poisoned). With none or several configured origins the grant is echoed per request and the response is `private, max-age=60`. Errors: `no-store`; `Vary: Origin` always, `X-Content-Type-Options: nosniff`. `403` for an `Origin` not in
`PUBLIC_SUBMISSION_ORIGINS` (same rule and exact-origin CORS echo as the other public endpoints; `Retry-After` is exposed). Per-client rate limit (the shared in-memory
limiter, same client-address rules): `SEARCH_RATE_LIMIT` (default 60) per `SEARCH_RATE_WINDOW_SECONDS` (default 60), then `429` with `Retry-After`. A database failure is
`500 { ok: false, errors: [{ message }] }`.

**Projection and operations.** Migration `20261023_090000_article_search` creates `article_search` (FK to `articles` with `ON DELETE CASCADE`, a GENERATED weighted `tsv` column, GIN index
on it, and btree indexes on `(category_id, published_at)` and `published_at`) and seeds published articles with title and excerpt only. Articles hooks keep it current on every
create, update (including status changes: any status other than `published` removes the row) and delete, for REST, the scheduler and the importer alike (they all use the Local API
and fire the same hooks). **After the first deploy and after every archive import run `npm run search:reindex`** (`-- --batch 200`): idempotent, keyset-batched, fills body text, and removes rows of
articles that are no longer published. It prints counts only. Plain article text is the Lexical text nodes (embeds and images contribute nothing), capped at 200,000 characters. The table is
hand-written SQL, not a Payload collection: do not run Payload's dev `push` mode against a database that matters (it is already off in production).

## 8. Environment variables

See `apps/cms/.env.example` (annotated) and `docs/operations.md` §4. Secrets (`PAYLOAD_SECRET`, `PREVIEW_SECRET`,
`IP_HASH_SALT`, `TURNSTILE_SECRET_KEY`, `SMTP_PASS`, database password) are server-side only and never committed or
shipped to a frontend. The only value a frontend needs is the public Turnstile **site** key. In production the app
refuses to start without a valid `TURNSTILE_SECRET_KEY`, `TRUST_PROXY=true` (the app always runs behind a reverse
proxy) and https-only `CMS_PUBLIC_URL`/CORS/CSRF settings (`docs/security.md`). Client-address handling for rate
limits: `TRUST_PROXY_HOPS` (default 1) and optional `CLIENT_IP_HEADER` (`docs/operations.md` §4).

## 9. Changelog

### v1.26: Additional categories on articles
Additive. `articles.categories` (relationship hasMany to categories, optional, max 5, never the primary, no duplicates) next to the unchanged
required primary `articles.category` (section 3, "Additional categories"). Public article reads, the preview projection and `GET /api/articles?where[categories][in]=`
expose it; the C8 search `category=` filter matches primary OR additional, and each search hit gains `categories: [{ id, slug, title }]` (additional only, in
stored order, empty when none; the primary stays in `category`). `categories` joins the numeric relationship filters (`400` on a non-numeric value).
- **Migration** `20261027_115905_article_multi_category`: join-table column `categories_id` on `articles_rels` and `_articles_v_rels` (FK ON DELETE CASCADE, indexed) and `article_search.category_ids integer[]` (primary first, GIN indexed, backfilled from `category_id`). Run `npm run search:reindex` once after deploying to fill the additional ids of existing published articles (idempotent). Reversible, every statement `IF [NOT] EXISTS`.
- **Importer:** the other WordPress categories of a post (up to 4 beyond the primary chosen by the existing chain) are stored in `categories`; see `docs/import.md`. Rollback is unchanged: join rows go with the articles, and a category an unlisted article still uses (primary or additional) is kept.

### v1.25: Larger image cap
Non-breaking relaxation; no shape changes. The image size cap rises from 10 MB to **25 MB by default** and is configurable with `MEDIA_IMAGE_MAX_MB` (whole MB, 1 to 50; unset or invalid gives 25). It applies to `POST/PATCH /api/media` (`413` above it, message states the limit), the legacy importer and `import:uploads-check` (`too-large`). The 40 megapixel decode limit and the sharp re-save are unchanged (peak memory for a ~23 MB / 40 MP JPEG measured at about 680 MB RSS). `/api/media` request limit: anonymous callers stay at 11 MB; callers with a VERIFIED session get max(image cap, explicit `MEDIA_AV_MAX_MB`) + 1 MB (26 MB by default; `MEDIA_UPLOAD_MAX_MB` still overrides). Next's body buffer follows (limit + 1 MB). The reverse proxy `/api/media` limit must be at least staff limit + 2 MB (28 MB by default, operations.md 4.4).

### v1.24: Staff related articles
Additive: new endpoint `POST /api/staff/related-articles` (section 6.4); no existing shape changes.
- Request bodies are read as a stream and refused with `413` as soon as they exceed 256 KiB measured in **bytes** (not characters), without buffering the remainder. The headline snippet is computed over the first 20,000 characters of an article body only.

### v1.23: Review follow-ups (preview, search cost, upload limits, review rules)
Additive except where a rule is tightened (listed first); the search response only gains a field.
- **Preview** (`GET /api/preview/articles?token=`): the response never contains `provenance`, `legacyId` or `legacyUrl` (nor, as before, `reviewNotes`, `author`, `scheduledFor`, `bodyMedia`).
- **Approve and publish are separate requests.** A recovered archive article (`provenance.importBatch` set) cannot be approved (`provenance.reviewStatus` becoming `reviewed`) and published or scheduled in the SAME write by a non-admin: `409` (also for bulk `PATCH ?where=`). Clients cannot clear or change `importBatch` (server-owned, ignored on write), so the rule cannot be dodged that way. **Admins are exempt** from the one-write rule (their approval is still audited as `archive.review`). A four-eyes rule (the reviewer and the publisher must be different people) is NOT implemented: it is an open owner decision. `provenance.reviewStatus` is refused (`400`) on an article without an import batch, and an article created already `reviewed` or `rejected` writes an `archive.review` row at creation. `restoreVersion` never changes `provenance`: the stored provenance wins over the old snapshot, so restoring cannot turn a `rejected` article back into a publishable one (the 409 publish guard then applies).
- `PATCH` with `"provenance": null` is treated as "not sent" (it used to be a 500).
- **Search:** new `totalCapped` field and the capped `totalDocs`, `totalPages: null` while capped (see "Go-live C8"); `SEARCH_MAX_LIMIT` default lowered from 50 to 20 (env `SEARCH_MAX_LIMIT`, 1 to 100); `SEARCH_COUNT_CAP` (default 1000); `Cache-Control` is `public` only when one public origin is configured (identical ACAO on every response), else `private`.
- **Request size (`src/proxy.ts`):** a write (`POST`/`PATCH`/`PUT`) to ANY `/api/*` route with a `Transfer-Encoding` header (a chunked body, which cannot be size-checked) is refused with `411`; a bodyless POST (no `Content-Length`, no `Transfer-Encoding`) is fine. `/api/media`: 11 MB for everyone, except that a caller with a VERIFIED session (a genuine, unexpired Payload JWT in the `payload-token` cookie or `Authorization: JWT`; merely sending such a header does not count) gets the configured larger limit, but only when one is configured: `MEDIA_UPLOAD_MAX_MB` (11 to 500) if set, else max(image cap, `MEDIA_AV_MAX_MB` when set explicitly) + 1 MB (26 MB by default since v1.25). Next's body buffer is that + 1 MB (27 MB by default) (`MEDIA_AV_MAX_MB` alone still sets the per-file audio/video cap, default 100). Next reads the body (up to `proxyClientMaxBodySize`) before the proxy runs, so the reverse proxy must enforce the real limits per location (operations.md 4.4); this is the second layer.
- **Audio/video legacy `sourceUrl`:** only `https:` addresses on an allowed host (`CMS_PUBLIC_URL`, `LEGACY_SITE_HOSTS`, the known old-site names) or a root-relative `/wp-content/uploads/...` path; any other root-relative path and plain `http:` are refused (400), and so are percent-encoding and backslashes in the path. Transcript links are unchanged. The importer upgrades `http://` and protocol-relative addresses on allowed hosts to `https:` and drops the rest.
- **Import tooling:** `import:rollback --force` never deletes a published article or one with `provenance.reviewStatus = reviewed` (skip code `published-or-reviewed`) unless `--include-published` is also given. CSV files the importer, link audit and categorisation eval write prefix cells starting with `=`, `+`, `-`, `@`, tab or CR with a single quote.
- No migration. (`articles.category_id` is NOT NULL in the database, so a published article without a category cannot exist and the search projection needs no change for it.)

### v1.22: Archive review audit entry
Additive; no request or response shape changes.
- Every change of `articles.provenance.reviewStatus` (an editor approving or rejecting a recovered archive draft in the newsroom's Archive review screen, or in the admin) writes an audit row: `action: "archive.review"`, `collection: "articles"`, `docId`, `actor` / `actorIdSnapshot` / `actorRole` (who), `createdAt` (when), `toStatus` (the article status, unchanged), `details: { from, to }`. The summary holds the article title only, never the source address or hash. Rows are readable by editor-in-chief and admin (existing `audit-logs` rule). A write that leaves the review status unchanged writes no row. No migration (`audit-logs.action` is free text).
- Access rule restated and tested: `provenance.reviewStatus` is writable by `admin`, `editor-in-chief` and `section-editor` (the latter only on articles the existing collection rules let them update, i.e. their sections). Reporters, trusted publishers and anonymous callers cannot change it (refused or ignored); the 409 publish guard of v1.21 is unchanged. Rejecting leaves the article a draft.
- Newsroom client use: list `GET /api/articles?where[provenance.importBatch][exists]=true&where[provenance.confidence][equals]=...&where[provenance.reviewStatus][equals]=...&where[provenance.importBatch][equals]=...` (staff only; counts via `limit=1` and `totalDocs`), decide with `PATCH /api/articles/:id` `{"provenance":{"reviewStatus":"reviewed"|"rejected"},"expectedUpdatedAt":"..."}`.

### v1.21: Archive-candidate provenance on articles
Additive; no existing response shape changes (a new staff-only field) and one new write rule.
- New `articles.provenance` group: `sourceUrl`, `sourceHost`, `captureTimestamp`, `originalDate`, `sourceSha256`, `confidence` (`partial` | `citation-only` | `missing`), `importBatch`, `reviewStatus` (`pending` | `reviewed` | `rejected`). **Staff-only**: absent from every anonymous response (list, by id, published or not) and from public projections; anonymous queries filtering on it return nothing or are refused (400). All fields are server-owned (set by the importer) except `reviewStatus`, which editor roles may change (`PATCH /api/articles/:id` with `{"provenance":{"reviewStatus":"reviewed"}}`); other callers' attempts are ignored or denied.
- **Write rule (409):** an article whose `provenance.importBatch` is set cannot be given status `published` or `scheduled` (create or update, any caller including the scheduler, seed and importer) while `provenance.reviewStatus` is not `reviewed`.
- New command `npm run import:archive-candidates` (dry run by default) creating draft-only articles from `archive-candidate/1` JSON Lines files; format in `docs/archive-candidate-schema.md`, behaviour in `docs/import.md` ("Archive candidates"). `import:rollback` recognises these articles by `provenance.importBatch`.
- Migration `20261023_143703_archive_candidate_provenance` (columns, enums, three indexes on `articles` and `_articles_v`; `down` uses `IF EXISTS`).

### v1.20: Go-live C8 public search
Additive; no existing response changes.
- New `GET /api/public/search` (see "Go-live C8: public search"), migration `20261023_090000_article_search`, Articles hooks that maintain the projection, and `npm run search:reindex`.
- New environment variables `SEARCH_RATE_LIMIT` and `SEARCH_RATE_WINDOW_SECONDS`.

### v1.19: Audio/video article block (self-hosted media)
Additive; YouTube/Vimeo/other-site handling is unchanged.
- New Lexical block `audioVideo` (`kind`, `media`, `sourceUrl`, `poster`, `title`, `caption`, `transcriptUrl`, `duration`) accepted in `articles.content`; validation, `bodyMedia` derivation and the public projection are described in §2 "Audio/video block".
- Media accepts `video/mp4`, `video/webm`, `audio/mpeg`, `audio/mp4`, `audio/ogg` (magic bytes verified, size cap `MEDIA_AV_MAX_MB`, default 100 MB); images keep their rules and the image cap (25 MB by default since v1.25). No other type, and never SVG or HTML.
- Importer: `<video>`, `<audio>`, `<source>`, `[fvplayer]`, `[video]`, `[audio]` map to the block; unresolved files keep the legacy address and are counted as `unresolved-media` in the run report (`content.avUnresolvedMedia`). Rollback is unchanged: created Media and articles are already in the manifest.
- `articles.featuredImage` must now be a JPEG/PNG/WebP image (`400` otherwise; audio/video Media is for the block only). The importer counts an audio/video featured attachment as a missing featured image.
- Opt-in `MEDIA_UPLOAD_MAX_MB` (11 to 500) raises the `/api/media` request limit only (default unchanged at 11 MB); the reverse-proxy cap must be raised with it, see operations.md section 4.4.
- No database migration (blocks live inside the Lexical JSON; `media.mime_type` is free text).

### v1.18: Articles live at `/{slug}/` (owner decision D1)
**Behaviour change** for the default of `PUBLIC_ARTICLE_PATH_TEMPLATE` (C7, O1) and for slug validation; no response shape changes.
- `PUBLIC_ARTICLE_PATH_TEMPLATE` now defaults to `/{slug}/` (was `/reports/{slug}/`); `/reports/{slug}/` stays an accepted value; anything else stops startup. The public host must read the same value.
- C7: with `/{slug}/` the WordPress address and the new address of an imported post are identical, so `GET /api/public/redirects` emits no rule for it (`sameAddress`). Rules remain only for genuine changes: slug renames made by the slug-lock feature, old-host or dated permalinks, and `?p=N` (resolved by the public host through `legacyId`).
- Slugs equal to a reserved route name (`admin`, `api`, `newsletter`, `contact`, `search`, `category`, `tag`, `feed`, `sitemap`, `wp-content`, `wp-admin`, `wp-json`, ... see `src/lib/reservedSlugs.ts`) are refused on write (400) while the template is `/{slug}/`; a generated slug that would collide gets `-2`; the importer gives a colliding post its `-<wp id>` slug and counts it (`articles.slugRenamedReserved`); `resolveSlugCollisions` treats reserved names as taken.
- The importer's link rewriting now defaults to the configured article path (`/{slug}/`) instead of `/article/<slug>`.
- Test vectors for root article paths added to `tests/fixtures/redirect-normalisation.json` (`rootArticlePath`).

### v1.17: Newsletter consent hardening (NDPA)
**Behaviour change** for the subscriber import and subscriber staff access; no public response changes (subscribe, confirm and unsubscribe answers are byte-identical to v1.14).
- Import: rows with no valid `OPTIN_TIME` are stored `pending` (previously `confirmed`) and excluded from sends and the confirmed export; `confirmedAt` comes from `CONFIRM_TIME` only
  (previously `CONFIRM_TIME ?? OPTIN_TIME`); times must be exactly `YYYY-MM-DD HH:MM:SS` UTC (previously other date formats were parsed); unsubscribed and cleaned exports are imported as blocking rows
  (previously refused); an `--apply` run is audited. Confirming an imported `pending` row records fresh consent.
- New server-side commands `npm run newsletter:reconfirm` and `npm run newsletter:purge-unconfirmed`; new consent version `mailchimp-reconfirm-v1`.
- `/api/subscribers` read and update are now `admin` only (was admin and editor-in-chief); staff status changes are audited and set `unsubscribedAt`; new `GET /api/subscribers/:id/subject-data`.
- No migration (existing enum values and columns are reused).

### v1.16: submission consent
Additive. `POST /api/public/submissions` accepts optional boolean `consent` (non-boolean → 400 field `consent`) and `consentTextVersion`.
When `consent` is `true` the CMS stores `submissions.consentAt` (server time, never client-supplied) and `consentTextVersion`; both are readable by
staff only. New env `SUBMISSIONS_REQUIRE_CONSENT` (default `false`): when `true`, a missing or false `consent` is a 400 on field `consent`.
Migration `20261021_110000_submission_consent` (nullable columns). Submitter `email`/`phone` stay readable by every editor role (admin,
editor-in-chief, section-editor): the newsroom review queue displays them and verifying a tip needs them. Restricting them to editor-in-chief/admin is a
product decision recorded here, not made.

### v1.15: Go-live A12 legacy media map
Additive, no schema change. New offline command `npm run export:media-map` and the `media-map/1` file format (§ "Go-live A12: legacy media map (offline export)"). No new HTTP route; media read access is unchanged.

### v1.14: Go-live C3 advertising
Go-live contract C3 (advertising). Additive, except that approving an ad campaign through the API requires `expectedUpdatedAt` (new collection, no existing client).
- New staff collections `advertisers` and `ad-campaigns` (admin and editor-in-chief only) with the approval and payment gate, creative checks and audit rows
  (§ "Go-live C3: advertising"); new anonymous `GET /api/public/advertising` (`max-age = min(60, seconds to next boundary)`, ETag for CDNs, Origin allowlist,
  creative links from `CMS_PUBLIC_URL`/`serverURL` only).
- Media read access (§3) gains one more public case: the creative of a delivered campaign. The file of a creative of an approved or pending campaign cannot be
  replaced by any role; media details of approved creatives are frozen for non-editors (§6.3).
- New environment values `ADS_REQUIRE_PAYMENT`, `PUBLIC_ADSENSE_ENABLED`, `PUBLIC_ADSENSE_REVIEWED`. Migration `20261020_144045_ad_campaigns`.

### v1.13: Go-live C6 legacy comments
Go-live contract C6 (comments archive). Additive.
- New collection `legacy-comments` (no email, website or IP stored; create refused over the API; editors may only hide or restore, admin deletes; audited).
- New anonymous `GET /api/legacy-comments?article=<id|slug>` (alias `where[article][equals]=`, also `articleLegacyId`), plain text, `limit` capped at 100,
  `nextPage`/`prevPage`, `Cache-Control: public, max-age=60`, origin allowlist (now compared case-insensitively, shared with the other public endpoints).
  It replaces Payload's generic list route on that path. `legacyId` is in the public projection.
- **Behaviour change:** deleting an article that has archived comments is `409` (see "Go-live C6").
- Importer helper `toLegacyCommentData`; migration `20261019_230557_legacy_comments` (reversible, composite index). Test database is now created as UTF8;
  production needs a UTF8 database.

### v1.12: Go-live C4 newsletter
Additive, no breaking change for existing clients. 
- New `POST /api/public/newsletter/subscribe`, `/confirm`, `/unsubscribe` (+ preflights, 405 for other methods), staff-only collection `subscribers`,
  `GET /api/subscribers/export`, `POST /api/subscribers/:id/erase`, CLI `npm run import:subscribers` (see "Go-live C4: newsletter" in §4).
- New environment variables `PUBLIC_SITE_URL`, `NEWSLETTER_TOKEN_SECRET`, `NEWSLETTER_RATE_LIMIT`, `NEWSLETTER_RATE_WINDOW_SECONDS`, `NEWSLETTER_TOKEN_RATE_LIMIT`.
  **Operational change:** production startup now also requires `NEWSLETTER_TOKEN_SECRET` (32+ characters, distinct from the other secrets) and rejects a
  malformed or non-https `PUBLIC_SITE_URL`; the loopback-only disposable staging stack (`CMS_ALLOW_INSECURE_LOCAL_STAGING`) is exempt and derives a throw-away key.
  `TURNSTILE_EXPECTED_ACTION` must also list `newsletter-subscribe` when set.

### v1.11: Go-live C5 contact
Additive, no breaking change. 
- New `POST /api/public/contact` and `OPTIONS` preflight (see "Go-live C5: contact" in §4). New staff-only collection `contact-messages`.
- New environment variables `CONTACT_RATE_LIMIT`, `CONTACT_RATE_WINDOW_SECONDS`, `CONTACT_NOTIFY_TO`. `TURNSTILE_EXPECTED_ACTION` must
  now also list `contact-message` when it is set.
- New shared helper `src/lib/publicEndpoint.ts` (origin, CORS, body cap, error shape, per-endpoint Turnstile action pin) for new public endpoints;
  `POST /api/public/submissions` is unchanged.

### v1.10: Go-live C7 redirects
Go-live contract C7 (redirects). Additive.
- New staff collection `redirects` (§ "Go-live C7: redirects"), new anonymous `GET /api/public/redirects` (ETag, 304, `max-age=300`),
  pure canonical-path module shared with the public host, derived rules from `legacyUrl`, and the commands `export:redirects`,
  `check:redirects`, `import:redirects`.
- New environment values `PUBLIC_ARTICLE_PATH_TEMPLATE`, `REDIRECT_ALLOWED_HOSTS` and `LEGACY_SITE_HOSTS`; an invalid value stops startup.
- Migration `20261017_095306_redirects`; no existing endpoint or field changed.

### v1.9: Go-live C1
Legacy content shapes (CMS side), see "Go-live C1: legacy content shapes" in §3. Additive: `youtubeEmbed` block and table feature on
`articles.content`; any other embed is `400`; staff-only `media.legacyPath` (migration `20261016_110618_media_legacy_path`: one nullable
indexed column, reversible); pure importer helpers. The archive importer (#19) is not changed here and must switch from raw `embed`
nodes to `youtubeEmbed` blocks before it can write to this CMS.

### v1.8
Go-live contract C2 (SEO fields). Additive, no breaking change.
- New optional article fields `seoTitle` (≤ 70) and `seoDescription` (≤ 200): plain text, sanitised, `null` when unset, public on published
  articles, no template variables, not a material change for corrections (§2, §3). Migration `20261016_094708_article_seo_fields`
  adds four nullable columns (two on `articles`, two on its versions table); reversible.
- The rest of the go-live contracts (C1, C3 to C7) are still **proposed** in `go-live-contracts.md`.

### v1.7
Review round 3. Additive.
- Preview tokens also open the images of that article (§4.4); the preview payload no longer contains `bodyMedia` or any staff-only media field.
- Media reads no longer evaluate the access-only join fields (`joins: false` in `beforeOperation`); the media file route still evaluates them once per file hit.
- Replacing the file (or changing the alt text) of a media used by an approved live update re-delivers that update to pollers (new
  `publishSequence`, new `image.url`), like an edit of its image (§4.3).
- `live-events.endedAt` is re-stamped on every move to `ended` and cleared while `live`/`draft` (§3).
- A multipart media upload or replacement whose `alt` is present but empty/blank/longer than 300 characters (or, on create, missing) is `400`
  *Alt text is required and must be 1 to 300 characters.* before any file is touched, so a refused replacement keeps the old file (§6.3).
- Docs: order of `expectedUpdatedAt` checks (§6.1).

### v1.6
Security follow-ups (review findings M3 and L2). Additive for correct clients; **media read access is a behaviour change**.
- **Media privacy (M3).** `media.read` = any staff role, OR the media is the `featuredImage` / a `bodyMedia` image of a `published` article,
  OR the image of an `approved` update of a `live`/`ended` event. Everything else (drafts, in review, approved-unpublished, **scheduled**,
  archived, pending/rejected updates, unreferenced uploads) is `404` on `GET /api/media[/:id]` / omitted from the list and `403` on
  `GET /api/media/file/<name>` including size variants, for anonymous callers. Implemented as an access Where over three virtual
  `join` fields on `media` (`publishedAsFeatured`, `publishedInBody`, `liveUpdateImages`; never returned, no migration, uses existing
  indexes). Published article responses still populate their media for anonymous readers. See §3 Media and §6.3.
- **Approve what you saw (L2).** Optional `expectedUpdatedAt` on `PATCH /api/articles/:id` and `PATCH /api/live-updates/:id`:
  `409` *This item changed after you opened it. Reload and review it again.* when the stored `updatedAt` differs; never stored (§6.1, §6.2).
- Server-side attachment checks (`assertAttachableImage`) read the media with the caller's access only for authenticated callers; trusted
  server calls (seed, scheduler) read it as the system.

### v1.5
Follow-ups, additive, no breaking changes.
- Live-update photos in the public feed are the ~800 px `card` variant (url, width, height, mimeType of the variant), falling back to the
  original when there is none (§4.3).
- `live-events.startedAt` / `endedAt` are server-stamped for every non-draft status (§3); migration
  `20261014_221500_live_events_started_at_backfill` (data only, no schema change).
- Every 429 now carries `Retry-After` and `Access-Control-Expose-Headers: Retry-After`: also the per-IP login / forgot-password /
  reset-password limits (they used to send neither). See "429 and `Retry-After`" in §7.

### v1.4
Optional photo on live updates. Additive, no breaking changes.
- `live-updates.image` (upload → `media`); validation, edit rules and audit in §6.2. Public feed docs gain `image` (§4.3).
- Existing feed consumers that ignore unknown keys are unaffected; consumers that assert the exact key set must add `image`.
- Media of an approved live update is frozen for non-editors, like media of a published article (§6.3).
- Migration `20261014_203617_live_update_image` (`live_updates.image_id` + FK to `media` with `ON DELETE SET NULL`, index).
- `image` and `bodyMedia` are accepted as relationship filter names (numeric ids only), see §4.2.
- **Review fixes (same version):** body images are validated and frozen after publication (§2, §6.3, new server-owned
  `articles.bodyMedia`, migration `20261014_211527_article_body_media`, which also backfills it from existing bodies); an edit
  of the body or image of an approved live update re-stamps `publishSequence` so pollers receive it (§4.3; **clients must
  replace by `id`**); media read access and media-delete behaviour are documented as limitations (§4.3, §6.3).

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
- **Request size limits**: `413` / `411` / `400` from `src/proxy.ts` (§7). Proxy cap 28 MB (operations §4.4).
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
