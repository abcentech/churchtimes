# Codex Wave 4: spec for the remaining public-site work

Status: spec for Codex (public lane: `src/`, `index.html`, `tools/`, `docs/public-*`). Date: 2026-10-21.
Base: `feat/newsroom-mvp`. Same rules as `codex-wave2-briefs.md` ("Rules for both sessions"): small PRs, no `main`, no deploy,
no third-party script without consent and configuration, no secrets, no real personal data, no edit under `apps/cms` or `apps/newsroom`.
Read first: `codex-wave2-review.md`, `codex-wave3-review.md` (the MUST/SHOULD lists are binding), `apps/cms/docs/api-contracts.md` (v1.14 or later).

## 0. What changed on the CMS side (all merged into `feat/newsroom-mvp`)

| Contract | PR | What you can now build against for real |
| --- | --- | --- |
| C1 legacy shapes (YouTube block, tables) | #54 | `youtubeEmbed` and table nodes in article content |
| C7 redirects | #55 | `GET /api/public/redirects`, with the normalisation function and `apps/cms/tests/fixtures/` test vectors |
| C5/C4 contact and newsletter | #56 | `POST` contact, newsletter subscribe, confirm and unsubscribe; 403 with `field: 'turnstileToken'` means "verify again" |
| C2 SEO fields | #53 | CMS SEO fields on articles |
| C6 legacy comments | #68 | `GET /api/legacy-comments` (`article` or `where[article][equals]`, `page`, `limit`, `nextPage`, `prevPage`; `legacyId` is in the projection; no emails) |
| C3 advertising | #69 | `GET /api/public/advertising` (live campaigns only, `Cache-Control` at most 60 s, CORS follows `PUBLIC_SUBMISSION_ORIGINS`, creative links only from `CMS_PUBLIC_URL`) |
| Importer | #66, #67, #70, #71 | Nothing public-facing. Imported articles carry `legacyId`; `?p=N` links resolve through it |

Not yet built on the CMS side: the offline legacy-media map export (needed for A12). It is CMS-lane work; do not start A12 code until it lands.

## 1. Step 0: get the Wave 2 and Wave 3 PRs into a mergeable state

This is the critical path. Everything below depends on it. Do it in this order, one PR at a time, rebasing each onto the new base after the previous merge.
Claude reviews each fixed PR; the owner says merge.

1. **Wave 2 MUSTs** (list in `codex-wave2-review.md`), order: #41, #42, #43, #44, #50, #51, #49 (with #45 folded in), #46, #47, #48.
   Feature PRs do not commit `site/` or the script hash in `index.html`.
2. **#57** build policy, with the `OneSignalSDKWorker.js` line folded in.
3. **#58** (docs, with edits) and **#65** (evidence) any time.
4. **#64 is the single carrier** for #59 and #62. Close #59 and #62 as superseded once #64 contains their content; rewrite the #64 body so it does not read as stacked.
5. **#63** after #44 and #50, then #64 rebased. **#61** after #50. **#60 last**, rebased to its own commits.
6. **One rebuild-site PR** at the end (B11).

Binding MUST items inside those PRs (full text in the review files):

- #47 and #60/#49: first paint must never wait on a network call. Render, attach handlers, then fill slots when the module or ad response arrives. Add a stalled-chunk test.
- #49: newsletter confirm/unsubscribe must capture and strip the token under the real shell (`<base>` issue); omit an empty `name`; handle 403 `turnstileToken` as "verify again".
- #46: remove the dead "forms" checkbox or wire it to #51; send a sanitised `page_location`.
- #63: `X-Frame-Options: DENY` plus `frame-ancestors 'none'`, rollback commands in the runbook.
- #62/#64: redact email-shaped text on display (second layer behind the CMS importer), with a test that puts an email in `content`.

## 2. Work packages (after Step 0, or in parallel where marked)

Each package: task, build, done when. Pick them in the order given; A-series is host and routing, B-series is reader features.

### A9. Real redirects integration (unblocked, can start now)

- Run the public host against the real `GET /api/public/redirects` of a disposable CMS (use the cross-app lane pattern and the CMS test-vector fixture).
- Normalise the request path with the same function as the CMS before lookup (NFC, percent-encoding case, trailing slash).
- A CMS failure keeps the last good map and logs a counted warning.
- Done when: a real-CMS browser test shows an old address, an address without trailing slash, a non-ASCII slug and a 410 all behave, and a CMS 500 keeps the last good map.

### A12. Legacy media paths (blocked on the CMS offline map export and D2)

- Not started until Claude's media-map export contract lands. Build behind a default-off flag as in the #58 design note. No arbitrary remote fetch, no staff credential on the public host.
- Done when: tests with synthetic media; a withdrawal test shows an unapproved or revoked file stops being served within the agreed window.

### A13. SEO completion (can start now)

- Update `docs/public-seo-completion.md` (it says #54/#55 are unmerged).
- Real-browser checks of head tags, sitemap and feeds under both path templates against a CMS that holds imported-style articles.
- Done when: canonical, sitemap and RSS are consistent, and one reserved slug skips an article instead of failing the whole sitemap.

### B6/B7. Newsletter pages and contact form on the real endpoints

- Export pages for `/newsletter/confirm` and `/newsletter/unsubscribe`; capture and strip the token; POST once.
- Wire contact and newsletter to the real #56 endpoints on a disposable CMS (reference format `MSG-` plus 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`).
- Document that confirmation links need the public site at the root of its domain (CMS builds `${PUBLIC_SITE_URL}/newsletter/confirm?token=...`).
- Done when: a real-browser journey from the email link to the confirmed message, and a 403 `turnstileToken` journey that keeps form values.

### B4 (real). Ads delivery against the real endpoint

- Replace the stub with `GET /api/public/advertising`. No `If-None-Match` from the browser. Sizes: `mobile-banner` is 320x50. `rel="sponsored noopener noreferrer"` on every click-through, text rendering only for `alt`. Never wait on the call for first paint.
- Honour the response `Cache-Control` and refetch near the next start/end boundary.
- In production the public site origin must be in the CMS `PUBLIC_SUBMISSION_ORIGINS`. Document it.
- Done when: a real-CMS browser test shows a live campaign render, an expired one disappear, and a CMS failure leave the page intact with no console error.

### B8 (real). Archived comments against the real endpoint

- Use `GET /api/legacy-comments?article=<id>` with `page`/`limit`, follow `nextPage`. Use the per-comment `legacyId` from the projection to restore threading via `parentLegacyId` (the earlier "flattened" caveat is now obsolete).
- Text rendering only; never render an email; redact email-shaped strings on display. Use the default fetch cache mode, not `no-store`.
- Done when: a real-CMS test with threaded imported-style comments, a privacy test with an email inside `content` and `authorName`, and a draft-article id returning nothing.

### B9. Web push stays inert

- Fold into #64 as above. Withdraw-then-re-enable test; one consent listener in `main.js` that runs opt-out and unregister cleanup whenever push consent is off, required before any OneSignal app ID is configured. Fail the build if the push worker is enabled while `PUBLIC_BASE_PATH` is not `/`.

### B10. Budget and lazy loading

- Each reader feature loads only when configured. Keep at least 3 KB headroom under the initial JS gzip budget (currently about 4.2 KB with everything on). Add a `modulepreload` hint on article routes, or keep the article renderer in the main bundle.

### A10/A11. Host kit and cutover runbook (#63 follow-ups)

- Apply the #63 SHOULD list from the review (SIGHUP before initial load, port `||`, refresh-again flag, hardened unit, keep-alive timeouts, fail-closed Caddyfile hostname, pre-DNS check against the final hostname, `--allow-host`).
- Add the owner-facing cutover checklist: TTL values, `check-redirects` smoke, rollback by release symlink plus `systemctl restart`, what to watch, who runs what. No mail or nameserver changes.

### B11. Rebuild-site PR

- After the last feature PR merges: one PR that regenerates `site/` and the `index.html` script hash. Pages artifact check passes.

### B12. Mobile and accessibility sweep

- Android (Pixel 7) and keyboard checks for every new journey (newsletter, contact, comments, ads, share, listen, consent dialog). Evidence under `docs/evidence/`.

### New, from the importer (Claude lane will provide data, you provide display)

- **Imported article rendering corpus (P-corpus):** render a set of converted articles (tables, YouTube blocks, galleries, captions, embeds, nested blocks flattened) in the public renderer and fail on dropped content. Claude will supply a synthetic corpus from the rehearsal harness (`npm run import:rehearse`); until then use the existing synthetic fixtures.
- **Old links:** `/?p=N` and slug-only old addresses go through the redirect map; check `legacyId` resolution works in the host.

## 3. Definition of done for every PR

- Base `feat/newsroom-mvp`; CI green (`verify`, `docker-smoke`, `public-quality`); no committed `site/` or hash unless it is the rebuild PR.
- Real-CMS or real-browser evidence where the package says so; stubs are labelled.
- No new third-party request without configuration and consent; a negative test for each.
- PR body states what was and was not run, and what the owner must decide.
- Claude reviews, the owner says merge. Nothing merges on its own say-so.

## 4. Owner decisions that still gate Codex work

| ID | Decision | Default Codex may assume |
| --- | --- | --- |
| D1 | Article path | `/reports/{slug}/` via `PUBLIC_ARTICLE_PATH_TEMPLATE` |
| D2 | Public host (Caddy or other) and domain layout | Node host behind Caddy, site at the root of its domain |
| D3 | Comments policy | Read-only archive only, no new comments |
| D4 | Ads | Direct sponsorship, CMS-managed, `ads.txt` owner-supplied |
| D5 | Newsletter provider | CMS stores consent, no provider call from the browser |
| D6 | Analytics | GA behind consent, off when unset |
| D8 | Social | Share links only, no embedded third-party widgets |

## 5. Message to relay to Codex

> Wave 4 spec is in `docs/codex-wave4-spec.md` on branch `agent/claude-go-live-plan`. Read `codex-wave2-review.md` and `codex-wave3-review.md` first; their MUST items block merges.
> The CMS side is merged: redirects (#55), contact and newsletter (#56), legacy comments (#68), advertising (#69) and the importer. Please:
> 1. Fix the Wave 2 MUSTs and merge in the order in section 1 (#41, #42, #43, #44, #50, #51, #49 with #45, #46, #47, #48), then #57, #58, #65.
> 2. Make #64 the single carrier: close #59 and #62 as superseded, rewrite its body, apply the #64 addendum fixes. #63 after #44/#50. #61 after #50. #60 last.
> 3. Start A9 (real redirects), A13 (SEO) and the real-endpoint packages B4, B6, B7, B8 now; do not start A12 until the CMS media-map export lands.
> 4. Each PR targets `feat/newsroom-mvp`, no `site/` or hash changes except the final rebuild PR. Claude reviews, the owner approves each merge.
