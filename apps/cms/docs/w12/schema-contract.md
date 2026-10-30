# Waves 1-2 schema and API contract (Agent B)

Status: implemented on `agent/wave12-integration` (one migration, `20261030_090102_w12_newsroom_giving`). This is the
contract Agents A, C, D and E code against. Plan: `apps/cms/docs/w12-plan.md` section 4. Field names below are exact.

Conventions used everywhere below:
- All public reads are anonymous. A logged-in cookie never widens a public endpoint (they read as an anonymous caller).
- "Card" = the subset of a `GET /api/articles?depth=1` document listed in section 3.1. It has the same keys and shapes
  as the REST document, so `normalizePublishedArticle()` (`src/lib/published-articles.js`) accepts a card unchanged.
- Dates are ISO 8601 strings (UTC) or `null`. Amounts are integers in minor units (kobo, pence, cents).
- Plain text means: no `<` or `>`, no control characters; the server refuses (400) rather than strips.

## 1. Articles (`/api/articles`, existing REST; new fields, all optional)

| Field | Type in JSON | Rules (enforced server-side, 400 otherwise) | Public read |
|---|---|---|---|
| `kicker` | `string \| null` | plain text, trimmed, max 60; `""` stored as `null` | yes |
| `contentType` | `"news" \| "analysis" \| "opinion" \| "sponsored" \| "explainer" \| "factcheck"` | default `"news"`; existing rows were filled with `"news"` by the migration. Treat `null`/unknown as `"news"`. | yes |
| `keyPoints` | `Array<{ id: string, text: string }>` | at most 5 rows; `text` plain text 1-200 (trimmed). `[]` when none. | yes |
| `lastSubstantiveUpdate` | `string \| null` (ISO) | editor-set only, never automatic; not more than 10 min in the future. Show as "Updated <date>" only when set (and after `publishedAt`). | yes |
| `topics` | `Array<number \| TopicRef>` | at most 10, existing topic ids, de-duplicated | yes, see below |
| `bylineAuthor` | `number \| AuthorRef \| null` | an existing author profile id | yes, see below |
| `content` | Lexical JSON | two new block types, section 1.1 | yes |

Unchanged and still relevant: `bylineName` (text fallback byline), `author` (the staff user, staff-only, never public),
`corrections: Array<{ id, correctedAt, note }>` (public), `publishedAt`, `updatedAt`, `featuredImage`.

`readingMinutes` is NOT stored: compute it from the body text, `Math.max(1, Math.round(words / 220))`
(`readingMinutes()` in `apps/cms/src/lib/newsroomFields.ts`).

Population at `depth=1` (what the public site already requests):
- `topics`: populated entries are `TopicRef = { id: number, name: string, slug: string, kind: "topic"|"denomination"|"series"|"ministry", isPublic: true }`.
  A topic that is not public stays a bare number. **Keep only objects with `isPublic === true`; ignore numbers.**
- `bylineAuthor`: `AuthorRef = { id, name, slug, role: string|null, photo: number|null, avatar: Avatar|null, isPublic: true }`
  when the profile is public; a bare number when it is not (fall back to `bylineName`). `bio` and `socials` are NOT
  included here (fetch the author page endpoint).
- `Avatar = { url: string, width: number|null, height: number|null, alt: string, thumbnailUrl: string|null }` (the
  profile photo, already readable by anyone; `thumbnailUrl` is the 400 px size).
- `featuredImage`: the media document, now with `lqip` and the AVIF sizes (section 2).
- At `depth=0` relationships are ids for everyone.

Filtering via REST also works: `GET /api/articles?where[status][equals]=published&where[topics][equals]=<topicId>&depth=1`
and `where[bylineAuthor][equals]=<authorId>`; `where[contentType][equals]=analysis`.

Who may edit (unchanged rules, new fields included): the new fields count as content, so a reporter can only change them
while the story is `draft` / `changes_requested`; reporters still never publish; the archive four-eyes rule is unchanged.
Editing them on a published story does NOT require a corrections entry (only title, excerpt and body do).

### 1.1 New Lexical blocks in `content`

Both are ordinary Payload block nodes (`type: "block"`), siblings of paragraphs in `content.root.children`:

```json
{ "type": "block", "version": 2, "format": "",
  "fields": { "id": "65f0c0ffee", "blockName": "", "blockType": "pullQuote",
              "quote": "We will rebuild this church.", "attribution": "Archbishop A. B." } }
```
- `quote`: plain text 1-400 (required). `attribution`: plain text up to 120, may be absent/empty.

```json
{ "type": "block", "version": 2, "format": "",
  "fields": { "id": "65f0c0ffef", "blockName": "", "blockType": "gallery",
              "images": [ { "id": "6a1", "image": { "id": 12, "url": "/api/media/file/choir.jpg", "alt": "The choir", "caption": "", "lqip": "data:image/webp;base64,...", "width": 1800, "height": 1000, "sizes": { "...": "see section 2" } }, "caption": "The choir at dawn" } ] } }
```
- `images`: 1-12 rows. `image` is the populated media document at `depth >= 1` (a number at depth 0). Use
  `image.alt` as the alt text (always non-empty: the server refuses images without alt). `caption` (plain text up to 300)
  is the story-specific caption; when empty, fall back to `image.caption`.
- Gallery images are body media: they become publicly readable exactly when the article is published.
- Any other unknown block is still refused (400), as are URL-like keys inside these blocks. Render as text, never HTML.

## 2. Media (`/api/media`)

- `lqip`: `string | null`, a base64 `data:image/webp;base64,...` URI of a 16 px blur, at most 1,500 characters. Generated
  by the server on every image upload or file replacement; never client-writable. Older media have `null` until the owner
  runs `npm run media:lqip-backfill` (section 6.1); always render correctly without blur-up.
- New sizes under `sizes` (next to the existing `thumbnail` 400 w, `card` 800 w, `hero` 1600 w webp):
  - `sizes.cardAvif`: `{ url, width: 800, height, mimeType: "image/avif", filesize, filename }`
  - `sizes.heroAvif`: `{ url, width: 1600, height, mimeType: "image/avif", filesize, filename }`
  - Payload never enlarges: when the original is narrower than the size, every key of that size is `null`. Always check
    `url` before using a source. Existing media have no AVIF sizes (all `null`).
- Consumers that pick variants by width (`normalizePublicMedia`) must skip `mimeType === "image/avif"` for the `<img>`
  fallback and use the AVIF sizes only as `<source type="image/avif">`.
- AVIF originals are still refused on upload (JPEG, PNG, WebP only).
- Media visibility (unchanged rule, one addition): the photo of a PUBLIC author profile is public.

## 3. Public endpoints (new; read-only)

Common to all: `GET`, `HEAD`, `OPTIONS`. Origin allowlist `PUBLIC_SUBMISSION_ORIGINS` (other origins 403; no Origin header
is fine). CORS like `/api/public/search`. `Cache-Control: public, max-age=N` when exactly one public origin is configured,
else `private, max-age=N`. Rate limit per IP: `PUBLIC_READ_RATE_LIMIT` (default 120) per `PUBLIC_READ_RATE_WINDOW_SECONDS`
(default 60), shared by these routes: 429 with `Retry-After`. Errors: `{ "ok": false, "errors": [{ "message": "..." }] }`
with 400 (bad `page` / `kind`), 403, 404 (unknown, unpublished or non-public), 429, 500 (no internals).
`page` is 1-50; 20 articles per page.

### 3.1 Card shape

```json
{ "id": 42, "title": "...", "slug": "...", "excerpt": "...", "status": "published",
  "publishedAt": "2026-10-30T08:00:00.000Z", "updatedAt": "...",
  "category": { "id": 3, "title": "News", "slug": "news", "description": null, "...": "category doc" },
  "categories": [ { "...": "category doc" } ],
  "featuredImage": { "...": "media doc incl. lqip and sizes" } ,
  "bylineName": "Ada Okafor", "bylineAuthor": { "id": 7, "name": "Ada Okafor", "slug": "ada-okafor", "role": "Senior Correspondent", "photo": 31, "avatar": { "url": "/api/media/file/ada.jpg", "width": 600, "height": 600, "alt": "Ada Okafor", "thumbnailUrl": "/api/media/file/ada-400x400.jpg" }, "isPublic": true },
  "kicker": "Exclusive", "contentType": "analysis", "lastSubstantiveUpdate": null,
  "topics": [ { "id": 5, "name": "Persecution", "slug": "persecution", "kind": "topic", "isPublic": true } ],
  "legacyUrl": null }
```
In cards `topics` holds only public topics (objects), `bylineAuthor` is an object or `null`, `contentType` is never
null. No `content`, `keyPoints`, `corrections`, staff fields. `featuredImage` may be `null` or a bare id when not readable.

### 3.2 `GET /api/public/authors` (max-age 300)
`{ "docs": [ { "id", "name", "slug", "role", "avatar" } ] }`, public profiles A-Z, at most 200.

### 3.3 `GET /api/public/authors/:slug?page=1` (max-age 60)
```json
{ "author": { "id": 7, "name": "...", "slug": "...", "role": "...", "bio": "plain text, may contain \n",
              "photo": { "...": "media doc" } , "avatar": { "...": "Avatar" },
              "socials": [ { "kind": "x|facebook|instagram|linkedin|website", "url": "https://..." } ], "isPublic": true },
  "articles": [ "Card", "..." ], "page": 1, "totalDocs": 37, "hasNextPage": true }
```
`photo` is `null` when absent. 404 for a non-public or unknown slug. Articles: published, `bylineAuthor` = this profile,
newest first.

### 3.4 `GET /api/public/topics?kind=` (max-age 300)
`{ "docs": [ { "id", "name", "slug", "kind", "description" } ] }`, public topics A-Z, at most 200. `kind` optional
(`topic|denomination|series|ministry`, else 400).

### 3.5 `GET /api/public/topics/:slug?page=1` (max-age 60)
`{ "topic": { "id", "name", "slug", "kind", "description", "isPublic": true }, "articles": [Card], "page", "totalDocs", "hasNextPage" }`.
### 3.5.1 `GET /api/public/topics/:slug/feed.xml` (max-age 300)
RSS 2.0 (`application/rss+xml`) of the latest 20 published articles of a public topic: `title`, absolute `link` and `guid`
on the public site (`PUBLIC_SITE_URL` + the article path template, e.g. `https://churchtimesnigeria.net/<slug>/`),
`description` (excerpt), `pubDate`, `category`, `dc:creator`. Channel link `${PUBLIC_SITE_URL}/topic/<slug>/`. Every value is
XML-escaped. 404 for an unknown or non-public topic, and while `PUBLIC_SITE_URL` is unset.

### 3.6 `GET /api/public/site-trust` (max-age 300)
```json
{ "editorialStandards": { "root": { "...": "Lexical" } } , "ownershipFunding": null,
  "ethicsCorrectionsPolicy": { "root": {} }, "contactEditors": "plain text, may contain \n", "updatedAt": "..." }
```
404 until an editor ticks `published` on the global. Rich text holds headings, paragraphs, lists, quotes, inline
formatting and links only (no uploads, relationships or blocks; unsafe link schemes are refused on save).
Pages: `/about/editorial-standards/` (editorialStandards), `/about/ownership/` (ownershipFunding), `/corrections/`
(ethicsCorrectionsPolicy + the log in 3.7), contact text on all.

### 3.7 `GET /api/public/corrections?page=1` (max-age 60)
`{ "docs": [ { "article": Card, "corrections": [ { "note": "...", "correctedAt": "..." } ] } ], "page", "hasNextPage" }`,
published articles ordered by their latest correction (newest first); each article's corrections newest first.

## 4. New collections

### 4.1 `authors` (REST `/api/authors`)
`name` (text 1-120, plain), `slug` (unique, `^[a-z0-9]+(-[a-z0-9]+)*$`, max 80, generated from the name when empty),
`role` (plain, 120), `bio` (plain, multi-line, 600), `photo` (media id, JPEG/PNG/WebP), `avatar` (virtual, read-only,
see Avatar), `socials` (max 6 rows of `{ kind, url }`, url `http(s)://` max 300), `isPublic` (bool, default **false**).
Access: read = staff all / everyone else `isPublic: true` only; create/update = admin, editor-in-chief, section editor;
delete = admin, editor-in-chief. Separate from staff log-in accounts (`users`).

### 4.2 `topics` (REST `/api/topics`)
`name` (plain 1-80), `slug` (as authors), `kind` (`topic|denomination|series|ministry`, default `topic`),
`description` (plain, multi-line, 400), `isPublic` (default **false**). Same access as authors. Deleting a topic removes
it from articles (FK cascade on the join rows); deleting an author profile sets `bylineAuthor` to null.

### 4.3 `donations` (Agent D; never public)
Fields: `reference` (text, unique, max 64, server-generated by D), `provider` (`paystack|flutterwave`), `amountMinor`
(integer 1..10,000,000,000), `currency` (`NGN|USD|GBP|EUR`), `status` (`pending|succeeded|failed|abandoned`, default
`pending`), `channel` (text 40), `cause` (`general|relief|ministry`, default `general`), `email` (254), `name` (120),
`anonymous` (bool), `consentAt`, `receiptSentAt`, `providerRef` (text 120, indexed), `paidAt`, plus `createdAt`/`updatedAt`.
- REST: no create and no update for anyone (403); read = admin and editor-in-chief; `email`, `name`, `providerRef` are
  readable by admin only; delete = admin only (retention).
- D writes ONLY through the Local API with `overrideAccess: true` (`payload.create/update({ collection: 'donations', ... })`).
  Look rows up by `reference` (unique index). Never store card data or provider payloads.
- Retention (for D's doc): keep succeeded rows as long as the accounting rules require (7 years is the usual
  Nigerian/UK book-keeping period, confirm with the owner); `pending`/`abandoned` rows older than 90 days can be deleted by
  an admin; personal fields (`email`, `name`) may be blanked earlier on request.

### 4.4 `newsletter-issues` (Agent E; never public)
`date` (required), `subject` (plain 1-150), `status` (`draft|sending|sent|failed`, default `draft`), `bodyText`, `bodyHtml`
(each max 200,000), `sentCount`, `failedCount` (numbers, default 0), `capApplied` (bool), `lastError` (text 500).
- REST: read = admin, editor-in-chief, section editor; create = nobody (403); update = admin / editor-in-chief, `subject`
  only, and only while `status = draft` (every other field is server-owned and silently kept); delete = admin /
  editor-in-chief for `draft` or `failed` issues.
- E writes through the Local API with `overrideAccess: true`. A dry run writes a `draft`.

## 5. Globals (REST `/api/globals/<slug>`; read via Local API `payload.findGlobal({ slug, overrideAccess: true })`)

### 5.1 `giving-settings` (Agent D)
`enabled` (bool, default false), `provider` (`paystack|flutterwave`, default `paystack`),
`currencies: Array<{ id, currency: "NGN"|"USD"|"GBP"|"EUR", presets: number[] (minor units, at most 6), minimum: number, maximum: number, label: string|null }>`
(each currency once; `minimum <= maximum`; every preset within range; all integers >= 1),
`causes: Array<{ id, key: "general"|"relief"|"ministry", label: string, enabled: boolean }>` (each key once),
`thankYouNote`, `bankTransferNote` (plain, multi-line, 1000). Read: admin, editor-in-chief. Update: admin. No secrets
here. `GET /api/public/giving/settings` (D) must expose public-safe fields only.

### 5.2 `newsletter-settings` (Agent E)
`enabled` (false), `dailyDigestEnabled` (false), `sendHourLagos` (0-23, default 6), `dailySendCap` (0-10,000, default 100;
the hard stop), `fromName` (plain 80), `replyTo` (e-mail), `maxStoriesPerDigest` (1-20, default 6), `includeDevotional`
(false). Read: editor roles. Update: admin, editor-in-chief.

### 5.3 `site-trust` (Agent A)
`published` (false), `editorialStandards`, `ownershipFunding`, `ethicsCorrectionsPolicy` (Lexical rich text, text-only
features), `contactEditors` (plain, multi-line, 1000). Read: staff (public via 3.6). Update: admin, editor-in-chief.

## 6. Migration

`20261030_090102_w12_newsroom_giving` (generated, then edited, see its header). Additive only: new tables, nullable
columns, `articles.content_type` with `DEFAULT 'news'`, new FKs (`SET NULL` for byline profile and author photo,
`CASCADE` for topic join rows). `down` is idempotent (`IF EXISTS`). The `.json` snapshot is complete again: the previous
snapshot (`20261027_140000`) had lost the four-eyes columns added by the hand-written `20261027_124620`, so the next
`migrate:create` will not try to re-add them.

### 6.1 Operations

- `npm run media:lqip-backfill [-- --dry-run] [-- --batch 200]` (apps/cms): adds `lqip` to existing images from their files
  in the media folder. Idempotent, counts only, writes only that column (no hooks, no audit noise). Run once after the
  deploy and after an archive import. AVIF sizes are NOT backfilled: older media keep only their webp/original sizes.
- AVIF encoding runs on every new image upload and import (`effort: 2`); expect each image upload to take noticeably longer
  than before (about a second for a large photo on a small VPS).
- `GET /api/donations/export?status=&from=YYYY-MM-DD&to=YYYY-MM-DD`: CSV of the giving ledger (admin and editor-in-chief;
  `name`, `email`, `providerRef` columns for admins only; formula-injection safe; audited as `donation.export`; at most
  50,000 rows). Linked from the admin list view of Donations.

## 7. New environment variables

- `PUBLIC_READ_RATE_LIMIT` (default 120) and `PUBLIC_READ_RATE_WINDOW_SECONDS` (default 60): per-IP limit of the section-3
  endpoints. Optional.
- `PUBLIC_SITE_URL` (existing, newsletter links): also enables the topic RSS feed (3.5.1).

## 7.1 Newsroom app (apps/newsroom)

The story editor has a **Story details** box (kicker, story type, author profile, "Updated" date with Now/Clear, key
points one per line, topic chips) and two body blocks written as their own line: `>> Quote -- Attribution` (pullQuote) and
`[gallery](media:12,13)` (gallery, toolbar button adds the picked image to the gallery line under the cursor). Gallery
captions and block names are edited in the CMS admin; a body holding them opens read-only in the newsroom (as with other
blocks it cannot represent). Topics and author profiles come from `GET /api/topics` and `GET /api/authors` as the staff
user (non-public entries are marked). Mapping: `apps/newsroom/src/story-meta.js`, blocks: `apps/newsroom/src/lexical.js`.

## 8. Questions

Agent B is reviewer-of-record for CMS-side questions; check this file on the integration branch first.
