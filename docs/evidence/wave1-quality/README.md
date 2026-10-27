# P11 production quality evidence

Local gate completed on 15 October 2026 against integrated `feat/newsroom-mvp`
(including #30/#32) plus this PR. [Full numeric/boolean aggregate](local-quality.json).
This gate ran locally before the PR was pushed; CI did not reproduce these numbers. No live host, real export or private personal data was used.

All eight desktop/Pixel 7 journeys passed WCAG, label/heading, overflow, alt,
landmark, skip-focus, local-origin and console checks against real Payload REST.
External Turnstile transport was **STUBBED and unused**. The checker unit tests
use report **STUBS** and are not part of this browser evidence.

| Page | Performance | Accessibility | Best practices | LCP ms | CLS |
| --- | --- | --- | --- | --- | --- |
| Home | 93 | 100 | 100 | 3233 | 0.000 |
| Latest | 93 | 100 | 100 | 3162 | 0.040 |
| Article | 99 | 100 | 100 | 2257 | 0.000 |
| Live | 96 | 100 | 100 | 2704 | 0.041 |

Initial JS gzip: 34,609 bytes; initial CSS gzip: 9,946 bytes; shipped fonts: 159,536 bytes. All declared budgets passed. This is one recorded mobile audit,
not a statistical performance guarantee. Staging noindex remained enabled.

Reproduce with `npm run test:quality`; CI publishes its own aggregate rather
than relying on this checked-in sample. Private raw DOM/network reports remain
local and ignored. This does not constitute a production or staff cross-app
launch approval.

The full public browser suite passed 62 tests, including the deterministic
search-input/history regression. The real-CMS suite passed 24 tests including
clean-article keyboard skip focus. Validator unit tests: 58 passed.
