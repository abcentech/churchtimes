# Church Times CMS — operations

Status: **Production deployment has NOT been performed.** Deploying to a real server requires explicit
approval from the project owner after the hosting, backup and restore steps below have been verified.

This document covers hosting requirements, deployment, configuration, backups, rollback and security.
Items marked *(planned)* are documented in `.env.example` or the sprint plan but are not yet implemented in code.

## 1. Hosting requirements

Minimum for a small VPS:

| Resource | Minimum | Notes |
| --- | --- | --- |
| CPU | 2 vCPU | |
| RAM | 4 GB | `next build` can need more than this. Build on a CI runner or a larger machine, or add swap. |
| Disk | 40 GB SSD | Media uploads grow over time. Monitor usage. |
| OS | Ubuntu 24.04 LTS | |
| PostgreSQL | 16 | Installed on the same VPS. |
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

## 4. Environment variables

Copy from `apps/cms/.env.example`. Keep the real file at `apps/cms/.env` on the server, owned by the deploy user,
with permissions `600`. Never commit it.

"Read by code today" means the variable is referenced in `apps/cms/src` or `next.config.mjs` at the time of
writing. Other variables are reserved for features that are not implemented yet.

| Variable | Required | Example (non-secret) | Purpose | Read by code today |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | yes | `postgres://churchtimes:<password>@127.0.0.1:5432/churchtimes` | PostgreSQL connection string. Keep it on localhost. | yes |
| `PAYLOAD_SECRET` | yes | 64 hex chars | Payload signing secret, at least 32 characters. The app refuses to start without it outside tests. | yes |
| `CMS_PUBLIC_URL` | yes | `https://cms.example.org` | Public base URL, no trailing slash. Used for links and the server URL. | yes |
| `CMS_CORS_ORIGINS` | yes | `https://www.example.org` | Comma-separated origins allowed to call the API from a browser. | yes |
| `CMS_CSRF_ORIGINS` | yes | `https://cms.example.org` | Comma-separated origins allowed to send cookie-authenticated mutations. | yes |
| `PUBLIC_SUBMISSION_ORIGINS` | yes | `https://www.example.org` | Origins allowed to POST `/api/public/submissions`. | *(planned)* |
| `SUBMISSION_RATE_LIMIT` | no | `5` | Maximum submissions per IP per window. | *(planned)* |
| `SUBMISSION_RATE_WINDOW_SECONDS` | no | `900` | Length of the submission rate-limit window, in seconds. | *(planned)* |
| `PREVIEW_SECRET` | yes | 64 hex chars | HMAC secret for article preview tokens, at least 32 characters. Must differ from `PAYLOAD_SECRET`. | *(planned)* |
| `IP_HASH_SALT` | yes | 32 hex chars | Salt for hashing client IPs on submissions, at least 16 characters. | *(planned)* |
| `SCHEDULER_ENABLED` | no | `true` on exactly one instance | Enables the in-process scheduled-publishing loop. | *(planned)* |
| `SCHEDULER_INTERVAL_SECONDS` | no | `60` | Scheduler polling interval, in seconds. | *(planned)* |
| `PAYLOAD_DB_PUSH` | no | `false` | Development only. Schema push instead of migrations. Keep `false` in production. | yes |
| `TRUST_PROXY` | no | `true` | Trust `X-Forwarded-*` headers. Set to `true` **only** when the app is reachable only through your own reverse proxy. | *(planned)* |
| `NODE_ENV` | set by the platform | `production` | Use `production` on the server. | yes |
| `LOCAL_PG_PORT` | no | `54329` | Local development only (`npm run db:local`). Not used on the server. | dev script only |

Changing `PAYLOAD_SECRET` signs every user out. Changing `PREVIEW_SECRET` invalidates all outstanding preview links.
Plan rotations for a quiet period.

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

- **Rate limiting** (submissions): planned as an in-memory limiter per process. It is correct only for a single
  app instance. Multiple instances need a shared store, such as PostgreSQL, before scaling out.
  The limiter is not implemented yet.
- **Scheduler**: `SCHEDULER_ENABLED=true` on **exactly one** instance. Two instances will try to publish the same
  scheduled articles. The scheduler is not implemented yet.
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
- [ ] `TRUST_PROXY=true` is set only when the app is reachable exclusively through the reverse proxy.

## 11. Functional checks before go-live

- [ ] Upload validation rejects SVG and HTML (per the API contract). Verify with a test upload.
- [ ] A public submission from a disallowed origin gets `403`. Verify with `curl -H "Origin: https://evil.example"`.
- [ ] A reporter account cannot approve or publish an article. Verify in the admin UI and API.

## 12. Status

- Production deployment: **not performed**. Requires explicit approval.
- Restore test: **not yet performed**.
- Scheduler, submission rate limiting, seed fixtures: **not yet implemented** (see §4 and §8).
