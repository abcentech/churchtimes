# Church Times CMS — operations

Status: **Production deployment has NOT been performed.** Deploying to a real server requires explicit
approval from the project owner after the hosting, backup and restore steps below have been verified.

This document covers hosting requirements, deployment, configuration, backups, rollback and security.

## 1. Hosting requirements

Minimum for a small VPS:

| Resource | Minimum | Notes |
| --- | --- | --- |
| CPU | 2 vCPU | |
| RAM | 4 GB | `next build` can need more than this. Build on a CI runner or a larger machine, or add swap. |
| Disk | 40 GB SSD | Media uploads grow over time. Monitor usage. |
| OS | Ubuntu 24.04 LTS | |
| PostgreSQL | 16 | Installed on the same VPS. The database must use the UTF8 encoding (`createdb -E UTF8`; check with `psql -l`): the legacy comments archive holds emoji and non-Latin text that other encodings cannot store. |
| Node.js | 24 | Use the version in the repository root `.nvmrc`. |
| Reverse proxy | Caddy (recommended, automatic TLS) or Nginx | Terminates TLS and forwards to the app on `127.0.0.1:3000`. |

Network:

- Firewall (ufw or cloud firewall): allow **22** (SSH, key-only), **80** and **443** only.
- PostgreSQL listens on `127.0.0.1` only. Never open port 5432 publicly.
- The Next.js app listens on `127.0.0.1:3000`. Only the reverse proxy is public.
- HTTPS only. Redirect HTTP to HTTPS.

## 2. Architecture

```
Internet ──► Caddy/Nginx (443, TLS) ──► Next.js/Payload (127.0.0.1:3000)
                                              │
                                              ├──► PostgreSQL 16 (127.0.0.1:5432)
                                              └──► media directory (local disk)
```

Runtime processes: one `npm run start` process (systemd unit recommended), PostgreSQL, the reverse proxy.
Media uploads are stored on the local disk in `apps/cms/media` (Payload default for uploads).

## 3. Deployment procedure

Run as a dedicated deploy user, not root. Paths below are examples.

1. **Back up the database first.** Do this before every migration (see §6):
   ```sh
   sudo -u postgres pg_dump -Fc churchtimes > /var/backups/churchtimes/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).dump
   ```
2. Fetch the release. Check out the tagged or reviewed commit. Do not deploy an untagged working tree.
   ```sh
   cd /srv/churchtimes/app && git fetch --tags && git checkout <release-tag-or-commit>
   cd apps/cms
   ```
3. Install and build:
   ```sh
   npm ci
   npm run build
   ```
4. Apply migrations **before** starting the new version:
   ```sh
   npm run migrate
   ```
5. Restart the service:
   ```sh
   sudo systemctl restart churchtimes-cms
   ```
   On start the app validates its security configuration (§4). If it exits immediately, `journalctl -u churchtimes-cms` lists every
   problem (for example a missing `TURNSTILE_SECRET_KEY` or an http origin). Fix `.env` and restart; do not work around it.
   The systemd unit (not yet in the repository) should run `npm run start` in `apps/cms` as the deploy user,
   load the environment file, and restart on failure.
6. Health check. The public endpoint `GET /api/categories` returns JSON with status 200:
   ```sh
   curl -fsS https://cms.example.org/api/categories
   ```
   Also log in to `/admin` as a staff account and open one article.

Docker alternative: the repository includes `apps/cms/Dockerfile` and a compose file for local development.
A production compose setup is not defined yet. If you use Docker in production, run migrations as a separate
step before starting the new container (`docker compose --profile app run --rm cms npm run migrate`).

### 3.1 Docker smoke in CI

`.github/workflows/cms-docker.yml` builds `apps/cms/Dockerfile` on every pull request that touches `apps/cms/**` (and on pushes to
`feat/newsroom-mvp`), because Docker is not installed on the development machines. It uses no repository secrets: the PostgreSQL password,
`PAYLOAD_SECRET`, `PREVIEW_SECRET` and `IP_HASH_SALT` are random per run. It then:

1. builds the image (Buildx, GitHub Actions cache) and checks that the image sets a non-root `USER`, that no secret-bearing variable, build
   placeholder or per-run secret is in the image environment, history or filesystem, and that no `.env` file shipped;
2. starts `postgres:16` and applies migrations **with the image** (`npm run migrate`), as the release procedure above requires;
3. starts the CMS container in `NODE_ENV=production` (the production checks in `src/lib/securityConfig.ts` all run; the only relaxation is
   `CMS_ALLOW_INSECURE_LOCAL_STAGING=true`, which is honoured only for loopback origins) and waits for the image `HEALTHCHECK` to report healthy;
4. smoke-tests `GET /api/users/me` (200, anonymous, `user` null), `GET /admin` (200 or a redirect to a page that loads) and `GET /api/articles` (200),
   the HSTS header (production build only), `id -u` of the container process (not 0), that `/app/media` is writable, and that no run secret was logged;
5. prints the container logs if anything failed, and always removes the containers and network.

The compose file is not used in CI. If the job fails, read the "Container logs (on failure)" step first: a start-up validation error lists every problem.

## 4. Environment variables

Copy from `apps/cms/.env.example`. Keep the real file at `apps/cms/.env` on the server, owned by the deploy user,
with permissions `600`. Never commit it.

All variables below are read by the code. Startup validation (`NODE_ENV=production`) refuses to boot with a clear
message listing every problem (missing secrets, http or wildcard origins, dummy Turnstile secret).

| Variable | Required | Example (non-secret) | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | `postgres://churchtimes:<password>@127.0.0.1:5432/churchtimes` | PostgreSQL connection string. Keep it on localhost. |
| `PAYLOAD_SECRET` | yes | 64 hex chars | Signs login tokens, at least 32 characters. Rotating it signs everyone out. |
| `PREVIEW_SECRET` | yes | 64 hex chars | HMAC secret for preview tokens, at least 32 characters, must differ from `PAYLOAD_SECRET`. |
| `IP_HASH_SALT` | yes | 32 hex chars | Salt for hashing client IPs on submissions, at least 16 characters. |
| `TURNSTILE_SECRET_KEY` | **yes (production)** | `0x4AAAA…` (secret) | Cloudflare Turnstile secret key. Startup fails in production without it, or with a Cloudflare dummy test secret. Dev fallback: always-pass test secret + warning. |
| `TURNSTILE_ALLOWED_HOSTNAMES` | recommended (startup warning when unset) | `www.churchtimesnigeria.net` | Comma list. Siteverify's `hostname` must match (case-insensitive), otherwise 403. Do not set it with dummy/test keys (they return a fixed hostname). |
| `TURNSTILE_EXPECTED_ACTION` | recommended (startup warning when unset) | `submit-story,contact-message,newsletter-subscribe` | Comma list. If set, the widget's `action` must be exactly one of the entries (case-sensitive); a token without an action is rejected (403). Must include every action the public site sends: `VITE_TURNSTILE_ACTION` (default `submit-story`) plus `contact-message` and `newsletter-subscribe` for the contact and newsletter forms. Each new endpoint also pins its own action, so a token for one form is refused by another. |
| `CMS_PUBLIC_URL` | **yes (production)** | `https://cms.example.org` | Public origin of the CMS: https, no trailing slash. Used as Payload `serverURL` (also added to the CSRF allowlist), reset links, absolute media URLs. |
| `CMS_CORS_ORIGINS` | yes | `https://www.example.org,https://newsroom.example.org` | Browser origins allowed to call the API (CORS). Explicit origins only. |
| `CMS_CSRF_ORIGINS` | yes | `https://newsroom.example.org` | Extra origins allowed to make cookie-authenticated requests (the CMS origin is always included). |
| `PUBLIC_SUBMISSION_ORIGINS` | yes | `https://www.example.org` | Origins allowed to POST `/api/public/submissions`. If empty in production, browser submissions are rejected. |
| `SUBMISSION_RATE_LIMIT` / `SUBMISSION_RATE_WINDOW_SECONDS` | no | `5` / `900` | Submissions per IP per window. |
| `SUBMISSION_EMAIL_RATE_LIMIT` / `SUBMISSION_EMAIL_RATE_WINDOW_SECONDS` | no | `3` / `3600` | Submissions per e-mail address per window. |
| `SUBMISSION_DUPLICATE_WINDOW_HOURS` | no | `72` | Identical email+title+body inside this window is rejected (409). |
| `CONTACT_RATE_LIMIT` / `CONTACT_RATE_WINDOW_SECONDS` | no | `5` / `900` | Contact messages per IP per window (`POST /api/public/contact`). Per e-mail address the limit is fixed at 3 per hour. |
| `CONTACT_NOTIFY_TO` | recommended | `desk@example.org,editor@example.org` | Comma list (max 10) of staff addresses e-mailed for each contact message, with `Reply-To` set to the sender. Server-side only: never returned to a browser or written to logs. An invalid entry stops startup in production. Needs SMTP; without either, messages are still stored and show `notifyStatus: not-configured` in CMS > Contact messages. |
| `PUBLIC_SITE_URL` | for the newsletter | `https://www.example.org` | Public **site** origin that confirmation e-mails link to (`<origin>/newsletter/confirm?token=...`, never an API URL). Bare origin, https only in production (a malformed or http value stops startup). While unset or http in production, `POST /api/public/newsletter/subscribe` answers `503` and stores nothing. |
| `NEWSLETTER_TOKEN_SECRET` | **yes (production)** | 64 hex chars | HMAC key for unsubscribe links, at least 32 characters, different from `PAYLOAD_SECRET` and `PREVIEW_SECRET`. Startup fails in production without it (the loopback-only disposable staging stack derives a throw-away key instead). Rotating it breaks every unsubscribe link already sent. |
| `NEWSLETTER_RATE_LIMIT` / `NEWSLETTER_RATE_WINDOW_SECONDS` | no | `5` / `900` | Newsletter sign-ups per IP per window. Per e-mail address the limit is fixed at 3 per hour. |
| `NEWSLETTER_TOKEN_RATE_LIMIT` | no | `20` | Per-IP limit (same window) for the confirm and unsubscribe endpoints combined. |
| `NEWSLETTER_RESEND_COOLDOWN_SECONDS` | no | `600` | If a confirmation e-mail went to an address within this many seconds, a new sign-up gets the same neutral `202` and nothing is sent (`0` disables). |
| `NEWSLETTER_MAX_CONFIRM_MAILS_PER_DAY` | no | `5` | Daily cap (rolling 24 h) of confirmation e-mails per address; beyond it, same neutral `202`, nothing sent. `bounced` addresses are never mailed automatically. |
| `PUBLIC_ARTICLE_PATH_TEMPLATE` | no | `/reports/{slug}/` | Current public path of an article, used to derive redirects from `legacyUrl` (C7). Exactly `/reports/{slug}/` (default) or `/{slug}/`; anything else stops startup. Must equal the value the public host reads. |
| `REDIRECT_ALLOWED_HOSTS` | no | `www.example.org` | Comma list of bare host names a redirect target may use as an absolute https URL (C7). Unset: internal paths only. A malformed entry stops startup. **Must equal the public host's `PUBLIC_REDIRECT_ALLOWED_HOSTS`** (the host also needs `PUBLIC_SITE_URL`): one disagreement makes the host reject the whole list. |
| `LEGACY_SITE_HOSTS` | no | `churchtimesnigeria.net,www.churchtimesnigeria.net` (default) | Comma list of host names an article's `legacyUrl` may carry. A `legacyUrl` on another host derives no rule (counted). A malformed entry stops startup. |
| `ADS_REQUIRE_PAYMENT` | no | `true` (default) | Advertising gate (C3). Only the literal `false` lets a campaign be approved and delivered without `paid`/`waived` payment. |
| `PUBLIC_ADSENSE_ENABLED`, `PUBLIC_ADSENSE_REVIEWED` | no | `false` (default) | Copied into `adsense.enabled` / `adsense.reviewed` of `GET /api/public/advertising`. No publisher id or script is ever served by the CMS. |
| `AUTH_LOGIN_RATE_LIMIT`, `AUTH_FORGOT_RATE_LIMIT`, `AUTH_RESET_RATE_LIMIT`, `AUTH_RATE_WINDOW_SECONDS` | no | `10`, `5`, `10`, `900` | Per-IP limits for login / forgot-password / reset-password. |
| `TRUST_PROXY` | **yes (production)** | `true` | The app always runs behind a reverse proxy, so production startup **fails** unless this is exactly `true`. Make sure the app is reachable only through that proxy (it listens on `127.0.0.1`). Without trust every client would share one rate-limit bucket. |
| `TRUST_PROXY_HOPS` | no | `1` | Number of trusted reverse proxies in front of the app (1 to 10, default 1). The client address is the entry that many places from the **right** of `X-Forwarded-For` (the address your own proxy appended), never the leftmost, which clients can forge. A chain shorter than this fails closed (shared bucket). The §4.4 blocks overwrite the header, so `1`; use `2` only if two proxies each append (for example nginx with `$proxy_add_x_forwarded_for` behind another proxy). |
| `CLIENT_IP_HEADER` | no | `cf-connecting-ip` or `x-real-ip` | Optional single header carrying the client address. When set (and `TRUST_PROXY=true`) it takes precedence over `X-Forwarded-For`; if the header is absent or not an IP address the forwarded chain is used. Only set it if your proxy overwrites that header on every request (§4.4). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | for reset e-mails | `smtp.example.org`, `587`, `cms@example.org`, (secret), `false` | SMTP transport. Setting `SMTP_HOST` turns the mailer on; `SMTP_PASS` is a secret. In production without `SMTP_SECURE=true`, STARTTLS is required. |
| `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` | with SMTP | `cms@example.org`, `Church Times CMS` | Sender of reset e-mails. |
| `SCHEDULER_ENABLED` | no | `true` on exactly one instance | Enables the in-process scheduled-publishing loop. |
| `SCHEDULER_INTERVAL_SECONDS` | no | `60` | Scheduler polling interval, in seconds. |
| `PAYLOAD_DB_PUSH` | no | `false` | Development only. Schema push instead of migrations. Keep `false` in production. |
| `NODE_ENV` | set by the platform | `production` | Use `production` on the server (enables Secure cookies, the HSTS header and startup validation). |
| `LOCAL_PG_PORT` | no | `54329` | Local development only (`npm run db:local`). |

Frontends need only the **public** Turnstile site key (`TURNSTILE_SITE_KEY` in this repo's naming); the CMS does not read it.

### 4.1 Cloudflare Turnstile setup (free)

1. Cloudflare dashboard > **Turnstile** > **Add widget**. The free plan is enough; a Cloudflare account is free and the website
   does not need to be proxied by Cloudflare.
2. Name it "Church Times submissions". **Hostnames**: add the public website hostname(s) that will show the widget
   (for example `www.churchtimesnigeria.net`; use a separate development widget for `localhost`).
3. Widget mode: *Managed* (recommended). Create, then copy the two keys:
   - **Site key** (public): put it in the public website's build configuration and pass it to the widget
     (`data-sitekey`). Safe to expose.
   - **Secret key**: put it **only** in the CMS server's `.env` as `TURNSTILE_SECRET_KEY`. Never in git, frontend code or chat.
4. Pin the widget action and hostnames (recommended; the server logs a warning at startup while either is unset). The public
   site sends the action from its build variable `VITE_TURNSTILE_ACTION` on both forms when it is set; only if it is
   unset do the forms fall back to `submit-story` (story) and `submit-contact` (contact), so set `TURNSTILE_EXPECTED_ACTION` to that exact value (for example `submit-story`),
   and set `TURNSTILE_ALLOWED_HOSTNAMES` to the same hostnames as step 2.
5. The frontend sends the token in the JSON body as `turnstileToken`. Tokens are single use and expire after 5 minutes;
   after any error call `turnstile.reset()` and let the visitor retry.
6. Verify after deploying:
   ```sh
   # no token -> 400 with field "turnstileToken"
   curl -s -X POST https://cms.example.org/api/public/submissions -H 'Content-Type: application/json' \
     -d '{"name":"Test","email":"t@example.org","title":"Test title","body":"A test story that is long enough to pass validation."}'
   # same body plus "turnstileToken":"bogus" -> 403 "Verification failed. Please try again."
   ```
7. Local development: leave `TURNSTILE_SECRET_KEY` unset (always-pass test secret, with a console warning) and use Cloudflare's dummy
   site key `1x00000000000000000000AA` in the frontend. Cloudflare's dummy secrets: `1x…AA` always passes, `2x…AA` always fails,
   `3x…AA` reports "token already spent". The CMS refuses all dummy secrets in production.
8. **Rotation or leak**: dashboard > widget > *Rotate secret key*, update `TURNSTILE_SECRET_KEY`, restart. Until restarted,
   submissions fail closed (403); they are never accepted unverified. The same happens if Cloudflare is unreachable.

### 4.2 SMTP / password-reset e-mail (zero-cost options)

Any SMTP server works; the CMS only needs host, port, credentials and a from address.

- An existing mailbox on your domain host (cPanel, Zoho, Google Workspace, Microsoft 365): use its SMTP host, port `587`
  (STARTTLS, `SMTP_SECURE=false`) or `465` (`SMTP_SECURE=true`), and the mailbox address as `SMTP_USER` and `EMAIL_FROM_ADDRESS`.
- A free tier of a transactional provider (for example Brevo, Mailjet, Resend, SendGrid): create an SMTP credential and use its host.
  Check the current free quota; reset e-mails are a handful per month.
- Use an `EMAIL_FROM_ADDRESS` on a domain with SPF/DKIM set up, otherwise reset e-mails land in spam.
- Test: use **Forgot password?** on `/admin/login` with your own account; the mail should arrive and the link should open
  `${CMS_PUBLIC_URL}/admin/reset/<token>`. Without `SMTP_HOST`, Payload only prints e-mails to the application log, so resets cannot be
  delivered in production (use the break-glass procedure below).

### 4.3 Account recovery (no e-mail, or no admin can sign in)

With shell access to the server, as the deploy user in `apps/cms`:

```sh
ADMIN_EMAIL=someone@example.org ADMIN_NEW_PASSWORD='<throw-away passphrase, 12+ chars>' npm run admin:set-password
```

It applies the password policy, clears the lockout and ends all sessions of that user. Sign in and change the password at once.
If **no user exists at all**, open `/admin` over https and create the first admin (`/api/users/first-register`); that endpoint is
refused as soon as one user exists.

Changing `PAYLOAD_SECRET` signs every user out. Changing `PREVIEW_SECRET` invalidates all outstanding preview links.
Changing `IP_HASH_SALT` makes older IP hashes incomparable. Rotating `TURNSTILE_SECRET_KEY` or `SMTP_PASS` needs a restart.
Plan rotations for a quiet period.

### 4.4 Reverse proxy: TLS, body limits, client address, compression

Payload's core routes read request bodies without a size limit, and the rate limiters trust whatever client address
the proxy reports. So the proxy must (1) cap request bodies at **12 MB** (the largest legitimate request is an 11 MB
media upload; everything else is under 1 MB and the app itself rejects `Content-Length` above 1 MB with `413`, above 11 MB
on `/api/media`, see `src/proxy.ts`), (2) **overwrite** the client-address headers instead of passing client values
through, (3) terminate TLS, and (4) compress text. The app listens on `127.0.0.1:3000` only.

Pick the block that matches your setup and set `TRUST_PROXY=true` (required) plus the matching variables:

| Setup | `TRUST_PROXY_HOPS` | `CLIENT_IP_HEADER` |
| --- | --- | --- |
| Caddy or nginx directly on the internet (blocks below) | `1` (default) | unset (or `x-real-ip`) |
| Cloudflare in front of Caddy/nginx; origin firewall allows Cloudflare ranges only | `1` | `cf-connecting-ip` |
| Cloudflare in front of nginx using `real_ip_header CF-Connecting-IP` (nginx block, option B) | `1` | `x-real-ip` |

**Caddyfile** (`/etc/caddy/Caddyfile`; TLS certificates are obtained and renewed automatically):

```caddyfile
cms.example.org {
	encode zstd gzip

	# Reject oversized bodies before they reach the app (413).
	request_body {
		max_size 12MB
	}

	header {
		Strict-Transport-Security "max-age=15552000"
		-Server
	}

	reverse_proxy 127.0.0.1:3000 {
		# Overwrite, never append to, anything the client sent. With one hop the app reads the last
		# X-Forwarded-For entry, which is therefore exactly the peer address Caddy saw.
		header_up X-Forwarded-For {remote_host}
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-Proto {scheme}
		# Behind Cloudflare use instead (and set CLIENT_IP_HEADER=cf-connecting-ip), and allow only
		# Cloudflare's published ranges (https://www.cloudflare.com/ips/) through the firewall:
		#   header_up CF-Connecting-IP {http.request.header.CF-Connecting-IP}
		transport http {
			read_timeout 60s
		}
	}
}
```

**nginx** (`/etc/nginx/sites-available/churchtimes-cms`; certificates from certbot or your CA):

```nginx
server {
    listen 80;
    server_name cms.example.org;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name cms.example.org;

    ssl_certificate     /etc/letsencrypt/live/cms.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cms.example.org/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=15552000" always;
    server_tokens off;

    # Largest accepted request body (413 above it). Keep request buffering on (the default): nginx then
    # always forwards a Content-Length, which the app requires on /api/users writes (411 otherwise).
    client_max_body_size 12m;
    client_body_timeout 30s;
    proxy_request_buffering on;

    gzip on;
    gzip_min_length 1024;
    gzip_types application/json text/css application/javascript text/plain;   # images are already compressed

    # Option B (Cloudflare in front): trust Cloudflare's ranges only, then $remote_addr is the visitor.
    #   set_real_ip_from 173.245.48.0/20;   # ...all ranges from https://www.cloudflare.com/ips-v4 and -v6
    #   real_ip_header   CF-Connecting-IP;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        # Overwrite, never $proxy_add_x_forwarded_for, so a client-supplied header cannot reach the app.
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Real-IP         $remote_addr;
        # Cloudflare option A (CLIENT_IP_HEADER=cf-connecting-ip): pass the header through unchanged.
        #   proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

Verify after deploying (from outside the server):

```sh
# 12 MB limit at the proxy (413 from Caddy/nginx), 1 MB limit at the app for JSON
head -c 13000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -X POST https://cms.example.org/api/media --data-binary @-
head -c 1100000  /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -X POST https://cms.example.org/api/articles -H 'Content-Type: application/json' --data-binary @-
# Forged X-Forwarded-For must not change the rate-limit bucket: after the limit, a fresh forged value is still 429
for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' -X POST https://cms.example.org/api/users/login \
  -H 'Content-Type: application/json' -H "X-Forwarded-For: 10.0.0.$i" -d '{"email":"nobody@example.org","password":"not-a-password"}'; done; echo
```

The last command should print ten `401` followed by `429` (`AUTH_LOGIN_RATE_LIMIT` is 10 per 15 minutes per address).
Remember that the in-memory counters are per process and reset on restart (§8).

### Secrets handling

- Generate secrets with a CSPRNG: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
- Store the production `.env` only on the server (and in the password manager of the two people who administer it).
- Never commit `.env`, dumps, media files or screenshots of the environment.
- Use different values per environment. CI uses obviously fake values generated per run.
- Rotate secrets after any suspected exposure or staff departure with admin access.

## 5. Media storage

- Uploads go to `apps/cms/media` on the server (`jpeg`, `png`, `webp`, max 10 MB, see `api-contracts.md` §3).
- The directory must be writable by the app user and excluded from git.
- Back it up with the procedure in §6. Media is not in the database dump.

## 6. Backups and restore

### Nightly database backup

Run as a cron job or systemd timer, under a user that can read the database:

```sh
pg_dump -Fc -h 127.0.0.1 -U churchtimes churchtimes \
  | gpg --encrypt --recipient <ops-key-id> \
  > /var/backups/churchtimes/db-$(date -u +%Y%m%dT%H%M%SZ).dump.gpg
find /var/backups/churchtimes -name 'db-*.dump.gpg' -mtime +14 -delete
```

- Retention: **14 days** locally.
- Encryption uses a key whose private half is held by the ops team, not on the VPS.
- Copy the encrypted dumps off-site (for example, to object storage in another region) as part of the same job.

### Nightly media backup

```sh
rsync -a --delete-after /srv/churchtimes/app/apps/cms/media/ <backup-host>:/backups/churchtimes/media/
```

- `rsync` sends data over SSH, but does not encrypt data at rest on the destination. The destination must
  be encrypted. For example, use an encrypted rclone remote, an encrypted restic repository, or an encrypted volume.
- Keep at least 14 days of media snapshots at the destination (use `restic` or versioned storage if you need history).

### Monthly restore test

Do this once a month and record the result. A backup you have not restored is not a backup.

1. Use a separate machine or VM, not the production server. Install PostgreSQL 16.
2. Create an empty database: `createdb churchtimes_restore`.
3. Fetch the most recent encrypted dump and decrypt it: `gpg --decrypt db-<timestamp>.dump.gpg > restore.dump`.
4. Restore: `pg_restore --no-owner --no-privileges -d churchtimes_restore restore.dump`.
5. Verify the data:
   - `psql churchtimes_restore -c '\dt'` lists the expected tables.
   - Check row counts for `articles`, `users` and `categories` against production (within the expected lag of the last backup).
6. Restore a sample of media files from the backup and open 5 of them. Check the byte sizes match.
7. Start the CMS against the restored database, with a test `.env` (own secrets, not production secrets), run
   `npm run migrate` (should report nothing to apply), and check `GET /api/categories`.
8. Record the date, the dump file name, and the result in the ops log. Delete the decrypted `restore.dump`
   and the test database when done.

## 7. Rollback

1. **Code rollback:** check out the previous release tag or commit, run `npm ci && npm run build`, and restart the
   service. Do not roll back code without considering the database.
2. **Database rollback:**
   - Preferred: stop the app, then restore the pre-deploy dump taken in §3 step 1 (`pg_restore --clean --if-exists`).
     Any content created after that dump is lost, so communicate with the newsroom before doing this.
   - Targeted: Payload's migration tooling can revert the most recent migration with `npx payload migrate:down`.
     This is not a package.json script yet. Confirm it works on a restored copy before using it in production.
3. After any rollback, re-run the health check in §3 step 6.

## 8. Concurrency and scaling limits

- **Rate limiting** (public submissions per IP and per e-mail; staff login, forgot-password and reset-password per IP):
  in-memory, per process. Correct only for a single app instance; with several instances each counts separately.
  Multiple instances need a shared store (PostgreSQL or Redis) before scaling out. Counters reset on restart.
  Per-account lockout and the reset-e-mail throttle are stored in PostgreSQL and are not affected.
- **Scheduler**: `SCHEDULER_ENABLED=true` on **exactly one** instance. Two instances will try to publish the same
  scheduled articles.
- **Live updates** use polling (`GET /api/live-events/:slug/updates`, every 15 to 30 seconds). Load is low at MVP scale.

## 9. Monitoring and logs

- Application logs: `journalctl -u churchtimes-cms -f` (systemd).
- Reverse proxy access and error logs: Caddy or Nginx default locations. Keep at least 14 days.
- PostgreSQL logs: `/var/log/postgresql/`. Watch for repeated authentication failures.
- Uptime: an external monitor that calls `GET /api/categories` every minute and alerts the ops contact.
- Disk: alert at 80% usage. The media directory and the backup directory both grow.
- No log shipping, metrics or error tracking is configured yet.

## 10. Security checklist

Confirm each item before go-live and again after any change to the server:

- [ ] HTTPS only, with a valid certificate. HTTP redirects to HTTPS. HSTS enabled at the proxy.
- [ ] `CMS_PUBLIC_URL`, `CMS_CORS_ORIGINS` and `CMS_CSRF_ORIGINS` list only the production origins.
- [ ] Session cookies are `Secure` (automatic in production) and `HttpOnly`.
- [ ] `PAYLOAD_SECRET`, `PREVIEW_SECRET` and `IP_HASH_SALT` are random, different, and not the example values.
- [ ] `PAYLOAD_DB_PUSH=false`.
- [ ] PostgreSQL and the app listen on `127.0.0.1` only. Port 5432 and 3000 are not reachable from the internet.
- [ ] Firewall allows only 22, 80 and 443. SSH is key-only, with root login disabled.
- [ ] Default and demo passwords are changed. No account has a password that appears in this repository.
- [ ] The first admin account uses a strong, unique password, and the account is named (not shared).
- [ ] **Two-person rule for admin:** no more than two people hold the `admin` role, and any change to a user's
      role or sections is agreed by both.
- [ ] Staff accounts that leave the newsroom are disabled the same day.
- [ ] Backups are encrypted, restored in a test at least monthly, and the last test passed.
- [ ] The system packages are updated (`unattended-upgrades` enabled), and Node 24 patch releases are applied.
- [ ] `TRUST_PROXY=true` (the app refuses to start in production without it), the app is reachable exclusively through the reverse proxy,
      and the proxy **overwrites** `X-Forwarded-For` / `X-Real-IP` (§4.4). `TRUST_PROXY_HOPS` matches the number of proxies; `CLIENT_IP_HEADER`
      is set only when the proxy (or Cloudflare, with the origin firewalled to its ranges) always supplies it.
- [ ] The proxy caps request bodies at 12 MB (`request_body max_size 12MB` / `client_max_body_size 12m`); the §4.4 verification commands return
      `413` / `429` as described.
- [ ] `npm run migrate` has applied `review_fixes` (adds `media.uploaded_by_id`, `live_updates.publish_sequence`, back-fills it for approved updates).
- [ ] `NODE_ENV=production` and the service starts (startup validation passes: https `CMS_PUBLIC_URL`, no `*`/http origins).
- [ ] `TURNSTILE_SECRET_KEY` is the real secret from the Cloudflare dashboard (not a dummy key); the widget's hostnames match the public site;
      `TURNSTILE_ALLOWED_HOSTNAMES` is set to the widget's public hostname(s), and `TURNSTILE_EXPECTED_ACTION` to the public build's
      `VITE_TURNSTILE_ACTION` (default `submit-story`). The server cannot see the public build, so confirm the two values match by hand;
      the startup log must show no `[security] TURNSTILE_*` warning. The secret exists only in the server `.env`.
- [ ] The public site embeds only the Turnstile **site** key and sends `turnstileToken` with every submission.
- [ ] `PAYLOAD_SECRET`, `PREVIEW_SECRET`, `IP_HASH_SALT` are each unique 32+ char random values; `.env` is mode 600.
- [ ] `CMS_CORS_ORIGINS`, `CMS_CSRF_ORIGINS`, `PUBLIC_SUBMISSION_ORIGINS` contain only the real https origins.
- [ ] SMTP is configured (`SMTP_HOST`, `EMAIL_FROM_ADDRESS`, SPF/DKIM on the sender domain) and a reset e-mail was received and used successfully.
- [ ] `npm run migrate` has applied `security_hardening` (adds `submissions.content_hash`).
- [ ] Response headers on `/admin` and `/api/categories` include `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
      `Strict-Transport-Security` (the proxy may add its own HSTS too).
- [ ] Login sets `payload-token` with `HttpOnly; Secure; SameSite=Lax` (check in the browser dev tools).
- [ ] Only the `admin` role holders can manage users; the first admin was created over https; no demo users exist.
- [ ] Break-glass procedure (§4.3) was tried once on a restored copy.

## 11. Functional checks before go-live

- [ ] Upload validation rejects SVG and HTML (per the API contract). Verify with a test upload.
- [ ] A public submission from a disallowed origin gets `403`. Verify with `curl -H "Origin: https://evil.example"`.
- [ ] A reporter account cannot approve or publish an article. Verify in the admin UI and API.
- [ ] A submission without a valid `turnstileToken` is refused (§4.1 step 6) and one from the real site form is accepted.
- [ ] Contact form (C5): a message from the real site form gets a `201` with a `MSG-` reference, appears in CMS > Contact messages (admin and
      editor-in-chief only), and `CONTACT_NOTIFY_TO` receives the notification with Reply-To set to the sender. With SMTP stopped, a message is
      still stored (`notifyStatus: failed`) and the sender still sees the normal `201`.
- [ ] Newsletter (C4): `NEWSLETTER_TOKEN_SECRET` and `PUBLIC_SITE_URL` are set; a sign-up from the real site form answers `202`, the confirmation e-mail
      arrives with a link on the public site, the public confirm page POSTs the token and the row becomes `confirmed` in CMS > Subscribers
      (admin and editor-in-chief only). With SMTP stopped the form answers `503` and stores nothing. `GET /api/subscribers/export?status=confirmed`
      works for an `admin` (CSV, audited) and is refused for everyone else.
- [ ] Mailchimp import (only if the owner supplies an export): keep the CSV **outside** the repository (the command refuses a path inside it), run
      `npm run import:subscribers -- --file <path>` first (dry run, counts only), check the counts, then add `--apply`. Expected columns, any order:
      `Email Address` (or `email`), `First Name`, `Last Name`, `OPTIN_TIME`, `CONFIRM_TIME`, `Status`. Only rows whose Status is `subscribed` are imported
      (as `confirmed`, consent time = `OPTIN_TIME`; a row without it is stored with `consentAt` null and counted). A file with `UNSUB_TIME` or `CLEAN_TIME` columns is refused; a file with no Status column is refused unless it is Mailchimp's "Subscribed" segment export and `--assume-subscribed` is added. Existing rows and erased addresses are never overwritten or re-created.
- [ ] Privacy notes (contact and newsletter): erasing a subscriber does **not** touch `contact-messages` from the same address (an admin deletes those by
      hand); rotating `IP_HASH_SALT` changes every erase hash, so earlier erasures stop suppressing re-imports (keep the salt stable); `PUBLIC_SITE_URL` is a
      bare origin, so the public site must be served at the root of its domain (confirmation links are `<origin>/newsletter/confirm`). Logs for these
      endpoints carry only error class and code, never an address, name or message; SMTP timeouts are 10 s connect, 10 s greeting, 20 s socket.
- [ ] `TURNSTILE_EXPECTED_ACTION`, when set, lists `contact-message` and `newsletter-subscribe`; startup prints a `[security]` warning if either is missing
      (that form would answer 403 to everyone).
- [ ] Article editor (go-live C1): open an article in the admin, insert a table and a **YouTube video** block (11-character id), save, reload. The
      editor features (blocks, table) are registered on `articles.content` only, so `npx payload generate:importmap` must be re-run and
      committed when they change. Any embed other than a valid YouTube block is refused by the API (`400`). Deploying this change runs
      migration `media_legacy_path` (one nullable indexed column on `media`; reversible).
- [ ] Wrong password 5 times locks the account; **Forgot password?** works end to end; after logout the old token no longer works.

### Newsletter subscriber data: retention (suggestions, owner to decide)

Nothing here runs on a schedule; the only deletion implemented is the purge command.
- Imported rows without proof of opt-in: `npm run newsletter:reconfirm -- --apply --deadline <date>`, then `npm run newsletter:purge-unconfirmed -- --deadline <date> --apply` after the date (dry run both first).
- Suggested: unsubscribed and bounced rows keep only what is needed to honour the opt-out (address or its hash, status, time); review yearly. Erase on request (`POST /api/subscribers/:id/erase`).
- Suggested: confirmed subscribers with no engagement for 24 months get a re-permission mail, then the purge flow; audit-log rows hold counts and ids only and can be kept.
- Subscriber data is admin only; every export, per-person export (`GET /api/subscribers/:id/subject-data`), status change, erase and CLI run leaves an audit row. Keep Mailchimp exports outside the repository and delete them after the import.

## 12. Status

- Production deployment: **not performed**. Requires explicit approval.
- Restore test: **not yet performed**.
- Security hardening (Turnstile, sessions, password policy, rate limits): implemented and covered by `tests/integration/security.test.ts`; see `docs/security.md`.
- Security-review fixes (media ownership, version access, live feed order, client IP, request limits, corrections, current password):
  implemented and covered by `tests/integration/review-fixes.test.ts` and the unit tests listed in `docs/security.md` §5.
- Scheduler, rate limiting and seed fixtures: implemented (single-instance limits, see §8).
