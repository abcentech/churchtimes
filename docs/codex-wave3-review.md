# Review of Codex Wave 3 (PRs #57 to #65)

Reviewer: Claude (CMS lane), read-only reviews that traced the code, checked against `codex-wave3-briefs.md` and the CMS contracts.
CI is green on all nine PRs. No secret, no edit under `apps/cms` or `apps/newsroom`, no committed `site/` or `index.html` hash, and no
third-party request without configuration and consent was found. Items marked **MUST** block the merge; **SHOULD** can follow.

## Merge order (the main risk is stacking)

#59, #60, #61, #62, #63 and #64 each carry copies of other PRs (#44, #46 to #51, #57, #62). Merged out of order they land unreviewed work and
hit add/add conflicts on `tools/public-build-policy.mjs` and `unit-tests/public-build-policy.test.js` (#62's copy lacks the one
`OneSignalSDKWorker.js` line the others have). The base has moved: #54 and #55 are merged.

1. Fix and merge the Wave 2 MUST items first (`codex-wave2-review.md`), in the order given there.
2. #57, with the `OneSignalSDKWorker.js` line folded in.
3. #58 (docs) any time. #65 any time.
4. #59 rebased on #57. #61 after #50. #62 or #64, not both: #64 contains #62's comment code byte for byte, so either close #62 as superseded
   or merge #62 and rebase #64. #63 after #44 and #50, then #64 rebased. #60 last, rebased to its own commits.
5. One rebuild-site PR at the end.

## Verdicts

| PR | Verdict |
| --- | --- |
| #57 build policy | **Approve** |
| #58 legacy media design | **Approve with edits** |
| #59 web push (inactive) | **Fix, then approve** |
| #60 lazy loading and budget | **Do not merge yet** |
| #61 SEO completion | **Approve, merge after #50** |
| #62 comments projection | **Fix, then approve** |
| #63 host kit and runbook | **Fix, then approve** |
| #64 reader integration | **Fix, then approve** |
| #65 evidence | **Approve** |

## MUST items

- **#59, #60, #61, #62, #63, #64:** the stacking and conflict items above.
- **#60 first paint waits on a network call** (`src/main.js:385-396`): `readerFormsReady.then(() => { ...; render(); })` delays the first render until
  the `reader-forms` chunk arrives whenever newsletter or contact plus a Turnstile key is configured. A stalled chunk leaves a blank page and no
  navigation handlers. Render and attach handlers immediately, then fill the newsletter and contact slots when the module resolves. Add a test with a
  delayed or stalled chunk. The same flaw is in #49's `4125575`.
- **#63 no frame protection:** add `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` in the Caddyfile and in the host headers
  (newsletter confirm and unsubscribe are POST buttons that another site could frame), assert them in the host-kit test, add HSTS as a commented
  line gated on the owner, and correct `docs/public-host-production.md:118`, which refers to an application CSP that does not exist.
- **#63 runbook rollback has no commands** (`docs/public-cutover-runbook.md:119-125`): write the release-symlink switch and `systemctl restart`
  (the process pins the real path at start, so reload is not enough), a verification step, and concrete TTL values or a rule.
- **#64 and #62 emails inside comment text:** contract C6 says no emails anywhere in the payload or the DOM, but `content` and `authorName` render
  verbatim. Decision: the CMS importer strips email-shaped strings (CMS lane), **and** `normalizePublicComment` redacts them on display as a second
  layer, with a test that puts an email inside `content`.

## SHOULD items

- **#57:** `tools/check-public-source.mjs:28-36` checks only script and stylesheet tags in the HTML, not lazy chunks or `modulepreload`; the log says
  assets were validated. Document that a PR whose base is not `feat/newsroom-mvp` falls into strict mode.
- **#58:** it says #54 is open (it is merged); `legacyPath` is staff-only, collapses duplicate slashes, tolerates a failed decode and does not NFC-normalise
  (`apps/cms/src/lib/legacyMediaPath.ts:19-32`). Offer a bounded short-cache alternative to `no-store` tied to an agreed withdrawal window and say why a 301
  to the CMS media URL was rejected. The offline map export is new CMS-lane work: flag it as a contract item.
- **#59:** after withdrawal, `revoke()` opts out but `state.loading` stays resolved, so re-enabling shows "enabled" while the subscription is opted out and no
  worker is registered (`public-push.js:39-41,64-69`); add a withdraw then re-enable test. Act only on a transition from allowed to not allowed
  (`:31`). Do not overwrite `state.allowed` from whichever panel clicked last (`:34`). Check the CDN's CORS headers at staging or drop `crossOrigin` (`:38`).
- **#60:** add `permissions: contents: read` and a push trigger on `feat/newsroom-mvp` to `public-reader-budget.yml`; remove the extra
  `captureNewsletterLink` argument at `src/main.js:9`.
- **#61:** `docs/public-seo-completion.md` says #54 and #55 are unmerged and A9 is blocked; both are merged, update it and start A9.
- **#62 and #64:** use the default cache mode instead of `cache:'no-store'` (`public-comments.js:74`). Threading is flattened because C6 has no per-comment
  `legacyId` (the CMS lane will add it). Pin Node 24 via `.nvmrc` in `public-comments.yml`. Add a negative test that consent alone makes no
  `cdn.onesignal.com` request; fail the build if the push worker is enabled while `PUBLIC_BASE_PATH` is not `/`; record the risk of the unpinned OneSignal script (no SRI).
- **#63 host kit:** `refresh()` never rejects after startup, so `public-host.mjs:56` always logs `finished` and the failed branch is dead; log `ruleCount`,
  `warningCount` and map `version`. A SIGHUP that joins an in-flight refresh can leave the new map unread until the next tick (`public-redirects.mjs:188`);
  add a "refresh again" flag. Register the SIGHUP handler before the initial load (a reload in that window kills the process). An empty `PORT=` becomes port 0;
  use `||` and reject 0 outside tests. `REDIRECT_ALLOWED_HOSTS` and `PUBLIC_REDIRECT_ALLOWED_HOSTS` must agree: fail at startup if both are set and differ. HTML is
  `no-store` and each article view calls the CMS; plan a short cache before go-live traffic. Add a pre-DNS check against the final hostname, mention
  `--allow-host`, use `systemctl reload`, harden the unit further (`CapabilityBoundingSet=`, `PrivateDevices`, `ProtectKernel*`, `SystemCallFilter`,
  `MemoryMax`, `TasksMax`), set Node `keepAliveTimeout` and `headersTimeout`, and make the Caddyfile hostname fail closed.
- **#65:** the README's SEO scores (66/63/69/63) are not in the JSON; add them or mark them manual. Tag the audited commit on `agent/wave3-validation`.

## Unblocked now that #54 and #55 are merged

A9 (real redirects integration) and A12 (media paths, once the CMS offline map export exists) can start. #56 (contact and newsletter) is being rebuilt on the merged
base; B6 and B7 can use it once merged.

## Addendum: independent build-and-merge check of #64

Built twice in a temporary worktree: unit 133 passed, 1 skipped; initial JS 36,143 gzip bytes with every optional setting filled (4,817 bytes headroom) and
36,745 bytes unset (4,215 bytes). `docs/evidence/wave3-reader-budget/quality.json` (37,127) predates the lazy article renderer and is stale but still passes.
`git merge-tree` simulations: #62 conflicts with #64 in either order (the one-line `OneSignalSDKWorker.js` difference in `tools/public-build-policy.mjs:6`);
#59 merges cleanly with #64 but conflicts with #57 and #62; #63, #61, #65, #50 and #41 are clean after #64; #49, #45, #42, #43 and #52 conflict with #64.

- **MUST:** make #64 the single carrier. Close #62 and #59 as superseded by #64, rebase or close #45 and #49, rebase #42, #43 and #52 onto whichever lands second, and
  rewrite the #64 body so it no longer reads as stacked on #62 and #59. Resolving the policy conflict by keeping #62's side would drop the worker entry.
- **SHOULD, required before any OneSignal app ID is configured:** the push withdrawal listener exists only while the push panel is mounted (`public-push.js:32,73`,
  `main.js:135`), but `requestConsent()` (`reader-consent.js:14`) opens the same dialog without mounting it. A reader who unticks push there keeps an active
  worker and subscription. Register one consent listener in `main.js` that runs the opt-out and unregister cleanup whenever push consent is off.
- **SHOULD:** the comments-disposal tests pass even if disposal is broken (they remove the section themselves or rely on page replacement). Test navigating from article A to B while A's response
  is held, then release it and assert B shows no A comments and A's fetch was aborted.
- **SHOULD:** `await import('./lib/article-content.js')` (`main.js:366`) now delays article text by one more download even when the server supplied the data; add a `modulepreload`
  hint on article routes or keep the renderer in the main bundle (about 4.2 KB headroom).
