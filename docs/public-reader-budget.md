# Reader feature loading and bundle headroom (Wave 3 B10)

This source-only stack depends on public routing #50 (including #44), reader features #46–#49, story consent #51, and source-build policy #57. Review B10's final commits separately from those prerequisite branches. It does not regenerate `site/` or `index.html`; B11 remains conditional on feature integration.

Newsletter link capture and URL scrubbing stay in a small synchronous module. The C4/C5 validation, submission code, form UI and styles load only for configured forms or a newsletter token page. The previous shared contract import caused form submission code to enter the initial chunk even when form UI was lazy. The public contract module re-exports the capture helper for compatibility.

GA4 and direct advertising keep their configuration-gated imports. Local speech loads only on article pages; unavailable voices remain a progressive fallback. Optional form startup completes before attaching navigation handlers. Navigation then renders synchronously, preserving the new main landmark's focus when delayed advertising resolves. This fixes the interaction between #47's nonblocking delivery and #49's asynchronous form startup.

`npm run check:reader-budget` requires **3,072 gzip bytes of initial JS headroom** below the existing 40,960-byte ceiling. The existing ceiling and quality thresholds remain unchanged. The PR template records this check. A dedicated CI matrix builds with CMS configuration and both unset and synthetic optional-service configuration. Every provider identifier/domain in that matrix is a **STUB build fixture**; no host is served, deployed or contacted by the build.

Local validation before the final navigation adjustment: all 121 unit tests passed; the fully configured synthetic build measured 36,397 initial gzip bytes, leaving 4,563 bytes. The disposable real CMS build measured about 37.13 KB. Final production quality and browser evidence is recorded in the PR. CMS C4/C5/ads provider integration is not claimed by synthetic transport checks.
