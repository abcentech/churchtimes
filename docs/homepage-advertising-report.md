# Homepage refinement and advertising readiness

Branch: `agent/homepage-advertising`. Base: `feat/newsroom-mvp`.
PRs **#1, #3 and #4 were still open** at the final dependency inspection.
This branch starts at #3 (`e81637a`) and merges #4 (`d171dd3`) only into this
new branch, preserving mobile quality and public forms. `ae4c9b1` is the combined
frontend baseline. No existing PR branch was modified or reopened.

Merge #1, #3 and #4 before this PR. After integration, update this branch against
`feat/newsroom-mvp`, resolve any conflicts here, regenerate/verify the export,
and confirm the PR diff contains only the homepage/advertising additions.
No PR was merged and no production deployment, WordPress, Payload, authentication
or Gemini dashboard change occurred.

## Homepage

Keep the existing masthead, lead story, typography, palette, navigation and
reading tools. The homepage now contains featured reporting, a latest-story
list and one perspectives section, plus the existing optional published CMS
reports. Remove the repeated society/interview feature blocks and repeated
publication statement. Keep all stories available through sections and search.

The allocator gives each canonical story slug one homepage appearance, including
filters/load-more and overlaps with CMS homepage reports. A deliberate category
filter takes precedence over the supplementary perspectives group. The lead and
headline rail remain separate from the latest list. Existing Business/Interviews
filters, reading-list persistence, article sharing and newsroom pagination remain
functional. CMS API/publication/safe-content contracts remain unchanged.

| Unconfigured homepage measurement | Before | After |
| --- | ---: | ---: |
| Story headline appearances | 18 | 13 |
| Distinct stories | 11 | 13 |
| Page height at 390×900 | 11,087px | 8,017px |
| Page height at 1440×900 | 5,485px | 3,678px |

Homepage height decreased about 28% on Android-sized screens and 33% on desktop,
while the first view of the complete page includes more distinct reporting.
These observations use the current static edition without a configured CMS.

## Advertising

[Claude's delivery contract](advertising-contract.md) describes the proposed
public projection, paid/approved eligibility, schedules, creative dimensions,
priority and integration boundary. No backend endpoint was implemented.

Reusable **billboard**, **article-inline** and **mobile-banner** components use
explicit Advertisement/advertiser labels and a separate commercial boundary.
Valid direct campaigns take precedence; empty, expired, unsupported and failed
placements collapse. Intrinsic creative dimensions and responsive aspect ratios
reserve the served creative's height before it loads. Ads do not cover content,
autoplay, add analytics, or intercept article links. Paid campaign images are
lazy-loaded; link behaviour is labelled and keyboard-accessible.

`src/data/advertising.json` ships with **zero campaigns** and AdSense disabled.
The optional reviewed fallback-provider hook consumes only an already-filled
unit. It does not load Google scripts, create ad units, set publisher/slot IDs or
request ads. The app supplies no provider until a separate existing-configuration
review/integration is completed. Failed/unfilled fallback remains collapsed.
No production publisher configuration was reviewed or altered. Screenshots with
campaigns use explicit **test fixtures**, not live customers or sold inventory.

## Performance observations

[Raw comparison](homepage-advertising/performance.json): Chromium 154, 390×844,
three fresh-context runs per version, cache disabled, 150ms simulated latency,
150,000 bytes/s download, 75,000 bytes/s upload, 4× CPU throttling. The baseline
is the archived compiled `ae4c9b1` frontend; after is the production Vite preview.
Both have no CMS and no active campaign. Byte counts sum subresource
`encodedBodySize` and exclude HTML/HTTP headers. Local servers do not gzip assets.

| Measurement | Before | After |
| --- | ---: | ---: |
| Median observed LCP | 3,128ms | 2,512ms |
| Subresource bytes | 405,106 | 345,779 |
| Median observed CLS | 0.000675 | 0.000785 |
| Resource requests | 11 | 11 |
| Built JS / gzip | 79.91 / 25.17KB | 82.39 / 26.53KB |
| Built CSS / gzip | 49.85 / 10.15KB | 51.29 / 10.42KB |

Observed LCP improved 19.7% and resource bytes decreased
14.6%. JS/CSS grew slightly for
allocation and advertising readiness; imagery accounts for the net savings.
CLS stayed near zero and increased slightly. Served-ad tests separately verify
that the creative's reserved height changes by less than 1px on image delivery.
Failure collapse can move following content; validate assets before activation.
These are simulated observations, not Lighthouse scores, real-user CWV or proof
of performance with production creative/AdSense. Physical Android/TalkBack and
live commercial delivery were not tested.

To repeat the comparison, serve the archived compiled baseline on port 5190 and
the current production preview on 4173, then run
`node tools/measure-homepage-advertising.mjs`. Baseline/current URLs can be set
with `BASELINE_BASE_URL` / `AUDIT_BASE_URL`. The baseline can be extracted with
`git archive ae4c9b1 index.html site` into an external temporary directory;
no worktree or repository reset is required.

## Tests

| Validation | Outcome |
| --- | --- |
| `npm run test:unit` | 21 passed |
| `npm test -- --workers=2` | 56 passed |
| `npm run test:newsroom -- --workers=2` | 34 passed; mocked API |
| `npm run test:forms` with local port override | 28 passed; mocked API/Turnstile |
| `npm run test:advertising -- --workers=2` | 22 passed; campaign/fallback fixtures |
| Public tests on compiled `/churchtimes/` subpath | 56 passed |
| Build, export verification and `git diff --check` | Passed |

The original forms command encountered an occupied 5175 port. An external
`/tmp/task5-forms.config.mjs` imported the existing config and changed only the
server/base/API ports to 5185; `npm run test:forms -- --config
/tmp/task5-forms.config.mjs --workers=2` ran the unchanged suite. CI uses the
repository's normal forms config. No tests were disabled or skipped.

Checks cover 320, 360, 390, 430, 768, 1024 and 1440px; filtered/load-more uniqueness;
CMS overlaps; direct eligibility and unsafe URLs; labelled responsive placements;
reserved size; image-error/empty collapse; keyboard and axe; disabled/unfilled
fallback and direct precedence; existing articles, reading lists, search, public
forms, publication filtering and newsroom error states. Automated accessibility
checks are supplementary, not a complete WCAG conformance certification.

## Screenshots

| View | Before | After: unsold | After: demo campaign |
| --- | --- | --- | --- |
| Android-sized 390px homepage | [Before](homepage-advertising/before-390.png) | [Collapsed](homepage-advertising/after-unsold-390.png) | [Fixture](homepage-advertising/after-demo-campaign-390.png) |
| Desktop 1440px homepage | [Before](homepage-advertising/before-1440.png) | [Collapsed](homepage-advertising/after-unsold-1440.png) | [Fixture](homepage-advertising/after-demo-campaign-1440.png) |
| Article advertising | — | No unsold slot | [390px](homepage-advertising/after-demo-article-390.png) · [1440px](homepage-advertising/after-demo-article-1440.png) |

To regenerate after screenshots, start Vite on 5177, then run
`node tools/capture-homepage-advertising.mjs`. It injects labelled campaign fixtures
only through the test browser; production configuration stays empty. Images in
these screenshots are warmed for complete visual inspection, independently of
the cold-context performance measurement.

## Outstanding integration

Claude must provide the approved paid-campaign projection and reliable creative
hosting before real inventory is served. Anonymous CMS/public forms, CORS and
real Turnstile verification remain backend dependencies from #1/#4. AdSense
account/loader/slots and consent/privacy must be reviewed separately before the
fallback provider can be connected. No billing, revenue measurement or deployment
was performed. Branch update after #1/#3/#4 integration remains a future step;
this PR must not merge first or deploy automatically.
