# Codex Wave 3: next work for the two sessions

Status: proposal for the owner. Same rules as `codex-wave2-briefs.md` section "Rules for both sessions" (base `feat/newsroom-mvp`, small PRs,
no `main`, no deploy, no third-party script without consent and configuration, no secrets, no real personal data, stubs labelled,
no edit under `apps/cms` or `apps/newsroom`). First finish every MUST in `codex-wave2-review.md`; Wave 3 starts after those PRs are fixed.

CMS endpoints now exist as PRs and can be used for **real** integration once merged: #55 redirects list, #56 contact and newsletter,
#54 content shapes (YouTube block, tables). Ads (C3) and comments (C6) are not built yet: keep building those against stubs.

## Session A: host, routing and cutover

| Task | Build | Done when |
| --- | --- | --- |
| A9 Real redirects integration | Once #55 is merged, run the public host against the real `GET /api/public/redirects` on a disposable CMS (the cross-app lane pattern). Use the CMS test-vector fixture for path normalisation. | Real-CMS browser test: old address, no trailing slash, non-ASCII slug and a 410 all behave; a CMS 500 keeps the last good map. |
| A10 Production host kit | A documented, tested way to run the Node public host in production behind Caddy (or the chosen D2 host): environment variables, systemd or Docker unit, health check, cache headers, `/ads.txt`, redirects file path, graceful reload of the redirect map. Draft only, nothing deployed. | `docs/public-host-production.md` plus a smoke test that starts the host from the documented command. |
| A11 Cutover runbook (public side) | Step list for the soft launch subdomain and the cutover: TTL, redirect smoke check with `check-redirects`, rollback, what to watch, who runs what. No mail or nameserver changes. | Reviewed by the owner; every command tested against staging. |
| A12 Legacy media paths | Serve `/wp-content/uploads/*` from the public host by mapping to the CMS media file (needs D2 and the CMS `legacyPath`); no arbitrary remote fetch. Design note first, then build behind a flag. | Design note reviewed; tests with synthetic media. |
| A13 SEO completion | `robots.txt`, sitemap for categories and pages, `hreflang` not needed, structured data check on migrated-style articles, canonical consistency under both path templates. | Real-browser checks of head tags and feeds for both templates. |

## Session B: reader features

| Task | Build | Done when |
| --- | --- | --- |
| B6 Newsletter pages | Export pages for `/newsletter/confirm` and `/newsletter/unsubscribe`; capture and strip the token in the real shell; POST once. Then wire to the real #56 endpoints on a disposable CMS. | Real-browser journey from the email link to the confirmed message. |
| B7 Contact form real integration | Same for contact (reference format, 403 means verify again). | Real-browser journey against the real endpoint. |
| B8 Comments display (P9) | Read-only archived comments under articles from `GET /api/legacy-comments` as in contract C6 (names, dates, text only; no emails; text rendering only). Build against a labelled stub until the CMS endpoint lands. | Stub-based tests plus a privacy test that no email field is ever rendered. |
| B9 Web push (P7), inert | OneSignal loader behind consent and an app-ID setting; service worker at the site root; absent when unset. Do not activate anything. | Test: no script or request without consent and configuration. |
| B10 Lazy loading and bundle budget | Each reader feature loads only when configured. Keep the initial JS under budget with headroom, and add the budget check to the PR template. | Quality gate green with at least 3 KB headroom. |
| B11 Rebuild-site PR | After all feature PRs merge, one PR that regenerates `site/` and the script hash in `index.html`. | Pages artifact check passes. |
| B12 Mobile and accessibility sweep | Android (Pixel 7) and keyboard checks for every new journey; fix findings. | Evidence added under `docs/evidence/`. |

## Independent of the CMS work (either session)

- Review of the CMS contracts as they land in `apps/cms/docs/api-contracts.md`; comment on PR #39 if anything is unclear.
- Do not close or merge PR #19; the CMS lane is replacing it (see the review).
