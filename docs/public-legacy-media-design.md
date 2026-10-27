# A12 proposal: preserve legacy WordPress image paths

**Design for review. No proxy, file route or flag is implemented by this PR.**
CMS PRs [#54](https://github.com/abcentech/churchtimes/pull/54) and [#55](https://github.com/abcentech/churchtimes/pull/55) are merged, and the CMS lane has
merged the offline exporter (`npm run export:media-map`) with its `media-map/1` format (`apps/cms/docs/api-contracts.md`, section "Go-live A12: legacy media
map (offline export)", code in `apps/cms/src/lib/mediaMapExport.ts`). The staff-only `media.legacyPath` field stays staff-only; there is no anonymous lookup endpoint.
This note now follows that merged format; it replaces the earlier flat proposal (`entries[{legacyPath, mediaPath, mimeType}]` with `revision`).
Wave 4 permits Node behind Caddy with the public site at the domain root as the D2 planning default; the actual production host and its operational limits
still need owner acceptance. The host route (A12) can be built against `media-map/1` once the owner accepts D2.

The goal is to retain approved image URLs such as `/wp-content/uploads/2021/03/synthetic-photo.jpg` on the public
origin. An exact, reviewed map points that address to an already-public CMS media file. The browser keeps its old
address and receives image bytes; the host does not redirect to the CMS. No request can select a remote origin.
All examples here are synthetic. Real migration inventories and maps stay in approved private storage, outside GitHub.

## Decision and ownership boundary

- The owner approves D2, the public origin, the CMS origin, the proposed image scope, limits and withdrawal policy.
- The CMS lane owns the merged export tooling and the `media-map/1` contract; the host adapts to it, not the reverse. `path` stays staff-only; this design
  does not widen media access or scan anonymous media documents to discover it.
- Codex implements a narrowly scoped public route after this design review, against the merged `media-map/1` contract.
- Hosting must preserve the original request target for validation, route `/wp-content/uploads/` to the Node host,
  and bypass shared/CDN caches for the initial no-store proposal. Node behind Caddy at the domain root is the
  Wave 4 planning default; it is not evidence of an owner-approved production installation.
- A future `PUBLIC_LEGACY_MEDIA_ENABLED=true` setting would opt in. Unset/false must register no proxy behavior and
  make no CMS request. The proposed `PUBLIC_LEGACY_MEDIA_MAP` would identify a local, operator-provisioned file;
  neither setting is implemented or approved for production here.

## Merged private export contract: `media-map/1`

The CMS owner runs `npm run export:media-map -- --out <file> [--aliases <json>] [--detail-file <path>]` outside every checkout. A media record is exported only if an
anonymous reader can read it at export time (the exporter reads with `overrideAccess: false` and no user), so drafts, in-review, scheduled, archived and unreferenced
media are never listed. The file carries no ids, alt text, captions, credits, uploaders or staff fields. The public host receives neither a staff token nor Local API access.
A CMS anonymous file read remains the final authority on whether a mapped file is public at request time.

Format (JSON, UTF-8; all values below are synthetic):

```json
{
  "version": "media-map/1",
  "generatedAt": "2026-10-17T00:00:00Z",
  "counts": { "entries": 2, "aliases": 1 },
  "contentSha256": "<stable content id, ignores generatedAt and formatting>",
  "entries": [
    { "path": "2021/03/synthetic-photo.jpg", "file": "/api/media/file/synthetic-photo.jpg", "mime": "image/jpeg", "size": 123456 },
    { "path": "2021/03/synthetic-banner-1920x1080.jpg", "file": "/api/media/file/synthetic-banner-original.jpg", "mime": "image/jpeg", "size": 234567 }
  ],
  "aliases": [
    { "alias": "2021/03/synthetic-photo-300x200.jpg", "path": "2021/03/synthetic-photo.jpg" }
  ]
}
```

- `path` is relative to `/wp-content/uploads/`: NFC, percent-decoded once, no duplicate, leading or trailing slash, no `.`/`..`, case-sensitive, exact match. It is a key, not a URL.
  `file` is a CMS public-file pathname matching `^/api/media/file/[A-Za-z0-9][A-Za-z0-9._-]*$`, never an absolute URL or a template. `mime` is `image/jpeg`, `image/png`
  or `image/webp`; `size` is bytes. Entries are sorted by `path` in code-unit order and aliases by `alias`.
- Size-suffix aliases (`photo-300x200.jpg` to `photo.jpg`) exist only when the owner listed them, the alias is the original with exactly one `-WxH` suffix, the original is
  an exported entry and no media (of any visibility) claims the alias as its own exact path. The host looks up the exact entry first, then the alias, and never strips a suffix
  itself. Two media of any visibility claiming one normalised path are ambiguous and neither is exported (reported in the private detail file).
- Limits: at most 50,000 entries counting entries plus aliases, and 8 MiB serialised; the exporter refuses and writes nothing beyond them. The host enforces the same caps before parsing.
- Digest: `<out>.sha256` (`<hex>  <file name>`, `sha256sum -c` compatible) is the sha256 of the exact bytes of the map file and is the provisioning check; it detects damage, it is
  not a signature. `contentSha256` inside the file is a stable content id only. The map is copied to the host over a private channel, verified, then swapped in atomically.
- The host must validate every entry at load itself (the exporter's `validateMediaMapBody` is a reference): schema, caps, duplicate paths and aliases, alias targets that exist,
  `file` pattern, MIME and size bounds. Any failure rejects the whole map.
- Withdrawal. With the no-store design below, revocation is immediate: once a media file stops being anonymously readable the CMS file URL answers 403 or 404 and the host
  serves 404 before any re-export. A re-export and atomic map replacement then removes the entry. An ad creative stops being public when its campaign ends; media still used by
  another published article stays public and mapped. Images already downloaded cannot be recalled.

## Path and origin validation proposal

Exporter and host need agreed normalisation test vectors before implementation. The merged staff-side helper in
`apps/cms/src/lib/legacyMediaPath.ts` collapses duplicate slashes, retains raw text when percent decoding fails, and
does **not** NFC-normalise Unicode; the exporter's `path` key is the NFC, decode-once form above. `legacyPath` remains staff-only. The request-facing rules proposed here are
deliberately stricter: an export must report malformed escapes, slash aliases, decomposed Unicode and collisions
for reconciliation instead of copying helper output blindly. Do not silently lose media or introduce a second,
undocumented key format; the agreed exporter/host vectors must settle those differences.

1. Inspect the raw request path before a URL parser or reverse proxy can remove dot segments. Only GET/HEAD on the exact
   case-sensitive `/wp-content/uploads/` prefix are eligible. Never derive routing or fetch origin from `Host`, forwarded
   headers, a query parameter or `Referer`. Other methods return 405 with `Allow: GET, HEAD` and no CMS call.
2. Cap the complete raw request target (path plus query) at 8,192 bytes and the decoded relative path at 500 UTF-16
   code units, matching PR #54's field bound. Recheck the decoded bound after Unicode normalisation.
   Reject malformed percent escapes/UTF-8, controls (including C1 controls), NUL, backslashes, encoded slashes/backslashes,
   empty segments, duplicate slashes, leading/trailing slashes, `.`/`..` segments and a residual `%HH` after one decode.
   This rejects ambiguous double encoding; genuine filenames containing such a literal sequence need explicit review.
3. Decode exactly once, NFC-normalise each Unicode segment and construct the key by joining segments with `/`.
   Preserve case. Reject collisions after NFC normalisation. Never use a URL-derived path as a filesystem filename.
   A wire space must be percent-encoded; a valid decoded space inside an approved filename may remain part of its key.
   Normalised map entries must pass the same decoded-segment rules. Hostile/unmatched paths get no per-URL cache entry.
4. Query strings are not map keys and are never forwarded. For the initial proposal, a bounded, ignored query is permitted
   for old cache-buster links; reject an oversized request target before lookup. Fragments never reach the server.
   A future transformation/download query requires its own contract; there are no dynamic image transforms here.
5. Validate every `file` at map load: exact approved public-file prefix (initial proposal `/api/media/file/`), a
   nonempty canonical encoded filename, no query/fragment, dot segments, separator escapes or double encoding. Build a URL
   against one configured, approved CMS origin and assert that its origin and pathname remain approved after parsing.
   Never accept arbitrary absolute destinations, localhost supplied by a requester, or even a second allowlisted origin
   chosen by an entry. A loopback CMS origin is allowed only in explicit local tests; production configuration is reviewed.
6. Use that fixed CMS origin, normal TLS validation and operator-controlled outbound network restrictions. Do not forward
   browser cookies, credentials, `Authorization`, `Host`, `Origin`, query strings or arbitrary headers. Do not use staff
   authentication to bypass CMS anonymous access. Request redirects are disabled; no upstream Location is followed or exposed. Use a fixed
   `Accept-Encoding: identity`; unexpected upstream content encoding must fail rather than being copied blindly.

Examples for the planned test vectors:

| Request | Intended outcome |
| --- | --- |
| `/wp-content/uploads/2021/03/synthetic-photo.jpg` | Exact approved entry; anonymous CMS file read |
| `/wp-content/uploads/2021/03/synthetic-photo-300x200.jpg` | Explicit alias only; no runtime suffix guessing |
| `/wp-content/uploads/2021/03/synthetic-banner-1920x1080.jpg` | Exact original wins over a possible size suffix |
| `/wp-content/uploads/2021/03/caf%C3%A9.jpg` | NFC key `2021/03/café.jpg`, only if explicitly mapped |
| `/wp-content/uploads/2021/03/cafe%CC%81.jpg` | Same NFC key; duplicate export keys are refused |
| `/wp-content/uploads/2021/03/synthetic-photo.jpg?ver=123` | Same lookup; query never forwarded |
| `/wp-content/uploads/../private.jpg`, encoded/double-encoded traversal | Cheap 404; zero CMS requests |
| `/wp-content/uploads/2021%2F03/synthetic-photo.jpg` or `%5C` separators | Cheap 404; zero CMS requests |
| `/wp-content/uploads/2021//03/synthetic-photo.jpg` or malformed `%` | Cheap 404; zero CMS requests |
| `/wp-content/uploads/https://remote.example.test/x.jpg` | No matching approved key; zero remote fetches |

## Delivery, limits and privacy proposal

Initial scope follows the existing CMS public-image contract: JPEG, PNG and WebP only. SVG, HTML, scripts, PDFs,
animated GIFs and other historic uploads are not silently proxied. The reconciliation report must expose that coverage
gap for an owner decision. A later format needs a reviewed MIME/security/cache contract.

Proposed initial limits are reviewable operating values, not implemented defaults: an 8 MiB map, 50,000 entries,
a 10 MiB response, 8 concurrent upstream transfers per process, 2 seconds to receive headers and a 10-second total
transfer deadline. Both declared and streamed byte counts are bounded. Check response type and initial image signature
before releasing bytes; stream the remainder with backpressure instead of buffering a whole file. Abort upstream work
when the client disconnects or a deadline/size limit is reached. A limit hit after streaming begins closes the response;
it cannot be relabelled as a successful complete image. Oversized originals need an approved smaller explicit mapping.

- Only an anonymous upstream 200 with an allowed matching MIME/signature may produce an image response. Return the
  verified MIME and `X-Content-Type-Options: nosniff`. Forward `Content-Length` only when it is a single valid bounded
  integer consistent with the delivered body; truncated/mismatched bodies must fail. Never forward upstream cookies,
  content encoding, HTML errors, filenames or diagnostics.
- HEAD returns the same public-access decision and safe response headers without a response body. If the CMS HEAD route
  does not provide equivalent access/MIME guarantees, bounded GET-and-cancel behavior must be specified and tested first.
- Initial responses use `Cache-Control: no-store`, including errors. There is no shared CDN cache, local file/body cache,
  conditional 304 shortcut or stale media fallback. Every request rechecks current anonymous CMS access. This deliberately
  prioritises withdrawal over byte-cache efficiency until the owner/CMS contract defines an acceptable withdrawal window.
- Upstream 403/404, a withdrawn mapping and an absent mapping all give a generic 404. Upstream 3xx, malformed headers or
  MIME mismatch give a generic 502; timeout gives 504; concurrency exhaustion gives 503 with a bounded `Retry-After`.
  Do not disclose CMS error bodies or distinguish draft/private media from an unknown image.
- Initially ignore Range/If-Range and conditional request headers and serve a bounded full 200; do not advertise byte-range
  support or invent a 206. Tests must confirm the CMS request is not ranged. PDFs/audio/video are outside this scope.
  True range support, if later needed, requires validated single ranges, total-length/MIME/access guarantees and limits.
- Keep aggregate counters for misses, rejected paths, status classes, timeouts and bytes. Do not log raw paths, query
  strings, cookies, complete maps, upstream credentials or private migration reports. Operational troubleshooting uses
  explicitly approved private tooling. Incoming client IP exposure/retention and proxy headers need the hosting privacy review.

### Bounded cache alternative for review

If no-store is too costly at launch, a separate approved contract may allow a short cache with a numeric maximum
withdrawal window **W**. An illustrative proposal is W = 60 seconds with body/browser/shared-cache TTLs capped at
30 seconds, but neither number is selected by this note. The CMS's cache policy must permit caching. The combined
worst-case map propagation, any upstream reuse and downstream cache lifetime must fit within W; a single component's
30-second TTL is not proof of a 60-second end-to-end bound. Bound every layer or keep that layer no-store.

Such a design must disable stale-while-revalidate/stale-if-error, invalidate cached bytes on map `contentSha256` change or removal,
never cache denied/error responses, and fail closed once freshness expires. Shared caching needs an explicit CDN
configuration and purge mechanism; a CMS denial or removal must stop new delivery by W in a timed withdrawal test.
If that bound cannot be demonstrated, retain no-store. Already downloaded images remain outside any recall guarantee.

A permanent 301 to a CMS media URL was rejected for this proposal: browsers and intermediaries can retain the
redirect after the publisher removes a mapping, bypass future map/withdrawal checks, and bind old public URLs to a
particular CMS origin. Keeping the publication URL on the public host preserves origin portability and one controlled
withdrawal/cache boundary. Redirect-based delivery would need its own explicit owner/CMS cache and revocation contract.

Removing an entry prevents future lookups; CMS revocation must also deny anonymous file reads without waiting for an
export rotation. Images already downloaded cannot be recalled. The bounded-cache alternative above must not be introduced until
its maximum withdrawal delay and purge behavior are agreed and tested. Under the initial proposal, Caddy/CDN must
not override `no-store`.

## Immutable map rotation and failure behavior

The operator provisions an immutable, privately stored map plus a digest over its exact bytes, using the same trusted
release channel as host configuration. The digest is not a signature or a substitute for trusted file permissions.
The map is data only: no executable hooks, templates, filesystem targets or remote include URLs. Cap bytes before parsing,
check the schema/limits and every entry, reject duplicates/collisions and validate destination invariants before activation.

A future reload operation would load the complete new snapshot and atomically swap one in-memory reference. No partial map
is visible. In-flight requests are cancelled and late responses recheck the active snapshot before sending headers so a
removed/changed entry cannot be served by an old lookup. A rejection keeps the last validated map and emits a counted,
redacted warning. This availability behavior can retain old entries, so urgent withdrawal must use CMS public-access
revocation or disable the route, rather than relying on a failing reload. If opt-in is set but startup has no valid map,
startup fails clearly; do not silently claim legacy compatibility. The route flag is the emergency off switch.

There is no per-request map download or directory watch triggered by untrusted input. Reload mechanics (process restart,
signal or authenticated operator action), trusted symlink/file permissions, map rollback and CDN bypass depend on D2 and
must be agreed in the host kit. A rollback must never restore access to a file the CMS has withdrawn.

## Acceptance plan — not executed by this design PR

After design approval, D2 is settled (the exporter contract is merged), a separate feature PR would implement the default-off
route. Planned checks below are **not implemented tests or evidence of working delivery**:

- Unit/property tests for shared normalisation vectors, limits, encoded separators, raw/double-encoded dot segments,
  malformed UTF-8, NFC collisions, real size-suffixed originals, duplicate keys and invalid destination paths.
- A clearly labelled CMS-file **stub server** records requests: flag off, junk, misses and invalid maps produce zero
  requests; a match uses only the fixed origin/file path, no browser credentials/query; no redirect is followed.
- Stub responses cover correct images, MIME/signature mismatch, HTML served as an image, oversized/chunked bodies,
  disconnects, slow headers/body, upstream 403/404/3xx/5xx, concurrent limits, HEAD and ignored Range/conditionals.
- Snapshot rotation tests cover atomic activation, rejected maps preserving the old snapshot, removal during an in-flight
  request, emergency disable, and CMS revocation after an otherwise valid map was loaded. No stale bytes may be served.
- Once Claude's required contract lands: actual Payload/PostgreSQL journeys with synthetic public/draft/withdrawn media,
  equivalent GET/HEAD access checks and explicit old-size aliases. Stub success must not be reported as real integration.
- Pixel 7/desktop browser checks of legacy URLs, image dimensions/alt supplied by article markup, no layout overflow,
  correct MIME/nosniff/cache headers, zero arbitrary-origin requests, console errors and measured load/connection costs.
- Host-kit checks on the owner-approved staging setup: raw-path handling before normalisation, cache bypass, TLS/outbound
  restrictions, deadlines, health monitoring, private map permissions and rollback. No test targets production by default.

Review must settle D2, the offline export ownership/schema, canonical path vectors, anonymous media withdrawal/HEAD behavior,
coverage and numeric limits, then approve the implementation scope. This note creates that reviewable proposal; it does not
choose the host or authorise a deploy, CMS change, real-data export or live WordPress change.
