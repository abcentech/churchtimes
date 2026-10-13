# Public CMS integration — Issue #7

Branch `agent/codex-public-cms` starts from integration commit `75cc671` after
PRs #1 and #6 were squash-merged. It follows the merged backend's
[API v1.2 contract](../apps/cms/docs/api-contracts.md) and
[Claude's frontend notes](../apps/cms/docs/frontend-integration.md).
It does not change `apps/newsroom`, PR #2, backend source/collections, production
WordPress, DNS, AdSense or `main`. No deployment or automatic merge occurs.

## Overlapping PR review

| PR | Reviewed overlap | Disposition |
| --- | --- | --- |
| #3 mobile quality | `main.js`, CSS, published adapter, tests, responsive image assets, package/lockfile | Not merged. Preserve its distinct performance/accessibility work when rebasing it on this integration. Reconcile adapter/media signatures and shared route rendering deliberately; do not replace this contract mapping with its old version. |
| #4 public forms | Form markup/lifecycle, Turnstile, submission adapter, tests, docs, public `main.js`/CSS and generated export | Selectively carried forward the latest forms work, then updated fields/responses/errors to v1.2 here. The original branch/PR stays untouched. This PR does not require #4 to be merged first; after this integration, #4 must drop duplicated forms/PR #1 content and retain any genuinely distinct changes. |
| #5 homepage/advertising | Stacked on #3/#4; overlaps routes/adapters, public tests, export and package/CI | Not merged. Rebase after contract integration and reconcile only its distinct story-allocation/campaign work. Its aggregate diff must not overwrite this adapter or repeat the older PR #1/#4 implementations. |

Additional code review: #3 adds compatible request-abort support to the old published
adapter; retain that small cancellation change around the new media/byline/correction
normalization rather than substituting the whole file. #5's `uniqueHomeReports` deduplicates
by slug, which this adapter retains; its old forms wire mapping must be replaced with
the v1.2 mapping here. Merge package scripts/CI steps additively and regenerate shared
exports after the final combined source.

The intentional forms import was compared against `agent/chatgpt-frontend`; generated
exports and the old article adapter were not copied wholesale from #4. No changes
were pushed to another author's branch, no PR was closed, and no PR was merged.

## Current behavior

- Published-only anonymous list/slug reads remain `credentials: omit`; no preview
  tokens, staff authentication or staff fields are used.
- Render public bylines, correction notes/dates, legacy source links and populated
  CMS featured/card/hero/embedded images with safe URL/MIME checks and escaping.
- Submit `name,email,phone,title,body,categorySuggestion,location,website,turnstileToken`
  and accept only the real `201 {ok:true,reference,message}` receipt.
- Phone remains required in the UI (publisher requirement); CMS makes it optional.
  Category is a suggestion string; article relations still use backend category IDs.
- Match CMS length limits, optional location, array field errors, verification errors,
  duplicate 409, size 413, permission/origin 401/403, format 415 and rate limit 429.
- Default/configurable widget action `submit-story` matches
  `TURNSTILE_EXPECTED_ACTION`. Tokens are never verified in the browser and the
  secret remains backend-only. No live failure falls back to a mock receipt.
- The backend does not implement contact delivery. The separate contact form stays
  disabled unless its own compatible endpoint is explicitly configured; email works.

Public build variables and full response handling are in
[public-forms.md](public-forms.md) and
[public-newsroom-integration.md](public-newsroom-integration.md).
Use `.env.example` as a public-value template. No secret belongs in a `VITE_` value.

## Local reproduction and rollback

For a local CMS, install `apps/cms` dependencies, create its ignored `.env` with
fresh server secrets, then run its documented `db:local`, `migrate`, `seed`, and
`dev` commands from `apps/cms`. List the actual public Vite origin in both
`CMS_CORS_ORIGINS` and `PUBLIC_SUBMISSION_ORIGINS` (e.g. `http://localhost:5173`).
Set `VITE_PUBLIC_CMS_URL=http://localhost:3000`, the registered **public** site key,
and `VITE_TURNSTILE_ACTION=submit-story` before starting/building Vite. The backend
expected action must match. Configure a real provider key for spam protection;
Cloudflare's dummy development keys are only for testing.

`npm run test:cms` is independently reproducible: it starts disposable embedded
PostgreSQL by default and cleans up its fixture server/cluster. In CI it uses the
isolated Postgres service via `TEST_DATABASE_URL`; the guarded test host requires
`NODE_ENV=test` and loopback DB/network access. It is never a deployment target.
The new `public-cms.yml` PR workflow runs that acceptance gate alongside existing
public/CMS checks.

For rollout reversal, unset public CMS/submission/site-key build values and rebuild
so the current edition and email fallback remain available. Do not roll back
backend migrations as part of a frontend rollback. The compiled export must be
regenerated on the integration branch; no production deployment is included here.

## Validation and limits

Verified in this cloud session:

- Frozen root/CMS dependency installation; all committed migrations on real local
  PostgreSQL; 21 legacy articles and 9 categories seeded without demo staff accounts.
- Next.js dev host: published list `200`, populated category/byline, staff fields
  absent; public POST without a token `400` with a Turnstile field error.
- CMS typecheck and production build; existing 263-test CMS suite against PostgreSQL.
- Public unit and standard/form/newsroom browser regression suites, build/export checks.
- Six real-REST/DB browser checks (desktop + Android-sized): submission stored `new`
  with correct phone/location/category hint, no automatic publication; reporter
  denied; editor converts a draft, reviews/approves/publishes; Vite reads published
  content; draft hidden; media loads; byline/correction shown; duplicates and spent
  tokens rejected. No CMS API responses are mocked in these checks.

The acceptance fixture host mounts the same Payload REST handlers as Next but does
not exercise Next's proxy layer. It uses the backend's existing **test-only** seam
for Siteverify HTTP transport and a test widget. The external provider is blocked
by the cloud proxy (`CONNECT 403`), so real Cloudflare verification is **unverified**.
This is not a production spam-protection or newsroom dashboard readiness claim.

Backend follow-up for Claude: expose `Retry-After` for cross-origin reads to permit
precise retry timing (currently a 60-second client fallback); resolve anonymous
media listing before confidential assets are introduced. This frontend only uses
media attached to published documents and does not repair backend media permissions.
Real contact delivery, physical Android/TalkBack, production CORS/CSP, deployment,
SMTP, signed draft previews and the Gemini newsroom security integration remain
outside the validated scope.
