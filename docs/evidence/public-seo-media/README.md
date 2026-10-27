# Mobile production-build evidence

Baseline: integrated `feat/newsroom-mvp` at `3bdf345` (before this PR).
After: the implementation in this PR. Measured 14 October 2026, one cold
Lighthouse 12.8.2 mobile navigation per route, Chromium 154.0.8037.57 on this
cloud host; simulated mobile throttling, 4× CPU slowdown, 412×823 viewport.
Both runs use the same disposable real Payload/PostgreSQL fixture harness,
production Vite/Pages asset layout and `tools/serve-public.mjs` public host.
No Vite dev server, API response mocking or production deployment is used.
Fixture IDs/ports vary. Scores vary with runtime load; these are recorded runs,
not a statistical performance guarantee. Earlier diagnostic runs were discarded
before fixing the audit CORS origin and production asset layout.

| Page | Performance before → after | Accessibility | Best practices | SEO |
| --- | --- | --- | --- | --- |
| home | 83 → 91 | 100 → 100 | 100 → 100 | 60 → 66 |
| latest | 72 → 93 | 100 → 100 | 96 → 100 | 60 → 63 |
| article | 67 → 99 | 100 → 100 | 96 → 100 | 66 → 69 |
| live | 76 → 96 | 100 → 100 | 96 → 100 | 60 → 63 |

| Page | LCP seconds before → after | CLS before → after |
| --- | --- | --- |
| home | 4.21 → 3.45 | 0.000 → 0.000 |
| latest | 3.10 → 3.16 | 0.386 → 0.040 |
| article | 3.36 → 2.26 | 0.595 → 0.000 |
| live | 2.80 → 2.70 | 0.327 → 0.041 |

Staging **intentionally remains noindex** in both runs. This lowers Lighthouse's
SEO score; crawlability is not enabled to improve the score. Unit tests separately
verify allow/sitemap/index behavior with `PUBLIC_INDEXABLE=true`. Mobile secondary
text and the visible brand label are improved. Existing contrast, landmark,
heading, alt and focus checks remain green. The final experimental label-content
name audit also passes on all four pages.

Article LCP is below 2.5s in this run. Home/latest/live still have LCP headroom:
the SPA startup and font/render dependency chain remain. Remaining JPEG delivery
and CMS cache/compression opportunities belong to the CMS/media host; this PR
uses its available safe size variants and leaves that backend unchanged.
The staging fixture host does not compress/cache API responses. Shared edition
JS/CSS still contain styles/data for other public routes; form bindings, Turnstile
and form CSS are deferred, and the Node public host compresses frontend text.
No public live implementation changes were needed for the shared layout gains.

## Screenshots

Captured through the production public host using real published CMS fixtures.
The article and live titles are synthetic fixtures; the photo comes from the
existing edition. Desktop viewport: 1440×1000. Android-sized Pixel 7 emulation:
412×839 CSS pixels, DPR 1 for reviewable image files. Browser tests also run the
standard Pixel 7 device profile. Screenshots wait for fonts and images to decode.

| Page | Desktop | Android-sized |
| --- | --- | --- |
| home | [View](home-desktop.png) | [View](home-android.png) |
| latest | [View](latest-desktop.png) | [View](latest-android.png) |
| article | [View](article-desktop.png) | [View](article-android.png) |
| live | [View](live-desktop.png) | [View](live-android.png) |

Full article (including inline responsive figure and caption):
[desktop](article-full-desktop.png), [Android-sized](article-full-android.png).

## Raw evidence and reproduction

[Before summary](before-summary.json) and [after summary](after-summary.json)
include scores, LCP/CLS, timestamps and failed audit identifiers. Full original
Lighthouse results are preserved as `before-<page>.json.gz` and
`after-<page>.json.gz`. Decompress a report and open it in the Lighthouse viewer,
or inspect its audits/configSettings/network records directly.

See [reproduction commands](../../public-seo-media.md#validation-and-evidence).
A baseline source directory can be made with `git archive 3bdf345`, dependencies
installed there, then selected via `PUBLIC_AUDIT_SOURCE=/path/to/baseline` while
running the current harness. The harness keeps fixture CMS CORS and production
asset layout consistent across the comparison.
