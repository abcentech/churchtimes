# Owner security hardening guide

Status: a checklist for the owner and whoever builds the new server. Nothing here has been applied. Written after the
October 2026 compromise of the old WordPress server: an attacker gained administrator-level control of that machine and
its database stopped working. The old server's address and domain are deliberately not recorded here.

Refreshed 2026-10-23 against the merged production definition on `feat/newsroom-mvp` (Docker Compose with host Caddy, a
migrator image, health endpoints and backup scripts). Related: [owner-migration-runbook.md](owner-migration-runbook.md),
[operations.md](operations.md) and [security.md](security.md).

## The principle

The old server is treated as hostile. We do not repair it and we do not reuse anything from it that can run code or
carries a secret. We build a new host from a clean image, move only data (the WordPress export and image files, after
scanning), and change every secret.

Where each command runs is labelled: **[SERVER]** is the new host over SSH, **[OWNER PC]** is your Windows PowerShell.
Replace `<angle-bracket>` values. Never write real passwords, keys, tokens, IPs or hostnames into documents, GitHub,
issues, pull requests or chat. Secrets are typed only into the server's environment file or your password manager.

How the new CMS is deployed (so the checks below make sense): one clean Ubuntu server, Docker with the compose plugin and
Caddy on the host (Caddy handles https). The database runs in a `postgres` container that publishes no port to the
internet; the CMS runs in a `cms` container as an unprivileged user (uid 1000) with a read-only filesystem; a one-off
`migrate` container (never started automatically) runs migrations, `admin:create` and the import tools. Full procedure:
`operations.md`, section 3.2.

## 1. Clean-rebuild checklist for the new host

| # | Step | Done | How to verify |
| --- | --- | --- | --- |
| 1 | Create a NEW server from the provider's official, current Ubuntu LTS image. Do not clone, snapshot-restore or "migrate" the old one | [ ] | The provider console shows a new server with a fresh creation date |
| 2 | Use a different provider account or reset that account's password and enable two-factor sign-in first | [ ] | Sign-in asks for a second factor |
| 3 | Do not copy any program, theme, plugin, script, cron job or config file from the old server | [ ] | Only data files (export, scanned images) were transferred |
| 4 | Apply sections 2 to 6 below before installing the CMS | [ ] | Each "verify" line passes |
| 5 | Install the CMS from the repository at a reviewed commit, using the digest-pinned images listed in the CI "publish" job summary (nothing is built on the server) | [ ] | `git log -1` in `/srv/churchtimes/app` matches the commit you approved; the image digests match the summary |
| 6 | Use new secrets everywhere (section 7) | [ ] | Nothing in the new environment file equals an old value |
| 7 | Scan imported images and remove non-image files (migration runbook, step 2.3) | [ ] | Scan report is clean |
| 8 | Switch the old server off at the provider (do not delete yet), keep one offline copy of its data for evidence | [ ] | The old server is stopped in the console |

## 2. SSH keys only, no password login

**[OWNER PC]** create a key (use a passphrase) and keep the private key private:

```
ssh-keygen -t ed25519 -C "churchtimes-admin"
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

The second line prints the PUBLIC key; that is the one you give the server. Never share the file without `.pub`.

**[SERVER]** as the admin user you create (not root), add the public key, then lock down SSH:

```
sudo adduser <admin-user>
sudo usermod -aG sudo <admin-user>
sudo mkdir -p /home/<admin-user>/.ssh
echo "<paste-public-key-here>" | sudo tee /home/<admin-user>/.ssh/authorized_keys
sudo chown -R <admin-user>:<admin-user> /home/<admin-user>/.ssh
sudo chmod 700 /home/<admin-user>/.ssh
sudo chmod 600 /home/<admin-user>/.ssh/authorized_keys
```

Before turning anything off, open a SECOND terminal and confirm you can log in as `<admin-user>` with the key. Then:

```
sudo tee /etc/ssh/sshd_config.d/99-hardening.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
CONF
sudo sshd -t && sudo systemctl reload ssh
```

How to verify: **[OWNER PC]**

```
ssh -o PubkeyAuthentication=no <admin-user>@<server-address>
ssh root@<server-address>
```

Both must be refused ("Permission denied (publickey)"). A normal `ssh <admin-user>@<server-address>` must still work.
Keep the second terminal open until you have proved this.

## 3. Firewall

Allow only: SSH, web (80 and 443). The database and the CMS port are never open to the internet.

**[SERVER]**

```
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

How to verify: the status list shows only those rules. From **[OWNER PC]** check nothing else answers:

```
Test-NetConnection <server-address> -Port 5432
Test-NetConnection <server-address> -Port 3000
```

Both must report `TcpTestSucceeded : False`. Also use the provider's own cloud firewall as a second layer, with the same
three rules. Optionally limit SSH to your own address if it is stable.

Install a brute-force blocker: `sudo apt install fail2ban`, then `sudo systemctl enable --now fail2ban`.
Verify: `sudo fail2ban-client status sshd` shows the jail running.

## 4. Automatic security updates

**[SERVER]**

```
sudo apt update && sudo apt upgrade -y
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

How to verify: `systemctl status unattended-upgrades` shows active, and
`sudo unattended-upgrade --dry-run --debug 2>&1 | tail -5` ends without errors. Check `/var/log/unattended-upgrades/`
monthly. A reboot is needed after kernel updates: pick a quiet time and note it in the calendar: [Day/Time].

## 5. No control panel exposed to the internet

The old setup used a hosting control panel. On the new host:

- Do not install cPanel, Plesk, Webmin, phpMyAdmin, Adminer or any web-based file manager or database tool.
- Administer through SSH only. For the database, use a command-line client over SSH or an SSH tunnel.
- The CMS admin (the `/admin` page) is public by design, so it is protected by strong unique passwords, two-factor sign-in
  if the CMS offers it, rate limiting and the audit log. Consider restricting `/admin` to known addresses at the web
  server if staff addresses are stable.
- PostgreSQL is only inside Docker's private network: the production compose file publishes no database port, and CI
  checks that. If you ever see port 5432 open on the server, stop and ask your technical helper.
- The "first user" sign-up (`POST /api/users/first-register`) would give an administrator account to whoever calls it first
  on an empty database. In production the CMS refuses it unless `ALLOW_FIRST_REGISTER=true`, and the Caddyfile in
  `operations.md` also answers 404 for it. Leave `ALLOW_FIRST_REGISTER` unset. Create the first administrator on the
  server with `admin:create` (`operations.md`, "First administrator") BEFORE the site is exposed, then sign in and change
  that password at once. If you ever set `ALLOW_FIRST_REGISTER=true` for recovery, remove it again straight afterwards.

How to verify: **[SERVER]**

```
sudo ss -tlnp
```

Only SSH (22) and the web server (80 and 443) should listen on `0.0.0.0` or `[::]`. The CMS container's port must show
`127.0.0.1` only (Caddy forwards to it), and there is no PostgreSQL entry at all. Anything else needs an explanation or
must be stopped. Then, from outside, check the two health addresses (they reveal no secrets, versions or error text):

**[OWNER PC]**

```
curl.exe -s https://<cms-address>/api/health/live
curl.exe -s https://<cms-address>/api/health/ready
```

`live` returns `{"status":"ok"}`. `ready` returns `"status":"ready"` with `database`, `migrations` and `media` all `true`;
a `503` with a `false` flag tells your technical helper which part failed.

## 6. Least-privilege accounts

| Account | May do | May not do |
| --- | --- | --- |
| Admin user (SSH, sudo) | Maintain the server | Run the CMS process; be shared between people |
| The CMS container (user 1000, read-only filesystem) | Run the CMS and write only to its media folder `/srv/churchtimes/media` (owned by uid 1000) | Run as root; write anywhere else |
| Database role `churchtimes` | Read and write the CMS database only | Be a superuser; be reachable from the internet |
| Backups | Run as root on the server with an encryption PUBLIC key only | Hold the private decryption key (kept by two people, off the server) |
| Anyone in the `docker` group | Treated as root: only people you would also give sudo | Be used as a way to share the environment file |
| CMS staff accounts | Only the role needed (writer, editor, admin); one person, one account | Share logins; admin for everyone |
| Provider and DNS accounts | Owner plus one named deputy, two-factor on | Shared passwords; email without two-factor |

How to verify: **[SERVER]**

```
sudo docker compose -f /srv/churchtimes/app/apps/cms/docker-compose.production.yml ps
ls -ld /srv/churchtimes/media /etc/churchtimes/cms.env /etc/churchtimes/secrets/postgres_password
getent group docker
```

The services show as running (the `cms` entry healthy), the media folder is owned by `1000:1000`, the environment file and
database password file are `root:root` mode `600`, and the `docker` group lists only people you trust. In the CMS admin,
list users and remove or downgrade anyone who does not need access; remove every account left from the old WordPress.

## 7. Secrets rotation list

Assume every secret that ever lived on, or was typed into, the old server is stolen. Generate new values on your own PC,
store them in a password manager, and put them only in the server's environment file (permissions `600`, owned by
`<cms-user>`, never in GitHub). Rotate, then revoke the old value at its source.

| Secret | Where it lives | Rotate by | Verify |
| --- | --- | --- | --- |
| CMS secrets: `PAYLOAD_SECRET`, `PREVIEW_SECRET`, `IP_HASH_SALT` (three different values) | `/etc/churchtimes/cms.env` | Generate each on your own PC (`openssl rand -hex 32`); all staff must sign in again | Old session no longer works; staff can sign in. The CMS refuses to start in production with missing, dummy or duplicated secrets, and prints the problems in its log |
| Staff and admin passwords | CMS | Force reset for every account | Old passwords refused |
| Database password | `/etc/churchtimes/secrets/postgres_password` and `DATABASE_URL` in `cms.env` | Use a hex password (`openssl rand -hex 24`). The password file is only read when the database is first created, so a later change needs `ALTER ROLE` as described in `operations.md` (section 3.2, "Env file rules"), then the same value in `DATABASE_URL`, then restart the `cms` container | CMS connects; old password refused |
| SMTP username and password (outgoing email) | Server environment file, mail provider | Create a new credential at the mail provider, delete the old one | A test message arrives; old credential gone from the provider |
| Turnstile site key and secret (`TURNSTILE_SECRET_KEY` on the CMS; the site key is public) | Cloudflare, `cms.env`, public site build | Create a NEW Turnstile widget (new pair); delete the old widget | Forms still verify; old secret rejected |
| `NEWSLETTER_TOKEN_SECRET` (signs confirm and unsubscribe links; at least 32 characters, different from the other secrets) | `cms.env` | New random value. Old confirm links stop working, so ask for re-confirmation of any pending sign-ups | New confirm link works |
| Mailchimp API key (if used) | Provider account | Create new key, delete old | Test sync works |
| Retired WordPress | Old server and its admin | Change every WordPress admin, database, FTP, hosting panel and salts password, then switch it off. Delete leftover admin users. Keep only an offline copy of the data | You can no longer log in to the old admin; the old server is stopped |
| Hosting, registrar, DNS, Cloudflare, GitHub | Provider accounts | New password plus two-factor on; review and revoke old tokens, API keys and sessions | Provider security page shows no old sessions or tokens |
| SSH keys | Server, your PC | Remove every old public key; use the new key only | `cat ~/.ssh/authorized_keys` lists only keys you recognise |
| Social and analytics accounts (GA4, Search Console, OneSignal) | Provider accounts | Review users and tokens; remove unknown access | Only known people listed |
| Reused passwords | Anywhere else | Change any password that was also used on the old site | Password manager shows no duplicates |

Also search GitHub for accidentally committed secrets before go-live; anything found must be treated as leaked and rotated.
Values containing a dollar sign must be single-quoted in `cms.env` (Compose reads that file, not a shell); `operations.md`
section 3.2 lists the rules. Two more rules: the public site host's `PUBLIC_CMS_URL` must be exactly the CMS `CMS_PUBLIC_URL`
(a different address makes the public site silently drop images), and `CMS_CORS_ORIGINS` and `CMS_CSRF_ORIGINS` must list
only your real https addresses, never `*` or `http`.

## 8. Backups: 3-2-1

Three copies of the data, on two kinds of storage, one of them off-site and not reachable from the server's own
credentials. The CMS comes with tested scripts, so use them rather than writing your own (`operations.md`, section 6).

| Copy | What | Where | Frequency |
| --- | --- | --- | --- |
| 1 (live) | CMS database and media | The server | Always |
| 2 (local backup) | `backup.sh` output: encrypted database dump, media archive, checksums, row counts | `/var/backups/churchtimes/daily` on the server, plus a second disk or provider snapshot | Nightly (systemd timer at 02:15 UTC); also before every import or upgrade (`predeploy`) |
| 3 (off-site) | The same finished, already encrypted backup folders | A different provider, pulled by a backup host or pushed with a write-only credential | Nightly; keep 14 daily, 8 weekly, 12 monthly |

Rules: `backup.sh` encrypts with a PUBLIC key (`--encrypt age`), so the private decryption key is never on the server; keep
it in the password managers of two people. The off-site credential can add files but not delete them, so an attacker on the
server cannot wipe the history. Never copy `.partial-*` or `.tmp-*` folders. The environment file (secrets) is backed up
separately to the password manager, never inside a backup folder. After any compromise, do not restore the old
environment file: rotate every secret first (`operations.md`, "After a real restore").

How to verify: every month, **[OWNER PC]** open the off-site storage and confirm last night's folder exists with a
sensible size. Every month (and after any change to the backup tooling) do the restore drill from the OFF-SITE copy:
`verify-backup.sh` must print `VERIFIED` and `restore.sh` must show `ok` on every count row (migration runbook, section 8.4,
and `operations.md`, "Restore drill checklist"). Record the date: [Date].

## 9. Uptime and alert monitoring

- Sign up for an external uptime monitor (a free tier is enough). Check, every 1 to 5 minutes from outside the server:
  the CMS `https://<cms-address>/api/health/live` (keyword `ok`) and `/api/health/ready` (keyword `ready`), the public
  home page (a stable word from it), one article and the admin login page. The health addresses never show secrets or
  error text, so they are safe to give to a monitoring service.
- Alerts go to two people by email and one by phone message: your technical helper, your technical helper, your technical helper.
- Also watch disk space (alert at 80 percent), failed backups (`systemctl --failed` shows a failed backup unit, and a
  missing new backup folder for more than 26 hours is an alert), and certificate expiry (alert 14 days ahead).
- Optionally send the server's authentication log summary by email daily (`logwatch`).

How to verify: pause the web server for a minute on a quiet night (**[SERVER]** `sudo systemctl stop <web-service>`, then
start it again) and confirm the alert reaches everyone. Write down the time the alert took: [Minutes].

## 10. After the build: a final check

**[SERVER]**

```
sudo ufw status
sudo ss -tlnp
grep -E "PasswordAuthentication|PermitRootLogin" /etc/ssh/sshd_config.d/*.conf
systemctl is-active unattended-upgrades fail2ban
systemctl list-timers churchtimes-backup.timer
sudo grep -c "ALLOW_FIRST_REGISTER" /etc/churchtimes/cms.env
```

What to check afterwards: firewall active with three rules; only expected ports listening; password login and root login
set to `no`; both services `active`; the backup timer is listed with a next run time; the last line prints `0` (the
first-register switch is not set; the count prints a number only, never a value). Print this page, tick the boxes, and file it with the date: [Date].

## 11. If personal data may have been exposed: breach notification (Nigeria, NDPA)

This is a plain-language note, not legal advice. The Nigeria Data Protection Act 2023 expects a data controller to notify
the regulator (the Nigeria Data Protection Commission) of a breach that is likely to risk people's rights and freedoms
within **72 hours** of becoming aware of it, and to tell affected people without delay where the risk is high. Take legal
advice from a lawyer who knows Nigerian data protection law, today, because the clock may already be running. Confirm the
current rules and the notification channel with them.

What the old server may have held: comment names and emails (about 935 commenters), any stored form messages, staff and
admin accounts, and site settings. Subscriber lists were not stored in the database according to the audit.

Decisions for the owner (write them down, with the time):

| Decision | Answer | By whom | When |
| --- | --- | --- | --- |
| Time we became aware of the compromise | [Date/Time] | Owner | [Date/Time] |
| Is personal data likely to have been accessed or taken? | [Yes/No/Unknown] | Owner with [Lawyer] | [Date/Time] |
| Notify the regulator? | [Decision] | Owner with [Lawyer] | [Date/Time] |
| Notify affected people (for example commenters)? | [Decision] | Owner with [Lawyer] | [Date/Time] |
| Who writes and sends the notices | your technical helper | Owner | [Date/Time] |
| Where evidence is kept (offline copy of the old server, logs) | [Location] | your technical helper | [Date/Time] |
| Our contact point for questions | [Name, channel] | Owner | [Date/Time] |

A notice normally says: what happened, when, what kinds of data were involved, the likely consequences, what we have done
about it, and who to contact. Do not put real names or emails into this repository; keep the notice drafts and the log of
decisions in private storage. Whatever you decide, keep a written record of the decision and the reasons, including a
decision not to notify.
