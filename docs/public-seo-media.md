# Public discovery, sharing and CMS images

This public-only change starts at integration commit `3bdf345` (including merged
PR #26). It changes no Payload collection, access rule, staff screen or WordPress
site. The live renderer/client, `/site/*` handling, Retry-After cap and CSP hash
remain owned by the parallel public-site session. New HTTP routes are isolated in
`tools/public-feeds.mjs` and `tools/public-pages.mjs`; `serve-public.mjs` has small
hooks, article metadata/hydration, and a response compression hook. Regenerate the
Pages export after combining frontend branches.

## Public host configuration

Use `npm run build` and `npm run serve:public`. Supply the same CMS origin to
`VITE_PUBLIC_CMS_URL` at build time and `PUBLIC_CMS_URL` at runtime. Set
`VITE_PUBLIC_SITE_URL` / `PUBLIC_SITE_URL` to the canonical HTTPS site origin.
`PUBLIC_BASE_PATH` optionally identifies a trailing-slash directory such as
`/churchtimes/`. URLs are constructed from configuration, never the Host header.
These dynamic endpoints require the Node public host; a static Pages export
cannot generate feeds or server metadata from the CMS.

`PUBLIC_INDEXABLE` must be exactly `true` to enable crawling. Its default remains
staging-safe: robots disallows `/`, HTML has noindex, and working sitemap/RSS
responses carry `X-Robots-Tag: noindex`. A configured indexable host allows
crawling and publishes the sitemap URL in robots. Do not change this flag as part
of reviewing this PR; no deployment or production indexing is authorized here.

## Discovery routes

- `/sitemap.xml`: article paths `/reports/<slug>/`, latest, home, about, contact,
  advertising, and clean `/category/<slug>/` pages. Article lastmod uses a valid
  `updatedAt`, falling back to `publishedAt`. Hash-only edition briefings,
  searches, saved stories and forms are excluded.
- More than 100 articles produces a sitemap index linking `/sitemap-1.xml`, etc.
  Each child requests one CMS page of 100 articles; static/category URLs appear
  only in the first child. Limits: 1,000 child maps (100,000 articles), 20 category
  pages (2,000 categories). Oversized or malformed CMS pagination fails with 503
  instead of advertising a partial sitemap. Each output stays well below the
  protocol's 50,000 URL / 50 MB limits.
- `/feed.xml`: RSS 2.0, latest 30 published reports, canonical permalink GUIDs,
  UTC RFC dates and escaped excerpts. An original-image enclosure includes the
  CMS's actual filesize and MIME type when available. Media RSS carries the
  selected large image and known dimensions even when filesize is absent.
- XML escapes all five special characters and removes invalid XML 1.0 control
  characters/unpaired surrogates. Draft or invalid records are discarded by the
  existing anonymous published-articles adapter, even if upstream misbehaves.
- Sixty-second HTTP and in-process caches, bounded to 64 entries per host. Failed
  generation is not cached. CMS/canonical misconfiguration returns 503/noindex;
  missing child pages return 404. GET/HEAD are supported; writes remain rejected.

Clean static/latest/category paths render useful initial HTML and hydrate the
existing browser views, so sitemap URLs work without JavaScript and on reload.
They do not replace the existing hash navigation. The canonical article endpoint
continues to return genuine 404/503 responses.

## Sharing and media

Server article cards include article OG type, title, excerpt, canonical URL,
site name, publication time, section, image/alt/dimensions, and a large Twitter
card. JSON-LD selects the same image, URL, section and publication date. All HTML
attributes are escaped; script data uses inert escaped JSON. Home has website
cards, canonical URL and a lead image. Indexable home HTML now honors its setting.

Payload media sizes are collected generically (including thumbnail/card/feature),
checked individually against the existing same-origin `/api/media/file/` policy,
validated for dimensions and deduplicated/sorted by width. Each rendered srcset
keeps one aspect ratio, so cropped variants cannot swap to a different original
ratio after loading. The hero/social choice
is the smallest size at least 800px wide, with the largest available/original as
fallback. Cards use a 420px target. Every rendered source is checked again.
Cards, hero and Lexical body figures share srcset/sizes and intrinsic dimensions;
captions and credits are escaped. Missing dimensions are omitted, never invented.

The public server supplies a responsive hero preload and safely serialized public
article data. The browser consumes that data on initial hydration instead of
blanking the server article and fetching it again. Subsequent navigation retains
anonymous API reads and normal error handling. No staff credentials are involved.

## Public quality changes

Shared layout reserves room during asynchronous reads, stabilizing the footer.
Critical local fonts are preloaded with optional font display; only the Latin
faces used by this English edition are bundled, with system fallback for other
scripts. Form bindings/Turnstile and form CSS load on contact/submission pages.
The optional public Node host compresses text responses with negotiated gzip and
preserves HEAD semantics. Existing contrast, landmark and alt checks remain;
wordmark whitespace now matches its accessible name, secondary mobile copy is
larger, and select/textarea focus outlines are explicit.

## Validation and evidence

See [mobile Lighthouse results and screenshots](evidence/public-seo-media/README.md).

- `npm run test:unit`: 53 tests, including pagination bounds, XML escaping,
  published filtering, cache/failure/noindex policy, metadata, image safety and
  responsive captions, and gzip/HEAD behavior.
- `npm test -- --workers=2`: 60 public responsive/navigation/accessibility tests,
  including the experimental visible-label rule and on-demand form resources.
- `npm run test:newsroom -- --workers=2`: 58 tests.
- `npm run test:forms -- --workers=2`: 34 tests. Locally port 5175 was already in
  use; an external config ran the unchanged suite on 6185.
- `npm run test:advertising -- --workers=2`: 22 tests.
- `npm run test:cms`: 22 desktop/mobile tests against disposable PostgreSQL and
  real anonymous Payload REST, including valid parsed XML, published-only feeds,
  staging robots, social cards, no duplicate hydration fetch, inline responsive
  media/captions, and clean category/static routes. External Turnstile transport
  is stubbed by the pre-existing test-only harness.
- `npm run export:pages`, `npm run check:pages`: compiled export regenerated and
  matched. CI runs unit/build/export checks and all existing public suites.

To reproduce mobile production audits (Lighthouse is a pinned development-only
dependency, never bundled into the site):

```sh
npm ci
npm ci --prefix apps/cms
PUBLIC_AUDIT_DIR=/tmp/public-audit PUBLIC_AUDIT_SCREENSHOTS=true npm run test:cms
```

The harness uses a disposable loopback database, real published CMS fixtures and
a production Vite build rearranged exactly like `prepare-pages.mjs`. It serves
through `createPublicServer` on an allowed CMS CORS origin. It runs home,
`/#latest`, a clean article URL and `/#live`, then captures desktop/Pixel 7
screenshots. `CHROMIUM_PATH` can select Chrome (default `/usr/bin/chromium`).
`PUBLIC_AUDIT_SOURCE` can point to a baseline checkout with dependencies installed
for the same harness/fixtures to audit its production frontend and public host.
Reports are local evidence, not a deployed site or a production traffic benchmark.
