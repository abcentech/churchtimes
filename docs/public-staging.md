# Public staging acceptance — issue #15

This frontend change targets `feat/newsroom-mvp`, starting at `ba1d653`. It does
not alter CMS contracts, newsroom/archive applications, production WordPress,
DNS or infrastructure. No merge or deployment is included. Interface notes for
Claude/Gemini are recorded in issue #15; review against the merged
[CMS API contract](../apps/cms/docs/api-contracts.md) (v1.3).

## Public build configuration

All `VITE_` values are shipped to the browser. Set only public values:

```dotenv
VITE_PUBLIC_CMS_URL=https://cms.staging.example.test
VITE_PUBLIC_SITE_URL=https://public.staging.example.test/
VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA
VITE_TURNSTILE_ACTION=submit-story
VITE_PUBLIC_SUBMISSIONS_URL=
VITE_PUBLIC_CONTACT_URL=
```

The domains above are examples, not provisioned services. CMS URL is an origin
with no path, query or credentials. HTTPS is required outside loopback. The story
endpoint defaults to the CMS origin plus `/api/public/submissions`. Contact
sending stays disabled because the merged CMS has no contact delivery endpoint.

For manual staging only, Cloudflare's always-pass test site key above pairs with
its test secret `1x0000000000000000000000000000000AA` **on the server**. These
publicly documented test credentials provide no spam protection. Never use them
on production. Register real hostname-bound keys before production use; keep
`TURNSTILE_SECRET_KEY`, `PAYLOAD_SECRET`, database credentials, preview tokens and
staff credentials out of every `VITE_` variable and frontend asset.

On the CMS configure the exact public origin (no path/trailing slash) in BOTH
`CMS_CORS_ORIGINS` and `PUBLIC_SUBMISSION_ORIGINS`. Set
`TURNSTILE_ALLOWED_HOSTNAMES` to the actual public hostname and
`TURNSTILE_EXPECTED_ACTION=submit-story`, or a documented comma-separated
allowlist containing the chosen frontend action. Do not disable verification or
origin checks. PR #8 exposes `Retry-After`; verify the deployed reverse proxy
preserves that header and CORS headers on success, validation and throttling.

Public reads and submissions use `credentials: 'omit'`; they need no CMS cookie
or authorization token. Gemini's staff newsroom has a different contract: its
host-only SameSite=Lax CMS authentication cookie requires compatible same-site
HTTPS hosting and credentialed CORS/CSRF configuration. Public success here does
not prove cross-site staff authentication works, particularly from github.io.

## URLs, content and SEO boundaries

With a CMS configured, public reports use `/reports/` and `/reports/:slug/`,
categories use `/sections/:slug/`, and search uses `/search/?q=...`. Existing CMS
hash links are normalized. A configured site base path, such as `/churchtimes/`,
is retained in routes and canonical URLs. The HTML base element ensures compiled
assets resolve from that base on fresh article URLs. The dated static edition
and its saved briefings remain separate; it is not substituted for failed CMS
category/search requests.

Category slugs/titles resolve through paginated `/api/categories` to numeric
relationship IDs before querying articles. Unknown categories show an unavailable
state rather than an unfiltered feed. Search sends published-only title, excerpt
and public-byline `like` filters. List/detail pagination, byline, populated media,
corrections and publication access remain governed by the CMS.

The host MUST serve the public HTML entry for clean public paths while serving
`site/` assets normally. For example, a separately provisioned nginx staging
server at the origin root can use:

```nginx
location /site/ { try_files $uri =404; }
location / { try_files $uri $uri/ /index.html; }
```

Adapt the document root/fallback to the configured base path. Vite dev/preview
provide this fallback locally. Native GitHub branch Pages does not provide an
arbitrary SPA rewrite; enabling CMS clean routes there without a reviewed hosting
solution will break direct requests. This PR does not change Pages settings.

Loaded published articles receive canonical, Open Graph and NewsArticle metadata,
removed on navigation/unavailable states. This metadata is **client rendered**.
It is not server-rendered HTML, prerendered social cards, a sitemap or proof of
search indexing. Server-rendered/prerendered article HTML, cache invalidation,
redirects from old .net paths, robots/sitemap and social-crawler verification
remain a separately reviewed SEO/hosting gate. Hash routes alone are not SEO.

## Reproduce safely

Use Node 24 and the existing checkout; no additional worktree is needed:

```bash
npm --cache /tmp/churchtimes-npm-cache ci --no-audit --no-fund
npm --cache /tmp/churchtimes-npm-cache ci --prefix apps/cms --no-audit --no-fund
# When system Chromium is unavailable:
npx playwright install --with-deps chromium
npm run test:unit
npm test -- --workers=2
npm run test:forms
npm run test:newsroom
npm run test:cms
PUBLIC_CMS_TEST_BUILD=true npm run test:cms
npm run export:pages
npm run check:pages
```

`test:cms` creates a disposable embedded PostgreSQL cluster, applies committed
migrations and creates synthetic articles, categories, staff fixtures and a
generated PNG. It does not import live news or photographs. Optionally use
`TEST_DATABASE_URL` pointing to a disposable loopback database whose name contains
`test`; migrations/fixtures are writes, so never use a live database. The host
binds loopback only, requires NODE_ENV=test, generates server secrets, clears
inherited provider/SMTP credentials, then cleans its fixtures and shuts down.
Do not expose or deploy the `/__test/*` controls or fixture host.

The browser sends real HTTP requests through the imported Next proxy guards and
Payload REST handlers into PostgreSQL; no CMS API responses are mocked in the
CMS suite. This is not a full deployed Next HTTP stack or reverse proxy. The
Cloudflare widget script and external Siteverify transport use explicit test
stubs. Separate mocked browser suites cover gateway 401, malformed receipts,
provider script failures, timeout and accessibility. Anonymous submissions do not
naturally produce CMS 401; we do not label the mocked gateway test a real CMS 401.

Desktop Chrome uses 1440×1000; mobile uses Pixel 7/Android-sized Chromium emulation.
These are not physical-device or TalkBack checks. The compiled CMS run verifies
fresh clean article URLs and reload against the same real handlers/database.
Tests confirm real 201 storage as `new`, review/approval/publication permissions,
published media/corrections, draft exclusion, numeric category filters, search,
canonical cleanup, real 400/403/409/429, cooldown and fresh verification, plus a
socket dropped AFTER a genuine 201 persisted. That loss retains the draft and
never invents a receipt or automatically retries.

The test runner preserves Playwright's exit status after PostgreSQL cleanup.
The CI public CMS workflow runs both development and compiled acceptance modes.

## Remaining staging gates

- Provision actual staging origins and configure clean-path rewrites, TLS,
  CORS/CSRF, CSP and provider keys; verify external Cloudflare with test keys there.
- Confirm deployed Next/reverse-proxy headers, request limits and cookies with
  Claude/Gemini. Local tests do not attest these deployed interfaces.
- Complete the server-rendered SEO gate above before claiming crawler readiness.
- Contact delivery, SMTP, staff dashboard integration, physical Android and
  production rollout remain outside this public frontend change.

See the PR for exact executed commands and counts; prior issue #7 results are
historical, not results for this change.
