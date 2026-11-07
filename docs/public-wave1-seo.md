# Wave 1 public SEO groundwork (P2)

Source: [PR #35's build spec](https://github.com/abcentech/churchtimes/blob/agent/claude-go-live-plan/docs/go-live-build-spec.md), section 0 and P2.
This change targets integration only. No production setting, external service or
script is enabled. No `apps/cms` or `apps/newsroom` file is edited.

## What is available

PR #30 supplies published-only sitemap/RSS, category/static-page coverage, staging
robots/noindex, canonical article/share metadata and responsive CMS media. Its
public adapter was retested against the newer integrated CMS image hooks.

The optional Node public host now accepts two **public, owner-supplied** runtime
values (neither has a default value):

| Variable | Behavior |
| --- | --- |
| `PUBLIC_ADS_TXT_LINE` | One owner-supplied IAB publisher record, served verbatim apart from surrounding whitespace and one final newline at the host root `/ads.txt`. No comments, inferred IDs, generic publisher record or second line. Unset means 404 with an empty body. This does not load AdSense or deliver campaigns. |
| `PUBLIC_SEARCH_CONSOLE_VERIFICATION` | Owner-supplied opaque HTML verification token, inserted as a `google-site-verification` meta tag on server-rendered pages. Unset means no tag. No Google request, script, analytics ID or private verification file/key is introduced. |

Malformed configuration fails at startup. All existing staging noindex rules
remain in force, including when these inert values are supplied. Tests use
`example.test` / explicitly synthetic tokens, never an actual publisher identity
or private account value. The host's GET/HEAD policy applies to `/ads.txt` too.

## Dependencies deliberately left open

- **C2:** no SEO title/description/canonical-override fields are invented. Claude's
  written public projection contract must land and be reviewed before mapping
  them. Then test the exact fields through the real anonymous CMS endpoint and
  its browser rendering. RSS descriptions continue to use editorial excerpts.
- **D1 / C7:** current `/reports/<slug>/` canonicals remain. The recommended root
  path is a proposal, not an owner decision. This PR implements no P1 redirect or
  article-path change.
- **D2:** the current public host requires a Node runtime behind HTTPS, with
  runtime CMS/canonical configuration, for per-request CMS HTML, sitemap/RSS,
  robots and supplied verification/ads records. A plain GitHub Pages export
  cannot supply these dynamic routes, redirects or genuine per-URL error
  responses. Caddy can reverse-proxy the Node host; another platform needs an
  equivalent approved adapter after D2. This documents requirements, not a host
  selection or deployment.
- Actual publisher record and Search Console token still come from the owner;
  none is requested in chat or committed here. Their public values can be set in
  approved environment configuration when the owner authorizes that step.

## Validation boundaries

Unit tests use a **stub HTML template and synthetic configuration** to exercise
absence/validation and staging headers. They are not end-to-end tests.
The public CMS browser tests use disposable PostgreSQL, real Payload REST and a
compiled public article page to check the inert owner configuration, robots and
feed headers. The existing harness **stubs external Turnstile transport**; these
SEO tests never submit a form. This is public-host integration evidence, not the
CMS-owned staff cross-app launch gate or a production verification claim.

## Publisher-record validation hardening (Wave 2 A7)

Only spaces and horizontal tabs may separate fields in the single owner-supplied
`PUBLIC_ADS_TXT_LINE`. Vertical tabs, form feeds, newlines and Unicode whitespace
are rejected, including at the record edges; valid records retain their content.
GET and HEAD return the same plain-text, nosniff and short-cache headers; HEAD
returns no body. POST remains a 405 with nosniff and no-store and never returns
the publisher record. These checks use synthetic configuration and the actual
local public HTTP host, without contacting an advertising service or enabling scripts.
