# Staging on your own PC, published with Tailscale Funnel

This gives Church Times a **free, on-demand test copy** (staging) that runs on your Windows 11 PC and is reachable from the internet (phones, other people) over real `https`. It does **not** touch the live website, any server, or the DNS of `churchtimesnigeria.net`. When you are not testing, you switch it off and it is gone from the internet.

You will get three web addresses on one name, for example (your machine name will differ):

| What | Address | Where it really runs |
|---|---|---|
| Public site | `https://churchtimes-staging.<your-tailnet>.ts.net` | your PC, port 48501 |
| Newsroom (staff app) | `https://churchtimes-staging.<your-tailnet>.ts.net:8443` | your PC, port 48502 |
| CMS and Payload admin | `https://churchtimes-staging.<your-tailnet>.ts.net:10000` | your PC, port 48503 |

Everything runs only on `127.0.0.1` (invisible to your network); Tailscale Funnel is the only door to the internet.

---

## One-time setup (about 15 minutes)

### 1. Install Tailscale and sign in
1. Download **Tailscale for Windows** from <https://tailscale.com/download/windows> and install it.
2. Sign in (a free personal account is enough). The Tailscale icon appears next to the clock.

### 2. Turn on the three Tailscale settings (admin console, needs the account owner)
Open <https://login.tailscale.com/admin/dns> :
1. Make sure **MagicDNS** is **enabled**.
2. Scroll to **HTTPS Certificates** and click **Enable HTTPS...** (confirm). This is what gives you the padlock.

Open <https://login.tailscale.com/admin/acls/file> :
3. Funnel needs permission in the access-control file. Look for a block named `nodeAttrs` containing `"attr": ["funnel"]`. New accounts already have it:
   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```
   If it is missing, add it and press **Save**. (The first time you start the staging, Tailscale may also print a link to turn Funnel on. Open it, approve, and run the command again.)

### 3. Give this PC a readable name
The web address contains the machine name. In the admin console open <https://login.tailscale.com/admin/machines>, click the **...** menu of this PC, **Edit machine name...**, choose e.g. `churchtimes-staging` and untick "auto-generate from OS hostname". Your address is now `https://churchtimes-staging.<your-tailnet>.ts.net`. (Run `tailscale status` in a terminal to see the exact name; the tool reads it for you automatically.)

### 4. Create the Cloudflare Turnstile widget (the spam check on the story form)
1. In the Cloudflare dashboard open **Turnstile**, **Add widget**.
2. Name: `Church Times staging`. **Hostname:** add exactly your machine name, e.g. `churchtimes-staging.<your-tailnet>.ts.net` (no `https://`, no port).
3. Widget mode: *Managed*. Create it.
4. Cloudflare shows a **Site key** (public) and a **Secret key** (private). Keep the page open; you will paste them once in the next step.

Do **not** use Cloudflare's "test" keys (they start with `1x000...`): the tool refuses them on purpose, because this staging is meant to behave like the real thing.

---

## Start it

Open a terminal in the project folder, then:

```
cd apps\cms
npm run staging:funnel:up
```

What happens (the first run takes several minutes, later runs are faster):
1. It checks Tailscale (signed in, HTTPS on, Funnel allowed) and tells you exactly what to fix if not.
2. **First run only:** it asks for the Turnstile **site key** (you can see what you type) and the **secret key** (typing is hidden, nothing appears on screen; paste and press Enter). They are saved in the private state folder and never printed or logged.
3. It creates the database, adds **made-up** staff accounts and sample stories, builds the sites, starts the three programs, and turns the three Funnel addresses on.
4. It tests everything from your PC and prints **READY**, the three addresses, and the location of two login files.

Keep the window open or close it: the programs keep running in the background.

### Where your files are
Everything generated lives **outside the project** in `%LOCALAPPDATA%\churchtimes-staging-funnel` (paste that into the Explorer address bar):

| File | What it is |
|---|---|
| `staff-logins.txt` | the made-up staff logins (admin, editor-in-chief, section editor, trusted publisher, reporter) for you and for the phone checklist |
| `xapp-remote-credentials.json` | the same logins in the format the automatic test run needs |
| `secrets.json`, `turnstile.json` | generated passwords/keys for the programs (private, never share) |
| `pgdata\` | the staging database (kept between runs) |
| `logs\` | what each program printed, useful if something is wrong |
| `state.json` | which programs are running |

## Look at it

```
npm run staging:funnel:status
```
shows what is running, the ports, whether the funnels are on, and the addresses.

## Stop it (do this when you are not testing)

```
npm run staging:funnel:down
```
This turns off exactly the three Funnel addresses this tool created (your other Tailscale settings are left alone), stops the programs and the database, and **keeps the data** so the next start is quick. Starting again later: `npm run staging:funnel:up` (no questions the second time).

To throw everything away (database, logins, saved Turnstile keys, uploaded pictures): `npm run staging:funnel:down -- --wipe` and type `DELETE` when asked.

`down` only reports success when Tailscale itself confirms the three addresses are gone. If it cannot (it prints `FAILED`, exits with an error and keeps `state.json`), the addresses are probably **still public**: run it again, or use `npm run staging:funnel:down -- --reset-all`, which clears **all** Serve/Funnel settings of this PC (only if you have no others). `down` also finds leftover entries that point at this tool's ports when its own record was lost.

---

## Security notes (please read)

- **Only these three programs are public.** Nothing else on your PC is reachable: they listen on `127.0.0.1` only and Funnel forwards just these three addresses. Funnel never exposes files, other ports, or your tailnet.
- **Keep it off when you are not testing.** While it is on, anyone who knows the address can open the public site, the newsroom login screen and the CMS. Run `staging:funnel:down` when you finish. If you restart or shut down the PC, run `staging:funnel:down` after the next boot too: Tailscale remembers the Funnel addresses across restarts, so they stay switched on and forward to local ports where nothing of ours listens any more. That is risky, because **whatever program starts on those ports next becomes public**. This is why the ports are unusual (48501-48503), why `staging:funnel:status` and `staging:funnel:up` print a loud warning for such a leftover entry, and why `up` refuses to start while one exists (run `down` first). `down` also removes the entry.
- **Synthetic accounts only.** The staff logins are invented (`staging-<role>-<random>@staging.invalid`, the random part is made for your install and is not in the repository) with long random passwords. Never put real staff accounts, real tips, real stories or real personal data in this staging. It is a test copy and can be wiped at any time.
- **The Payload admin (`.../:10000/admin`) is public**, protected only by those generated passwords (plus the CMS's login lockout and rate limits). That is acceptable for synthetic data; do not weaken the passwords or reuse them elsewhere.
- **Search engines are told to stay away** (`X-Robots-Tag: noindex, nofollow` on every response of the public site and the newsroom, plus `robots.txt` on the public site; the CMS sends the same header on every response, admin pages and API included). It is not a secret address though: do not post it publicly.
- **Funnel has a bandwidth limit** (Tailscale does not publish the number; it is meant for testing, not traffic). Fine for a few testers.
- **The PC must stay awake and online** while testing: change Windows power settings to "never sleep" while plugged in, or the staging disappears mid-test.
- **No ads and no real mail.** Ads are switched off in the builds (the tool checks), and no e-mail is configured, so password-reset e-mails do not exist: use the logins file.
- The first start needs internet (Tailscale certificate, Cloudflare Turnstile). A first-ever HTTPS certificate for the name can take a minute to appear; the tool waits up to 3 minutes.

### Technical notes (for the developers)
- One hostname for all three services is deliberate: the CMS login cookie is host-only, `Secure`, `SameSite=Lax`; browsers treat the other ports as the same site, so the newsroom (port 8443) can sign in to the CMS (port 10000).
- **Client addresses and rate limits.** Tailscale's serve proxy overwrites `X-Forwarded-For` with a single entry, the visitor's address (for Funnel taken from the ingress relay; source: `ipn/ipnlocal/serve.go`), and adds `X-Forwarded-Proto: https`. So the CMS runs with `TRUST_PROXY=true`, `TRUST_PROXY_HOPS=1`. The CMS **refuses to start in production without `TRUST_PROXY=true`**, so it cannot be switched off; if a future Tailscale version stopped forwarding the address, every visitor would share one rate-limit bucket (the CMS then multiplies the login limit by 20). Because the remote test run also comes from one address, the limits are raised: `AUTH_LOGIN_RATE_LIMIT=200` (minimum enforced) and `SUBMISSION_RATE_LIMIT=20` (minimum 10) per 15 minutes. Tune with `FUNNEL_AUTH_LOGIN_RATE_LIMIT`, `FUNNEL_SUBMISSION_RATE_LIMIT`, `FUNNEL_TRUST_PROXY_HOPS`. There is deliberately **no** `CLIENT_IP_HEADER` option (`FUNNEL_CLIENT_IP_HEADER` is refused): Funnel does not overwrite arbitrary request headers, so a visitor could pick their own rate-limit bucket with it.
- The running CMS has real `https` origins and **no** `CMS_ALLOW_INSECURE_LOCAL_STAGING`. The synthetic seed runs once as a separate short-lived process with loopback-only values, because the seed refuses anything else.
- Ports (override if something else uses them): `FUNNEL_PUBLIC_PORT=48501`, `FUNNEL_NEWSROOM_PORT=48502`, `FUNNEL_CMS_PORT=48503`, `FUNNEL_PG_PORT=48500`. Funnel itself only allows 443, 8443 and 10000.
- **The database is seeded on every start** (idempotent, a few seconds) and, before any funnel is switched on, the tool checks that the CMS reports existing users (`GET /api/users/init`) and that the synthetic admin can log in. An empty CMS would let the first visitor create the first admin, so the tool refuses to publish one. If the database folder exists but `secrets.json` or `seed-users.json` was lost, it asks you to `--wipe` and start clean.
- **`tailscale serve` on those ports.** Funnel publishes a whole host and port (every path). If `tailscale serve` already has other paths or TCP forwards on 443, 8443 or 10000, `up` refuses; `--overwrite-serve` first CLEARS everything on those three ports (`tailscale serve --https=<port> off`) and then takes them over. `up` also refuses while Funnel is still on for this tool's local ports (leftover from an earlier run) and when `state.json` still lists funnels.
- **Media uploads** go to `<state folder>\media` (env `CMS_MEDIA_DIR`), not into the repository; `--wipe` deletes them. **HSTS** on the CMS and newsroom is 300 seconds (`CMS_HSTS_MAX_AGE`, compiled into the CMS build) because browsers pin it to the whole `ts.net` name for every port; the CMS also sends `X-Robots-Tag: noindex, nofollow` (`CMS_NOINDEX`). Both are build-time settings, so the tool rebuilds `apps/cms/.next` unless the existing build carries its marker (`.next/funnel-staging-build.json`); that replaces a normal production build in that folder.
- The state folder must be inside your user profile (`FUNNEL_STATE_DIR` overrides it, same rule); PostgreSQL is started with `listen_addresses=127.0.0.1`.
- Options of `funnel-up`: `--dry-run` (print every command), `--host <name.ts.net>` (with funnels it must equal this machine's Tailscale name), `--rotate-turnstile`, `--rotate-passwords` (new passwords for the synthetic staff accounts, e.g. after one was shown or shared), `--rebuild`, `--overwrite-serve`, `--no-funnel`, `--test-keys`. For a non-interactive start set `FUNNEL_TURNSTILE_SITE_KEY` and `FUNNEL_TURNSTILE_SECRET_KEY` (first run only).
- **`--test-keys` is TEST ONLY.** It never configures a funnel, stores nothing, and uses Cloudflare's always-pass test *site* key and a placeholder secret (the production CMS rejects Cloudflare's dummy secret), so story-form submissions fail in that mode. `--no-funnel` starts everything on `127.0.0.1` with real keys but no Tailscale. Both exist to test this tool without Tailscale.
- The CMS production build in `apps/cms/.next` is reused when it is newer than everything in `apps/cms/src`; otherwise `next build` runs first (several minutes).

---

## How Claude runs the automatic test suite against it

After `READY`, from `apps\cms` (the start command prints these exact lines with your real addresses):

```
set XAPP_PUBLIC_URL=https://churchtimes-staging.<your-tailnet>.ts.net
set XAPP_NEWSROOM_URL=https://churchtimes-staging.<your-tailnet>.ts.net:8443
set XAPP_CMS_URL=https://churchtimes-staging.<your-tailnet>.ts.net:10000
set XAPP_REMOTE_CREDENTIALS=%LOCALAPPDATA%\churchtimes-staging-funnel\xapp-remote-credentials.json
npm run test:e2e:remote
```

(PowerShell: `$env:XAPP_PUBLIC_URL="..."`, etc.) Add `-- --headed` so a person can click the Turnstile box if it does not pass by itself; `-- --plan` lists what would run without a browser. The run only creates records whose names start with `E2E-<date>-<time>` and removes them afterwards. Full details: `apps/cms/docs/staging.md`, section "Remote mode".

## Phone checklist

Use `deploy/staging/phone-checklist.md` with these addresses instead of the `staging.churchtimesnigeria.net` ones:

- Section A and B (public site and story form): `https://churchtimes-staging.<your-tailnet>.ts.net`
- Sections C and D (newsroom): `https://churchtimes-staging.<your-tailnet>.ts.net:8443`
- Logins: reporter and section editor from `staff-logins.txt` (typing the long passwords on a phone is easier if you open the file on the PC and send yourself the text through a private channel you delete afterwards; never post it in a public place).

On a phone with mobile data the page loads straight from the internet through Funnel, which is exactly the point: it tests the real route.

## If something goes wrong

| Message / symptom | What to do |
|---|---|
| "tailscale command line tool was not found" | Install Tailscale for Windows (step 1), open a new terminal. |
| "Tailscale is not connected" | Click the tray icon, **Log in**. |
| "HTTPS certificates are not enabled" | Step 2, **Enable HTTPS**. |
| "Funnel is not enabled" / a link is printed | Step 2, `nodeAttrs` with `funnel`, or open the printed link as the account owner. |
| "Port 855x is already in use" | Another program uses it. Run `staging:funnel:status`; or pick other ports (technical notes). |
| The funnel checks fail but the local checks pass | Wait a minute (certificate) and run `staging:funnel:status`. Logs are in the `logs` folder. |
| Story form says the check failed | The Turnstile widget hostname must be exactly your machine name, and the secret must be pasted **once** (the hidden prompt shows nothing; the script now checks the secret with Cloudflare and refuses a doubled or wrong one). Fix it in Cloudflare, or run `staging:funnel:up -- --rotate-turnstile`. |
