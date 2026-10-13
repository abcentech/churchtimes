# Public frontend mobile quality report

Implemented on `agent/codex-mobile-quality`, starting from frontend commit
`0ce7f33` (PR #1), for `feat/newsroom-mvp`. PR #1 must merge first; this branch
includes its changes until then. No production deployment, WordPress change,
backend API/schema change, or newsroom administration change occurred.

## Findings and improvements

- Mobile navigation showed a partially clipped, horizontally scrolling section
  list; tablet readers did not have the sections dialog. Use the existing native
  dialog below 1001px, keep reading-list/search access, and include advertising.
  Menu/search controls expose their dialog relationship and expanded state.
- Narrow two-column cards used 10px summaries. Use one column through 430px,
  readable summaries/metadata, wrapping search forms and long article text.
  Increase mobile navigation, filtering, saving, pagination and footer targets.
- Secondary text on sage panels failed 4.5:1 contrast; numbered perspectives
  failed 3:1. Darken those colours without changing the editorial palette. Keep
  clear focus outlines, including light outlines on dark feature panels.
- Loading more stories replaced the focused button. Focus the first new headline
  after pagination; retain retry focus on failures and announce updated results.
- Clipboard-denied sharing gave only an instruction. Both briefing and CMS
  article sharing now offer a labelled, selectable link in a native dialog.
  Escape restores the share/search/menu opener. Native dialog focus behaviour
  preserves access to browser chrome and prevents focus on background controls.
- Explicit smooth scrolling and hover transforms bypassed reduced-motion
  preferences. Respect the preference in navigation and CSS.
- Original photos were downloaded at full size even for small rail thumbnails.
  Commit WebP derivatives at up to 320/640/1024px, keep originals and attribution,
  provide intrinsic dimensions and context-specific `sizes`/`srcset`, retain
  eager/high-priority lead images and lazy images below the fold.
- Abort discarded CMS requests on route changes; disable retry controls while
  loading. Keep the published-only query, client filtering, anonymous requests,
  timeout, safe rich-text rendering and `VITE_PUBLIC_CMS_URL` contract unchanged.
  No new response cache is introduced that could retain withdrawn articles.
- The decorative, aria-hidden CT watermark generated a tablet axe contrast
  finding. Render that ornament as an aria-hidden SVG; meaningful text remains
  subject to the full accessibility assertions.

## Measured performance

Production Vite preview, Chromium 154, 390×844, three fresh contexts per version,
cache disabled, 150ms simulated latency, 150,000 bytes/s download, 75,000 bytes/s
upload, and 4× CPU throttling. Measurements cover the homepage without a CMS.
Resource bytes are summed `encodedBodySize` for subresources, excluding the HTML
response and HTTP headers. Local preview serves these assets without gzip.

| Measurement | Before | After |
| --- | ---: | ---: |
| Median observed largest contentful paint | 4,012ms | 2,448ms |
| Homepage resource bytes | 571,234 | 304,442 |
| Median observed layout shift | 0.000785 | 0.000785 |
| Built JavaScript / gzip | 61.57 / 18.66KB | 64.68 / 19.69KB |
| Built CSS / gzip | 43.50 / 8.90KB | 46.10 / 9.40KB |

Resource bytes decreased **46.7%** and observed median LCP decreased **39.0%**.
JavaScript and CSS grew slightly for responsive metadata and accessibility
behaviour; image savings account for the net improvement. Axe is a development
only dependency and is not included in the website bundle. Local fonts already
use `font-display: swap`, Unicode subsets and system fallbacks; these are retained.
No analytics, external font requests, UI framework or service worker was added.
These are simulated laboratory observations on a shared cloud host, not
Lighthouse scores or real-user Core Web Vitals. Physical Android, TalkBack and
unstable real mobile networks were not tested.

Raw observations: [before](mobile-quality/before.json),
[after](mobile-quality/after.json). To repeat against a running production preview:

```bash
npm run build
npm run preview -- --port 4173 --strictPort
# In another terminal:
node tools/mobile-audit.mjs after
```

`AUDIT_BASE_URL` can select another local static export. The audit writes
screenshots and JSON under `docs/mobile-quality/`. Committed image derivatives
need no build dependency. To refresh them after changing source photographs,
run `python tools/optimize-news-images.py` with Pillow installed, then build and
export; the script preserves originals and avoids upscaling.

## Validation

Viewports: **320, 360, 390, 430, 768, 1024 and 1440px**. Public pages, search and
empty results, reading lists, contact/advertising, menu/footer navigation,
briefings, mocked newsroom feeds/articles, long content, loading and outage
states were checked. Browser inspections reviewed the 320/390/1440 homepage,
320px sections dialog, and a 320px mocked article screenshot.

| Check | Result |
| --- | --- |
| `npm run test:unit` | 8 passed |
| `npm test -- --workers=2` | 48 passed |
| `npm run test:newsroom -- --workers=2` | 32 passed, controlled API fixtures |
| `npm run build` | Passed |
| `npm run export:pages` then `npm run check:pages` | Passed |
| Public tests against plain static `/churchtimes/` export | 48 passed |
| `git diff --check` | Passed |

The static check used `python -m http.server 4180 --bind 127.0.0.1 --directory
/workspace` and `TEST_BASE_URL=http://127.0.0.1:4180/churchtimes/ npm test --
--workers=2`. No tests were skipped. Added regression coverage checks viewport
fit and clipped content, WCAG A/AA axe findings, keyboard/dialog focus and
Escape, focus outlines, touch targets, pagination announcements, denied
clipboard fallback, responsive image dimensions, reduced motion, CMS outages
and cancellation. Existing suites still check search, reading-list persistence,
all story routes, publication filtering and safe rendering. Automated axe checks
passed for the selected public pages/dialog and mocked feed/article views; this
is not a complete WCAG conformance certification.

## Screenshots

| Width / view | Before | After |
| --- | --- | --- |
| 320px homepage | [Before](mobile-quality/before-320.png) | [After](mobile-quality/after-320.png) |
| 390px homepage | [Before](mobile-quality/before-390.png) | [After](mobile-quality/after-390.png) |
| 1440px homepage | [Before](mobile-quality/before-1440.png) | [After](mobile-quality/after-1440.png) |
| 320px mocked article | — | [After](mobile-quality/after-mocked-report-320.png) |
| 320px menu | — | [After](mobile-quality/after-menu-320.png) |

## Dependencies and remaining limits

Live Payload integration was **not** verified. Backend owners must confirm
anonymous published-only access, CORS and the existing article/Lexical contract.
CMS uploads, authors and internal document links remain unsupported until that
contract is defined. The static edition's search and reading list do not yet
include CMS articles, as in PR #1. Client filtering does not replace server-side
publication permissions. CMS availability and latency were tested with mocks,
not a live service. No new backend infrastructure or deployment caching policy
was introduced; hashed assets can use deployment-supported cache headers later.

[PR #3](https://github.com/abcentech/churchtimes/pull/3) is open for review,
targeting `feat/newsroom-mvp` from `agent/codex-mobile-quality`. GitHub API access
was restored after adding `api.github.com` to the environment network draft.
The frontend changes are not yet in the integration branch. After PR #1 merges,
update this branch against the integration branch and verify that the PR diff
contains only these quality changes; do not merge the PR automatically.
