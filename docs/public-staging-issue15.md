# Public staging readiness — issue #15

The public site accepts a genuine anonymous CMS receipt, reads published articles,
resolves category IDs, searches CMS title/excerpt/public byline, and serves clean
`/reports/:slug/` article URLs. Failures preserve text or earlier results and do not
substitute mock content. This branch extends PR #17 (`a6bdbd1`), which already includes
integration `ba1d653` and the pending public mobile/homepage enhancements. Existing
PR branches are untouched. PR #21 already incorporates #17; integrate this follow-up
there or after #17 reaches `feat/newsroom-mvp`. No automatic merge or deployment.

## Public interface with Claude and Gemini

- Anonymous requests use `credentials: omit`. Staff cookies and login response
  tokens are never read, forwarded or stored by the public frontend/SSR host.
- `GET /api/categories?where[slug][equals]=...` resolves a category's numeric ID
  before `GET /api/articles?where[category][equals]=ID`. Missing sections show an
  unavailable state; a slug is never passed into the relationship filter.
- Article reads always include `where[status][equals]=published`, `depth=1`,
  descending publication time and bounded pagination. Search adds Payload `or`
  `like` filters over title, excerpt and `bylineName`; staff author fields are absent.
- A form posts name/email/phone/title/body/categorySuggestion/location/empty website/
  turnstileToken. Only `201 {ok:true,reference}` is a confirmed receipt. Consent is a
  required local acknowledgement, not an invented stored CMS field. Contact remains
  disabled unless an independent compatible contact endpoint is configured.
- Safe field errors, challenge rejection, 401/403, 409, 413, 415, 429/Retry-After,
  response/body timeouts and network failures are retained from the verified adapter.
  A rejected Origin may surface as 403 or a network/CORS failure depending on the
  hosting layer. Both preserve input without a receipt or automatic retry.
- HTTP is supported only on reserved loopback hosts: localhost, 127.0.0.1, [::1]
  and `*.localhost`. Remote hosts require HTTPS; URLs with credentials are rejected.
- Same-origin `/api/media/file/` JPEG/PNG/WebP remains the media policy. Configure
  `CMS_PUBLIC_URL` to the same public CMS origin used by readers, so absolute media
  URLs match; alternate CMS hostnames are not silently trusted.
- Backend schemas, initial migrations, authentication, approvals, live events,
  Gemini's dashboard and Jules's archive source remain unchanged.

## Configure a disposable staging instance

Use Claude's disposable CMS/PostgreSQL staging instructions. Never reuse production
credentials or data. Public build values:

```dotenv
VITE_PUBLIC_CMS_URL=http://cms.churchtimes.localhost:3400
VITE_PUBLIC_SUBMISSIONS_URL=
VITE_PUBLIC_CONTACT_URL=
VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA
VITE_TURNSTILE_ACTION=submit-story
VITE_PUBLIC_SITE_URL=
```

The site key shown is Cloudflare's public always-pass development key. The CMS must
use the corresponding development secret, and its expected action/hostname settings
must match the chosen provider configuration. Never use test keys in production.
The automated harness uses the backend's existing test-only Siteverify transport
seam and a browser widget double; it does not validate the live Cloudflare provider.

Allow the exact public origin (scheme, hostname, port) in both `CMS_CORS_ORIGINS`
and `PUBLIC_SUBMISSION_ORIGINS`; keep the backend's Retry-After exposure. Public
reads/writes do not need credentialed CORS. Staff-session cookie/CORS configuration
belongs to the separately owned newsroom integration. Do not copy staff secrets
or cookie configuration into `VITE_` variables. Reserved localhost names must resolve
on the chosen client; the Playwright harness maps them in Chromium without hosts-file
or DNS changes. A Node SSR host also needs ordinary DNS/hosts resolution for its CMS
hostname, or a matching reachable CMS origin/media configuration.

## Build and serve articles with real HTML

`npm run serve:public` is an optional public frontend Node host, not a Payload server.
It serves the compiled `dist/` and anonymously fetches published article data to
render the body, public byline/media/corrections, canonical/OG metadata and escaped
NewsArticle JSON-LD in the initial HTTP response. It neither forwards incoming
cookies nor provides staff/write endpoints. Requests for unpublished/missing reports
return 404; CMS outages return 503 and noindex; slashless article URLs redirect 308.

```bash
npm ci
# Set public VITE_ values before this build; never include server secrets.
npm run build
PUBLIC_CMS_URL=http://localhost:3400 PORT=5373 npm run serve:public
```

Runtime public host settings:

| Variable | Meaning |
| --- | --- |
| PUBLIC_CMS_URL | Same CMS origin used by the public bundle; HTTPS except reserved loopback HTTP |
| PUBLIC_SITE_URL | Canonical publication HTTPS origin; match VITE_PUBLIC_SITE_URL |
| PUBLIC_BASE_PATH | `/` by default; `/churchtimes/` for a mounted subpath |
| PUBLIC_INDEXABLE | `false` by default; explicitly `true` only for an approved public release with a canonical HTTPS origin |
| PUBLIC_DIST | Optional compiled directory override, used by disposable tests |
| HOST / PORT | Loopback and 5373 by default; reverse proxy configuration is owned by deployment |

Staging is noindex by default. An explicit valid publication origin plus indexable
flag permits indexable article responses; the site does not guess the WordPress
canonical hostname. Canonical origin and base path must describe the actual serving
location. Navigation clears article metadata when leaving an article, and legacy
`#report/slug` links normalize to clean paths. Static edition search/results stay
separate from explicitly labelled published CMS search results.

## SEO and deployment boundaries

Hash routes are retained for the existing edition/navigation, not presented as
server-rendered CMS article SEO. Vite dev fallback supports clean paths for local
work; initial article HTML and accurate status codes require the provided host or
an equivalent SSR implementation. An unchanged static GitHub Pages or generic SPA
fallback does not provide that guarantee. Do not deploy this branch over WordPress.
Sitemap generation, full server-rendered section/search pages, redirecting historical
WordPress URLs, CDN caching, reverse-proxy TLS/CSP policy and production indexing
approval remain deployment/SEO follow-ups, not claims made by these tests.

Claude's PR #21 `05-public-gap.spec.ts` marks the old localhost gap as an expected
failure. Its owner must remove that `test.fail` when integrating this fix; otherwise
a now-successful test will intentionally turn the integration lane red. This change
does not edit `apps/cms` to adjust another owner's tests.

## Reproduce validation

```bash
npm ci
npm ci --prefix apps/cms
npm run test:unit
npm run test:cms
npm test -- --workers=2
npm run test:newsroom -- --workers=2
npm run test:forms -- --workers=2
npm run test:advertising -- --workers=2
npm run export:pages
npm run check:pages
```

`test:cms` provisions an isolated loopback PostgreSQL database (or uses a disposable
loopback TEST_DATABASE_URL containing `test`), applies the existing migrations through
fixtures, mounts actual Payload REST handlers, builds a temporary public bundle,
starts dev and compiled frontend hosts on free ports, then runs desktop and Pixel 7
browser tests. No CMS response or persistence is mocked. Only the external widget/
Siteverify HTTP transport uses test doubles. The runner tears down the processes and
PostgreSQL and deletes synthetic records/media; its temporary diagnostics are local.
It does not exercise the deployed Next proxy, production TLS, real provider verification,
physical phones or another owner's staff UI end to end. PR #21 owns the cross-app gate.

The public-CMS CI lane repeats this harness with a disposable Postgres service.
Local form/public tests used temporary port-only configs on 5195/5193 to
avoid occupied or reused servers; committed CI uses the normal configurations. No test is skipped or marked expected-failure in this public change.

For rollback, disable the public CMS/submission build values and rebuild the previous
frontend, preserving the static edition and email fallback. Do not revert backend
migrations or change production infrastructure as part of a frontend rollback.

## Results and screenshots (14 October 2026)

38 unit/contract tests, 56 public browser tests, 46 newsroom tests, 34 form tests,
22 advertising tests and 16 real CMS/PostgreSQL browser checks passed (212 total).
Build, generated export consistency and whitespace checks passed. No backend or
newsroom source differs from the inherited integrated base.

Synthetic CMS records and receipts, with an existing local edition photo uploaded
as the media fixture; no production data or real provider verification:

| Evidence | Desktop | Android-sized Pixel 7 |
| --- | --- | --- |
| Live article, canonical clean route | [image](public-staging/real-article-desktop.png) | [image](public-staging/real-article-mobile.png) |
| Initial article HTML without JavaScript | [image](public-staging/ssr-no-js-desktop.png) | [image](public-staging/ssr-no-js-mobile.png) |
| Real receipt through reserved localhost CMS URL | [image](public-staging/localhost-receipt-desktop.png) | [image](public-staging/localhost-receipt-mobile.png) |

To refresh screenshots intentionally, use `CAPTURE_PUBLIC_STAGING=1 npm run test:cms`.
Normal CI runs do not rewrite committed evidence.
