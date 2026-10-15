# Go-live plan: from the current WordPress site to the new site, CMS and newsroom

Status: **a proposal for the owner to decide on. Nothing in this plan has been done.** No DNS, hosting, WordPress or
database change is made by this document. Every step that touches production needs the owner's explicit approval.

Written for: the project owner, and anyone who helps run the hosting or DNS (developer, Truehost, ChatGPT/Codex sessions).

## 1. Where things stand (2026-10-15)

| Part | State |
| --- | --- |
| Live site | WordPress (Soledad theme, ~45 plugins) on a 1 CPU / 2 GB Truehost VPS (158.69.36.54), served by OpenLiteSpeed. DNS is at OLITT. The same server also runs the domain's mail (ports 25/465/587/993). |
| Live server health | Overload was fixed on 2026-10-15 (crawler trap blocked, page cache working). Load fell from about 11 to under 2. Needs a few days of watching. |
| New public site | Static Vite site, built in GitHub Actions and published through the existing Pages branch. Owned by Codex (`src/`, `index.html`, `tools/`). |
| CMS and newsroom | Payload CMS 3 + PostgreSQL, plus the newsroom app. Merged into `feat/newsroom-mvp`, including images in articles and live-update photos (PR #32). |
| Staging | Runs on the owner's PC through Tailscale Funnel. Free and on demand. Not suitable for production. |
| Content migration | Archive tooling exists as open PRs (#18 recovery, #19 import engine). Neither is merged or tested against the real WordPress export. |
| Real browser tests | 86 of 86 pass locally (desktop and mobile). Against the deployed staging, 66 of 76 pass. The 10 failures are Cloudflare Turnstile blocking automated browsers, which is expected. |

**The live server cannot host the CMS.** It has 1 CPU and 2 GB RAM, no Node, Postgres or Docker, and runs the live
site. The CMS needs 2 vCPU and 4 GB (`apps/cms/docs/operations.md` §1).

## 2. Decisions the owner needs to make

1. **Where does the CMS live?** See section 3.
2. **Where does the public site live?** It must be a host that can send **server-side 301 redirects** for the old
   WordPress addresses and a real 404 for unknown paths (for example Caddy on the CMS server, Cloudflare Pages/Workers, or
   Netlify). GitHub Pages alone cannot do per-URL redirects, so it is fine for staging but not enough for cutover. See
   decision D2 in [go-live-build-spec.md](go-live-build-spec.md).
3. **Which domain name structure?** For example, `www` for the public site, `cms.` for the CMS, `newsroom.` for the
   newsroom app. All under the current domain, with the CMS and newsroom cookies kept separate from the public site.
4. **Who maintains it after launch?** A named person for hosting, backups and updates (the existing operations doc says
   the same).
5. **Which content moves, and which stays archived?** All WordPress articles, or only a recent window with older ones
   kept as redirects to an archive.

## 3. Hosting options for the CMS

| Option | Cost (check current prices) | For | Against |
| --- | --- | --- | --- |
| **A. Small VPS, 2 vCPU / 4 GB, Ubuntu 24.04** (Hetzner, DigitalOcean, Vultr, etc.) | Roughly $5 to $25 a month | Matches the repo's operations doc and the VPS kit in PR #27. Full control. Cheap. | Someone must patch and watch it. |
| B. Managed platform (Railway, Render, Fly.io) with managed Postgres | Roughly $20 to $50 a month | Less server care | Needs adapting the repo's Docker setup. More expensive. Media storage needs extra work. |
| C. Keep Tailscale on the owner's PC | Free | Fine for testing | Goes down when the PC sleeps. Not for readers or reporters. |

**Recommendation: option A**, on a new server that is separate from the live WordPress one. Do not install the CMS on
158.69.36.54.

## 4. Phases, with go/no-go gates

Each phase ends with a gate. Do not start the next phase until the gate passes.

### Phase 0: Stabilise the live site (now, about 1 week)
- Set up uptime monitoring (see section 6).
- Remove the `tel:` links from articles that cause the crawler trap.
- Confirm Truehost has deleted the full site copy they made in the `felix905132` account, or give you the download.
- Ask whoever manages the hosting to close the public admin ports (8090, 7080) and plain FTP (21), apply the pending
  updates with a planned reboot, and move root login to SSH keys.
- **Gate:** the live site has stayed healthy for 7 days (load under 2, no downtime alerts).

### Phase 1: Finish and approve staging (about 1 week)
- Restart Tailscale staging with the rotated Turnstile key and passwords (the tip-form problem was a doubled secret).
- Merge and test the open Codex PRs against the merged CMS: #31 (public live photos), #30 (SEO feeds, share cards,
  responsive images), #34 (the combined integration draft). The `I4` photo test in `10-images.spec.ts` must change from
  "no photos" to "photos shown" at the same time.
- Owner tests on a phone: tip form, a reporter story with images, live coverage with a photo, editor approval.
- **Gate:** all real-browser journeys pass, and the owner has signed off on staging. No mocked results are counted as
  full end-to-end tests.

### Phase 2: Build real hosting (about 1 week)
- Owner creates the new server account (option A) and shares nothing secret in chat.
- Deploy using the repo's operations doc: Caddy for TLS, Postgres on the same machine, systemd for the app.
- Set up nightly database and media backups **off the server**, and do one full **restore test**. The operations doc
  says the restore test has not been done.
- Real Turnstile keys, SMTP for password resets, real staff accounts created.
- **Gate:** health check passes, restore test passes, security checklist (operations doc section 10) is ticked.

### Phase 3: Migrate content (about 2 weeks, in parallel with phase 2)
- Take a fresh full backup of WordPress first, and keep it off the live server.
- Run the import in **dry-run mode** into a disposable database. Review the editorial QA report: text, headings, images,
  authors, dates (archive dates must be kept, not replaced by the import date).
- Build a **redirect map** of every old address to its new address, keeping existing article slugs wherever possible.
- Check rights and credits for photos, and check for sensitive data.
- **Gate:** a sample of at least 50 legacy articles, across categories and years, is checked by an editor against the
  originals. Redirect map has zero unresolved top-traffic URLs.

### Phase 4: Soft launch on a subdomain (about 1 week)
- Put the new site at a separate address (for example `beta.`) alongside the live WordPress site. Nothing at the
  main address changes.
- Editors publish real stories there for a week. Check Google Search Console, sitemap, RSS and share cards.
- **Gate:** editors are comfortable, no data-loss or access-control issue found, and the owner gives written approval to
  switch the main address.

### Phase 5: Cutover (a quiet hour, with a rollback ready)
1. **48 hours before:** lower the DNS TTL on the records you will change to 300 seconds, at OLITT.
2. **Just before:** final WordPress export, import the new articles since the last run, freeze publishing on WordPress.
3. Change **only** the web records (`www` and the apex) to the new site. **Do not change MX, SPF, DKIM or other mail
   records**: the old server also runs the domain's mail. Moving mail is a separate project.
4. Load the redirect map. Test 20 old addresses by hand, the sitemap, the tip form and the newsroom login.
5. Watch the monitor and Search Console for 48 hours.
- **Rollback:** change the same records back to 158.69.36.54. With a 300-second TTL, readers are back within minutes.
  Keep WordPress running, untouched, for at least 30 days after cutover.
- **Gate to close:** 7 days without a serious incident. Then lengthen the TTL again.

### Phase 6: After launch
- Keep WordPress read-only for 30 to 90 days as a safety net, then decommission it on the owner's decision.
- Monthly restore test, monthly security updates, a named support person.

## 5. What must not happen

- No deploy or merge to `main`, and no live DNS, WordPress, hosting, AdSense or production database change, without the
  owner's explicit approval for that step.
- No mock success in live mode, and mocked test results never reported as full end-to-end.
- No secrets in the repo or in chat. Turnstile secret keys and authentication secrets live in server-side environment
  variables only.
- Do not change the domain's nameservers. DNS stays at OLITT.
- Do not move the domain's mail as part of this launch.

## 6. Uptime monitoring (setup, about 5 minutes, free)

Use UptimeRobot or Better Stack (free tiers are enough).

1. Create an account with an email address that more than one person can read.
2. Add an **HTTPS monitor** for `https://churchtimesnigeria.net/`, checking every 5 minutes. Alert if it is down, or if
   the response takes more than a few seconds (if the plan allows response-time alerts).
3. Add a second monitor with a **keyword** check on the homepage (a word that always appears), so a blank or error page
   with status 200 is also caught.
4. Add a monitor for the login page `https://churchtimesnigeria.net/wp-login.php`, expecting status 200. A change
   here can mean a plugin or server problem.
5. Add two alert contacts: the owner's email and one backup person. Turn on phone push notifications.
6. Add monitors for the new sites as they come up (`cms.`, `newsroom.`, `beta.`), including the CMS health endpoint.
7. Optional: a public status page, so readers and staff can check it.

Server-side quick check (read-only, run over SSH when something looks wrong):

```
uptime
curl -s -o /dev/null -w 'home: %{http_code} in %{time_total}s\n' https://churchtimesnigeria.net/
curl -s -o /dev/null -D - https://churchtimesnigeria.net/ | grep -i x-litespeed-cache
```

Healthy means load under 2, status 200 in under 2 seconds, and a cache `hit`.

## 7. Risks and how this plan handles them

| Risk | Handling |
| --- | --- |
| New site goes down at cutover | Keep WordPress untouched, short TTL, one-step DNS rollback |
| Search ranking drops because old addresses break | Keep slugs, full redirect map, sitemap, watch Search Console |
| Lost or damaged content in import | Dry run, editor QA sample, fresh WordPress backup kept off-server |
| Mail breaks | Do not touch MX, SPF or DKIM in this launch |
| CMS server is hacked or fails | Firewall with ports 22/80/443 only, key-only SSH, off-server backups, tested restore |
| One person knows everything | Named maintainer, documented runbook (operations doc), recovery steps (operations doc section 4.3) |
| Spam or bots on public forms | Turnstile, rate limits, origin checks (already built and tested) |

## 8. Rough timeline

About 5 to 7 weeks end to end if decisions are quick. Phases 2 and 3 overlap. The biggest unknowns are the content
import quality and how fast the owner can decide on hosting and sign off on staging.

## 9. Next actions

The build work found by auditing the live site (URL redirects, SEO, analytics, ads, newsletter, contact form, push,
comments archive, import) is specified in [go-live-build-spec.md](go-live-build-spec.md), split by lane.

1. Owner: choose a hosting option (section 3) and domain structure (section 2).
2. Owner: set up uptime monitoring (section 6) and send the Truehost request.
3. Claude: review and test Codex PRs #31, #30 and #34 against the merged CMS.
4. Claude: restart-and-retest checklist for staging with the rotated keys.
5. Codex: archive tooling review and a real dry run (PRs #18 and #19), once there is a WordPress export to run it on.
