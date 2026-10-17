# Wave 3 combined public-lane evidence

Recorded locally on 2026-10-17 using production Vite output served by
`tools/serve-public.mjs`, real anonymous Payload REST and disposable PostgreSQL.
The audited source is integration `17e7900075be134da65c973048352b9198b994da`;
the earlier comparison is `9615d1f194916469a35b6e4e028bea402a39f0cd`.
The branch combines the review fixes and public feature PRs; neither source was
merged into `feat/newsroom-mvp` or `main`. The source history is available on the
review-only `agent/wave3-validation` branch; it has no merge PR. The final test integration
`7827cdc81c7333988a87cc8e12914f5ac958e405` additionally contains only host startup
review fixes and documentation/evidence updates; its browser source is identical
to the final audit. CI on this evidence-only PR does **not** reproduce the
combined source metrics. Feature PRs retain their own CI.

## Mobile Lighthouse and browser gates

One Lighthouse 12.8.2 mobile run per route in each comparison, 412×823 simulated
mobile screen, Chromium on this cloud host. Runtime load and fixture origins/IDs
vary; these are recorded measurements, not a statistical speed guarantee.

| Page | Performance before → after | Accessibility | Best practices | Final LCP ms | Final CLS |
| --- | --- | --- | --- | --- | --- |
| Home | 92 → 92 | 100 → 100 | 100 → 100 | 3240 | 0.000 |
| Latest | 94 → 94 | 100 → 100 | 100 → 100 | 3017 | 0.040 |
| Article | 99 → 98 | 100 → 100 | 100 → 100 | 2411 | 0.000 |
| Live | 95 → 96 | 100 → 100 | 100 → 100 | 2708 | 0.041 |

Both production quality gates passed. Staging remains deliberately noindex;
SEO scores 66/63/69/63 reflect that gate. The separate real-CMS SEO tests cover
indexable/staging modes, both article URL templates, XML, archived metadata and
published-only discovery. No indexing setting was changed for this audit.

The first combined build passed the base quality budget but failed the stronger
B10 headroom requirement: 38053 gzip JS bytes left only 2907 bytes below the
40960-byte ceiling. Loading the CMS article body renderer only on article routes
reduced initial JS to **36748 bytes**, leaving **4212 bytes** of headroom; the
required margin is 3072. CSS is 10134 gzip bytes and fonts total 159536 bytes.
A separate fully configured synthetic build in #64 is 36143 JS bytes with 4817
bytes headroom; build settings make no provider requests.

All eight desktop/Pixel 7 production browser journeys passed WCAG AXE checks,
landmarks/headings, image alt, overflow, keyboard skip focus and unexpected
request/console checks. The eight PNGs here were captured from that same final
production build and visually checked for the home/article mobile layout.
Fixture article/byline/media values are synthetic. Existing static public
headlines on the home page are public editorial content.

## Source and integration checks

- 149 unit tests passed on the final combined source.
- 40 real-CMS desktop/Pixel 7 browser tests passed on that source, including
  100 synthetic historical article views, C2 metadata, both URL templates,
  published-only XML, media, submissions, live coverage and keyboard focus.
  Only external Turnstile transport is STUBBED in this disposable CMS harness.
- 84 public browser tests passed, including inactive push lifecycle STUB cases.
- 40 form and 22 advertising browser checks passed after explicitly extending
  the saved consent schema with push:false. External transports are STUBS.
- Exported newsletter shell: eight checks passed before the later lazy-article
  change; advertising delivery: ten STUB checks passed at that same review gate.
- #64 adds four actual reader-shell desktop/Pixel 7 STUB journeys for configured
  comments/privacy controls, with AXE, projection/privacy, disposal and withdrawal.
- Host kit tests start the actual Node process and reject invalid initial
  redirect sources, keep last-good reloads, exercise local health/ads/cache,
  quiet cutover checks and graceful stop. They use a labelled CMS STUB.

The CMS, newsroom, committed Pages export and production services are untouched.
The generated worker is absent unless configured; no third-party service was
activated. AdSense publisher configuration remains unchanged.

## Review and external dependencies

Review fixes remain in their individual PRs (#41–#51 and #57). Wave 3 delivery:
#58 legacy-media design, #59 inactive push, #60 lazy-loading/budget gates,
#61 real-CMS SEO checks, #62 comments component, #63 draft host kit/runbook and
#64 reader integration with mobile STUB evidence.

Real redirects (A9) wait for #55 to merge and the CMS normalisation fixture/NFC
contract gap to be resolved. Real newsletter/contact journeys (B6/B7) wait for
#56 to merge. C6 comments are still a STUB. Legacy-media implementation (A12)
waits for D2 and a private map/withdrawal contract; #58 is design only. A11 still
requires owner review and commands on the actual staging host; Caddy/TLS and
installed production Node paths have not been validated here. B11 is deliberately
deferred until feature PRs merge, then one dedicated generated-site PR must pass
the strict artifact checker. None of these pending gates is represented as done.

## Reproduce

Use the reviewed combined source with its locked dependencies and CMS test
dependencies installed. Run `npm run test:unit`, `PUBLIC_LEGACY_SAMPLES=true npm
run test:cms`, the public/forms/advertising suites, and:

```sh
PUBLIC_AUDIT_DIR=/tmp/public-quality PUBLIC_QUALITY_GATE=true PUBLIC_AUDIT_SCREENSHOTS=true PUBLIC_INDEXABLE=false node tools/run-public-cms-tests.mjs
```

This creates only disposable local services and synthetic data. Compare the
current output and source commit explicitly; no private reader data, tokens or
real redirect inventories belong in published evidence.
