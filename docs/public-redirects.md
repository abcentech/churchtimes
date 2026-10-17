# Public redirects and cutover smoke (Wave 2 A2/A3/A5)

This is public-host tooling against the C7 contract. It makes no CMS schema, staff UI,
production hosting, DNS or WordPress change. Owner D1/D2 decisions remain pending.
The article template still defaults to `/reports/{slug}/`.

## Configuration, disabled by default

| Setting | Behaviour |
| --- | --- |
| `PUBLIC_REDIRECTS_FILE` | Optional private local JSON export in C7.3 shape. Takes precedence over a configured endpoint. Missing/unreadable file means no exact redirects, without an HTTP error. |
| `PUBLIC_REDIRECTS_URL` | Optional explicit `https://<cms-host>/api/public/redirects`; loopback HTTP is accepted for local tests. No endpoint is inferred from `PUBLIC_CMS_URL`. No credentials, query or fragment. Ignored while a file is configured. |
| `PUBLIC_REDIRECT_ALLOWED_HOSTS` | Comma-separated exact HTTPS hosts, bare hostnames only (no port, scheme or wildcard), matching CMS `REDIRECT_ALLOWED_HOSTS`. Empty by default, so destinations must be internal paths. The host also accepts `REDIRECT_ALLOWED_HOSTS` directly. If both names are set they must match after normalization, or startup fails. |
| `PUBLIC_REDIRECT_PATTERNS` | Optional JSON object of explicitly approved destination templates. Every pattern is off unless its destination is supplied. |
| `PUBLIC_ARTICLE_PATH_TEMPLATE`, `PUBLIC_BASE_PATH`, `PUBLIC_SITE_URL` | Shared routing settings, also used to reject destinations that would need a second canonical-path redirect. |

File and endpoint responses must have `{version, generatedAt, count, rules}` with
`version: "sha256:..."`, a parseable generation timestamp and `count === rules.length`.
Each rule has `from`, `to`, numeric `status` and `source` (`manual`, `rank-math` or
`legacy-url`). Canonical source paths are unique and at most 300 characters. The shared C7 normalizer adds directory slashes, NFC-normalizes UTF-8, encodes apostrophes and uses uppercase percent bytes before lookup. A 410
may omit `to`; a provided destination must still be safe and is never emitted as
`Location` for that response.

The module caps each generation at **5 MiB / 20,000 rules** and validates it atomically.
Duplicate sources, loops, chains, unsupported statuses and unsafe destinations reject
the entire generation. File reads and remote responses are bounded; response streaming
also enforces the byte cap when Content-Length is absent. Remote fetches omit
credentials, refuse redirects and time out after five seconds. Refreshes run in the background, are coalesced,
use `If-None-Match`, and cache for at most **300 seconds**. A 304 retains the validated
map. A failed, timed-out, invalid or partial refresh keeps the last good map and emits an address-free counted warning (`public_redirect_refresh_failed`). It retries at the next refresh interval; it never swaps in a partial map. There is no per-request-URL cache or per-URL log.

Only GET and HEAD may redirect, with status 301, 302 or 410. Exact rules use a `Map`
lookup and win over patterns. Request query parameters are not carried to exact
destinations. `Location` comes from the validated rule or an explicit template with a
strictly validated slug/page replacement; arbitrary request text never becomes a
destination. Protocol-relative URLs, credentials, encoded slashes/backslashes, nested
percent encodings, control characters and dot segments are rejected. External targets
must be HTTPS and match the configured allowlist. Absolute targets also require an explicit `PUBLIC_SITE_URL`, so same-origin loops and chains cannot evade validation when the canonical origin is unset. Internal destinations that are
known public pages or article paths must already have the canonical trailing slash.
Known exact/pattern chains are rejected or suppressed rather than returning another hop.
The exporter/owner must still verify that internal targets actually exist; the host
does not probe every destination or claim a CMS-import validation result.

## Optional pattern destinations: proposals requiring owner approval

These are **examples**, not active defaults or final taxonomy decisions:

| Key | Recognised old address | Proposed destination example |
| --- | --- | --- |
| `category` | `/category/<slug>/` | `/category/{slug}/` would be the current category path, but a self-redirect is suppressed; configure a different approved mapping only if needed. |
| `tag` | `/tag/<slug>/` | `/latest/` is a possible owner-approved fallback; `/topics/{slug}/` requires a separately implemented taxonomy. |
| `author` | `/author/<slug>/` | `/people/{slug}/` only if that destination is separately implemented and approved. |
| `page` | `/page/N/`, positive N up to 999999 | `/latest/?page={page}` only if pagination is separately implemented and approved. |
| `feed` | `/feed/` | `/feed.xml` |
| `amp` | `/<slug>/amp/`, `/reports/<slug>/amp/`, `/amp/<slug>/`, article `?amp` or `?amp=1` | `/reports/{slug}/` or `/{slug}/`, matching the owner's eventual D1 choice. |
| `legacyId` | `/?p=ID` | Article template containing `{slug}`, resolved through the anonymous published-article adapter. |

Slugs are limited to 160 lowercase alphanumeric/hyphen characters. Legacy IDs are
positive decimal values of at most 15 digits. `?p=` triggers no article request unless
the `legacyId` pattern is explicitly configured. The injected adapter must return
`status: "published"`, the exact matching `legacyId` and a safe slug. Drafts, archived
articles, mismatched IDs, malformed data and lookup errors do not redirect. The host
uses the existing anonymous published-articles API, never a staff collection.

The options deliberately do not infer destinations for tags, authors or pagination.
No new `/topics/`, `/people/` or pagination implementation is part of this PR.

## Cheap junk handling and server integration

`isJunkPath(req.url)` runs **before URL parsing**, base-path checks, map loading or CMS
reads. This preserves evidence of malformed encoding/dot segments that `new URL`
would normalise away. `tel:` crawler traps, malformed escaping, encoded separators,
control characters and excessive lengths return a cheap 404. No URL enters a cache.

`createPublicRedirects(options)` returns an async
`handler({method, url, rawUrl}, respond)` with the existing public responder signature
`respond(status, contentType, body, headers)`. Invoke it before feeds, public-page
handlers or article lookups; `true` means a response was sent. Keep the early raw-path
guard even though the redirect handler repeats it for defensive standalone use.

## Read-only smoke checker

Keep real Search Console paths and migration lists **outside GitHub**. The checker
refuses to run without an explicit origin and input file. It never defaults to
production and never changes content or follows more than one redirect.

```sh
npm run check:redirects -- --target http://127.0.0.1:5373 --urls /tmp/synthetic-paths.json --quiet
```

Input may be newline-separated root-relative paths or a JSON array:

```json
[
  {"path":"/old-synthetic-story/","expectedStatus":301,"expectedTitle":"Synthetic report — Church Times Nigeria"},
  {"path":"/retired-synthetic-page/","expectedStatus":410}
]
```

`--target` accepts HTTPS or loopback HTTP and must be an origin, without path/query/
fragment. `--rate` defaults to **2 requests/second**, including follow-up requests;
the allowed range is 0.1–10. Requests are sequential, credential-free, time out after
10 seconds, and read at most 2 MiB of final HTML. An external redirect is followed
only with an explicit `--allow-host approved.example.test` (repeatable). Other
redirect statuses, a second hop, loops, unapproved destinations, missing pages and
title mismatches fail the check. A known intentional 404 can be asserted explicitly;
a default 404 is unresolved. A 410 is a valid retired result. Missing expected titles
still require a nonempty title for successful HTML pages; provide expected titles
for the owner-supplied cutover gate.

The default output gives only row numbers, statuses, hop counts and booleans;
`--quiet` prints only aggregate counts. Paths, target origins, response text and titles
are never printed, including on errors. Exit status is nonzero if any row fails.
Private file permissions and access remain the operator's responsibility.

## Validation and limitations

`node --test unit-tests/public-redirects.test.js` covers synthetic maps, junk/no-CMS
behaviour, allowlisting, all permitted statuses/methods, atomic rejection, byte/rule
caps, ETag/cache refresh and failure, explicit pattern templates, canonicalisation
and chain guards, the injected published-only legacy lookup, checker argument
guards, rate limits, title escaping and a real checker subprocess against a
**synthetic local HTTP stub**. These are not end-to-end CMS, actual import, private
Search Console, staging deployment or production-cutover results. Claude's real C7
projection and cross-app journey are still required before claiming integration.

## Reader email-action shell hook

The same host serves `/newsletter/confirm/` and `/newsletter/unsubscribe/` (optional trailing slash, with the configured
base path) as neutral HTML shells before redirects or CMS reads. GET and HEAD never confirm, unsubscribe or write. These
pages have no canonical, no token echo, `X-Robots-Tag: noindex,nofollow`, `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`. The separate Session B reader PR owns token capture, URL scrubbing and explicit POST
buttons. These paths are excluded from sitemap/static-page discovery. The shell alone does not implement a newsletter endpoint.

## Startup readiness and review corrections

The CLI awaits `server.publicReady` before listening. An embedding host should also await that promise before exposing the
server. Redirect HTTP handling never awaits map I/O; expiry triggers a coalesced background refresh while requests use the
last good generation. A periodic unref'ed timer also refreshes without traffic. Server close stops its timer. The handler's
`diagnostics()` returns only loaded/rule/count/refresh metrics; warnings never include addresses, paths or response text.
Local absolute targets without an allowlist or canonical site origin fail startup explicitly. Remote startup configuration
errors reject readiness. General transient remote failure retains any last-good generation, or starts with none if no map
has ever loaded, and emits a counted warning. Keep the CMS and public-host hostname allowlists identical.

`tools/public-redirect-paths.mjs` and `tools/fixtures/public-redirect-paths.json` transcribe the dependency-free C7.1
contract and synthetic cases from CMS PR #55 a90183c, with the reviewed NFC correction. The current CMS PR has not yet
landed that correction or exported JSON vectors. This is **provisional contract/fixture validation**, not claimed shared
CMS parity or A9 real-CMS integration. The host's separate junk guard still rejects unsafe encoded separators before lookup.
Stray query-string percent characters are ignored for path normalization; malformed path encodings remain junk. Empty
article path settings use `/reports/{slug}/`; reserved root slugs are skipped with counted address-free discovery warnings.
