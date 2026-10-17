# Wave 1 P11: public quality gates

This public-only change adds `npm run test:quality` as a separate public production CI job.
It uses disposable local PostgreSQL and real anonymous Payload REST, builds the
production frontend, and serves it through `tools/serve-public.mjs` with the
same Pages asset layout as the normal build. It never accepts a live target or
changes a production host. No `apps/cms` / `apps/newsroom` source is edited.

## Browser journeys

Home, latest, a published article and live discovery each run on desktop and
Pixel 7. The check waits for actual CMS-backed content, not just a static shell,
and requires:

- a successful HTTP response with staging noindex intact;
- one main landmark and h1, no document overflow, and alt attributes;
- no WCAG 2 A/AA or WCAG 2.1 A/AA violations;
- matching visible link labels and accessible names, with ordered headings;
- keyboard skip navigation that focuses the current page's main content;
- no console/page errors or requests outside the local public/CMS origins.

The gate found a real base-URL skip-link bug on clean articles. The enhanced
skip link now focuses within the current document without changing its URL.
A shared HTML response helper gives article, static and error skip links their
own path and
have a focusable main target for the JavaScript-disabled case. Duplicate history
and hash notifications are deduplicated after each completed route render,
preventing a second render from discarding an edited search input. The browser
regression exercises duplicate notifications, search submission and Back.

## Budgets

Lighthouse 12.8.2 then audits the four routes with its simulated mobile network
and CPU throttling. `tools/public-quality-budgets.json` is the reviewable budget:

| Gate | Limit |
| --- | --- |
| Performance | at least 80 on every route |
| Accessibility | 100 |
| Best practices | at least 95 |
| LCP | at most 6,000 ms |
| CLS | at most 0.1 |
| Console / visible-label audits | must pass, not merely be absent |
| Initial JavaScript, gzip | at most 40 KiB |
| Initial CSS, gzip | at most 12 KiB |
| All shipped WOFF/WOFF2 fonts | at most 192 KiB |

`unit-tests/public-quality-policy.test.js` pins these exact numeric floors and
ceilings independently from the configurable validator, so weakening the budget
JSON fails the standard unit-test CI job. A deliberate policy change must update
this document and the pinned policy in review. Both push and pull-request quality
workflow filters include `vite.config.js`, ensuring build configuration changes
run the production budget check.

The LCP ceiling gives CI runner variance room; 2.5 seconds remains the product
objective. SEO's staging noindex penalty is intentional and does not cause a
false gate failure. Missing audits, failed navigation, missing build entries,
incomplete/duplicated journey records or missing output fail the check. No
retry discards a failed score or automatically raises a budget. The production
quality command has an eight-minute CI timeout and its job a fifteen-minute
timeout, so a stalled browser or CMS cannot occupy a runner indefinitely. A
timed-out run remains a failure; the normal failure diagnostic and artifact
steps still attempt to preserve the sanitized evidence.

The wrapper writes an incomplete-run failure record before starting, so a failed
run cannot leave an old successful aggregate as its current evidence. Raw
Lighthouse files stay in ignored local output; CI uploads only small numeric /
boolean aggregate files, without DOM dumps, article titles, tokens or personal
data. Browser test failures additionally use Playwright's GitHub reporter and
retain test evidence for seven days, making failures reviewable without a log
archive download. Failed production runs also annotate their fixed validator
messages and numeric page metrics, making the cause readable if artifact storage
is unavailable. Raw Lighthouse reports and page URLs are never annotated.

## Validation boundaries and reproduction

```sh
npm ci
npm ci --prefix apps/cms
npx playwright install --with-deps chromium
npm run test:quality
```

`CHROMIUM_PATH` may select an installed browser. Otherwise the tool uses system
Chromium when present, or Playwright's installed Chromium, including on CI.
`PUBLIC_QUALITY_OUTPUT` changes the local output directory. Defaults deliberately
force staging, disable supplied verification/ad records and screenshot-only
modes, and use only disposable CMS fixtures. No third-party script is activated.

The real public journeys use synthetic article metadata. The existing homepage
edition is unchanged. External Turnstile transport is **STUBBED** by the existing
test host and unused by these read-only checks. Validator unit reports are
explicitly **STUBS**, never browser evidence. This gate does not replace Claude's
CMS-owned staff cross-app journeys, actual migration QA or owner phone sign-off.

P2, legacy-corpus and subsequent approved Wave journeys must retain their own
real-endpoint browser checks. PR #37 enables its 50-article corpus in CI; the
four-route budget is independent and does not claim C1's import pipeline passed.
No P1/P4/P5/P6 or P7–P9 implementation is included here.

See [local numeric evidence](evidence/wave1-quality/README.md). If combining this
PR with another frontend PR, regenerate `npm run export:pages`; generated assets
are bookkeeping, and the public source changes remain separate.
