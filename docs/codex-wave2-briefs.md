# Codex Wave 2: briefs for two parallel sessions

Status: **proposal for the owner.** Two Codex sessions can work at the same time without touching the same files. Claude
reviews every PR and implements the CMS side. Read [go-live-build-spec.md](go-live-build-spec.md) sections 0 and 3 first, and
the CMS contracts in `apps/cms/docs/go-live-contracts.md` (PR #39). Wave 1 (#30, #36, #37, #38) is merged.

## Rules for both sessions (from the spec, section 0)

- Base every branch on `feat/newsroom-mvp`. Open small PRs into it early. Never merge to `main`, never deploy.
- You own `src/`, `index.html`, `tools/`, public tests and public docs. Do **not** edit `apps/cms` or `apps/newsroom`.
  If a contract is wrong or missing something, comment on PR #39 instead of working around it.
- No third-party script runs unless its configuration value is set **and** consent is given. With nothing configured,
  the page makes no external request. No AdSense, no push SDK, no analytics ID is committed or invented.
- No secrets in the repo. `VITE_*` values are public. No real personal data, exports or backups anywhere in GitHub or tests.
- The CMS endpoints for ads, newsletter, contact, comments and redirects **do not exist yet**. Build against the contract
  with a **stub server in tests, labelled as a stub**. Never report a stubbed result as end-to-end. Claude will prove the
  real integration in the cross-app browser lane once each CMS endpoint lands.
- Owner decisions D1 to D8 are not made. Each task below says what to build **without** deciding them.
- Every PR states what was tested, what was stubbed, and what is not claimed, as in #36 to #38.

## Session A: routing, redirects and cutover tooling

Files you own for this round: `tools/serve-public.mjs`, `tools/public-pages.mjs`, `src/lib/public-routes.js`, new
`tools/public-redirects.mjs`, new `tools/check-redirects.mjs`, `docs/public-redirects.md`. Do not edit `src/main.js` except
for one small routing hook if unavoidable, in its own commit.

| Task | Build | Done when |
| --- | --- | --- |
| **A1 Article path template** | `PUBLIC_ARTICLE_PATH_TEMPLATE` (`/{slug}/` or `/reports/{slug}/`). **Default stays `/reports/{slug}/` until the owner decides D1**, so behaviour does not change. Canonicals, sitemap, RSS, share cards, JSON-LD and internal links all use the same template. | Tests with both templates; a check that no hard-coded article path remains. |
| **A2 Redirect engine (P1)** | Load rules from `PUBLIC_REDIRECTS_FILE` (JSON in the shape of contract C7.3) and, optionally, `GET /api/public/redirects` with `ETag` and a cache. No rules or no file means no redirects and no error. Exact rules first, then pattern rules for `/category/*`, `/tag/*`, `/author/*`, `/page/N/`, `/feed/`, AMP variants of an article, and `/?p=ID` (look up by `legacyId`). **Pattern targets are configuration with documented proposed defaults for the owner to approve; do not invent final targets.** | Unit tests on a synthetic map; edge cases below pass. |
| **A3 Junk paths** | Paths such as `tel:...`, very long or malformed paths answer a cheap 404 or 410 with no CMS call and no per-URL cache entry. (A `tel:` crawler trap took the old server down.) | Test shows zero CMS requests for junk. |
| **A4 C2 mapping** | Read optional `seoTitle` and `seoDescription` from the article projection with the fixed fallbacks (title, excerpt). Tolerate their absence until C2 lands. | Fixture tests labelled as fixtures; a real-CMS test is added when C2 merges. |
| **A5 Cutover smoke (P12)** | `tools/check-redirects.mjs`: reads a file of old paths, checks status, hop count and final title against an **explicit** target URL. Rate-limited (default 2 requests a second), refuses to run without an explicit target, never defaults to production, and can run quietly so addresses are not printed in CI logs. | Dry run on synthetic data. |

Redirect safety rules (test each): `Location` is built only from the rule's `to`, never from request input (no open
redirects); at most one hop; no loops or chains; only 301, 302 and 410; only GET and HEAD; `to` is a path or an allowlisted
host; rules are looked up in O(1).

## Session B: reader features

Files you own for this round: new modules under `src/` (for example `src/lib/analytics.js`, `src/lib/newsletter.js`,
`src/lib/contact.js`, `src/forms/`), `src/lib/advertising.js`, the share dialog, tests and `docs/public-reader-features.md`.
Do not edit `tools/serve-public.mjs` or any redirect code (Session A owns them). If you need a CSP change, put it in its own
commit and list the exact directives in your doc; whoever merges second rebases.

| Task | Build | Done when |
| --- | --- | --- |
| **B1 Analytics with consent (P3)** | GA4 loader gated on consent from the existing privacy dialog. Measurement ID is a public env value; **unset means no loader and no request**. No analytics on staging by default. Optional Clarity flag, default off. | Test: no network request before consent, one after, none when unset. |
| **B2 Newsletter (P5)** | Sign-up form (footer and article end) posting to the C4 endpoint with Turnstile (action `newsletter-subscribe`). Shows the neutral success text, the 429 `Retry-After`, and a clear "unavailable" state on 503. Confirm and unsubscribe pages that **POST** the token (never confirm on page load by GET). Hidden when no endpoint or site key is configured. | Labelled stub-server tests for every response in C4; accessibility and mobile checks. |
| **B3 Contact (P6)** | Replace the disabled online contact state with the C5 endpoint (Turnstile action `contact-message`) when configured; keep the email fallback otherwise. | Same as B2 for C5. |
| **B4 Ads delivery (P4)** | Fetch `GET /api/public/advertising` (C3.2) with caching and `ETag`, then feed the existing `advertising.js` validation unchanged. **AdSense stays inert**: nothing loads. On any failure render no slot, no gap and no console error. | Stub-server tests; layout shift stays within the quality budget. |
| **B5 Share and Listen (P8)** | Copy-link in the share dialog. Optional "Listen" button using the browser speech API as progressive enhancement, hidden where unsupported. | Works without JavaScript errors on desktop and Pixel 7. |

**Not in this round:** web push (P7, needs the owner's OneSignal app ID and a third-party script) and the comments display
(P9, needs the C6 CMS endpoint). Do not start them.

## How review works

1. Each task is its own small PR into `feat/newsroom-mvp`, with green CI.
2. Claude reviews every PR (a security-focused read plus a check of the stub labelling) and comments on the PR.
3. When a CMS endpoint lands, Claude adds the real cross-app browser journey (real Payload and PostgreSQL) and reports
   it separately from the stubbed results. "Ready" needs that real journey.
4. The owner decides when to merge. Nothing goes to `main` and nothing is deployed from these PRs.

## What Claude does at the same time (CMS lane)

C2 (SEO fields) first, then C7 and C1, then C3, C4 and C5, each as a small PR with a migration, tests and an update to
`api-contracts.md`. Questions O6 (does the article renderer accept the `youtubeEmbed` block?) and O7 (are the ad placement
sizes right?) in PR #39 are for Session B; please answer them in that PR before starting B4.
