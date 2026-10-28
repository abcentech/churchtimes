# Historical Wave 2 public-site validation (before review fixes)

Validated on 2026-10-16 against integration base `ec2d798`, in unpublished local
branch `agent/wave2-validation`, final snapshot `5bca99f`. These results exercise
the pre-review combination of the public PRs below, not their current revised
heads. CI checked the individual PR heads; **CI did not reproduce this combined
local run**. Keep the numbers as historical evidence, not a current release gate.
No production setting was selected and nothing was deployed in this round. Status update 2026-10-27: #41, #42 (through #57 and #43) and #43 have since merged into feat/newsroom-mvp after review fixes, so the legacy YouTube link rendering is now present; the numbers below are from the earlier local combination and were not re-run on the merged base.

## Review inventory and dependencies

| Session | PR | Scope / dependency |
| --- | --- | --- |
| A | [#41](https://github.com/abcentech/churchtimes/pull/41) | A7: horizontal-only ads.txt records and GET/HEAD/POST headers |
| A | [#42](https://github.com/abcentech/churchtimes/pull/42) | A8: pinned budgets, Vite trigger, readable failures, form-test readiness and bounded CI |
| A | [#43](https://github.com/abcentech/churchtimes/pull/43) | A6: bounded tables, heading fixes, relative links, YouTube links only |
| A | [#44](https://github.com/abcentech/churchtimes/pull/44) | A1/A4: shared article template and optional C2 fields |
| A | [#50](https://github.com/abcentech/churchtimes/pull/50) | A2/A3/A5: redirects, junk handling, private smoke checker; depends on #44; also supplies neutral newsletter token-page shells |
| B | [#45](https://github.com/abcentech/churchtimes/pull/45) | B2/B3 shared form components and proposed-contract STUB tests; no site wiring by itself |
| B | [#46](https://github.com/abcentech/churchtimes/pull/46) | B1: optional analytics and shared explicit consent |
| B | [#47](https://github.com/abcentech/churchtimes/pull/47) | B4: optional advertising delivery, ETag/cache and failure collapse |
| B | [#48](https://github.com/abcentech/churchtimes/pull/48) | B5: clipboard fallback and optional on-device listening |
| B | [#49](https://github.com/abcentech/churchtimes/pull/49) | B2/B3 site wiring; depends on #45/#46 and #50 for clean token URLs |
| B | [#51](https://github.com/abcentech/churchtimes/pull/51) | Existing story-form spam-protection consent; shares #46's identical consent module |

Review and merge prerequisites before dependents, only when the owner authorizes
merging. This evidence PR includes #42 as a prerequisite; after it lands, its own
diff consists only of this evidence directory. #43 also includes the same bounded
quality-workflow guard. Keep both form readiness regressions when resolving
appended-test conflicts. The shared consent module must exist only once.

The small routing, analytics, advertising and form hooks meet in `src/main.js`.
Their one-line route handlers can conflict despite separate feature modules. The
tested combination preserves all of: configured `reportSlug` routing, the SEO
hydration guard, early newsletter-token scrubbing, lazy form UI, advertising
snapshot loading before browser rendering, navigation-generation cancellation,
and form field disabling while the lazy controller loads. Resolve those hooks
together. Feature PRs must not commit generated `site/`, `newsletter/`, or root
`index.html` changes. PR #57 checks the actual compiled source and explicitly
reports the committed export as pending. After all approved feature PRs merge,
one dedicated rebuild PR runs `npm run export:pages` and the unchanged strict
`npm run check:pages`; generated assets are never hand-merged. Repeat public
checks on that resulting approved integration branch. The final rebuild has not
been performed or authorized by this historical record.

## Combined checks

| Check | Result |
| --- | --- |
| Unit tests | 108 passed |
| Existing public browser suite, including new reader/readiness checks | 70 passed |
| Existing forms suite, including C5 and loading failures | 38 passed |
| New reader-form contract browser suite | 46 passed; explicitly STUBBED endpoints and Cloudflare transport |
| Configured advertising delivery browser suite | 4 passed; explicitly STUBBED C3 endpoint |
| Existing advertising placement suite | 22 passed; synthetic campaign fixtures / STUB adapter |
| Public CMS integration, including legacy corpus | 28 passed; actual anonymous Payload REST and disposable PostgreSQL |
| Production route-template browser fixtures | 4 passed; explicitly STUBBED C2 article responses |
| Combined production quality | 8 desktop/mobile journeys and 4 mobile Lighthouse audits passed |
| Additional configured production-host reader probe | 8 passed on desktop/Pixel 7 with a non-root base path; C4/C5 and Cloudflare STUBBED |
| Production build / compiled export | Built and export match checked |

The CMS corpus checks 50 synthetic articles on desktop and Pixel 7, including a
full 100-row, 20-column table and article text after it. No real migration export
or personal data was used. External Turnstile script/Siteverify transport in the
CMS harness is **STUBBED**; it is unused by the quality journeys. This does not
replace Claude's staff cross-app journeys or editorial migration QA.

## Numeric production evidence

The combined audit uses actual CMS fixtures with new optional services **unset**.
Configured forms, analytics and advertising are separately tested using the
labelled transports above. The audit does not exercise real GA4, SMTP, AdSense,
paid campaigns or a real newsletter provider.

| Page | Mobile performance | Accessibility | Best practices | CLS |
| --- | ---: | ---: | ---: | ---: |
| Home | 92 | 100 | 100 | 0 |
| Latest | 94 | 100 | 100 | 0.0401 |
| Article | 99 | 100 | 100 | 0 |
| Live | 96 | 100 | 100 | 0.0415 |

Initial JS: 39,536 gzip bytes (limit 40,960); initial CSS: 10,037 gzip bytes
(limit 12,288); fonts: 159,536 bytes (limit 196,608). No budget was relaxed.
The 2.5-second LCP product target remains an improvement target; the documented
6-second CI ceiling is unchanged. Staging remains noindex, so these are not
production search-indexing scores or launch approval.

[`combined-quality.json`](combined-quality.json) contains only aggregate numbers,
fixed gate messages and boolean journey results. The additional
[`root-template-quality.json`](root-template-quality.json) records Session A's
separate real-CMS run with `PUBLIC_ARTICLE_PATH_TEMPLATE=/{slug}/`: eight journeys
and four audits passed. It proves routing compatibility without choosing D1.

[`configured-reader-stubs.json`](configured-reader-stubs.json) records a separate
local probe of the compiled combined site on the actual Node public host under
`/journal/`. On desktop and Pixel 7, confirmation/unsubscribe scrubbed the token,
rendered one h1 and sent no API request until an explicit POST button press;
configured contact and footer signup loaded no Cloudflare script before reader
permission and showed the prescribed receipts. C4/C5 and Cloudflare were
**STUBBED**. This supplementary probe is not a new CI lane or real CMS proof;
the repeatable component/contract suites remain the automated lanes above.

## Remaining external integration

C2 overrides, C7 delivery, C3 campaigns and C4/C5 forms still need Claude's landed
CMS implementations and real cross-app tests. Optional absent SEO fields keep
their title/excerpt fallbacks. `/reports/{slug}/` stays the default; redirect
patterns, analytics, newsletter/contact sending and advertising endpoint delivery
remain off without configuration. AdSense remains inert. No push or comments
implementation is part of this round. Owner decisions, real import/media-path
mapping, staging/phone sign-off and production approval remain separate gates.
