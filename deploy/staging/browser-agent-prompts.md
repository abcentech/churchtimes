# Staging setup: prompts for a browser agent

These prompts are for Claude in Chrome or ChatGPT agent mode. They cover the three dashboard tasks for the Church Times staging environment. The server itself is set up afterwards with `deploy/staging/setup.sh`; see `README.md`.

**Who does what**
- The browser agent clicks through the dashboards.
- **You** sign in, approve every payment, and copy the Turnstile **secret key** yourself. The secret is pasted only into the hidden prompt of `setup.sh` on the server, never into a chat, a document or GitHub.
- Run the prompts in order. Stop if anything on screen does not match what a prompt expects.

**Staging addresses** (all new; nothing existing changes):

| Purpose | Hostname |
|---|---|
| Public site | `staging.churchtimesnigeria.net` |
| Newsroom (staff app) | `newsroom.staging.churchtimesnigeria.net` |
| CMS (backend) | `cms.staging.churchtimesnigeria.net` |

---

## Prompt 1: a SEPARATE staging VPS (Truehost)

**Never use the live website's server for staging.** The existing Truehost VPS (158.69.36.54: 1 vCPU, 2 GB, Ubuntu 22.04, WordPress on LiteSpeed) **is** the live site. Staging needs ports 80 and 443, its own firewall rules, swap and about 1–1.2 GB of memory, so running it there would put the live site at risk. Never reinstall, reconfigure or run `setup.sh` on that server. `setup.sh` refuses to run on a machine that already has a web server or anything listening on ports 80 or 443.

A second, small VPS is enough, because the CMS image is built on GitHub (`.github/workflows/cms-image.yml`). The staging VPS only downloads and runs it, with a 2 GB swap file as a safety margin.

> I'm signed in to my Truehost client area. I need a **new, separate** unmanaged Linux VPS for staging. Do not touch my existing VPS at 158.69.36.54: it runs the live website.
> - Show me the cheapest unmanaged VPS with **at least 1 vCPU, 2 GB RAM and 25 GB disk** (2 vCPU / 4 GB if the price difference is small).
> - Operating system: **Ubuntu 24.04 LTS** (or 22.04). No cPanel, LiteSpeed, WordPress or other add-ons.
>
> Show me the plan name, price and billing period, and **wait for my confirmation before paying**.
>
> After the order completes, open the **new** VPS and tell me its public **IPv4 address**. It must **not** be 158.69.36.54. Also tell me where its root password or SSH access is shown.
>
> **Do not** type, copy or repeat any password.

## Prompt 2: add the DNS records (at OLITT)

The domain's live DNS is hosted by **OLITT** (nameservers `ns1.olitt.net` and `ns1.olitt.com`, checked on 2026-10-14). Truehost's DNS manager shows the zone as "terminated" because it is **not** the zone in use. Ignore it.

**Never change the nameservers.** Switching them to Truehost would take down the live website and email.

Before running this prompt, take a screenshot or export of the current OLITT DNS records as a backup.

> I'm signed in to my **OLITT** account. Find the DNS management for **churchtimesnigeria.net**. It may be under Domains → DNS / Manage DNS, or in the cPanel "Zone Editor" of the hosting account that runs the live website. Show me the list of existing records **before changing anything**.
>
> Do **not** use Truehost's DNS manager, and do **not** change the nameservers.
>
> Then **add** exactly these three new **A** records. Each one points to `<NEW staging VPS IPv4 address>` (never 158.69.36.54, the live server) with TTL 300 (or the lowest offered):
> 1. name `staging`
> 2. name `newsroom.staging`
> 3. name `cms.staging`
>
> Rules:
> - **Only add** these three records.
> - Do **not** edit, delete or re-create any existing record, including `@`, `www`, `mail`, `MX`, `TXT`/SPF/DKIM, `CNAME` and `NS`.
> - If a record with one of these names already exists, **stop and tell me** instead of changing it.
>
> When done, list the three records as saved.

**Check:** a few minutes later, `nslookup cms.staging.churchtimesnigeria.net` should show the VPS IP.

## Prompt 3: create the Cloudflare Turnstile widget

> I'm signed in to my Cloudflare dashboard. Open **Turnstile** and click **Add widget**.
> - Widget name: `Church Times staging`
> - Hostnames: `staging.churchtimesnigeria.net` and `newsroom.staging.churchtimesnigeria.net`
> - Widget mode: **Managed**
> - Pre-clearance: off
>
> Create it. Then tell me the **Site key**, which is public and fine to repeat. **Do not reveal, copy or repeat the Secret key**: leave it on screen for me.

**Then, yourself:** keep the Cloudflare page open. When `setup.sh` asks for the Turnstile secret on the server, copy the **Secret key** from Cloudflare and paste it into that hidden prompt. Give the **Site key** to `setup.sh` when it asks, or to Claude Code.

## By hand (no browser agent): a read-only GitHub token for the VPS

The VPS downloads the CMS image from GitHub's private package registry, so it needs a token that can **only read packages**. Do this step yourself, because the token is shown on screen:

1. GitHub → Settings → Developer settings → **Personal access tokens (classic)** → Generate new token.
2. Note: `churchtimes staging VPS pull`. Expiration: 90 days. Scope: **`read:packages` only**, nothing else.
3. Copy it once into the hidden prompt of `setup.sh` on the server. Don't save it anywhere else.

The first image appears after the staging kit is merged into `feat/newsroom-mvp`: the "CMS staging image" workflow builds it. In GitHub → abcentech → Packages → `churchtimes-cms`, check that its visibility is **Private**.

---

## After these steps
1. **Run the setup on the server.** SSH to the VPS as root and follow `README.md`: download the kit, then run `setup.sh`. It installs Docker, opens only ports 22, 80 and 443, generates every server secret on the server, asks for the Turnstile keys, gets https certificates and starts everything.
2. **Collect the staff logins.** `setup.sh` writes them to a root-only file on the server and prints only its path. Keep them out of chats and GitHub.
3. **Tell Claude Code staging is up.** Claude then runs the browser test suite against it.
4. **Phone check.** Work through `phone-checklist.md` on your phones.

Out of scope: the live site, WordPress, AdSense, email and existing DNS records. None of these change.
