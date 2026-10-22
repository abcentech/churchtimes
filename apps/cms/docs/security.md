# Church Times CMS — security model

Scope: the Payload CMS 3.90.2 + PostgreSQL backend in `apps/cms`. Cost model: no paid services. Authentication is
Payload's built-in auth on PostgreSQL; spam protection is Cloudflare Turnstile (free tier); password-reset e-mail uses
any SMTP server. See [api-contracts.md](api-contracts.md) §4–6 for the wire contract and
[operations.md](operations.md) for deployment.

## 1. Threat model (summary)

| Threat | Main controls |
| --- | --- |
| Bots / spam flooding the public submission form | Turnstile (server-side Siteverify, fail closed), per-IP and per-email rate limits, honeypot, 64 KB body cap, duplicate detection, strict input validation |
| Public contributor publishing content | Submissions are a separate staff-only inbox; the endpoint ignores any client-supplied status/article/notes; only an editor can convert to a **draft** |
| Password guessing / credential stuffing | 12+ char policy with common-password and e-mail checks, per-account lockout (5 / 10 min), per-IP limits on login/forgot/reset, generic error messages |
| Account enumeration | Identical login errors, identical forgot-password response for known/unknown e-mails |
| Stolen or stale session | 8 h tokens, server-side sessions revoked on logout / password change / reset / admin action, HttpOnly + Secure + SameSite=Lax cookie |
| CSRF / cross-origin abuse | Origin allowlist for cookie authentication (`csrf`), explicit CORS allowlist, `Authorization` header alternative is not ambient |
| Privilege escalation | Server-side field access (`role`, `sections` admin-only), admin-only user create/delete/unlock/revoke, workflow hooks on articles and live updates, first-user bootstrap closed once any user exists |
| Secret leakage | Secrets only in server env, never in frontend; production startup validation rejects dummy/missing secrets; `.env` never committed |
| Clickjacking / MIME sniffing | `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, Referrer-Policy, Permissions-Policy, HSTS (production) |

Out of scope: protection against a compromised server or database, DDoS beyond what the reverse proxy / Cloudflare provide,
two-factor authentication (not available in Payload core; see limitations).

## 2. Controls mapped to the requirements

Test files are in `tests/integration/security.test.ts` (S) and `tests/unit/*` (U) unless noted.

### 1. Secure staff login, logout, password reset, session management, lockouts
- Config: `src/collections/Users.ts` (`auth`: `useSessions`, `tokenExpiration` 8 h, `maxLoginAttempts` 5, `lockTime` 10 min,
  `forgotPassword`), `src/lib/authRateLimit.ts`, `src/lib/passwordPolicy.ts`, `src/payload.config.ts` (e-mail adapter).
- Payload facts verified in 3.90.2 source: `useSessions` defaults to `true`; logout deletes the session; password change removes
  all of the user's other sessions; reset-password clears all sessions; unknown forgot-password e-mails return the normal
  `200`; `forgotPassword.minRequestInterval` (15 s) throttles reset e-mails per account; `unlock` access defaults to "any logged-in
  user" (we restrict it to `admin`).
- Per-IP login limiting is **not** built into Payload. We implement it in `Users.hooks.beforeOperation` for the `login`,
  `forgotPassword` and `resetPassword` operations (REST requests only; local API calls from seed/tests are trusted) and return `429`.
- Password policy: Payload's reset operation passes only the stored hash to `beforeValidate` hooks, so create/update are checked in
  `beforeValidate` (`data.password`) and reset in `beforeOperation` (`args.data.password`), all through `checkPasswordPolicy`.
- Tests: S "login, lockout and sessions" (cookie flags, bad credentials, lockout, per-IP 429, logout revokes token, password change
  revokes other sessions), S "password policy and reset flow" (weak passwords, no enumeration, forgot rate limit, reset single use,
  expired token), U `passwordPolicy.test.ts`, U `usersConfig.test.ts`.

### 2. Server-enforced permissions
- `src/access/roles.ts`, `src/collections/*.ts`, `src/workflow/articleWorkflow.ts`. Full matrix: api-contracts §1–2, §6.
- Tests: S "staff privilege limits", "role escalation is impossible through the API"; `tests/integration/articles.test.ts`,
  `live.test.ts` (full matrices); U `articleWorkflow.test.ts`.

### 3. Public contributors never publish directly
- `src/endpoints/publicSubmissions.ts` writes `status: 'new'` only; `Submissions` has `create: false` for REST; articles are created from
  submissions only by `POST /api/submissions/:id/convert` (editors) as `draft`.
- Tests: S "anonymous visitors and public contributors cannot write editorial data"; `submissions.test.ts` (convert flow).

### 4. Turnstile on `POST /api/public/submissions` with mandatory server-side Siteverify
- `src/lib/turnstile.ts` (`verifyTurnstile`: form-encoded POST to `https://challenges.cloudflare.com/turnstile/v0/siteverify`,
  `AbortController` 5 s timeout, `success === true` required, optional hostname/action pinning, error codes logged server-side only);
  `src/endpoints/publicSubmissions.ts` (step 6 of the pipeline).
- Fail closed: missing token → 400; rejected, network error, timeout, non-200, malformed response → 403 and nothing stored; in production a
  missing secret also rejects (and startup fails).
- The test seam `setTurnstileFetchForTests` replaces only the HTTP transport, throws unless `NODE_ENV=test`, and is not reachable from a request.
- Tests: S "public submissions: Turnstile" (missing token, rejected, network/500, success + Siteverify call contents, alias field, bypass
  attempts, verifier not called when rate-limited / honeypot / invalid / 415 / bad origin); U `turnstile.test.ts`.

### 5. Rate limiting, request-size limits, duplicate detection, safe input validation
- Per-IP limit, per-email limit (`SUBMISSION_EMAIL_RATE_LIMIT`), 64 KB cap (header + streamed), content-type check, honeypot, sanitising
  (`src/lib/sanitize.ts`), length limits, duplicate detection by `contentHash` (`src/lib/submissionHash.ts`, window
  `SUBMISSION_DUPLICATE_WINDOW_HOURS`).
- Tests: S "public submissions: duplicates, per-email limit, server-owned fields"; `submissions.test.ts` (413, 415, 429, validation, HTML
  stripping); U `publicSubmissions.test.ts`, `submissionHash.test.ts`, `rateLimit.test.ts`, `sanitize.test.ts`.

### 6. Untrusted submissions cannot set approval / publication status
- Whitelist in `validateSubmissionInput`; `status` forced to `new`; server-owned fields (`reference`, `ipHash`, `contentHash`, `userAgent`)
  have `create/update: false` field access.
- Tests: S "ignores status, article, reviewerNotes, reference, ipHash and contentHash from the body"; `submissions.test.ts`.

### 7. Turnstile and auth secrets only in server-side env vars
- `process.env` reads are in server modules only; nothing is exposed via `NEXT_PUBLIC_*`; the CMS does not read the Turnstile site key;
  `src/lib/securityConfig.ts` (`validateProductionEnv`) refuses to start in production with missing/short/shared secrets or a dummy
  Turnstile secret; `.env.example` holds placeholders only.
- Tests: U `securityConfig.test.ts`; S asserts the secret never appears in a response.

### 8. Auth cookies, CORS, CSRF
- Cookie: `payload-token`, HttpOnly, `Secure` in production, `SameSite=Lax`, no `Domain`. Lax rather than Strict because links to
  `/admin` from e-mail or chat must arrive logged in; the admin is same-origin so Lax is sufficient, and CSRF is additionally enforced by
  Payload's Origin allowlist.
- CSRF (`csrf`): `CMS_PUBLIC_URL` (Payload adds `serverURL` itself) + `CMS_CSRF_ORIGINS`. **Payload disables the check when the list is empty**,
  so `src/payload.config.ts` always includes the CMS origin (and `http://localhost:3000` only outside production).
- CORS (`cors`): explicit allowlist; Payload sets `Access-Control-Allow-Origin` (exact echo) and `Access-Control-Allow-Credentials: true`
  only for listed origins. Never `*`.
- Startup validation: https-only, bare origins, no wildcards (`checkOriginList`); `CMS_PUBLIC_URL` required and https in production.
- Headers: `next.config.mjs` (`nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`,
  Permissions-Policy, HSTS in production, `no-store` on `/api/users/*`). No script CSP is set because the Payload admin needs inline scripts.
- Tests: S "login ... sets an HttpOnly, SameSite=Lax cookie", "a cookie only authenticates requests from an allowlisted Origin (CSRF)",
  S "CORS allowlist" (3 tests); U `usersConfig.test.ts` (production cookie is Secure), `securityConfig.test.ts`.

### 9. Automated tests proving unauthorised users cannot approve, publish, escalate roles or bypass spam protection
- Approve/publish: S "staff privilege limits (server-enforced)", "anonymous visitors ... cannot write editorial data".
- Escalate: S "role escalation is impossible through the API" (reporter PATCH own role, EIC cannot create admins, `first-register` refused,
  `unlock` admin-only, revoke-sessions admin-only, role changes audited).
- Spam bypass: S "cannot be bypassed by request content", S "never calls Cloudflare when rate limited...".

### 10. Document env vars and deployment
- `.env.example`, `README.md` (security configuration, first admin, password reset), `operations.md` §4 (variables), §4.1 (Turnstile),
  §4.2 (SMTP), §4.3 (account recovery), §10 (checklist), this file.

## 3. Operational notes

- **Force logout**: change a user's password (ends their other sessions) or `POST /api/users/:id/revoke-sessions` (admin).
- **Unlock**: `POST /api/users/unlock` (admin) or wait 10 minutes.
- **Break-glass**: `npm run admin:set-password` (operations §4.3).
- **Audit**: user creation, role/section changes, password and e-mail changes (without values) and session revocations are written to
  `audit-logs` (`user.create`, `user.role-change`, `user.password-change`, `user.email-change`, `user.password-reset`, `user.revoke-sessions`),
  next to article (`correction`, `correction.amend`, `article.restore`), media (`upload`, `media.update`, `media.replace-file`), submission and
  live-event actions.
- **Token rotation**: changing `PAYLOAD_SECRET` signs everyone out; `useSessions` means individual tokens can also be revoked without that.

## 4. Known limitations

1. **Rate limiters are in memory** (`src/lib/rateLimit.ts`): per process, reset on restart, multiplied by the number of instances. Fine for
   the single-VPS design; use a shared store before scaling out. Account lockout and the reset-e-mail interval live in PostgreSQL.
2. **Client IP depends on the reverse proxy.** `TRUST_PROXY=true` is mandatory in production (startup fails otherwise) and the proxy must
   overwrite `X-Forwarded-For` / `X-Real-IP` (operations §4.4). The IP is taken from the right of `X-Forwarded-For` (`TRUST_PROXY_HOPS`) or
   from `CLIENT_IP_HEADER`; if the app were reachable around the proxy, a caller could choose its own bucket. In development without a
   trusted proxy all clients share one bucket (public submissions fail closed; login uses a 20x larger bucket so a stranger cannot lock out all staff).
3. **Lockout is per account**, so an attacker who knows an e-mail can keep it locked (10-minute windows) — a denial-of-service on one account.
   The locked-account message also reveals that the account exists. Both are Payload behaviours; the per-IP limit bounds the cost to the attacker.
4. **No two-factor authentication** (not part of Payload core). Mitigations: long passwords, lockout, short sessions, admin two-person rule.
5. **Duplicate detection has a race window**: two identical requests arriving at the same instant can both pass the check.
6. **Turnstile is a dependency**: if Cloudflare is unreachable, submissions are refused (fail closed) rather than accepted unverified.
7. **Email-address owners can be spammed** with submissions only up to the per-email limit; verification of the contributor's e-mail is not performed.
8. **Reset e-mails need SMTP.** Without it, e-mails are printed to the log; use the break-glass script.
9. **`legacyUrl` / `legacyId`** on articles are writable by anyone who can edit the article (cosmetic migration fields, no privilege impact).
10. **No script CSP** for the admin (Payload requires inline scripts); the CSP header only sets `frame-ancestors`.
11. Sessions list (`sessions` field) shows session ids to the account owner only; ids are not credentials.
12. **Media is private unless it is on the public site (v1.6, review finding M3, fixed).** `media.read` is: any staff role, or the media is
    the featured / a body image of a **published** article, or the image of an **approved** update of a live/ended event. The rule is a Payload
    access Where over three virtual join fields (`publishedAsFeatured`, `publishedInBody`, `liveUpdateImages`; no migration), so list, by-id
    and `/api/media/file/<name>` (originals and size variants, `payload/dist/uploads/checkFileAccess.js` L10-57) share it, and relationship
    population of published articles keeps working. Images of draft / scheduled articles are not readable by anonymous browsers, **except** with a valid preview
    token for that article: `/api/preview/articles?token=` returns every media URL with `?preview=<token>`, and `media.read` accepts it for the
    featured / body images of that single article (HMAC, constant-time, expiry, article id from the signed payload). Files already downloaded or
    cached stay downloaded.
13. **Media "in use" freeze covers `featuredImage` only.** A non-editor can still replace a media file they uploaded if it is used solely
    inside an article body (Lexical upload node). Editors are never restricted.
14. **The admin UI shows `currentPassword` as a plain text input** (Payload has no password-type field for custom fields); it is cleared on
    save and never stored. Prefer using the API/`curl` or a password manager's autofill, or reset via e-mail.
15. **Live feed after rejection**: rejecting an already-approved live update removes it from the feed, but clients that already received it
    keep showing it until they reload (the polling protocol has no delete event). Re-approval re-delivers it with a new `sequence`.
16. **Restoring versions** is audited but is a whole-document overwrite by `admin` / `editor-in-chief`; it can remove corrections entries that
    were added after the restored version (the audit log keeps the `article.restore` entry; `correction.amend` details hold prior values only
    for normal PATCH amendments).
17. **Request-size limits rely on `Content-Length`.** `src/proxy.ts` rejects declared sizes; for chunked uploads the reverse proxy limit (12 MB) and
    Next's body buffer limit (`experimental.proxyClientMaxBodySize: 12mb`, bodies beyond it are truncated, not rejected) are the backstops. The 411 rule
    applies to `/api/users/*` only.
18. **Security audit follow-ups (fixed):** per-IP rate-limit keys use the IPv4 address or the /64 of an IPv6 address (IPv4-mapped IPv6 counts as
    IPv4), and a full limiter never evicts a blocked bucket (new keys fail closed when every bucket is blocked); uploads are re-encoded through
    sharp so stored originals carry no EXIF / GPS (orientation applied, ICC kept) and are refused above 40 megapixels; deletes of users, submissions,
    live updates, live events, categories and contact messages are audited without personal data, user audit summaries carry ids not e-mail
    addresses, and `audit-logs.actorIdSnapshot` keeps the actor id when the user row is later deleted (`actor` stays ON DELETE SET NULL);
    Lexical link nodes are limited to http, https, mailto, relative paths and fragments; the preview payload no longer exposes `legacyPath` or
    `adCampaignCreatives`; free-text fields have length caps (byline 200, media caption 1000 / credit 300, reviewer notes 5000, category
    description 1000).
19. **Known limitation (audit L3): `/admin` is reachable by anyone who can reach the host.** Login is rate limited and locked out, but the panel is
    exposed. Mitigation: restrict `/admin` by IP allowlist at the reverse proxy or put it behind Cloudflare Access.
20. **Known limitation (audit L4): every editor role, section editors included, can read all submissions** (names, e-mail, phone, tip text; see
    the Submissions collection note). Mitigation: restrict contact fields to editor-in-chief / admin via field access, or split the triage view,
    once the product owner accepts the workflow cost.
21. **Known limitation (audit L6): `CLIENT_IP_HEADER` is trusted blindly.** When set (`cf-connecting-ip`, `x-real-ip`), any client that can reach
    the app directly can choose its rate-limit bucket. Mitigation: firewall the app port so only the proxy can connect, and make the proxy
    overwrite the header on every request.

## 5. Review fixes (contract v1.2)

Fixes for the verified findings of the security review. Tests marked R are in `tests/integration/review-fixes.test.ts`, U in `tests/unit/`.
Each integration test was written to fail first against the previous code.

| # | Finding | Fix | Tests |
| --- | --- | --- | --- |
| 1 | Any staff could PATCH any media and replace its file; updates not audited | `media.uploadedBy` (server-set, hidden from the public); update access: editors any, others only their own; `beforeChange` blocks non-editors on media that is the `featuredImage` of a published/scheduled article; audit `media.update` / `media.replace-file` (`src/collections/Media.ts`) | R "1. media ownership and replacement" (5 tests) |
| 2 | `/api/articles/versions` leaked other users' drafts and review notes | `access.readVersions` mirrors the read rule on `version.status` / `version.author` / `version.category`; admin/EIC everything; anonymous 403 (`src/collections/Articles.ts`) | R "2. article versions follow the article read rule" (2 tests, incl. by-id and anonymous 403) |
| 3 | Live updates approved out of order never reached pollers | `publishSequence` stamped when an update becomes approved (per-event advisory lock, unique `(event, publishSequence)`); the public feed filters/sorts/returns it as `sequence` (`LiveUpdates.ts`, `liveEventUpdates.ts`, migration back-fill) | R "3. live updates are delivered in publication order" (4 tests, incl. concurrent approvals); updated `live.test.ts` |
| 4 | Spoofable client IP | `getClientIp`: rightmost-by-hops of `X-Forwarded-For` (`TRUST_PROXY_HOPS`), optional `CLIENT_IP_HEADER`, IP syntax validated; `TRUST_PROXY=true` and the two new variables validated at production startup (`rateLimit.ts`, `securityConfig.ts`) | U `rateLimit.test.ts` (5 getClientIp tests), U `securityConfig.test.ts` (2 tests), R "4. client IP for rate limiting" |
| 5 | No request body limits | `src/proxy.ts` (Next 16 proxy, the renamed middleware) + `lib/requestLimits.ts`: 413 above 1 MB (11 MB for `/api/media`), 411 for length-less writes to `/api/users/*`, 400 for a bad `Content-Length`; `proxyClientMaxBodySize: 12mb`; proxy snippets in operations §4.4 | U `requestLimits.test.ts` (6 tests); manual `next start` check (see report) |
| 6 | `?pagination=false` bypassed the 100 clamp | shared `lib/clampLimit.ts` `beforeOperation` hook on all eight collections: pagination forced on, limit 1..100 (`find` and `findVersions` both report operation `read`; the operation re-reads `args` after the hook) | U `clampLimit.test.ts` (4 tests), R "6. pagination=false is clamped on every collection" (4 tests) |
| 7 | Corrections could be rewritten or erased | `workflow/corrections.ts` `reconcileCorrections`: prefix match on `id`/`note`/`correctedAt`, server-set `correctedAt`, 400 otherwise; admin/EIC may amend (`correction.amend` audit); needs content-edit rights | U `corrections.test.ts` (5 tests), R "7. corrections are append-only" (5 tests) |
| 8 | Unchanged content flagged as a material edit | `lib/deepEqual.ts` (key-sorted canonical JSON) for title/excerpt/content/featuredImage/schedule comparisons | U `deepEqual.test.ts` (6 tests), R "8. canonical comparison of content" (2 tests) |
| 9 | Contract said out-of-scope live update = 400/404 | Documentation only: code returns 403 (api-contracts §6.2); editors may create `approved` articles (§2) | n/a (existing `live.test.ts` / `articles.test.ts` matrices) |
| 10 | Anonymous media listing | Fixed in v1.6 (limitation 12): `Media.access.read` = staff OR media of a published article OR image of an approved live update (join-field Where, files and size variants included) | I `media-privacy.test.ts` |
| 11 | Restoring a published article always failed | admin/EIC `restoreVersion` is detected through a `beforeOperation` hook (`operation === 'restoreVersion'`, server-side `req.context`), skips the corrections rule and is audited `article.restore`; everyone else keeps the rule (documented in api-contracts §2) | R "11. restoreVersion on a published article" (2 tests) |
| 12a | Password / e-mail change without the current password | virtual `currentPassword`, verified with Payload-compatible pbkdf2 (`lib/passwordVerify.ts`); failures use Payload's lockout counter; admin changing someone else exempt | U `passwordVerify.test.ts` (3 tests), R "12a. password and e-mail changes" (4 tests); `security.test.ts` updated |
| 12b | `convert` race created two articles | claim by `UPDATE ... WHERE status <> 'converted' RETURNING` inside one request transaction (`initTransaction`/`commitTransaction`/`killTransaction`), article creation joins it, rollback on failure (`convertSubmission.ts`, `lib/dbTransaction.ts`) | R "12b. converting a submission is atomic" (concurrent 201/409/409, rollback) |
| 12c | Password and e-mail changes not audited | `user.password-change`, `user.email-change`, `user.password-reset` (no values stored) | R "12a ... audits both kinds without values", R "12c. password reset audit" |

Payload 3.90.2 facts relied on (all read in `node_modules`): `beforeOperation` receives the REST query already parsed into `args` and the operation
re-destructures `args` afterwards; `findVersions` uses `access.readVersions` (default "any logged-in user") and `version.*` paths; field-level `access.update:false`
strips client input before `beforeChange`, which can still assign the value; `req.file` carries a multipart PATCH's replacement file; `incrementLoginAttempts` and
`resetLoginAttempts` are exported; `initTransaction`/`commitTransaction`/`killTransaction` are exported and `payload.create/update(..., { req })` joins
`req.transactionID`; the drizzle transaction handle is `payload.db.sessions[transactionID].db`; Next 16 renamed `middleware.ts` to `proxy.ts` (Node runtime) and
buffers/truncates request bodies at `experimental.proxyClientMaxBodySize` (default 10 MB) when a proxy file exists.
