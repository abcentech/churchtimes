# Wave 3 reader integration and mobile checks

This source-only PR stacks the reviewed reader budget (#60), archived comments
component (#62), inactive push component (#59), and source build policy (#57).
Their existing Wave 2 dependencies remain explicit; this does not merge them.
No CMS/newsroom files, committed generated Pages assets, or production services
are changed. The final B11 export rebuild still waits for feature integration.

## Actual shell behavior

Published articles mount the configured C6 archived-comments component below
the body and dispose it on navigation. The component is imported only when
configured; names, dates and text are projected without email or HTML. C6 is
still a labelled STUB: the endpoint has not landed, and its missing legacy
parent join means this implementation intentionally shows a flat archive.

The privacy dialog exposes push only for a valid configured app ID. Configuration
alone makes no SDK request: explicit push consent and the Enable notifications
button are required. The shared loader handles panel replacement, deadlines and
withdrawal. Provider script, permission and worker transports in browser tests
are STUBS. No real provider is enabled. The worker is generated at the origin
root only for a configured build and omitted otherwise; export/check tools
verify its exact generated content. Non-root deployments require an approved
origin-root worker route before push can be enabled.

The CMS body renderer is loaded only on article routes, with cancellation
checked after import. The stored consent schema explicitly includes push:false
by default. Privacy choices now occupy separate rows with 44px touch targets.

## Reproduce and interpret evidence

- `npm run test:unit`: 134 tests passed locally after the final source changes.
- `PUBLIC_READER_SCREENSHOTS=true npx playwright test --config playwright.reader-integration.config.js`: four desktop/Pixel 7 shell journeys passed, with AXE checks, text/privacy assertions, explicit consent, withdrawal and route disposal.
- A build with all optional settings populated by synthetic values passes the actual-source validator and the 3072-byte headroom gate: initial JS 36143 gzip bytes, headroom 4817 bytes. Build settings do not contact providers.
- The budget CI matrix includes comments and push in its synthetic configuration.

The four images in `evidence/wave3-reader-integration/` were regenerated locally
from the final source on 2026-10-17. They show synthetic archived text and the
privacy controls; all API/provider transports are labelled STUBS. They are
local evidence, not a claim that CI ran the combined public-lane branch or that
real CMS comments, newsletter/contact, push delivery or production are ready.
