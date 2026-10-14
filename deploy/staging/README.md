# Church Times staging: one-VPS deployment kit

> **STOP. Staging must never run on the live web server.** The live Church Times Nigeria website (WordPress on LiteSpeed) is
> on **158.69.36.54**. Do **not** run anything from this folder there, or on any machine that hosts anything else. Staging goes on
> its **own NEW, EMPTY, separate VPS**. `setup.sh` refuses to run on 158.69.36.54 (no override), on a machine with a web server,
> panel, MySQL/MariaDB, `/var/www` content or something already on ports 80/443, and on a machine with less than 1.8 GB RAM.
> Do not reinstall, reset or "repurpose" an existing VPS for this. Only a VPS that was bought for staging and is empty qualifies.

This kit puts the newsroom MVP (public site, newsroom app, CMS, database) on one small Ubuntu server so the owner and the
team can test it over https. Everything here is synthetic test data. Nothing touches production, the live WordPress site, the
existing DNS records, e-mail or AdSense.

```
Internet :80/:443
   |
 Caddy ---- staging.churchtimesnigeria.net          -> public  (node, tools/serve-public.mjs, pre-built site)
   |   \--- newsroom.staging.churchtimesnigeria.net -> static files built from apps/newsroom
   |    \-- cms.staging.churchtimesnigeria.net      -> cms     (Payload/Next image from GHCR)
   |                                                     |
   +---------- compose network (nothing else published) -+-- postgres 16
```

The base domain is the single variable `STAGING_DOMAIN` (default `staging.churchtimesnigeria.net`, in `.env`). The three hostnames
are derived from it. They must stay under one registrable domain (`churchtimesnigeria.net`): see "Cookie" below.

## 1. Prerequisites

| Need | Detail |
| --- | --- |
| A NEW VPS | **1 vCPU, 2 GB RAM, 25 GB disk (minimum)**, Ubuntu **22.04 or 24.04** LTS, root SSH, a public IPv4 address, **hosting nothing else**. Not 158.69.36.54. Provider firewall (if any) must allow 22, 80, 443. setup.sh adds a 2 GB swapfile and `vm.swappiness=10` if the machine has no swap. |
| The CMS image in GHCR | The image is **built in GitHub Actions**, not on the VPS (`next build` needs about 4 GB RAM). It is `ghcr.io/abcentech/churchtimes-cms`, a **private package**, tags: the full git SHA and `staging`. The publish workflow must have run at least once before setup. |
| A GitHub token for GHCR | A fine-grained or classic token with **`read:packages` only** (nothing else), for a GitHub user that can read the package. |
| Cloudflare Turnstile widget | Create a widget (free) for the hostname **`staging.churchtimesnigeria.net`** (the public site shows it). You will need its **site key** (public) and **secret key** (secret). |
| Repository access | `https://github.com/abcentech/churchtimes` is cloned on the VPS. If it is private, setup.sh generates a deploy key and tells you where to add its public half (read-only). |
| DNS access | Access to the DNS panel that is authoritative for `churchtimesnigeria.net` (section 2). |

## 2. DNS: three A records to ADD (never change anything that exists)

`churchtimesnigeria.net` DNS is hosted at **OLITT** (nameservers `ns1.olitt.net` / `ns1.olitt.com`). **Truehost's DNS manager is NOT
authoritative for this domain**: records added there have no effect. Add the records in the **OLITT DNS panel** (or in the
**cPanel Zone Editor of the hosting account that runs the live site**, if that is how the zone is managed). **Never change the
nameservers**, and never edit, delete or "replace" an existing record (the live site, mail/MX, SPF, DKIM are in that zone).

1. **First take a screenshot or export of the whole zone** and keep it. That is your undo.
2. Look at the zone for a **CAA** record on `churchtimesnigeria.net`. If one exists and does not allow `letsencrypt.org`, tell the
   developers before continuing (certificate issuance would fail). Do not change it yourself.
3. ADD these three **A** records, all pointing to the **new staging VPS IP** (not 158.69.36.54), TTL 300 if the panel offers it:

| Type | Name (host) | Value |
| --- | --- | --- |
| A | `staging` | `<new VPS IPv4>` |
| A | `newsroom.staging` | `<new VPS IPv4>` |
| A | `cms.staging` | `<new VPS IPv4>` |

(Some panels want the full name, for example `staging.churchtimesnigeria.net`.) Do not add a wildcard and do not add AAAA records.
Check from any computer: `nslookup staging.churchtimesnigeria.net` should return the new IP. Caddy can only obtain its Let's Encrypt
certificates once all three resolve to this VPS and ports 80/443 are reachable.

## 3. Order of operations

1. Create the Turnstile widget (section 1). Keep the secret key to hand; **do not paste it anywhere except the hidden prompt**.
2. Make sure the GitHub Actions job has published the CMS image (private package `churchtimes-cms`, tag `staging`).
3. Take the DNS zone export, add the three A records (section 2), wait until `nslookup` shows the new IP.
4. Buy/create the new empty VPS. Log in as root over SSH.
5. Copy the one script across and run it. (Until this kit is merged into `feat/newsroom-mvp`, add `--ref agent/claude-truehost-staging`.)

   ```sh
   scp deploy/staging/setup.sh root@<new-vps-ip>:/root/
   ssh root@<new-vps-ip>
   bash /root/setup.sh                    # or: bash /root/setup.sh --ref <branch-tag-or-sha>
   ```

   It asks, in this order: Turnstile **site** key (visible), Turnstile **secret** (hidden), GitHub username, GitHub token (hidden).
   Hidden input is never echoed, never in shell history, never in logs. For unattended use see the header of `setup.sh`
   (`TURNSTILE_SECRET_FILE`, `GHCR_TOKEN_FILE`: files you create with `chmod 600` and delete afterwards).
6. setup.sh then: runs the safety checks (read-only) and stops if the server is not fresh; installs Docker from Docker's apt repo;
   enables ufw (22, 80, 443 only); creates the `deploy` user; clones the repo; generates all secrets; logs in to ghcr.io; builds
   the two static sites in a pinned `node:24` container (no Node on the host); pulls the images; runs the migrations; seeds
   synthetic staff users; starts the stack; waits for the health checks. It prints the path (not the content) of the file that
   holds the generated staff passwords: `/root/churchtimes-staging-credentials.json` (mode 600, root only).
7. Verify (section 5).

Re-running `setup.sh` is safe: existing secrets, volumes and the staff passwords are kept. `--rotate-turnstile` replaces the
stored Turnstile secret, `--relogin-ghcr` replaces the registry login.

## 4. What is generated, and where each variable comes from

Files in `deploy/staging/` on the server (all gitignored; templates `.env.example`, `.env.cms.example`):

| File | Mode | Content |
| --- | --- | --- |
| `.env` | 644 | Non-secret: `STAGING_DOMAIN`, `TURNSTILE_SITE_KEY`, `TURNSTILE_ACTION`, `CMS_IMAGE`, `REPO_REF`, `ACME_CA`, `SEED_CREDENTIALS_FILE`. |
| `.env.cms` | 600 | CMS environment (below). |
| `.env.postgres` | 600 | `POSTGRES_USER=churchtimes`, `POSTGRES_DB=churchtimes`, `POSTGRES_PASSWORD` (generated; the same password is in `DATABASE_URL`). |
| `build/public`, `build/newsroom` | | Compiled sites (`build-static.sh`). |
| `/root/churchtimes-staging-credentials.json` | 600 | Synthetic staff logins (outside the checkout). |
| `/var/backups/churchtimes-staging/` | 700 | `pg_dump` files taken before every update (newest 10 kept). |
| `/etc/churchtimes-staging` | 644 | Marker: this machine was prepared by setup.sh. `update.sh` and `teardown.sh` refuse to run without it. |

`.env.cms` (names checked against `apps/cms/src`; production validation is `validateProductionEnv` in `securityConfig.ts`):

| Variable | Value | Source |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://churchtimes:<pw>@postgres:5432/churchtimes` | generated password |
| `PAYLOAD_SECRET`, `PREVIEW_SECRET` | 64 hex each, different | `openssl rand -hex 32` |
| `IP_HASH_SALT` | 32 hex | `openssl rand -hex 16` |
| `TURNSTILE_SECRET_KEY` | the widget secret | hidden prompt |
| `TURNSTILE_ALLOWED_HOSTNAMES` | `<STAGING_DOMAIN>` | the public build's hostname |
| `TURNSTILE_EXPECTED_ACTION` | `submit-story` | equals `VITE_TURNSTILE_ACTION` of the public build |
| `CMS_PUBLIC_URL` | `https://cms.<STAGING_DOMAIN>` | derived |
| `CMS_CORS_ORIGINS` | `https://<STAGING_DOMAIN>,https://newsroom.<STAGING_DOMAIN>` | derived |
| `CMS_CSRF_ORIGINS` | `https://newsroom.<STAGING_DOMAIN>,https://cms.<STAGING_DOMAIN>` | derived |
| `PUBLIC_SUBMISSION_ORIGINS` | `https://<STAGING_DOMAIN>` | derived |
| `TRUST_PROXY`, `TRUST_PROXY_HOPS` | `true`, `1` | see "Proxy headers" |
| `SCHEDULER_ENABLED`, `PAYLOAD_DB_PUSH` | `true`, `false` | fixed |

Not set on purpose: `CMS_ALLOW_INSECURE_LOCAL_STAGING` (the CMS runs in production mode with real https origins and the real
Turnstile secret), `CLIENT_IP_HEADER`, SMTP (no mail in this staging).

Build-time (public) values compiled into the static sites by `build-static.sh`:

| Variable | Public site | Newsroom |
| --- | --- | --- |
| `VITE_PUBLIC_CMS_URL` | `https://cms.<STAGING_DOMAIN>` | n/a |
| `VITE_CMS_URL` | n/a | `https://cms.<STAGING_DOMAIN>` |
| `VITE_TURNSTILE_SITE_KEY`, `VITE_TURNSTILE_ACTION` | site key from `.env`, `submit-story` | n/a |
| `VITE_PUBLIC_SITE_URL` | empty (no canonical URL on staging) | `https://<STAGING_DOMAIN>` |
| `VITE_PUBLIC_SUBMISSIONS_URL`, `VITE_PUBLIC_CONTACT_URL` | empty (the form posts to the CMS) | n/a |

`build-static.sh` also refuses a mock newsroom build (`VITE_NEWSROOM_MOCK` set; the newsroom's vite config refuses `--mode mock`
too), a Cloudflare dummy test site key, and checks the finished bundles (CMS URL present, no ad script URL, no mock-mode strings).

**Ads/AdSense are off.** There is no build switch: the public site only shows direct campaigns listed in `src/data/advertising.json`
(currently none) and a reviewed AdSense unit (`adsense.enabled/reviewed` both `false`), and the code contains no AdSense script loader. The
build script asserts the file is still ads-off and refuses to build otherwise.

## 5. How to verify

From your own computer (replace the domain if you changed it). Expect each `x-robots-tag` line to read `noindex, nofollow`.

```sh
D=staging.churchtimesnigeria.net

# http redirects to https; https answers on all three hosts (certificates are issued on first contact: allow a minute)
curl -sI http://$D | head -n 3
for h in $D newsroom.$D cms.$D; do echo "== $h"; curl -sSI https://$h/ | grep -iE '^(HTTP|x-robots-tag|strict-transport-security|content-security-policy|x-frame-options)'; done

# CMS: anonymous session is 200 with "user":null; public collection read works
curl -sS https://cms.$D/api/users/me; echo
curl -sS -o /dev/null -w '%{http_code}\n' https://cms.$D/api/articles

# Public site: home page and a synthetic article page (rendered by the SSR host)
curl -sS -o /dev/null -w '%{http_code}\n' https://$D/
curl -sSI https://$D/reports/ | head -n 1        # 404 is fine: it checks the SSR host answers

# Newsroom: static app, hashed assets cached for a year, index revalidated
curl -sSI https://newsroom.$D/ | grep -iE '^(HTTP|cache-control)'

# CORS: the newsroom origin is allowed with credentials; a stranger is not
curl -sSI -H "Origin: https://newsroom.$D" https://cms.$D/api/categories | grep -i '^access-control'
curl -sSI -H "Origin: https://evil.example" https://cms.$D/api/categories | grep -ci '^access-control-allow-origin' || true   # 0
```

Staff login and cookie (the password is read from the root-only file on the VPS and piped to curl, so it is never printed;
run it **on the VPS**):

```sh
D=staging.churchtimesnigeria.net
python3 -c 'import json;u=json.load(open("/root/churchtimes-staging-credentials.json"))["users"]["admin"];print(json.dumps({"email":u["email"],"password":u["password"]}))' \
 | curl -sS -D - -o /dev/null -H 'Content-Type: application/json' -H "Origin: https://newsroom.$D" --data-binary @- https://cms.$D/api/users/login \
 | grep -i '^set-cookie' | sed -E 's/(payload-token=)[^;]+/\1<hidden>/'
```

Expected: `payload-token=<hidden>; Path=/; ... HttpOnly; Secure; SameSite=Lax` and **no `Domain=`** (host-only). Then open
`https://newsroom.<domain>/` in a browser, sign in with a synthetic user (emails `staging-admin@staging.invalid`, `staging-editor-in-chief@...`,
`staging-section-editor@...`, `staging-trusted-publisher@...`, `staging-reporter@...`; passwords only in the root-only file), and
submit a tip on `https://<domain>/` to exercise Turnstile (the widget must allow this hostname).

Rate limits see the real client address (the forged header must not change the bucket; after 10 failed logins you get `429`):

```sh
for i in $(seq 1 12); do curl -s -o /dev/null -w '%{http_code} ' -X POST https://cms.$D/api/users/login \
  -H 'Content-Type: application/json' -H "X-Forwarded-For: 10.0.0.$i" -d '{"email":"nobody@example.org","password":"not-a-password"}'; done; echo
```

On the VPS: `cd /srv/churchtimes/deploy/staging && docker compose ps` (all `healthy`), `docker compose logs --tail 80 cms`. The CMS log must
show no `[security] TURNSTILE_*` warning.

## 6. Operating it

```sh
cd /srv/churchtimes/deploy/staging
./update.sh                       # pull image tag "staging" + the recorded git ref, rebuild static sites, back up, migrate, restart
./update.sh <full-git-sha>        # pin the CMS to an exact build (also the way to roll the CMS back)
./update.sh staging --ref <ref>   # also move the repo checkout (static sites, Caddyfile, compose file) to another ref
```

`update.sh` order: checkout, pull the CMS image, **`pg_dump` into `/var/backups/churchtimes-staging`**, stop CMS + public host,
rebuild static sites (into a new directory, swapped in only if every check passes), migrate, start, wait for health. The image never
migrates on its own start. Uploaded media (volume `cms-media`) is not in the dump.

### Rollback

* **Code only (no schema change):** `./update.sh <previous-sha> --ref <previous-ref>`.
* **Bad migration:** the CMS is left stopped. Restore the pre-update dump (this replaces the database), then run the old release:
  ```sh
  cd /srv/churchtimes/deploy/staging
  docker compose stop cms public
  docker compose exec -T postgres pg_restore -U churchtimes -d churchtimes --clean --if-exists < /var/backups/churchtimes-staging/<file>.dump
  ./update.sh <previous-sha> --ref <previous-ref>     # it will migrate to that release's schema (a no-op if already there)
  ```
* **Full teardown:** `./teardown.sh` stops and removes containers and keeps all data. `./teardown.sh --wipe-volumes --confirm-wipe` also deletes
  the database and media volumes (a final dump is taken first); add `--include-certs` to delete the certificate volume (re-issuing counts against
  Let's Encrypt rate limits) and `--remove-secrets` to delete `.env.cms`, `.env.postgres` and the credentials file. Both scripts refuse to run
  on a machine without `/etc/churchtimes-staging`.
* The DNS records are the only thing outside the VPS: delete the three A records you added (the zone export from step 3 is your reference).

### Memory budget (2 GB RAM + 2 GB swap)

| Container | Limit | Why |
| --- | --- | --- |
| postgres | 320 MB | `shared_buffers=64MB`, `effective_cache_size=192MB`, `work_mem=4MB`, `max_connections=30`: a few editors and the public reads; about 150-250 MB resident. |
| cms | 900 MB | Next + Payload. `NODE_OPTIONS=--no-deprecation --max-old-space-size=640` keeps the V8 heap below the cgroup limit (heap + native + sharp image buffers). |
| public | 150 MB | A tiny node HTTP server, heap capped at 96 MB. |
| caddy | 100 MB | `GOMEMLIMIT=70MiB`. |
| migrate / seed | 800 MB each | One-shot. Run only while the CMS is stopped, so they never add to the steady-state total. |
| static build | 1.4 GB container, V8 heap 1 GB | Runs while the CMS and public host are stopped (update.sh) or before anything starts (setup.sh). |

Caps total 1.47 GB; real use is well below the caps, and the OS plus Docker need roughly 300-450 MB. That is tight, which is why
the swapfile, the stop-then-build order and the per-container caps exist: an overrun is killed inside its own container instead of taking the
server down. If the CMS is ever OOM-killed (`docker inspect` shows `OOMKilled=true`), resize the VPS to 4 GB rather than raising limits.

## 7. Behind the scenes: proxy headers and the cookie

**Proxy headers.** The CMS (`src/lib/rateLimit.ts`) trusts forwarding headers only when `TRUST_PROXY=true` and reads `X-Forwarded-For`
from the right, `TRUST_PROXY_HOPS` entries in (default 1). Caddy is the only hop. In the Caddyfile the CMS block **overwrites** `X-Forwarded-For` and
`X-Real-IP` with the TCP peer address Caddy saw and sets `X-Forwarded-Proto`, so a client cannot choose its rate-limit bucket. `CLIENT_IP_HEADER` is unset.
Caddy runs in a container but binds the host's ports, and IPv4 source addresses are preserved, so the peer is the real visitor. (Only add AAAA records after
testing: Docker's IPv6 userland proxy can hide the source address, which would put every IPv6 visitor in one bucket.) If Cloudflare is ever put in
front, change `TRUST_PROXY_HOPS`/`CLIENT_IP_HEADER` as described in `apps/cms/docs/operations.md` section 4.4.

**Cookie.** The CMS sets `payload-token` as `HttpOnly; Secure; SameSite=Lax`, host-only (no `Domain`). The newsroom runs on a different origin
(`newsroom.<domain>`) and calls `cms.<domain>` with `credentials: 'include'`. Because both hosts share the registrable domain, that is a *same-site*
request and the Lax cookie is sent. CORS answers with the exact newsroom origin and `Access-Control-Allow-Credentials: true`; CSRF accepts cookie
requests only from the newsroom and CMS origins. Do not move the hostnames to different registrable domains.

**Public site to CMS.** The public SSR container reaches `https://cms.<domain>` through a network alias on the Caddy container (it refuses plain http
to a remote host), so it does not depend on routing back through the VPS's public IP.

**noindex.** All three hosts send `X-Robots-Tag: noindex, nofollow` on every response, including Caddy-generated 404/502 pages. The public host is also
started with `PUBLIC_INDEXABLE=false`, and the newsroom's HTML carries `noindex`.

## 8. Optional: build the CMS image on a bigger machine

Not the default. On a machine with about 4 GB RAM: set `CMS_IMAGE=churchtimes-cms:local` in `.env` and use `docker-compose.build.yml` (instructions at the top of
that file). On the 2 GB staging VPS use the GHCR image.

## 9. Known caveats and notes

* **The seed.** The repo's staging seed (`src/seed/staging.ts`) refuses to run unless every origin and the database host are loopback-only. The `seed`
  service satisfies that **for its own one-shot container only**: it shares PostgreSQL's network namespace (so `127.0.0.1:5432` really is the staging
  database) and overrides the origins, the staging flag and the Turnstile secret in its own environment. `.env.cms` and the running CMS are not changed
  and never carry `CMS_ALLOW_INSECURE_LOCAL_STAGING`. It creates five synthetic staff users (one per role), the nine categories and synthetic
  `staging-` articles, live events and one tip. Nothing is published that is not obviously synthetic, and everything is `noindex`.
* **ufw and Docker.** Docker-published ports bypass ufw. Only Caddy publishes ports (80, 443); PostgreSQL, the CMS and the public host are not published.
* The `deploy` user owns the repository checkout only. It has no sudo and is not in the `docker` group; run `update.sh`/`teardown.sh` as root.
* GHCR credentials live in `/root/.docker/config.json` (Docker stores them there, base64, not encrypted). Keep the file root-only, use a `read:packages`-only
  token, and revoke it in GitHub when staging is retired. Replace it with `bash setup.sh --relogin-ghcr`.
* No mail: password reset e-mails do not work (no SMTP). Use the synthetic logins; `npm run admin:set-password` in the CMS container is the break-glass path.

## 10. Explicitly out of scope

Production deployment; the live WordPress site or its server (158.69.36.54); any change to existing DNS records or nameservers; certificates for any
other hostname; AdSense or any ad serving; e-mail/SMTP; monitoring and off-server backups; real content migration.

## Files

| File | Purpose |
| --- | --- |
| `setup.sh` | First-time setup of a new empty VPS (guards, swap, Docker, ufw, user, clone, secrets, GHCR login, static build, migrate, seed, start). |
| `update.sh`, `teardown.sh` | Update (with pre-migration dump) and stop/wipe. Refuse without `/etc/churchtimes-staging`. |
| `build-static.sh` | Builds the public site and the newsroom for the staging hostnames. |
| `common.sh` | Helpers shared by the scripts. |
| `docker-compose.yml`, `docker-compose.build.yml` | The stack; optional local-build override. |
| `Caddyfile` | The three sites, TLS, headers, proxy. |
| `.env.example`, `.env.cms.example`, `.gitignore` | Templates and the ignore rules that keep secrets, backups and generated files out of git. |
