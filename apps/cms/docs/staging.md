# Disposable staging environment and end-to-end tests

Scope: GitHub issue #16 (parts 1, 2, 4), building on issue #7 and PR #8. Everything here is **disposable and
synthetic**: no production database, no live WordPress, no DNS, no real Turnstile secret, none of the 21 real stories.
Rolling back means deleting a directory (`npm run staging:down`).

Run every command from `apps/cms`. Requirements: Node 24, `npm ci` done. No Docker needed.

## 1. Quick start

```sh
npm run staging:up          # embedded PostgreSQL + migrations + synthetic seed + production build + `next start`
npm run test:e2e:api        # 58 real-HTTP API tests against the running server
npm run test:e2e:browser    # Playwright browser tests (boots its own stack; see section 7.1)
npm run staging:down        # stop server + PostgreSQL, delete .staging/ (idempotent; `-- --keep` keeps the folder)
```

`staging:up` takes about 3 minutes the first time (production build). `STAGING_SKIP_BUILD=1 npm run staging:up` reuses an
existing `.next` (only safe when the code has not changed since that build).

| Variable | Default | Meaning |
| --- | --- | --- |
| `STAGING_PORT` | `3100` | CMS port (`next start`) |
| `STAGING_PG_PORT` | `55432` | embedded PostgreSQL port (the browser-test lane uses 3200 / 55433) |
| `STAGING_HOST` | `127.0.0.1` | bind address of the CMS: `127.0.0.1` or `localhost` only (anything else is refused). |
| `STAGING_DIR` | `.staging` | data directory: `.staging` or `.staging-<name>` in `apps/cms` (gitignored; anything else is refused, since up/down delete it). Use a different one per parallel instance. |
| `STAGING_SKIP_BUILD` | unset | `1` = reuse `.next` |
| `STAGING_NEWSROOM_ORIGIN` | `http://newsroom.churchtimes.localhost:5174` | newsroom UI origin (allowlisted) |
| `STAGING_PUBLIC_ORIGIN` | `http://www.churchtimes.localhost:5173` | public site origin (allowlisted) |
| `STAGING_EXTRA_ORIGINS` | unset | comma list of extra **loopback** origins added to every allowlist |
| `STAGING_SUBMISSION_RATE_LIMIT` | `3` | per-IP submissions per 15 min (low on purpose; see section 6) |
| `STAGING_AUTH_LOGIN_RATE_LIMIT` | `200` | per-IP logins per 15 min |
| `STAGING_URL` | from `state.json` | base URL the API tests call (`test:e2e:api`) |

Two instances side by side (for example the browser lane) need different ports **and** `STAGING_DIR`, and must not build at the
same time (they share `.next`): build once, then start the second with `STAGING_SKIP_BUILD=1`.

## 2. What `staging:up` does

1. Refuses to start if an environment is already running or a port is taken.
2. Creates a fresh `.staging/` and starts embedded PostgreSQL (`scripts/staging-pg.mjs`, detached) on `STAGING_PG_PORT`.
3. Writes `.staging/.env.staging` with **freshly generated** random `PAYLOAD_SECRET`, `PREVIEW_SECRET`, `IP_HASH_SALT` and database
   password, plus the origins below. Writes `.staging/credentials.json` (one synthetic staff login per role, random passwords).
4. `payload migrate`, then `payload run src/seed/staging.ts` (synthetic fixtures), then `next build` (skippable).
5. Starts `next start -p <port>` detached, waits for `GET /api/categories` = 200, writes `.staging/state.json` (pids, ports, URLs).

Nothing secret is printed. `.staging/` is in `.gitignore` and `.dockerignore`. Logs: `.staging/server.log`, `.staging/postgres.log`.

### Environment template (no secrets)

`.staging/.env.staging` is generated; this is its shape. To build one by hand (Docker path, section 8) fill the `<...>` values yourself.

```ini
DATABASE_URL=postgres://staging:<random>@127.0.0.1:55432/churchtimes_staging
PAYLOAD_SECRET=<64 random hex chars>
PREVIEW_SECRET=<64 random hex chars, different>
IP_HASH_SALT=<32 random hex chars>
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA     # Cloudflare's public always-pass TEST secret
CMS_PUBLIC_URL=http://cms.churchtimes.localhost:3100
CMS_CORS_ORIGINS=http://newsroom.churchtimes.localhost:5174,http://localhost:5174,http://127.0.0.1:5174,http://www.churchtimes.localhost:5173,http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080,http://cms.churchtimes.localhost:3100,http://localhost:3100,http://127.0.0.1:3100
CMS_CSRF_ORIGINS=<same list as CMS_CORS_ORIGINS>
PUBLIC_SUBMISSION_ORIGINS=<the frontend origins from the list above, not the CMS ones>
TRUST_PROXY=true
TRUST_PROXY_HOPS=1
CMS_ALLOW_INSECURE_LOCAL_STAGING=true
SUBMISSION_RATE_LIMIT=3
SUBMISSION_RATE_WINDOW_SECONDS=900
SUBMISSION_EMAIL_RATE_LIMIT=3
AUTH_LOGIN_RATE_LIMIT=200
SCHEDULER_ENABLED=true
PAYLOAD_DB_PUSH=false
# blank on purpose, so a developer's apps/cms/.env can never leak in:
TURNSTILE_EXPECTED_ACTION=
TURNSTILE_ALLOWED_HOSTNAMES=
CLIENT_IP_HEADER=
SMTP_HOST=
SEED_DEMO_USERS=false
```

## 3. NODE_ENV and production validation (design decision)

`next start` forces `NODE_ENV=production` (`next/dist/bin/next`: `NODE_ENV = NODE_ENV || 'production'`), and a non-standard
value (for example `staging`) only produces a warning and mixes development React with a production build. So staging runs the
**real production build with production validation switched on**, not a weaker mode. `validateProductionEnv` is unchanged for
everything that matters: strong, distinct secrets, `TRUST_PROXY=true`, no wildcards, bare-origin shapes, Turnstile secret required.

Two production rules cannot be met by a local, http-only, no-Cloudflare-account setup: "origins must be https" and "Turnstile dummy
secrets are rejected". For exactly those two, `src/lib/securityConfig.ts` honours **`CMS_ALLOW_INSECURE_LOCAL_STAGING=true`**, and
only when `CMS_PUBLIC_URL` is set and **every** configured origin (`CMS_PUBLIC_URL`, `CMS_CORS_ORIGINS`, `CMS_CSRF_ORIGINS`,
`PUBLIC_SUBMISSION_ORIGINS`) is a bare http(s) origin whose host is `localhost`, `*.localhost`, `127.0.0.1` or `[::1]`
(look-alikes such as `evil-localhost` or `localhost.evil.org` do not count). If the flag is set next to any non-loopback origin the
server **refuses to start** with a message naming the origin; it is never silently ignored and never loosens anything for a real
deployment (real origins are public https hostnames). `src/seed/staging.ts` also refuses to run without the flag. Unit tests:
`tests/unit/securityConfig.test.ts` > "CMS_ALLOW_INSECURE_LOCAL_STAGING".

Consequences to keep in mind:

- `TRUST_PROXY=true` is required (production rule). There is no reverse proxy in staging, so the API tests play the proxy by sending
  one `X-Forwarded-For` entry per client (`TRUST_PROXY_HOPS=1`: the right-most entry is the client). A request with no such header
  lands in the shared `unknown` bucket (see section 6).
- The auth cookie is `Secure; HttpOnly; SameSite=Lax` (production behaviour) while the staging origin is `http://`. Chromium and
  Firefox are expected to accept `Secure` cookies from `http://localhost` / `http://*.localhost` (potentially trustworthy origins) and Safari is known not to,
  so do not use Safari for staging. This was **not verified by the API suite** (it has no browser); the browser lane records the actual behaviour in its section of the matrix.
- HSTS is sent but browsers ignore it over http.

## 4. What is synthetic

`src/seed/staging.ts` (idempotent) creates only invented data. Slugs are prefixed `staging-`, titles say "Synthetic".

| Data | Content |
| --- | --- |
| Categories | the 9 site categories (taxonomy only; the frontends map `news`, `features`, ... by slug) |
| Staff | one per role: `staging-admin@staging.invalid`, `staging-editor-in-chief@...`, `staging-section-editor@...` (section: news), `staging-trusted-publisher@...` (section: news), `staging-reporter@...` |
| Articles (12) | 6 published (one with a correction), 1 each of draft, in_review, changes_requested, approved, scheduled (+30 days), archived |
| Live | `staging-live-event` (live; two approved updates, one **pending**), `staging-draft-event` (draft, must stay hidden) |
| Submissions | one `new` synthetic tip (`SUB-STAGING1`) |
| Media | none seeded; the API tests upload and delete their own generated PNG |

The tests create more records (prefix `e2e-<random>`) and delete them again (articles, media, submissions). Audit-log rows cannot be
deleted through the API and stay until `staging:down`.

## 5. Credentials: generation and storage

- Generated on every `staging:up` with Node `crypto.randomBytes` (passwords: `Stg-` + 24 hex chars, which satisfies the 12-character
  policy). Stored **only** in `.staging/credentials.json` (mode 0600 where the OS supports it) and, for the seed process, read from that file path
  (`STAGING_CREDENTIALS_FILE`); they are never put in an environment variable, argv, stdout or a log.
- `.staging/` is gitignored and deleted by `staging:down`. Copying credentials into a PR, issue, chat or evidence file is a mistake:
  `docs/evidence/*.txt` was scanned for every generated secret and password before saving.
- Browser tests read the same file (`staging.users.<role>.email|password`). Roles: `admin`, `editor-in-chief`, `section-editor`,
  `trusted-publisher`, `reporter`.

## 6. API E2E suite (`e2e/api/*.test.ts`, config `vitest.e2e.config.ts`)

Real HTTP with `fetch` against the running server, manual cookie jar (Set-Cookie parsed, `Max-Age=0` deletes), `Origin` set like a
browser. Excluded from `npm test` (which stays self-contained). Each test creates its own data under a unique run id, uses its own
client address, and cleans up, so order does not matter. Re-running against the same environment is safe (verified: two consecutive runs, 58/58).

Notes on behaviour that only a real server shows:

- `src/proxy.ts` (Next middleware) is what produces the invalid-filter `400` and the `413` for oversized bodies. Route-handler tests
  cannot reach it. Both are confirmed here, including their CORS headers.
- **Rate-limit buckets and browsers.** The per-IP submission limit is deliberately 3 per 15 minutes. Real browsers talk to staging with
  no `X-Forwarded-For`, so *all* browser traffic shares the `unknown` bucket (3 submissions in total, then 429 for everyone, and the per-email
  limit is 3/hour). Browser tests that submit more than a few tips must raise it:
  `STAGING_SUBMISSION_RATE_LIMIT=50 npm run staging:up`. Counters live in memory, so a restart resets them.
- The "(needs network)" tests call the real Cloudflare Siteverify (`challenges.cloudflare.com`) with the always-pass test secret and the dummy token
  `XXXX.DUMMY.TOKEN.XXXX`. If Cloudflare is unreachable they are **skipped with a console warning**, not failed.
- The expired-token test forges a token from a real one (same claims, `exp` in the past, same HS256 key derivation), reading `PAYLOAD_SECRET` from `.staging/.env.staging`; it skips if that file is absent
  (for example when `STAGING_URL` points at another server).

### PASS/FAIL matrix (run of 2026-10-13, Windows 11, Node 24.x, evidence: `docs/evidence/e2e-api-2026-10-13.txt`)

Result column: PASS = passed against the real production build. Browser rows are filled by the browser-test lane.

| Area | Test (file > test) | Result |
| --- | --- | --- |
| Login | auth > login returns 200, JWT, user, hardened cookie (HttpOnly, SameSite=Lax, Secure, host-only, no-store) | PASS |
| me (cookie) | auth > GET /api/users/me with the cookie | PASS |
| me (JWT) | auth > GET /api/users/me with `Authorization: JWT` | PASS |
| Bad login | auth > wrong credentials: 401, no enumeration | PASS |
| Logout | auth > logout clears cookie; old cookie and old JWT become anonymous | PASS |
| me after logout | auth > me after logout returns 200 `user: null` | PASS |
| Invalid token | auth > garbage token unauthenticated; protected collections refuse it | PASS |
| Wrong key | auth > token signed with the wrong key is rejected | PASS |
| Expired token | auth > EXPIRED token (valid signature, exp in the past) is rejected | PASS |
| CSRF | auth > valid cookie from a non-allowlisted Origin is anonymous | PASS |
| Staff-only reads | auth > anonymous callers cannot read staff-only collections | PASS |
| Reporter limits | workflow > reporter cannot publish (403); cannot create published (403); cannot approve own work (403); cannot delete | PASS |
| Reporter allowed | workflow > reporter can create draft and submit for review | PASS |
| Editor flow | workflow > editor-in-chief approves, then publishes; `publishedAt` server-owned; public display; staff fields hidden | PASS |
| Review loop | workflow > request changes then resubmit | PASS |
| Transitions | workflow > invalid transition rejected | PASS |
| Corrections | workflow > correction required to edit published; archive hides it | PASS |
| Anonymous submission | submissions > real Siteverify, test secret + dummy token -> 201 `{ok, reference, message}` | PASS |
| Stored pending | submissions > stored as `new`, IP hashed, client `status/reference` ignored, never visible publicly | PASS |
| Duplicate | submissions > identical content -> 409 | PASS |
| Turnstile missing | submissions > missing token -> 400 `turnstileToken`; blank token -> 400 | PASS |
| Validation | submissions > field errors are `[{field, message}]`; honeypot stores nothing; non-JSON -> 415 | PASS |
| Submission CORS | submissions > allowed origin echoed + `Expose-Headers: Retry-After`; disallowed -> 403, no ACAO; preflight 204 / 403 | PASS |
| 429 | submissions > 429 + `Retry-After` + `Access-Control-Expose-Headers` + ACAO; forged XFF prefix stays limited; other IP unaffected | PASS |
| 413 | submissions > >64 KB -> 413 with CORS; >1 MB JSON on `/api` -> 413 from `proxy.ts` with CORS (allowed origin) and none (disallowed) | PASS |
| Upload | media > multipart PNG -> 201, absolute url, resized thumbnail/card | PASS |
| Serve media | media > URL 200, `image/png`, `X-Content-Type-Options: nosniff`, PNG bytes; anonymous fetch 200 | PASS |
| Render image | media > article `featuredImage` at depth=1 (url, alt, sizes, no `uploadedBy`); depth=0 returns the id | PASS |
| Upload hardening | media > anonymous upload refused; SVG/HTML/mislabelled rejected; >11 MB -> 413 with CORS | PASS |
| Published-only | public-visibility > list only published, newest first, no staff fields | PASS |
| `pagination=false` | public-visibility > ignored, capped at 100 | PASS |
| Draft filter | public-visibility > `where[status][equals]=draft` (and 5 other statuses) returns nothing | PASS |
| By id | public-visibility > unpublished article 404 anonymously, 200 for admin | PASS |
| Slug / category | public-visibility > by slug and by category id; categories public | PASS |
| Live | public-visibility > draft event hidden; only approved updates public; cursor polling; pending only in the editor queue | PASS |
| Invalid category | public-visibility > `where[category][equals]=news` -> 400 `{ok:false, errors:[{field}]}` (through `proxy.ts`) | PASS |
| 400 + CORS | public-visibility > the 400 carries CORS for allowed origins only; other malformed relationship filters 400; numeric id 200 | PASS |
| CORS allowlist | cors > allowed origins echoed with credentials; disallowed get no ACAO, never `*` | PASS |
| Preflight | cors > OPTIONS login preflight grant (allowed) / none (disallowed) | PASS |
| Cross-origin login | cors > newsroom-origin login carries the grant; cookie authenticates later calls | PASS |
| Unit / types / build | `tests/unit/securityConfig.test.ts` (flag), `npx tsc --noEmit`, `npm test` (308 tests), `npm run build` | PASS |
| Browser: same-site login sets `payload-token` (host-only, HttpOnly, SameSite=Lax, Secure), invisible to `document.cookie`; me/logout | browser > auth.spec (desktop-chrome + android-pixel7) | PASS |
| Browser: tampered / garbage / wrong-key / `alg=none` / expired / unknown-session cookies are anonymous; admin revoke ends a live session | browser > auth.spec | PASS |
| Browser: cross-site origin cannot read (no ACAO), JSON POST blocked at preflight, HTML form POST 403 with no cookie; same-site non-allowlisted origin is anonymous | browser > auth.spec | PASS |
| Browser: reporter PATCH to published 403, editor approve 200; admin UI renders the Articles list (screenshots) | browser > auth.spec | PASS |
| Browser: public page (`credentials:'omit'`) sees published only, draft 404 | browser > auth.spec | PASS |
| Browser: cross-app publish -> public display through the real newsroom/public apps | not run (apps not on `feat/newsroom-mvp`, see section 10) | BLOCKED |

Total: 58 API tests, 0 failed, 0 skipped (network reachable on the run machine). Browser: 16 tests (8 x 2 viewports), 0 failed
(evidence: `docs/evidence/browser-auth-2026-10-13.txt` and the two `browser-admin-articles-*.png` screenshots).

## 7. Cookie authentication in a real browser (issue #16 part 3: requirements)

These are the rules the API tests assert at the HTTP level; the browser lane verifies them in an actual browser.

- The staff cookie is `payload-token`, `HttpOnly`, `SameSite=Lax`, host-only (no `Domain`), `Secure` in production. `Lax` means the browser only
  stores and sends it on **same-site** requests: `newsroom.churchtimes.localhost:5174` and `cms.churchtimes.localhost:3100` are same-site (same registrable
  suffix `churchtimes.localhost`, ports ignored). A newsroom on a different registrable domain (or `*.github.io`, `*.pages.dev`) logs in with 200 and is
  anonymous afterwards. We do not use `SameSite=None`.
- Every call from the newsroom must use `fetch(..., { credentials: 'include' })`. The CMS answers `Access-Control-Allow-Origin: <exact origin>` and
  `Access-Control-Allow-Credentials: true` only for origins in `CMS_CORS_ORIGINS`; the origin must **also** be in `CMS_CSRF_ORIGINS`, otherwise the cookie
  is ignored and the request is anonymous (tested: "valid cookie from a non-allowlisted Origin is anonymous").
- The public site calls with `credentials: 'omit'`; it needs no cookie and its origin goes in `CMS_CORS_ORIGINS` and `PUBLIC_SUBMISSION_ORIGINS`.
- `GET /api/users/me` returns `200 { user: null }` (not 401) for missing, expired, revoked or logged-out sessions. UIs must check `user`.
- Expired/revoked tokens: sessions are stored server-side; logout and admin revoke end them immediately; JWTs expire after 8 hours.

### 7.1 Browser suite (`e2e/browser/`, `playwright.config.ts`)

```bash
npm run test:e2e:browser:install   # once: downloads Chromium for Playwright
npm run test:e2e:browser           # boots its own stack, runs desktop-chrome (1280x800) + android-pixel7 (412x839)
```

By default the suite boots its **own** disposable stack: embedded PostgreSQL on 55433 in an OS temp dir, `payload migrate`, a synthetic seed
(random passwords, never printed), `next start` (production build, `CMS_ALLOW_INSECURE_LOCAL_STAGING=true`) on 127.0.0.1:3201 behind a small recording
proxy on 3200, and three static harness pages on 5173-5175. Chromium maps `*.churchtimes.localhost` and `evil.othersite.localhost` to 127.0.0.1 through
`--host-resolver-rules`, so no hosts-file or DNS change is needed. The recording proxy logs only what the CMS received (Origin, cookie **names**, ACAO),
because Chromium hides headers of CORS-blocked responses from Playwright. `.next` is reused when newer than `src/` (set `E2E_SKIP_BUILD=1` to force reuse);
the suite waits while `.next/lock` exists. Teardown kills its process tree, stops PostgreSQL and removes the temp dir (also after setup failures).
Its instance runs `AUTH_LOGIN_RATE_LIMIT=200`: browsers send no `X-Forwarded-For`, so every login shares one loopback bucket.

Against a `staging:up` instance instead: `STAGING_URL=http://cms.churchtimes.localhost:3100 npm run test:e2e:browser`. Credentials come from
`.staging/credentials.json` (or `STAGING_CREDENTIALS_FILE`); the instance must allow `http://newsroom.churchtimes.localhost:5174` and
`http://www.churchtimes.localhost:5173` in `CMS_CORS_ORIGINS`/`CMS_CSRF_ORIGINS` (never `evil.othersite.localhost:5175` or `sibling.churchtimes.localhost:5175`)
and run with `STAGING_AUTH_LOGIN_RATE_LIMIT=200`. In this mode the server-side header log and the expired/unknown-session tests are skipped
(they need the signing key). **This mode has not been run yet.**

Observed in Chromium (both viewports, 2026-10-13):

- `payload-token`: domain `cms.churchtimes.localhost` (host-only), path `/`, `HttpOnly`, `SameSite=Lax`, `Secure`, max-age 28800 s. Chromium accepts
  and returns a `Secure` cookie over `http://*.localhost`. `document.cookie` shows nothing on either origin; no cookie is stored for the newsroom host.
- Newsroom origin with `credentials:'include'`: exact-echo `Access-Control-Allow-Origin` plus `Access-Control-Allow-Credentials: true`, including
  on 403 error bodies and the preflighted PATCH. With `credentials:'omit'` no cookie is sent and `/me` returns `user: null`.
- `evil.othersite.localhost` (cross-site): GET reaches the CMS **without** the cookie, gets no ACAO, and the browser blocks the read; JSON POST stops
  at the preflight; an HTML form POST to `/api/articles` gets 403 and creates nothing. The same form from the allowlisted newsroom origin gets 201,
  so the 403 comes from origin + cookie policy, not the harness.
- `sibling.churchtimes.localhost` (same-site, **not** allowlisted): the browser **does** send the Lax cookie, and Payload's `CMS_CSRF_ORIGINS` check
  still treats the request as anonymous (403, nothing created). That allowlist is the only CSRF barrier between sibling subdomains, so keep it exact.
- Login also returns the JWT in the JSON body; frontends must ignore it and rely on the cookie (never store it in `localStorage`).

## 8. Docker Compose alternative (not required, not verified here: no Docker on the build machine)

The repository `docker-compose.yml` runs PostgreSQL 16 on `127.0.0.1:5432`. To use it instead of embedded PostgreSQL:

```sh
docker compose up -d postgres
cp .env.example .env     # then edit: DATABASE_URL=postgres://churchtimes:churchtimes-local@127.0.0.1:5432/churchtimes,
                         # fresh random PAYLOAD_SECRET / PREVIEW_SECRET / IP_HASH_SALT, and the "environment template" values from section 2
npm run migrate
# seed: write a credentials file by hand (shape below), then
STAGING_CREDENTIALS_FILE=.staging/credentials.json NODE_ENV=production npx payload run src/seed/staging.ts
npm run build && npm run start     # or the container: docker compose --profile app up -d --build cms
STAGING_URL=http://127.0.0.1:3000 npm run test:e2e:api   # needs state.json or STAGING_URL, plus .staging/credentials.json
```

Credentials file shape (`credentials.json`, never commit): `{ "users": { "admin": {"email","password","role":"admin"}, "editor-in-chief": {...},
"section-editor": {...}, "trusted-publisher": {...}, "reporter": {...} } }`. Keep it at `.staging/credentials.json` (gitignored, read by both
the seed and the tests); never in `apps/cms` itself. Compose maps port 3000, so origins in the env template must use `:3000`. The embedded path is the supported one.

## 9. Cross-app smoke-test checklist (public site + newsroom + CMS)

Start the CMS first: `npm run staging:up` (note the printed URLs; staff logins are in `.staging/credentials.json`, open it locally, do not paste it anywhere).
Use Chromium or Firefox (not Safari), and hostnames, not `localhost`, so same-site cookies are exercised.

**A. Public site** (repository root; origin must be `http://www.churchtimes.localhost:5173`):

```sh
# Cloudflare always-pass TEST site key (public); the CMS side uses the matching test secret.
VITE_PUBLIC_CMS_URL=http://cms.churchtimes.localhost:3100 VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA npm run dev -- --port 5173 --host 127.0.0.1
# open http://www.churchtimes.localhost:5173
```

- [ ] The "From the newsroom" section lists the 6 synthetic published stories; none of the draft/in-review/approved/scheduled/archived ones appear.
- [ ] Open a story: body renders; the corrected story (`staging-published-6`) shows its correction once the public app renders corrections (known gap).
- [ ] Submit a tip: genuine confirmation with a `SUB-...` reference; the same text again shows the duplicate message; 4th submission from the same address within 15 minutes shows the rate-limit message.

**B. Newsroom UI** (after Gemini's newsroom is integrated into `feat/newsroom-mvp`; serve it from `http://newsroom.churchtimes.localhost:5174`, live mode, backend `http://cms.churchtimes.localhost:3100`):

- [ ] Log in as the synthetic reporter: create a draft, submit it for review, cannot publish (UI shows the 403, no fake success).
- [ ] Log in as the editor-in-chief: approve and publish it; reload the public site: it appears; unpublish (archive): it disappears.
- [ ] Review queue shows the synthetic submission `SUB-STAGING1` and any tip made in step A; reject or convert one.
- [ ] Live: the pending update in `staging-live-event` appears in the queue; approve it; the public timeline poll shows it.
- [ ] Log out: the next protected action shows the sign-in state, not an error loop. Wait for the 401/403 states to render in the UI (expired session: restart staging, or revoke from the admin).

**C. CMS admin** (`http://cms.churchtimes.localhost:3100/admin`): log in as the admin, open Articles, Submissions, Live updates, Users; confirm no real data is present.

**D. Android-sized viewport**: Chrome DevTools device toolbar (Pixel 7, 412x915) on all three origins, or Playwright with `devices['Pixel 7']` (browser lane,
`npm run test:e2e:browser`). On a real Android phone: `adb reverse tcp:3100 tcp:3100 && adb reverse tcp:5173 tcp:5173 && adb reverse tcp:5174 tcp:5174`, then open the same
`*.localhost` URLs in Chrome for Android (it resolves `*.localhost` to loopback, which `adb reverse` forwards to the PC).

Full automated equivalents: API suite above; browser suite `npm run test:e2e:browser` (browser lane).

## 10. Exact staging blockers (as of 2026-10-13, from `gh`)

**Gemini newsroom (PR #2, issue #7).** PR #2 `agent/gemini-ui-support` is OPEN and `CONFLICTING` with `feat/newsroom-mvp`; `apps/newsroom` does not exist on the integration branch
yet, so there is nothing to serve in checklist B. Needed from that lane (all in `docs/frontend-integration.md`): (1) an integration branch from `feat/newsroom-mvp`;
(2) live mode with no mock fallback, no mock login, `credentials: 'include'` on **every** call, and a backend URL / `preferLive` setting that can be set without code changes
(the committed adapter defaults to `http://localhost:3000`, `preferLive: false`, stored in `localStorage`); (3) CMS field mapping (Lexical `content`, numeric category ids, submission
statuses and `reviewerNotes`, live event `category`, multipart media, corrections) and `where[category][equals]=<id>` instead of a slug; (4) serve from a hostname that is same-site with the
CMS (`newsroom.<domain>`), in `CMS_CORS_ORIGINS` and `CMS_CSRF_ORIGINS`. Backend side: nothing blocks them; staging already allowlists `http://newsroom.churchtimes.localhost:5174`.

**Codex public app (issue #15).** Public code on `feat/newsroom-mvp` reads published articles correctly; PR #17 (`agent/cms-field-mappings`, OPEN, mergeable, CI "unstable") aligns the submission
payload and the `201 {ok,reference,message}` parsing; PR #4 (forms) and #3/#5 are still open. Needed: (1) merge or base on PR #17 so tips are not reported as `unconfirmed`;
(2) set `VITE_PUBLIC_CMS_URL` and `VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA` (test key) for staging builds; (3) corrections and `featuredImage` rendering (available in the API, not rendered);
(4) real URLs/SEO: the site uses hash routes, which the CMS cannot influence; (5) the public site must run from `http://www.churchtimes.localhost:5173` (or be added through `STAGING_EXTRA_ORIGINS`).

**Backend / shared.** Cookies on `*.localhost` are verified in Chromium (section 7.1); Firefox and Safari are not tested. The Turnstile **widget** (as opposed to the server-side check) is
not exercised by the API suite; password-reset e-mail is not tested (no SMTP in staging); anonymous media access remains the documented limitation (`docs/security.md` section 4);
MFA for admin/editor-in-chief is not implemented.

## 11. Known gaps

- The browser suite covers Chromium only (desktop + Pixel 7 emulation), not Firefox/Safari or a physical phone; its `STAGING_URL` mode has not been run.
- Real https on a real registrable domain is not tested; the cookie attributes are identical there.
- Not tested: scheduler publishing (a scheduled article is seeded for +30 days), password reset, account lockout and per-IP login limits, `refresh`, preview tokens, convert-submission
  (covered by `tests/integration`), version restore.
- The in-memory rate limiters make results depend on process lifetime; the suite avoids shared buckets by using one client address per test.
- Uploaded test media is written to `apps/cms/media` (shared with local dev) and removed by the tests; a crash mid-run can leave files there (gitignored).
- Two staging instances cannot share `.next` while building (see section 1).
- The Docker path (section 8) is documented but was not run.
- The build prints a Next.js "multiple lockfiles" warning (workspace root inference); harmless.

## 12. Rollback

Staging is disposable and touches nothing outside `apps/cms/.staging/` (and `apps/cms/media` for transient uploads): `npm run staging:down` stops the server and PostgreSQL (by recorded PIDs;
`taskkill /T /F` on Windows, process group on POSIX) and deletes `.staging/`. There is no production, WordPress, DNS or Truehost interaction. To roll back the code change itself: revert
`src/lib/securityConfig.ts` (the `CMS_ALLOW_INSECURE_LOCAL_STAGING` flag; production behaviour is identical without it) together with `tests/unit/securityConfig.test.ts`. Never set the flag in a real deployment: it will refuse to start there anyway.

## 13. Cross-app real UI E2E

Answers issue #16 ("one real browser cross-app scenario ... actual newsroom and public UIs"). **Real UI, no mocks**: Chromium drives the compiled public
site (repository root, `vite build`) and the compiled newsroom SPA (`apps/newsroom`, `vite build`) against a real Payload CMS (`next start` on the existing
production `.next`) and a disposable embedded PostgreSQL. The real Cloudflare Turnstile widget (always-pass TEST site key
`1x00000000000000000000AA`, network required) produces the token; the CMS verifies it with Cloudflare's always-pass TEST secret. A test whose title
contains **HARNESS** is not a pure UI path (only one: an in-flight request edit, see below). Nothing here is the old mocked harness of section 7.1; the
browser lane in section 7.1 still tests cookies/CORS with static pages and is not a UI E2E.

```bash
cd apps/cms
npm run test:e2e:cross-app          # = playwright test -c playwright.cross-app.config.ts ; never runs `next build` (needs apps/cms/.next)
# faster developer loop (stack stays up between runs):
npx tsx e2e/cross-app/dev-stack.ts <scratch>/xapp.json                      # terminal 1, stop with Ctrl+C
XAPP_ATTACH=<scratch>/xapp.json npx playwright test -c playwright.cross-app.config.ts 02-newsroom   # terminal 2
```

Ports (this lane only): CMS 3400 (recording proxy) to 3401 (`next start`), PostgreSQL 55435, public site 5373 (served by its real host `tools/serve-public.mjs`: clean `/reports/:slug/` URLs, server-rendered
article HTML, real 404s), newsroom 5374, 5375 (second public build exactly as section 9 says, no endpoint override). Origins: `http://cms|newsroom|www.churchtimes.localhost:<port>` (same-site, `--host-resolver-rules`). `XAPP_KEEP_EVIDENCE=0` skips writing `docs/evidence/cross-app-*`.
Instance-only settings: `AUTH_LOGIN_RATE_LIMIT`, `SUBMISSION_RATE_LIMIT`, `SUBMISSION_EMAIL_RATE_LIMIT` raised to 500 (browsers send no `X-Forwarded-For`).
Uploaded test images land in `apps/cms/media` with a per-run prefix and are removed on teardown.

### Journeys (files in `e2e/cross-app/`, run for `desktop-chrome` 1280x800 and `android-pixel7` 412x915)

| File | Scenario | What is asserted |
| --- | --- | --- |
| `01-public-tip.spec.ts` | B (reader), C (public failures) | real Turnstile iframe from challenges.cloudflare.com verifies; real form shows the receipt `SUB-xxxxxxxx`; the same reference exists in PostgreSQL with `status=new`; tip is absent from the public API and Latest list. Duplicate: CMS 409 shown as an error, no receipt, one row. **HARNESS tamper:** token blanked in flight (the real widget cannot fail with the test key) gives CMS 400 shown as "Verification was not accepted", no receipt. Incomplete form sends nothing. |
| `02-newsroom-article.spec.ts` | A | reporter logs in (LIVE CMS banner, no mock store), writes title/standfirst/category/body, uploads a generated PNG through the media picker (multipart `POST /api/media` 201), saves (server `draft`), submits (server `in_review`); approve/publish buttons absent AND direct `PATCH` from the newsroom origin returns 403 (status unchanged); section editor inspects, approves, publishes (`publishedAt` set); fresh anonymous context sees card + article page at `/reports/<slug>/` (cold reload 200 with server-rendered `<h1>`), `naturalWidth > 0` for card and hero image, no draft/staff-only fields, no cookie sent by the public origin. |
| `03-newsroom-tip-review.spec.ts` | B (newsroom) | editor finds the tip by its reference in Reader Tips, converts it (`POST /api/submissions/:id/convert`), editor opens the new draft; submission `converted`, article `draft`; anonymous API 404; public `/reports/<slug>/` is a real 404 "Article unavailable", and the legacy `#report/<slug>` link normalises to it. Reporter sees "only editors", direct `GET /api/submissions` refused. |
| `04-newsroom-unauthorized.spec.ts` | C | logged-out newsroom shows only sign-in on every route and loads no protected data; wrong password shows the server error; logout ends the server session; stale editor save forbidden by the CMS shows the CMS error (no success toast, nothing changed); non-image upload shows the CMS rejection; revoked session on a write is refused with nothing created; revoked session on read-only navigation returns to sign-in ("Your session has ended") and the server agrees `user: null`. |
| `05-public-gap.spec.ts` | public regression (#15) | the public site built with only `VITE_PUBLIC_CMS_URL=http://cms.churchtimes.localhost:<port>` enables the story form (gap 1 below, fixed by #22). |
| `06-newsroom-mobile-layout.spec.ts` | D | no newsroom view forces horizontal page scrolling at the project viewport (`KNOWN_OVERFLOW` lists any view that still does). |

Evidence: `docs/evidence/cross-app-2026-10-13.txt` (per-step log, server-side checks, results), headline screenshots `docs/evidence/cross-app-<scenario>-<project>.png`,
every step in `docs/evidence/cross-app-steps/`. Screenshots contain synthetic data only (the login screenshot is taken before any password is typed).

### Frontend gaps found (owners: public-site lane and newsroom lane)

1. **Fixed by #22 (public site, issue #15).** Was: **the story form is disabled for `VITE_PUBLIC_CMS_URL=http://cms.churchtimes.localhost:<port>`** (the value in section 9 A). `src/lib/public-submissions.js`
   `submissionEndpoint()` accepts `http:` only for hostnames `localhost`, `127.0.0.1`, `[::1]`; the form then shows "Online sending is not available yet", `#send-submission` is
   disabled and no Turnstile widget mounts. Evidence: `05-public-gap.spec.ts`. This lane builds the public site with `VITE_PUBLIC_SUBMISSIONS_URL=http://localhost:3400/api/public/submissions`
   (same CMS) so tips can be tested; the section 9 checklist item "Submit a tip" fails as written. #22 allows `*.localhost` for http; the lane no longer sets `VITE_PUBLIC_SUBMISSIONS_URL`.
2. **Newsroom: a revoked/expired session is not noticed on read-only navigation.** Payload turns a dead token into an anonymous request, so `GET /api/articles` answers 200 (published
   only) and `/api/users/me` answers `user: null`; the SPA only reacts to 401/403, so after "revoke sessions" the Review view renders with the signed-in chrome and an empty "In Review 0"
   queue. Writes were refused correctly and shown as errors. **Fixed on the integration branch**: the router calls `CmsAdapter.verifySession()` (`GET /api/users/me`) before rendering
   every staff view and signs out on `user: null`; the test in `04` is now a normal assertion (was `test.fail()`).
3. **Newsroom, mobile (Pixel 7, 412 px): the Review view forced a 544 px layout** (`.review-tabs` did not wrap or scroll), pushing the bottom nav and every modal wider than the screen, so
   pointer clicks on inspect/approve/publish/convert were physically blocked (found in this lane's first mobile run; steps then used keyboard activation, logged as "pointer click was blocked").
   **Fixed by the newsroom lane during this work**: `06-newsroom-mobile-layout.spec.ts` now asserts no horizontal overflow for all five views at 412 px and the final run needs no keyboard fallback.
   (The Dashboard table is wider than the screen but scroll-contained.)
4. Minor: the "Log out" button text was dark on the dark header. **Fixed on the integration branch** (`.session-chip .btn-outline` in `apps/newsroom/styles/newsroom.css`).

Limits: Turnstile action/hostname enforcement is not exercised in the browser lane (Cloudflare's test secret returns no `action`, so a non-empty `TURNSTILE_EXPECTED_ACTION` would fail closed).
Endpoint-level enforcement (wrong/missing hostname or action, nothing stored) is covered by `tests/integration/turnstile-policy.test.ts` with a stubbed transport. Scheduled publishing, live coverage UI, correction notes and Firefox/Safari are not covered. Chromium only.

### Optional engines: Firefox and WebKit (`XAPP_ALL_BROWSERS=1`)

- Default stays Chromium-only. `XAPP_ALL_BROWSERS=1` adds projects `firefox-desktop` (Desktop Firefox 1280x800), `webkit-desktop` (Desktop Safari 1280x800) and `webkit-iphone` (iPhone 14); defined in `e2e/cross-app/support/browsers.ts`. Install engines once: `npx playwright install firefox webkit` (user cache, no npm install).
- `--host-resolver-rules` is Chromium-only. Probed on Windows: Firefox and Playwright's WebKit resolve `*.localhost` to loopback natively, so no hosts-file or system change is used. Firefox additionally lists the exact stack hosts in `network.dns.localDomains`.
- WebKit here is Playwright's WebKit build on Windows. It approximates Safari (same engine family) but is **not real Safari**: iOS-specific behaviour (keyboard, safe areas, ITP) is not covered.
- WebKit needs one harness accommodation (not a product bug): the CMS session cookie is `Secure` (production build) and WebKit refuses a `Secure` cookie received over plain http even for `*.localhost` (Chromium and Firefox exempt it), so the recording proxy strips `Secure` from `Set-Cookie` for WebKit user agents only (`support/cookie-compat.ts`; real staging is https).
- Cookie-free public site: A3 (`02`) counts only its own traffic (`logStart` slice; the proxy log is cumulative, and A3's fresh context has no staff session, so it cannot prove the staff-cookie property alone). Spec `03` asserts it where a staff session is live: after the signed-in editor page visits the public site, every public-origin request that reaches the CMS (at least one must exist) carries no cookie. Strict on Chromium and Firefox. **Windows WebKit exception (engine limitation, not a product bug):** a bare probe (plain page and server, no product code) showed Playwright's Windows WebKit sends the cookie jar on cross-origin `fetch` for `credentials: 'omit'` and `same-origin` as well as `include`, where Chromium and Firefox send it only for `include`. On `webkit-*` projects only the public site's own `omit` fetches (read-only `GET /api/articles`, `/api/categories`, the exact offenders recorded) are tolerated and annotated `webkit-windows-omit-cookie`; any other cookie-bearing public-origin request (media, writes, auth) still fails. Real Safari follows the fetch spec.
- Example: `XAPP_ALL_BROWSERS=1 npx playwright test -c playwright.cross-app.config.ts --project=firefox-desktop --project=webkit-desktop --project=webkit-iphone`.

### Teardown message `next start exited with code 1` (e2e/browser stack)

Not a crash. Windows `taskkill /T /F` (and any forced kill) gives the killed process exit code 1; a healthy idle `node` killed the same way also exits 1. Before the kill the server was
still running with 0 error lines in its output (16/16 browser tests passed). `e2e/browser/support/stack.ts` and the new stack now log "next start stopped by teardown (code 1; non-zero
after a forced kill is expected, not a crash)" for exits during teardown and `UNEXPECTED: next start exited on its own` plus the output tail for any earlier exit.

### Docker smoke in CI (`.github/workflows/cms-docker.yml`)

- The image is only ever built and run in CI (no Docker on the development machines): details in `docs/operations.md` section 3.1. It is a separate lane from this Playwright one.
- Production-mode boot uses the same documented flag as this lane (`CMS_ALLOW_INSECURE_LOCAL_STAGING=true`, loopback http origins, Cloudflare's always-pass test secret).
