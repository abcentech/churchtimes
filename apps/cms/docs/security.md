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
- **Audit**: user creation, role/section changes and session revocations are written to `audit-logs` (`user.create`, `user.role-change`,
  `user.revoke-sessions`), next to article, submission and live-event actions.
- **Token rotation**: changing `PAYLOAD_SECRET` signs everyone out; `useSessions` means individual tokens can also be revoked without that.

## 4. Known limitations

1. **Rate limiters are in memory** (`src/lib/rateLimit.ts`): per process, reset on restart, multiplied by the number of instances. Fine for
   the single-VPS design; use a shared store before scaling out. Account lockout and the reset-e-mail interval live in PostgreSQL.
2. **Client IP depends on `TRUST_PROXY`.** Without a trusted proxy all clients share one bucket (public submissions fail closed; login uses a
   20x larger bucket so a stranger cannot lock out all staff). With `TRUST_PROXY=true` the proxy must overwrite `X-Forwarded-For`.
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
