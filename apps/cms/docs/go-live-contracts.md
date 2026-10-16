# Go-live contracts for the CMS (proposed, v2.0 draft)

Status: **PROPOSED. Nothing in this file is implemented.** It is the written contract that the public site (Codex lane) and the
CMS (Claude lane) agree before either builds, as required by [go-live-build-spec.md](../../../docs/go-live-build-spec.md)
section 5. It is additive over [api-contracts.md](api-contracts.md) v1.7. When an item lands, its section moves into
`api-contracts.md` with a version bump and this file records it as implemented.

Covers CMS items **C1** (legacy content shapes), **C2** (SEO fields), **C3** (advertising), **C4** (newsletter), **C5**
(contact), **C6** (comments archive) and **C7** (redirects). Owner decisions D1 to D8 are in the build spec; where an item
depends on one, the **default** is written here and marked.

No production, DNS, hosting, AdSense or live-WordPress change, no deploy and no secret is part of this document. All values in
examples are synthetic (`example.test`).

## 0. Conventions shared by every public endpoint below

These repeat the rules of `POST /api/public/submissions` (api-contracts §4.1) so new endpoints behave the same way.

- **Anonymous and credential-free.** Called with `credentials: 'omit'`. They never return staff-only data.
- **Origin.** If `Origin` is sent it must be in `PUBLIC_SUBMISSION_ORIGINS` (403). Allowlisted origins get an exact
  `Access-Control-Allow-Origin` echo and `Access-Control-Expose-Headers: Retry-After`.
- **Content type and size.** JSON only (415 otherwise). Declared or actual body above the endpoint's cap is 413.
- **Turnstile on every anonymous write.** `turnstileToken` (or `cf-turnstile-response`) is required, verified server-side
  (fail closed, 5 s timeout), single use. Each endpoint has its own **action** string; the CMS's `TURNSTILE_EXPECTED_ACTION`
  list must include it and the public build sends it as the widget action. Secrets never leave the server.
- **Honeypot.** A non-empty `website` field returns the normal success response and stores nothing.
- **Processing order** (each step can end the request): origin, content type, size, per-IP rate limit, body read and JSON
  parse, honeypot, validation and sanitising, Turnstile, duplicate or per-address checks, write. Rate limiting runs before
  Turnstile so bots cannot burn Siteverify quota.
- **Rate limits** use the existing limiter (`lib/rateLimit.ts`, in-memory per process: correct for the planned single CMS
  host; a second instance needs a shared store). Every 429 carries `Retry-After` and exposes it.
- **Errors** use `{ "ok": false, "errors": [{ "field"?, "message" }] }` with the usual 400, 403, 409, 413, 415, 429.
- **Privacy.** Raw IP addresses are never stored (salted SHA-256 via `IP_HASH_SALT`, as for submissions). Text is stripped of
  control characters and HTML tags. Unknown request fields are ignored; server-owned fields cannot be set by a client.
- **Staff-only collections** are never readable anonymously. Their access follows the roles in api-contracts §1.
- **New environment variables** are server-side only and are listed per section. Only the public Turnstile **site** key and
  the public `VITE_*` values are visible to a browser.

## C1. Legacy content shapes (answers the open items in the public legacy-rendering notes)

The public renderer already handles standard serialized Lexical: paragraphs, h2 to h4, quotes, lists, links, uploads and
tables (`table` > `tablerow` > `tablecell`, `headerState` 1/2, `colSpan`/`rowSpan` up to 20). The import writes **only**
those shapes plus the two below. Everything else is converted to plain paragraphs or dropped and listed in the editorial QA
report. Raw HTML is never stored.

### C1.1 Embedded video (YouTube only)

The archive importer (#19) currently emits `{ type: 'embed', embedType, url }` with the **raw iframe source**. That shape is
**not accepted** by this contract: it is not a registered editor node (the admin editor could fail to load such a body) and it
stores arbitrary third-party URLs. The replacement is a registered Lexical block:

```json
{ "type": "block", "version": 2, "format": "",
  "fields": { "blockType": "youtubeEmbed", "id": "<block id>", "videoId": "dQw4w9WgXcQ", "title": "Optional short title" } }
```

- `videoId` is exactly 11 characters from `[A-Za-z0-9_-]`. Anything else is rejected by validation (400 on write, report entry
  on import). The URL is rebuilt by the renderer, never stored.
- The renderer builds `https://www.youtube-nocookie.com/embed/<videoId>` and loads it **only after the reader's consent and
  with the host's CSP allowing exactly that origin**. (The exact `version` number is whatever Payload's block feature writes;
  the contract fixes `blockType`, `videoId` and `title`, not the wrapper.) Until then it shows a labelled link to the video. This is a public-site
  (P10) decision; the CMS only guarantees the data shape.
- Any other iframe or embed (Facebook, Twitter/X, Vimeo, unknown) is converted to a paragraph that holds the original link
  text when it is a safe `https:` link, otherwise dropped, and always listed in the QA report for an editor.
- Implementation note for the CMS lane: this needs the Lexical `BlocksFeature` registered on `articles.content` and the same
  validator that guards body images (`lib/lexicalMedia.ts` pattern). Until it lands, the importer must emit the paragraph
  fallback, not `embed`.

### C1.2 Legacy images and `/wp-content/uploads/*` paths

- Imported images become `media` documents (JPEG, PNG or WebP with alt text, same rules as new uploads). Missing alt text
  on legacy images is filled from the caption, else the article title plus "photo", and flagged in the QA report so it is
  visible rather than silent.
- Each imported media document keeps its original upload path (for example `2023/10/photo.jpg`) in an optional staff-only
  `legacyPath` text field (additive, indexed) so old addresses can be mapped. Size suffixes such as `-300x200` map to the
  same media document.
- **Open question (needs D2):** whether `/wp-content/uploads/<legacyPath>` is served by the public host from the CMS media
  store, or from object storage at the same path. **Default:** keep the same path on the public host and let it fetch the
  public media file, so Google Images and hotlinks keep working with no per-image redirect. The CMS exposes nothing new for this
  until D2 is decided; the path map lives in `legacyPath`.

### C1.3 Dates, authors and slugs

- `publishedAt` keeps the **original** WordPress date. The server-side importer uses Payload's Local API; the "set by the
  server on first publish" rule is bypassed only for import runs, audited as `import.article`.
- `bylineName` carries the legacy author's display name. No staff accounts are created for legacy authors.
- `slug` keeps the WordPress `post_name` when it satisfies `^[a-z0-9]+(?:-[a-z0-9]+)*$` and is unique. A collision or an
  invalid slug is renamed (`-2`, `-3`, ...) and the pair (old, new) goes into the QA report and the redirect map (C7).
- `legacyUrl` stores the original absolute URL; `legacyId` the WordPress post ID. Both are already in the schema.
- Shortcodes found in the export (inventory: 0 `[penci...]`, 1 form shortcode, per the 2026-10-15 audit) are removed from the
  body and listed in the QA report. A form shortcode is never rendered or executed.

### C1.4 Tables (editor support is a precondition)

The importer writes tables in the standard shape the public renderer reads (`table` > `tablerow` > `tablecell`). The CMS
editor is the default `lexicalEditor()`, which has **no table feature registered**, and an unregistered node can stop the
admin editor from loading the article (the same reason C1.1 refuses a raw `embed` node). Therefore:

- The C1 PR must register Lexical's table feature on `articles.content` **and** prove it with a real-browser test that opens
  an imported article containing a table in the admin editor and saves it without data loss.
- If that proves unstable, the importer **flattens** each table to paragraphs (one paragraph per row, cells separated by
  ` | `) and lists the table in the QA report. The contract fixes the data shape either way; the public renderer already
  handles both.
- Until one of the two is done, the importer must not write table nodes.

### C1.5 Links in legacy bodies

- Absolute links to the old domain are rewritten to the new root-relative article path through the slug map (C7). Links to
  media on the old domain are rewritten the same way once C1.2 is decided.
- Only `http:`, `https:`, `mailto:` and root-relative links are written. Anything else is converted to plain text.
- The public renderer must therefore accept **root-relative** links (today they render as plain text). That is a public-side
  follow-up recorded in the Codex briefs.

## C2. SEO fields

Two optional plain-text fields on `articles`. No canonical override: the canonical address is **derived** by the public host
from the article path decided in D1, so an override could only create duplicates or loops (the public host keeps the
current canonical path until D1).

| Field | Type | Rules |
| --- | --- | --- |
| `seoTitle` | text, optional | 1 to 70 characters after sanitising; plain text; no HTML; no template variables |
| `seoDescription` | text, optional | 1 to 200 characters after sanitising; plain text |

- **Public projection.** `GET /api/articles` and `/api/articles/:id` for **published** articles return `seoTitle` and
  `seoDescription` (omitted or `null` when unset). They are not staff-only. Existing fields are unchanged, so this is
  additive for correct clients.
- **Fallbacks are the public host's job and are fixed here:** title tag uses `seoTitle`, else `title`; meta description and
  share-card description use `seoDescription`, else `excerpt`. RSS descriptions stay on `excerpt`, as today.
- **Who may write:** anyone who may edit that article's content (reporters while draft or changes requested, editors in
  scope, trusted publishers for their own). On a **published** article, changing only these two fields is **not** a
  "material" change and needs no corrections entry (api-contracts §2). Each change is still versioned.
- **Validation:** over-length input is 400 with a per-field message; HTML tags and control characters are stripped.
- **Import from Rank Math.** The importer reads the Rank Math title and description for each post. A value that contains
  template variables (anything matching `%[a-z_]+%`, such as `%title% %sep% %sitename%`) is **not stored raw**; it is
  dropped and counted in the QA report, because the new site builds its own pattern. Yoast data is not read (plugin inactive).
- **Migration:** adds two nullable columns; no backfill; reversible.
- **Tests expected:** length and sanitising, projection for published and not for drafts, not-material edit on a published
  article, importer variable-dropping.

## C3. Advertising

Implements the delivery side of the public team's [advertising contract](../../../docs/advertising-contract.md). The public
renderer (`src/lib/advertising.js`) already validates what it receives; the CMS must still enforce everything server-side.

### C3.1 Staff data

- **`advertisers`** (staff-only, `admin` and `editor-in-chief`): `name`, `contactName?`, `contactEmail?`, `notes?`. Never
  public. No payment-card or bank details are stored.
- **`ad-campaigns`** (staff-only):

| Field | Rules |
| --- | --- |
| `advertiser` | relation to `advertisers`, required |
| `sponsor` | public display name, required, 1 to 100 |
| `alt` | creative description and offer, required, 1 to 240 |
| `destinationUrl` | absolute `https:` URL, no credentials, no `javascript:`, 1 to 500 |
| `placements` | one or more of `homepage-billboard`, `article-inline`, `mobile-banner` |
| `creatives.<placement>.desktop/.mobile` | relation to `media` (JPEG, PNG or WebP only) with required width and height recorded from the media document |
| `startsAt`, `endsAt` | ISO timestamps with timezone; `endsAt` after `startsAt` |
| `priority` | integer 0 to 100 |
| `status` | `draft`, `pending_approval`, `approved`, `paused`, `cancelled` |
| `rightsConfirmed` | boolean; creative rights and advertiser authorisation checked by a person |
| `paymentStatus` | `unpaid`, `invoiced`, `paid`, `waived` (staff-only; never public) |
| `approvedBy`, `approvedAt` | server-set when moved to `approved` |

- **Who:** `admin` and `editor-in-chief` create, edit and approve. Section editors, trusted publishers and reporters have no
  access to advertising.
- **Approval rules (server-enforced):** `approved` requires `rightsConfirmed = true`, every selected placement to have a
  complete creative set, and — while `ADS_REQUIRE_PAYMENT` is `true` (the default) — `paymentStatus` of `paid` or `waived`.
  `waived` can only be set by `admin`. Changing any public field of an `approved` campaign sends it back to
  `pending_approval`. Every transition writes an `audit-logs` entry.
- **Creative checks:** dimensions must match the placement table below within the given limits; larger than 500 KB is
  rejected; animated images are not accepted in v1.

| Placement | Desktop | Mobile |
| --- | --- | --- |
| `homepage-billboard` | 970x250 | 320x100 |
| `article-inline` | 728x90 | 320x100 |
| `mobile-banner` | none | 320x100 |

### C3.2 `GET /api/public/advertising` (no credentials)

Response shape is exactly the one in the public advertising contract:

```json
{
  "campaigns": [
    { "id": "ac_1", "status": "active", "sponsor": "Example advertiser", "alt": "Describe the offer and destination",
      "destinationUrl": "https://example.test/offer",
      "startsAt": "2026-10-14T00:00:00Z", "endsAt": "2026-10-31T00:00:00Z", "priority": 10,
      "placements": ["homepage-billboard"],
      "creatives": { "homepage-billboard": {
        "desktop": { "src": "https://cms.example.test/api/media/file/example-desktop.webp", "width": 970, "height": 250 },
        "mobile": { "src": "https://cms.example.test/api/media/file/example-mobile.webp", "width": 320, "height": 100 } } } }
  ],
  "adsense": { "enabled": false, "reviewed": false }
}
```

- A campaign appears only when `status = approved` and `startsAt <= now < endsAt` (start inclusive, end exclusive), so the
  server, not the browser, decides "active". Invoices, payment status, advertiser contact, approval notes and the advertiser
  record are never in the response.
- `adsense.enabled` and `adsense.reviewed` come from server configuration `PUBLIC_ADSENSE_ENABLED` and
  `PUBLIC_ADSENSE_REVIEWED` (both default `false`). **The CMS never delivers an AdSense publisher ID or script.** Turning
  AdSense on stays an owner-approved step, with the publisher line supplied for `ads.txt` and configuration by the owner.
- **Caching:** `Cache-Control: public, max-age=60` and an `ETag`; the endpoint is cheap and read-only. No rate limit, no 429.
- **Media privacy:** a creative's media becomes publicly readable only while its campaign is delivered (same model as live
  update photos in api-contracts §3 Media, v1.6) and is private again when the campaign ends or is paused.
- **No tracking in v1:** no impression or click counters and no pixels. Advertiser reporting is a later, separate contract.
- **Tests expected:** schedule edges, status gating, payment gating, hidden fields, media privacy flip, dimension and size
  checks, and a contract test the public renderer's tests can reuse.

## C4. Newsletter

The CMS stores consent and subscribers; it **does not send newsletters in v1**. Sending stays with the chosen provider (D5).

### C4.1 `POST /api/public/newsletter/subscribe`

```json
{ "email": "reader@example.test", "name": "Optional name", "consent": true,
  "source": "footer", "website": "", "turnstileToken": "0.xxxx" }
```

- `email` required, valid, 254 max, lower-cased. `name` optional, 2 to 120. `consent` must be literally `true`. `source` is
  one of `footer`, `article`, `home`, `other`. Turnstile action: `newsletter-subscribe`. Body cap 8 KB.
- **Double opt-in.** The subscriber is stored as `pending` with a hashed one-time token. The CMS emails a confirmation link to
  the **public site** page `/newsletter/confirm?token=...` (never an API URL).
- **Neutral answer, no enumeration.** A new address, an address already pending and an address already confirmed all get the
  same `202 { "ok": true, "message": "If this address can be subscribed, we sent a confirmation email." }`. A previously
  unsubscribed address is **not** silently re-added; it gets the same answer and a fresh confirmation is the only path back.
- **Limits** (env, defaults): per IP `NEWSLETTER_RATE_LIMIT` = 5 per `NEWSLETTER_RATE_WINDOW_SECONDS` = 900; per address 3
  per hour. Both 429 with `Retry-After`. A honeypot hit returns the normal 202.
- If SMTP is not configured in production the endpoint answers `503 { ok: false, errors: [{ message: "Sign-up is unavailable." }] }`
  and stores nothing, so a reader is never told to wait for an email that cannot arrive.

### C4.2 `POST /api/public/newsletter/confirm` and `/unsubscribe`

- Body `{ "token": "..." }` (no Turnstile; the token is the proof). **POST only**, so mail scanners that pre-fetch links cannot
  confirm or unsubscribe anyone. Tokens are random, single use, expire after 72 h (confirm) and are signed
  (`NEWSLETTER_TOKEN_SECRET`) for unsubscribe so every future email can carry a working link.
- `confirm` on a valid token sets `confirmed`, records `confirmedAt`; `unsubscribe` sets `unsubscribed`, records
  `unsubscribedAt`. Both answer `200 { "ok": true }`; an invalid or expired token is `400 { ok: false, errors: [{ message: "This link is no longer valid." }] }`.

### C4.3 Staff data and export

- **`subscribers`** (staff-only, `admin` and `editor-in-chief`): `email` (unique), `name?`, `status` (`pending`,
  `confirmed`, `unsubscribed`, `bounced`, `erased`), `source`, `consentText` version, `consentAt`, `confirmedAt?`,
  `unsubscribedAt?`, `ipHash`, `importedFrom?` (`web`, `mailchimp-import`). Never readable anonymously, never in a public
  response.
- **Export:** `GET /api/subscribers/export?status=confirmed` returns CSV to `admin` only, audited, `Cache-Control: no-store`.
  Cells that start with `=`, `+`, `-` or `@` are prefixed with `'` to block spreadsheet formula injection.
- **Erasure on request:** an `admin` can erase a subscriber; the address is replaced by its salted hash and `status` becomes
  `erased`, which keeps a suppression record without keeping the address.
- **Import** (`npm run import:subscribers -- --file <path>`, server-side, CLI only, never an endpoint): reads an
  owner-supplied Mailchimp export that stays **outside the repository**. Only rows that Mailchimp marks as subscribed are
  imported, as `confirmed` with `importedFrom = mailchimp-import` and the Mailchimp opt-in time as `consentAt` when present.
  Unsubscribed, cleaned and pending rows are not imported. **Commenters, form senders and any other source are never imported
  as subscribers.** A dry run (default) prints counts only, no addresses.
- **Provider sync (D5):** off by default. When enabled it is a server-side adapter that sends **only confirmed** addresses,
  using `MAILCHIMP_API_KEY` and `MAILCHIMP_AUDIENCE_ID` held in environment variables, and records the result. It never runs
  in staging.
- **Tests expected:** double opt-in happy path, neutral answers, token expiry and single use, POST-only confirm, rate limits,
  export injection guard, erasure, importer dry run on synthetic data, 503 without SMTP.

## C5. Contact

A separate endpoint and collection from story submissions, so the story review queue stays editorial.

### `POST /api/public/contact`

```json
{ "name": "Ada Obi", "email": "ada@example.test", "topic": "general",
  "message": "Plain text, 20 to 5000 characters.", "website": "", "turnstileToken": "0.xxxx" }
```

- `name` 2 to 120; `email` valid; `topic` one of `general`, `advertising`, `corrections`, `tips`, `other`; `message` 20 to
  5 000, plain text. Turnstile action `contact-message`. Body cap 16 KB.
- Stored in **`contact-messages`** (staff-only, `admin` and `editor-in-chief`; section editors may be added later):
  `reference` (server-made), `name`, `email`, `topic`, `message`, `status` (`new`, `read`, `replied`, `spam`), `ipHash`,
  `userAgent`, `contentHash`. Never readable anonymously.
- **Notification:** an email goes to `CONTACT_NOTIFY_TO` (comma list, server-side, validated at startup, **never returned
  to the client**) with `Reply-To` set to the sender. CR and LF are stripped from every header-bound value (name, subject) to
  prevent header injection. If SMTP is missing or fails, the message is **still stored** (it is never lost) and the answer is
  the normal 201; the failure is logged and visible to staff.
- **Limits** (env, defaults): per IP `CONTACT_RATE_LIMIT` = 5 per 900 s; per address 3 per hour; duplicate (same address and
  same message within 72 h) is 409. Honeypot returns a normal 201.
- **Responses:** `201 { "ok": true, "reference": "MSG-7KQ2M9XA", "message": "Received. We will reply by email." }`, plus the
  shared error shapes (400 with per-field errors, 403, 409, 413, 415, 429).
- **Tests expected:** validation, header-injection attempts, stored-even-if-mail-fails, duplicate, rate limits, recipient
  never leaked, staff-only read.

## C6. Comments archive (read-only)

Default for D3. There are **no new comments**: this archives the approved WordPress comments and shows them under migrated
articles. A moderated "post a comment" flow would need its own contract and is not part of go-live.

- **`legacy-comments`** collection. Fields: `article` (relation, required), `authorName` (1 to 120), `content` (plain text,
  1 to 5 000), `commentedAt`, `legacyId` (number, unique), `parentLegacyId?` (threading, display depth capped at 2), `status`
  (`approved`, `hidden`).
- **Data minimisation: no commenter email, website or IP is stored in the CMS.** The commenter name is already public on the
  old site. The owner's private email export is a separate contact-handling matter and is never loaded here.
- **Import rules:** only `comment_approved = 1` and a normal comment type. Spam, trash, pingbacks and trackbacks are skipped
  (they are a spam vector). A comment whose article was not imported is skipped and reported. The counts must reconcile with
  the export (the 2026-10-15 audit had **1,833** approved comments); any difference is explained in the QA report.
- **Public read** through Payload REST, like articles (api-contracts §4.2):

```
GET /api/legacy-comments?where[article][equals]=<id>&sort=commentedAt&limit=100&page=1&depth=0
```

  Anonymous callers only ever see `approved` comments of **published** articles, regardless of query parameters. Returned
  fields: `id`, `authorName`, `content`, `commentedAt`, `parentLegacyId`. Lists are paginated with the same limit rules (max 100).
- **Staff:** editors in scope may set a comment to `hidden` (audited). `admin` may delete. Nobody can create or edit comment
  text through the API; the importer uses the server-side Local API and is audited.
- **Rendering rule for the public site:** render `content` as text with line breaks only. If links are ever made clickable they
  must carry `rel="nofollow ugc noopener noreferrer"`. No emails anywhere in the payload or the DOM.
- **Tests expected:** anonymous sees only approved comments of published articles, hidden and unpublished are not returned,
  email fields do not exist, import skips pingbacks and reconciles counts on a synthetic export, pagination clamp.

## C7. Redirects

The CMS produces the **exact-match** redirect list for the old WordPress addresses. Pattern rules (`/category/*`, `/tag/*`,
`/author/*`, `/page/N/`, `/feed/`, AMP variants, `/?p=ID`) belong to the public host (P1). The two together are the full set.

### C7.1 Staff-managed rows

- **`redirects`** collection (staff-only, `admin` and `editor-in-chief`, audited): `from` (path starting with `/`, no scheme,
  host or fragment, 1 to 300, unique), `to` (a path starting with `/`, or an absolute `https:` URL whose host is in
  `REDIRECT_ALLOWED_HOSTS`), `status` (`301`, `302`, `410`), `source` (`manual`, `rank-math`, `legacy-url`), `note?`.
- Rows imported from a **Rank Math redirects export** (supplied privately by the owner) use `source = rank-math`. A row that
  would create a loop or a chain is rejected at write time with the conflicting rule named.

### C7.2 Derived rules

For every **published** article with a `legacyUrl`, the generator derives `from` = the path of `legacyUrl` and `to` = the
article's current public path, built from `PUBLIC_ARTICLE_PATH_TEMPLATE` (`/{slug}/` for the D1 default, `/reports/{slug}/`
otherwise). When `from` already equals `to`, **no rule is emitted**: with the D1 default most articles need no redirect, only
renamed slugs (C1.3) and non-article addresses do. Unpublished and archived articles emit no rule, so their old addresses
answer a plain 404 unless a staff row says `410`.

### C7.3 `GET /api/public/redirects` and the export command

```json
{ "version": "sha256:…", "generatedAt": "2026-10-16T00:00:00Z", "count": 2, "rules": [
  { "from": "/old-slug/", "to": "/new-slug/", "status": 301, "source": "legacy-url" },
  { "from": "/some-retired-page/", "to": "/", "status": 301, "source": "manual" } ] }
```

- Sorted by `from`, with `version` a hash of the content so the public host can skip an unchanged list.
  `Cache-Control: public, max-age=300` and an `ETag`. Hard cap 5 MB and 20,000 rules; above that the endpoint refuses (500
  with a clear log) rather than truncating silently.
- `npm run export:redirects -- --out <file>` writes the same JSON for hosts that load redirects at build time or from a file
  (for example Caddy). The output file is a generated artifact and is not committed.
- **Validation at generation (fails the run, never ships a bad map):** no two rules share a `from`; no loops; no chains (any
  `to` that is itself a `from` is resolved to the final target); every internal `to` resolves to a published article or a
  known static path; at most one hop for any reader.
- **Reporting, not failing:** `npm run check:redirects -- --urls <file>` reads an owner-supplied list of old addresses (the top
  traffic URLs from Search Console, kept outside the repository) and prints how many resolve, how many do not, and the status
  of each, **without printing the addresses to CI logs**. The go-live gate is **zero unresolved top-traffic addresses**.
- Junk such as `tel:` paths is handled by the public host as a cheap 404 or 410 and never appears in this list.
- **Tests expected:** derived-rule skipping when `from = to`, collision renames, loop and chain rejection, hash stability,
  size cap refusal, anonymous cannot read the collection, endpoint omits unpublished articles.

## Open items that need an owner or Codex answer before building

| # | Item | Needed from | Default if unanswered |
| --- | --- | --- | --- |
| O1 | D1 article path: `/{slug}/` or `/reports/{slug}/` | Owner | `/{slug}/` |
| O2 | D2 production host and where `/wp-content/uploads/*` is served from | Owner and Codex | Same path on the public host, files from public media |
| O3 | D3 comments | Owner | Read-only archive (C6) |
| O4 | D4 ads: payment before delivery? | Owner | Yes (`ADS_REQUIRE_PAYMENT=true`) |
| O5 | D5 newsletter provider and whether the Mailchimp audience is live | Owner | Store consent, no sync, CSV export |
| O6 | Does the public renderer accept the `youtubeEmbed` block shape (C1.1)? | Codex | Yes, with consent gating |
| O7 | Are the placement sizes in C3.1 the real slot sizes in `advertising.js`? | Codex | As listed |

## Order of implementation (CMS lane)

1. C2 (small, unblocks Codex's SEO mapping), then C7 and C1 (the migration spine).
2. C3, C4 and C5, each as its own PR with migration, tests and a contract update in `api-contracts.md`.
3. C6 after the importer can reconcile counts.
4. Every PR is tested in the real-browser cross-app lane where a public form is involved, with stubs labelled as stubs.
