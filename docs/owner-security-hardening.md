# Owner security hardening guide

Status: a checklist for the owner and whoever builds the new server. Nothing here has been applied. Written after the
October 2026 compromise of the old WordPress server: an attacker gained administrator-level control of that machine and
its database stopped working. The old server's address and domain are deliberately not recorded here.

Related: [owner-migration-runbook.md](owner-migration-runbook.md) and `apps/cms/docs/operations.md`.

## The principle

The old server is treated as hostile. We do not repair it and we do not reuse anything from it that can run code or
carries a secret. We build a new host from a clean image, move only data (the WordPress export and image files, after
scanning), and change every secret.

Where each command runs is labelled: **[SERVER]** is the new host over SSH, **[OWNER PC]** is your Windows PowerShell.
Replace `<angle-bracket>` values. Never write real passwords, keys, IPs or hostnames into documents or GitHub.

## 1. Clean-rebuild checklist for the new host

| # | Step | Done | How to verify |
| --- | --- | --- | --- |
| 1 | Create a NEW server from the provider's official, current Ubuntu LTS image. Do not clone, snapshot-restore or "migrate" the old one | [ ] | The provider console shows a new server with a fresh creation date |
| 2 | Use a different provider account or reset that account's password and enable two-factor sign-in first | [ ] | Sign-in asks for a second factor |
| 3 | Do not copy any program, theme, plugin, script, cron job or config file from the old server | [ ] | Only data files (export, scanned images) were transferred |
| 4 | Apply sections 2 to 6 below before installing the CMS | [ ] | Each "verify" line passes |
| 5 | Install the CMS from the repository at a reviewed commit, on a clean machine | [ ] | `git log -1` on the server matches the commit you approved |
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
- PostgreSQL listens on the local machine only.

How to verify: **[SERVER]**

```
sudo ss -tlnp
```

Only SSH (22), the web server (80 and 443) should listen on `0.0.0.0` or `[::]`. PostgreSQL and the CMS process must show
`127.0.0.1` (or a Unix socket). Anything else needs an explanation or must be stopped.

## 6. Least-privilege accounts

| Account | May do | May not do |
| --- | --- | --- |
| Admin user (SSH, sudo) | Maintain the server | Run the CMS process; be shared between people |
| Service user `<cms-user>` (no login, no sudo) | Run the CMS and write only to its media folder | Log in; read other users' files |
| Database user for the CMS | Read and write the CMS database only | Create other databases or users; superuser |
| Database backup user | Read-only on the CMS database | Write |
| CMS staff accounts | Only the role needed (writer, editor, admin); one person, one account | Share logins; admin for everyone |
| Provider and DNS accounts | Owner plus one named deputy, two-factor on | Shared passwords; email without two-factor |

How to verify: **[SERVER]**

```
ps -o user,cmd -C node
sudo -l -U <cms-user>
getent passwd <cms-user>
```

The process runs as `<cms-user>`, that user has no sudo rights, and its shell is `/usr/sbin/nologin`. In the CMS admin,
list users and remove or downgrade anyone who does not need access; remove every account left from the old WordPress.

## 7. Secrets rotation list

Assume every secret that ever lived on, or was typed into, the old server is stolen. Generate new values on your own PC,
store them in a password manager, and put them only in the server's environment file (permissions `600`, owned by
`<cms-user>`, never in GitHub). Rotate, then revoke the old value at its source.

| Secret | Where it lives | Rotate by | Verify |
| --- | --- | --- | --- |
| CMS secrets (the Payload secret and any session or signing secret) | Server environment file | Generate a long random value (`openssl rand -hex 32`); all staff must sign in again | Old session no longer works; staff can sign in |
| Staff and admin passwords | CMS | Force reset for every account | Old passwords refused |
| Database password | Server environment file, PostgreSQL | `ALTER ROLE` with a new password, update the environment file, restart | CMS connects; old password refused |
| SMTP username and password (outgoing email) | Server environment file, mail provider | Create a new credential at the mail provider, delete the old one | A test message arrives; old credential gone from the provider |
| Turnstile site key and secret | Cloudflare, server environment file, public site build | Create a NEW Turnstile widget (new pair); delete the old widget | Forms still verify; old secret rejected |
| Newsletter token secret (signs confirm and unsubscribe links) | Server environment file | New random value. Old confirm links stop working, so ask for re-confirmation of any pending sign-ups | New confirm link works |
| Mailchimp API key (if used) | Provider account | Create new key, delete old | Test sync works |
| Retired WordPress | Old server and its admin | Change every WordPress admin, database, FTP, hosting panel and salts password, then switch it off. Delete leftover admin users. Keep only an offline copy of the data | You can no longer log in to the old admin; the old server is stopped |
| Hosting, registrar, DNS, Cloudflare, GitHub | Provider accounts | New password plus two-factor on; review and revoke old tokens, API keys and sessions | Provider security page shows no old sessions or tokens |
| SSH keys | Server, your PC | Remove every old public key; use the new key only | `cat ~/.ssh/authorized_keys` lists only keys you recognise |
| Social and analytics accounts (GA4, Search Console, OneSignal) | Provider accounts | Review users and tokens; remove unknown access | Only known people listed |
| Reused passwords | Anywhere else | Change any password that was also used on the old site | Password manager shows no duplicates |

Also search GitHub for accidentally committed secrets before go-live; anything found must be treated as leaked and rotated.

## 8. Backups: 3-2-1

Three copies of the data, on two kinds of storage, one of them off-site and not reachable from the server's own
credentials.

| Copy | What | Where | Frequency |
| --- | --- | --- | --- |
| 1 (live) | CMS database and media | The server | Always |
| 2 (local backup) | Encrypted database dump and media archive | A second disk or the provider's snapshot service | Nightly |
| 3 (off-site) | Same encrypted files | A different provider or your own storage, pushed with a write-only credential | Nightly; keep 7 daily, 4 weekly, 6 monthly |

Rules: the backup is encrypted before it leaves the server (passphrase kept in the password manager, not on the server);
the off-site credential can add files but not delete them, so an attacker on the server cannot wipe the history; the
environment file (secrets) is backed up separately to the password manager.

How to verify: every month, **[OWNER PC]** open the off-site storage and confirm last night's files exist with a sensible
size. Every quarter do the full restore test in the migration runbook, section 8.4, and record the date: [Date].

## 9. Uptime and alert monitoring

- Sign up for an external uptime monitor (a free tier is enough). Check the home page, one article and the admin login
  page every 1 to 5 minutes from outside the server.
- Alerts go to two people by email and one by phone message: [Name], [Name], [Name].
- Also watch disk space (alert at 80 percent), failed backups, and certificate expiry (alert 14 days ahead).
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
```

What to check afterwards: firewall active with three rules; only expected ports listening; password login and root login
set to `no`; both services `active`. Print this page, tick the boxes, and file it with the date: [Date].

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
| Who writes and sends the notices | [Name] | Owner | [Date/Time] |
| Where evidence is kept (offline copy of the old server, logs) | [Location] | [Name] | [Date/Time] |
| Our contact point for questions | [Name, channel] | Owner | [Date/Time] |

A notice normally says: what happened, when, what kinds of data were involved, the likely consequences, what we have done
about it, and who to contact. Do not put real names or emails into this repository; keep the notice drafts and the log of
decisions in private storage. Whatever you decide, keep a written record of the decision and the reasons, including a
decision not to notify.
