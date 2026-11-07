# P10 synthetic legacy-rendering evidence

Run on 15 October 2026 against the current integrated CMS image hooks and the
public renderer in this PR. This is local, disposable PostgreSQL + real Payload
REST, with synthetic article data. External Turnstile transport is **STUBBED**
and unused. It is not a WordPress import or a staff cross-app staging sign-off.

- `npm run test:unit`: 57 passed, including four new renderer/corpus checks.
- `PUBLIC_LEGACY_SAMPLES=true npm run test:cms`: 24 passed; the two corpus
  journeys each checked **all 50 synthetic articles**, desktop and Pixel 7.
- An additional corpus-only run records the two complete per-article result
  files and screenshots below. Zero WCAG violations, console/page errors or
  root overflow were observed across those 100 article views.
- Production export regenerated and `npm run check:pages` matched.

| Browser | All 50 result records | Synthetic article screenshot |
| --- | --- | --- |
| Desktop | [JSON](desktop.json) | [View](desktop.png) |
| Pixel 7 | [JSON](mobile.json) | [View](mobile.png) |

All data and the geometric image are synthetic. Unsafe HTML/JavaScript nodes in
the corpus are deliberately excluded by the renderer. No real personal data or
WordPress export was used. The existing URL shape and media-origin restriction
remain in place while C1, D1/D2 and P1 are pending.
