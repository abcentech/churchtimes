# Review of Codex Wave 2 (PRs #40 to #52)

Reviewer: Claude (CMS lane). Method: four independent read-only reviews that traced the code of every PR (not only the PR
text), checked against the build spec, the Session A and B briefs, and the CMS contracts (PR #39). Nothing was merged,
pushed or changed in any of these PRs. Status as of 2026-10-16.

**Overall:** no secret, no third-party script activation, no production change, no edit under `apps/cms` or `apps/newsroom`,
and no open-redirect or injection hole was found. Stub labelling is honest throughout. The problems below are correctness,
consent and merge-safety issues. Items marked **MUST** should be fixed before the PR merges; **SHOULD** can follow.

## Verdict per PR

| PR | Verdict | Why |
| --- | --- | --- |
| #41 ads.txt hardening | **Approve** | `[ \t]*` fixed; tests send GET, HEAD and POST and check headers; mutation check turns red if the old code returns. |
| #42 pin quality budgets | **Fix, then approve** | MUST: the policy test only matches `\n` and fails on Windows checkouts (`core.autocrlf=true`): normalise `\r\n` or add `.gitattributes` with `eol=lf`. MUST: conflicts with #43 in `.github/workflows/public-quality.yml` (same timeout guard added by both): rebase one on the other. SHOULD: `public/**` is still outside the workflow path filter. |
| #43 legacy rendering fixes | **Fix, then approve** | All six asked items are implemented and tested. MUST: regression, absolute links containing a space (`https://example.test/My File.pdf`, a leading/trailing space, `mailto:...?subject=Hi there`) now render as plain text; run the space/control check only on the root-relative branch or trim first. MUST: cap the `youtubeEmbed` title length (100k characters becomes 100k of HTML). SHOULD: a `youtubeEmbed` nested inside a paragraph outputs `<p><p>`; assert `colspan="20"` in the browser corpus too. |
| #44 article path + SEO mapping and #50 redirects (#50 contains #44's commits) | **Fix, then approve** | Redirect safety is good (no open redirect, no header injection, chains and loops rejected, junk paths cost no CMS call). MUST: with `/{slug}/`, `/old-slug` without the trailing slash takes two hops (308 then 301); normalise the request path (trailing slash and upper-case percent-encoding) before the lookup so it is one hop, and add a test. MUST: a bad or partial rules fetch silently discards the last good map and logs nothing; keep serving the last good map and log a counted warning. SHOULD: refresh in the background (requests wait up to 5 s every 5 minutes today); non-ASCII slugs never match because keys are not normalised; `/?p=N` and slug-shaped paths (`/wp-admin/`) make uncached CMS calls when enabled; one reserved slug makes the whole sitemap or RSS return 503, skip that article instead; a stray `%` in a query string returns 404; an empty `PUBLIC_ARTICLE_PATH_TEMPLATE` stops the server. |
| #45 and #49 newsletter and contact forms (#45's sources are identical to #49's) | **Do not merge yet** | MUST (High): on the real site shell the confirm and unsubscribe pages never capture or strip the token. `<base>` makes the base path `/newsletter/`, so the matching regex fails and returns `null`; the unit test passes basePath `/`, which the app never uses on that path. Add a real-browser test that opens `/newsletter/confirm?token=...` through the actual shell, check the token leaves the address bar, and export a page for the route. MUST: do not send `name: ""`; omit the field when empty (contract C4.1 now also accepts an empty string). MUST: the story form still loads Turnstile without consent until #51 lands, and the privacy text still says it "loads"; land #51 first or include it. SHOULD: contact `reference` format is now fixed in the contract (`MSG-` plus 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`); add a `referrer` policy meta to `index.html`. |
| #46 analytics consent | **Fix, then approve** | Measurement ID validation and "nothing before consent, nothing when unset" are good. MUST: the "forms" consent checkbox does nothing (nothing reads `hasConsent('forms')`; Turnstile loads as before) so the dialog misleads; remove it or wire it to #51. MUST: query strings and hashes can still reach GA through automatic events (`gtag('config')` sets no `page_location`); send a sanitised `page_location` and turn off automatic page views. SHOULD: withdrawal leaves `_ga` cookies; the Clarity flag in the B1 brief is not implemented (say so in the PR). |
| #47 ads delivery | **Do not merge yet** | MUST (High): `render()` awaits the ad request (up to 1.5 s) before drawing any route, so first paint waits and focus is lost after navigation; render first and fill slots when data arrives. MUST: do not send `If-None-Match` from the browser; cross-origin the ETag is unreadable and the conditional request needs a preflight the CMS does not allow (the contract now says so). MUST: the `mobile-banner` size is 320x50 (contract corrected). SHOULD: the failure test should also assert no console error. |
| #48 share and Listen | **Fix, then approve** | MUST: Listen reads the ad marker, sponsor name and "CONTINUE READING" callout aloud; exclude them. MUST: call `getVoices()` again on `voiceschanged` (Chromium returns an empty list first), and test it without a stub that returns a voice immediately. SHOULD: copy the canonical URL, not `location.href` with query and hash (pre-existing behaviour, but the new button inherits it); use `aria-pressed` or a label change, not both; clear `#share-status` when the dialog reopens. |
| #51 spam-check consent | **Approve with follow-up** | Works as designed. MUST (follow-up, before #49/#46 merge): `setConsent('forms', true)` leaves the privacy dialog checkbox showing "off"; re-sync the checkbox when consent changes. The text points to a control that exists only after #46/#49. |
| #40 and #52 evidence | **Approve with edits** | Numbers match the code and JSON. SHOULD: name the local runs (`#40` ran locally before the push; `#52` is an unpublished local merge) and say CI did not reproduce them; #40 still says the renderer does not accept `youtubeEmbed` (true until #43 lands). Risk to watch: initial JS is 39,536 of 40,960 gzip bytes in the combined run, leaving about 1.4 KB. |

## Two cross-cutting items

1. **Compiled bundles.** #46, #47, #48 (and #49, #51) each commit a rebuilt `site/assets` bundle and a different script hash in
   `index.html`, and each carries the same unrelated `bindPublicForm` fieldset change. Whichever merges second will conflict, and
   choosing one side drops the other PR's feature from the published bundle. **Rule:** feature PRs do not commit `site/` or the
   hash in `index.html`; one dedicated "rebuild site" PR does, after the last feature merges. Move the fieldset change into its own
   PR or name it in each description.
2. **Bundle headroom.** With about 1.4 KB left in the JS budget, loading ads, analytics, forms, listen and newsletter code eagerly will break
   the gate. Lazy-load each feature behind its own configuration check.

## Suggested merge order (owner decides)

#41, then #42 and #43 (resolve the workflow conflict), then #44 and #50 (one at a time), then #51, then #49 (with #45
folded in), #46, #47, #48. Rebuild the site once at the end.

## Contract changes made in response (PR #39)

- C7: path normalisation and one rule for chains; the public host keeps the last good map, refreshes in the background, skips a reserved slug and ignores a stray `%` in a query string.
- C7.2 and O1: `PUBLIC_ARTICLE_PATH_TEMPLATE` is the single source of truth and `/reports/{slug}/` stays in force until D1 is decided.
- C3: `mobile-banner` is 320x50; freshness is the smaller of 60 s and the time to the next start or end; withdrawal latency stated; browsers do not use conditional requests; the page must never wait on the ad call.
- C4.1: an empty `name` means no name. C5: fixed `reference` format.
- O6 answered (yes, with a title cap and malformed-ID tests); O7 answered (no, 320x50).

## Added after the review of the CMS redirect list (PR #55): host-side items for #44/#50

The CMS-side review ran the real CMS output together with `tools/public-redirects.mjs` from branch `agent/wave2-public-redirects`.
The CMS fixes are Claude's. These three are in the public host:

1. **MUST: normalise the request path with the same function as the CMS before the lookup.** The host looks up the raw
   `url.pathname`. For the rule `/caf%C3%A9-it%27s/`, the requests `/caf%c3%a9-it's`, `/caf%c3%a9-it's/` and `/caf%C3%A9-it's/` all got
   no redirect (browsers send `'` unencoded), and any old address without a trailing slash also misses. The contract's
   normalisation function (canonical form in C7.1) will ship as the single definition with a JSON test-vector fixture
   (`apps/cms/tests/fixtures/`); use the vectors in your tests. Also NFC-normalise, so `/café/` and `/cafe%CC%81/` are one key.
2. **MUST: one CMS failure must not remove every redirect.** In `public-redirects.mjs` the `catch` sets `map = emptyMap()`, so any
   CMS 500, timeout or bad list leaves the site with **no** redirects (observed: fetch 1 gave a 301, fetch 2 with a CMS 500 gave
   none). Keep the last good map and log a counted warning. Better still, drop only the offending rule instead of rejecting the whole list.
3. **SHOULD: the allowlist setting has a different name on each side.** The CMS reads `REDIRECT_ALLOWED_HOSTS`; the host reads
   `PUBLIC_REDIRECT_ALLOWED_HOSTS` and also needs `PUBLIC_SITE_URL`. One disagreement makes the host reject the whole list. Document
   that they must match, and reject at startup if the host's list is empty while the map contains an absolute `to`.
