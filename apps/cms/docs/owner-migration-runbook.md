# Owner migration runbook: from WordPress to the new site

Status: a guide for the owner, refreshed 2026-10-23 against the merged CMS tooling on `feat/newsroom-mvp`. The import
tools have been rehearsed on a real export on a throwaway database (PR #92); nothing here has been run on live systems.
Every step that touches the old site, DNS or production needs your explicit "go" first. Read it once start to finish
before running anything.

Related: [owner-security-hardening.md](owner-security-hardening.md), [import.md](import.md), [operations.md](operations.md),
[security.md](security.md), [api-contracts.md](api-contracts.md). The go-live plan, build spec and Codex specs
(`docs/go-live-plan.md`, `docs/go-live-build-spec.md`, `docs/codex-wave4-spec.md`) live on the go-live-plan branch.

## How to read the commands

Every command box starts with a label saying WHERE to run it. Never run a command in the wrong place.

| Label | Meaning |
| --- | --- |
| **[OWNER PC]** | Your own Windows computer, in PowerShell. |
| **[REHEARSAL MACHINE]** | A throwaway computer or virtual machine that holds no real site. Deleted afterwards. |
| **[SERVER]** | The new production or staging server, over SSH. |
| **[CMS HOST]** | The machine that runs the CMS, in its `apps/cms` folder (the server, or the rehearsal machine). |
| **[OLD WORDPRESS]** | The WordPress admin screen in your browser. Read-only use. |

Rules for the whole project:

- Private data (the export, the uploads, redirect lists, manifests, backups) lives in a private folder such as
  `D:\churchtimes-private\`. It is never put in GitHub, an issue, a pull request or a chat.
- Replace every `<angle-bracket>` value with your own. Never paste a real password, key or token into a document, a chat,
  an issue or a pull request. Type secrets only into the server's environment file or your password manager. The output of
  the import tools is counts and codes only, so it is safe to share; the manifest, detail files and exports are not.
- If a "what to check" line does not match, stop and ask. Do not carry on hoping.

## 1. Prerequisites and decisions

### 1.1 What you need before starting

| Item | Who | Check |
| --- | --- | --- |
| A new, clean server (see the hardening guide), not the old one | your technical helper | You can log in with an SSH key |
| The CMS deployed on that server per `operations.md` | your technical helper | Admin login page loads over HTTPS |
| A private folder on your PC with free space of about 3x the uploads size | Owner | `D:\churchtimes-private\` exists |
| WordPress admin access (read-only use) | Owner | You can open Tools, then Export |
| The Rank Math redirects export (CSV) | Owner | File exists in the private folder |
| DNS access (registrar or host) | Owner | You can see the current TTL values |
| A list of the 100 most-visited old addresses (Search Console or analytics) | Owner | Kept privately, never in GitHub |

### 1.2 Decisions D1 to D8 and their defaults

If you do not decide, the default applies. Write your answer and the date in the last two columns.

| # | Decision | Default | Your answer | Date |
| --- | --- | --- | --- | --- |
| D1 | Article address shape | SETTLED: `/{slug}/` (as today), all 4,343 posts, host `churchtimesnigeria.net` | Settled: `/{slug}/` | 2026-10 |
| D2 | Where the public site is hosted | A host that can send 301 redirects: Caddy on the new server | [Answer] | [Date] |
| D3 | Comments | Archive read-only, no new comments | [Answer] | [Date] |
| D4 | Ads | Direct sponsor campaigns; AdSense only after you approve and supply the publisher line | [Answer] | [Date] |
| D5 | Newsletter | Reuse the existing Mailchimp audience if it is active; the CMS stores consent | [Answer] | [Date] |
| D6 | Analytics | Keep the existing GA4, only after visitor consent, off on staging | [Answer] | [Date] |
| D7 | AMP and Web Stories | Retire, with 301 redirects to the normal article | [Answer] | [Date] |
| D8 | Auto-post to social | After launch; share links only at launch | [Answer] | [Date] |

D1 is settled: articles live at `/{slug}/` on `churchtimesnigeria.net`, so articles need almost no redirects (only
categories, dates, `?p=` ids, AMP and similar). `PUBLIC_ARTICLE_PATH_TEMPLATE=/{slug}/` is now the CMS default; set it
explicitly on both the CMS and the public site host, because the two values must match. A post whose slug equals a
reserved root name (for example `admin`, `api`, `search`) is renamed safely by the importer. D2 to D8 are still open: the
defaults above apply until you answer.

## 2. Taking the WordPress export safely

Do this from the old site as a read-only user. Do not install plugins, change settings or log in to the old server.
The old server was compromised (see the hardening guide), so treat everything that came from it as untrusted data.

### Step 2.1 Export the content (WXR)

**[OLD WORDPRESS]** in the browser:

1. Sign in to the admin and open Tools, then Export.
2. Choose "All content", then Download Export File.
3. Save it straight into `D:\churchtimes-private\export.xml`.

**[OWNER PC]**

```
Get-Item D:\churchtimes-private\export.xml | Select-Object Length, LastWriteTime
Get-Content D:\churchtimes-private\export.xml -Tail 3
```

What to check afterwards: the length is not zero and the last lines include `</channel>` and `</rss>`. If the file is cut
off, export again (a very large site may need the export split by date range; keep each part and import them one by one).

### Step 2.2 Take the uploads pack (images)

The export does not include image files. Ask your host or developer for a copy of the `wp-content/uploads` folder, made
with the hosting provider's file manager or backup download, not with tools run on the compromised server.

**[OWNER PC]** after you receive the archive:

```
New-Item -ItemType Directory -Force D:\churchtimes-private\uploads-raw
Expand-Archive -Path D:\churchtimes-private\uploads.zip -DestinationPath D:\churchtimes-private\uploads-raw
Get-ChildItem D:\churchtimes-private\uploads-raw -Recurse -File | Measure-Object
```

What to check afterwards: the file count is plausible (thousands) and the folder contains year folders such as `2019`.

### Step 2.3 Remove anything that is not an image

The old server was infected, so scan before anything is trusted. The importer only reads JPEG, PNG and WebP, but do not
rely on that alone.

**[OWNER PC]**

```
Get-ChildItem D:\churchtimes-private\uploads-raw -Recurse -File |
  Where-Object { $_.Extension -notin '.jpg','.jpeg','.png','.webp','.gif','.pdf' } |
  Group-Object Extension | Select-Object Name, Count
```

What to check afterwards: the list should be short. Any `.php`, `.exe`, `.js`, `.html` or `.phtml` file is a red flag.
Do not open it. Delete those files, tell your technical helper, and run a full anti-virus scan of the folder before continuing. Then
copy the clean result:

```
Copy-Item D:\churchtimes-private\uploads-raw D:\churchtimes-private\uploads -Recurse
```

What to check afterwards: the scan reports no threats. `D:\churchtimes-private\uploads\` is the folder used from now on.

### Step 2.4 Redirects export and a safety copy

**[OLD WORDPRESS]** in Rank Math, open Redirections and export to CSV. Save it as `D:\churchtimes-private\redirects.csv`.

**[OWNER PC]** make a dated copy of all three items on a second drive or a private store:

```
Copy-Item D:\churchtimes-private\export.xml D:\churchtimes-backup\export-<date>.xml
```

What to check afterwards: the copy opens and has the same size as the original.

## 3. Rehearse on a throwaway machine

Purpose: prove the tools work and can be undone before they touch anything that matters. The rehearsal machine is
deleted at the end. The commands come from `import.md` (branch `feat/newsroom-mvp`). These tools exist now:
`import:inspect`, `import:wxr-report`, `import:wxr`, `import:rollback`, `import:rehearse`, `import:redirects` and
`export:media-map`. `import:convert-wxr` and the real-export rehearsal arrive with PR #92 (open): until it is merged,
use branch `agent/claude-realdry` for step 3.3 and 3.4. If npm says "missing script", your copy is old: run `git pull`
and `npm ci`, or ask your technical helper.

### Step 3.1 Prepare the machine

**[REHEARSAL MACHINE]** install Node.js (the version in `apps/cms/package.json`) and Git, then:

```
git clone <repository-address> churchtimes
cd churchtimes
git checkout feat/newsroom-mvp
cd apps/cms
npm ci
```

What to check afterwards: `npm ci` ends without errors. Never put real data inside the `churchtimes` folder; the commands
refuse paths inside the repository.

### Step 3.2 Rehearsal on made-up data

**[CMS HOST]** (the rehearsal machine, `apps/cms` folder):

```
npm run import:rehearse
```

It builds a temporary database and a large invented export, then runs a dry run, a real run, a second run, an update and
a rollback. It uses no real data. Allow 5 to 10 minutes.

What to check afterwards: the last lines show PASS for every check and no FAIL. If anything says FAIL, stop and send the
output to your technical helper.

### Step 3.3 Read-only reports on your real export

Copy `export.xml` to the rehearsal machine (for example `D:\churchtimes-private\export.xml`). These commands read the
file only: no database, no network, nothing written. They print counts and codes, never titles, names or emails.

**[CMS HOST]**

```
npm run import:inspect -- --file D:\churchtimes-private\export.xml
npm run import:wxr-report -- --file D:\churchtimes-private\export.xml
npm run import:convert-wxr -- --file D:\churchtimes-private\export.xml --detail-file D:\churchtimes-private\reports\convert-detail.json
```

`import:inspect` is the quick size check. `import:wxr-report` is the wider parse report. `import:convert-wxr` converts every
published post in memory (no database) and reports what the converter had to drop or flatten. The `--detail-file` must not
exist yet and must be outside the repository; it holds WordPress post ids so you can open a post in the old admin. Never
paste it anywhere shared.

What the real export (the 2026-10-13 file) contains, so you can compare:

| Item | Expected |
| --- | --- |
| Published posts | 4,343 (all are imported at `/{slug}/`) |
| Draft posts | 101 (counted, never imported) |
| Approved comments on published posts | 1,348 (spam and trash excluded) |
| Pingbacks | 485, skipped on purpose |
| Attachments (media library entries) | 6,142 |
| Categories | 15 |
| Authors | 1 distinct author name (bylines are text only; no user accounts are created) |
| Posts without a WordPress category | about 3,050; the importer places them (see step 3.4) |
| Conversion failures; posts whose text shrank by over 20 percent; posts with text but empty output | 0 each |
| An error code such as `WXR_ENCODING` or `WXR_TRUNCATED` | none; if present, export again (step 2.1) |

A newer export will differ a little; a large difference needs an explanation from your technical helper before you carry on. Also look
at "shortcodes removed by tag": `video`, `audio`, `fvplayer` and `gallery` content is not imported as media yet (YouTube is
kept as a video block; a video and audio block is being added in a separate change). Write the counts down so an editor
can check those posts.

### Step 3.4 Dry run of the import

Never point this at staging or production. The simplest safe way is the all-in-one rehearsal on your real export: it uses a
temporary database and a temporary media folder and removes both at the end.

**[CMS HOST]**

```
npm run import:rehearse -- --file D:\churchtimes-private\export.xml --dry-run-only --detail-file D:\churchtimes-private\reports\rehearse-detail.json
npm run import:rehearse -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads --detail-file D:\churchtimes-private\reports\rehearse-detail-2.json
```

The first line is a dry run only (about 3 to 5 minutes for a 100 MB export). The second also applies the import, applies it
a second time (which must change nothing) and rolls it back, all on the throwaway database; allow longer. What to check
afterwards: every check says PASS and none says FAIL, the exit code is 0, "published posts accounted for X of Y" shows no
difference (password-protected posts count as skipped), failures are 0, and unresolved images are a small, explainable
number (reasons such as `missing-file`). Without `--uploads` every image shows as unresolved; that is expected.

To run the plain dry run against a scratch database of your own instead:

```
$env:DATABASE_URL = '<scratch-database-address>'
npm run import:wxr -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads
```

A dry run writes nothing. Save the printed report to a private text file for later comparison.

What the importer decides for you, so nothing surprises you in the QA:

- **One category per article.** A post with no WordPress category gets one in a fixed order: the Yoast "primary category" if
  it is one of the 15 exported categories; then the first tag that has an entry in an optional tag-to-category map file
  (the real export has one tag, so no map is needed); then the generic `uncategorised`; else the fallback category `News`
  (change with `--fallback-category`). About 1,400 posts land in the fallback; editors can recategorise them later.
- **SEO text.** Page title and description come from Rank Math first, then Yoast (`import:inspect` counts both). Template
  variables such as `%title%` are filled in where possible (title, site name, category, date, excerpt) and dropped
  otherwise; overlong values are cut at a word. Canonical address, noindex and social titles are counted but not stored
  (the CMS has no field for them yet; ask for one if you want them).
- **Bylines** are text only (the single author name in the export). No accounts are created.
- **Comments** keep name, date, text and replies. Email addresses, websites and IP addresses are never read, and anything
  shaped like an email address in a name or body becomes `[email removed]`.

### Step 3.5 Apply, repeat, and roll back

**[CMS HOST]** the manifest file must not exist yet and must be OUTSIDE the repository. It is the only way to undo a run.

```
$env:IMPORT_MANIFEST_PATH = 'D:\churchtimes-private\manifests\rehearsal-1.jsonl'
npm run import:wxr -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads --apply
```

Allow about 8 minutes for the 4,343 published posts. What to check afterwards: the end report matches the dry run, the run exits cleanly
and the manifest file exists.

Run the same command a second time with a new manifest name (for example `rehearsal-2.jsonl`). What to check afterwards:
everything is "unchanged" and nothing new is written. That proves the import can be repeated safely.

(To refresh already imported articles after a converter fix, `--update` rewrites those nobody edited since, but not their slug, category, status or date.) Now prove the rollback. Dry run first and read the counts, then apply:

```
npm run import:rollback -- --manifest D:\churchtimes-private\manifests\rehearsal-1.jsonl
npm run import:rollback -- --manifest D:\churchtimes-private\manifests\rehearsal-1.jsonl --apply
```

What to check afterwards: the dry run lists what would be deleted; after `--apply`, a second rollback changes nothing
("already gone"). Audit rows are kept on purpose. If a run was killed (no end line) add `--allow-incomplete`; if staff
edited rows add `--force`, but only after reading the dry run.

### Step 3.6 Look at real articles, then clean up

Run step 3.5 again, start the admin and open a sample (section 5.2 lists what to open). When satisfied, delete the
rehearsal machine, or wipe its scratch database and delete the copy of `export.xml`.

What to check afterwards: no real files remain on the rehearsal machine. Record the go-ahead decision with your technical helper in
section 9.

## 4. Real import into the staging CMS

Staging is the CMS on the new server, not yet public, with search engines blocked. The server runs the CMS from the
production Docker definition (`apps/cms/docker-compose.production.yml`): a `postgres` container, the `cms` container
(runs as user 1000, read-only filesystem), and a one-off `migrate` container that holds the tools (`migrate`,
`admin:create` and the import commands). The full server procedure is `operations.md`, section 3.2; your technical helper does the
server setup. Your part is below.

### Step 4.1 Bring the CMS up on the server (done by your technical helper, checked by you)

Facts to confirm with your technical helper before any import:

| Check | Where | What you should see |
| --- | --- | --- |
| The environment file is `/etc/churchtimes/cms.env` (mode 600, root only) and the database password is in `/etc/churchtimes/secrets/postgres_password` | [SERVER] | You never see these values in chat or screenshots; your technical helper confirms they exist and are new (not from the old server) |
| `CMS_PUBLIC_URL`, `CMS_CORS_ORIGINS`, `CMS_CSRF_ORIGINS` list only the real https addresses | [SERVER] | your technical helper confirms |
| `PUBLIC_CMS_URL` on the public site host is exactly the same address as the CMS `CMS_PUBLIC_URL` | public host settings | Yes. If they differ, the site silently drops article images (found in testing) |
| `PUBLIC_ARTICLE_PATH_TEMPLATE=/{slug}/` on the CMS and the public host | both | Same value on both (decision D1) |
| `ALLOW_FIRST_REGISTER` is NOT set (or not `true`) | cms.env | Left unset. With it unset the "first user" sign-up address is refused. The first administrator is created on the server with `admin:create` (`operations.md`, "First administrator") before the site is exposed |
| Health: `https://<cms-address>/api/health/live` shows `{"status":"ok"}` and `https://<cms-address>/api/health/ready` shows `"status":"ready"` with `database`, `migrations` and `media` all `true` | [OWNER PC] browser or `curl.exe -s` | Both answer 200. If ready says 503, a `false` flag tells your technical helper which part to look at |
| A backup ran and was verified before the import (section 8) | [SERVER] | A `churchtimes-<date>` folder exists and `verify-backup.sh` printed `VERIFIED` |

Gap to settle with your technical helper first: the production compose file does not mount your export, the uploads copy or a manifest
folder into the `migrate` container, and the import writes image files to the media folder. So the first real import
needs a small local override file (kept on the server, outside GitHub) that mounts, for the one-off `migrate` run only:
the private folder `/srv/private` read-only, a `manifests` folder that is writable, and `/srv/churchtimes/media` (owned by
user 1000). Until that exists, do the real import on a machine where the tools run directly (the rehearsal machine setup of
section 3, but with a persistent database), and move the result to the server with the backup and restore scripts
(`operations.md`, section 6). Do not improvise this: ask your technical helper.

### Step 4.2 Move the private files to the server safely

**[OWNER PC]**

```
scp D:\churchtimes-private\export.xml <user>@<server-address>:/srv/private/export.xml
scp -r D:\churchtimes-private\uploads <user>@<server-address>:/srv/private/uploads
```

What to check afterwards: on **[SERVER]**, `ls -la /srv/private` shows both items and the folder is readable only by the
deploy user (`drwx------`). It must be outside the code folder and outside any Git checkout. Remove the files once the
import is accepted.

### Step 4.3 Dry run, then apply

**[SERVER]** (inside the `migrate` container, with the override from step 4.1; your technical helper gives you the exact command line, which
looks like `$C --profile ops run --rm migrate npm run import:wxr -- --file /srv/private/export.xml ...`)

First a dry run, which writes nothing:

```
npm run import:wxr -- --file /srv/private/export.xml --uploads /srv/private/uploads
```

What to check afterwards: same as step 3.4 ("published posts accounted for X of Y" shows no difference, failures 0).
Then apply. The manifest file must not exist yet; it is your undo button and must be OUTSIDE the repository.

```
export IMPORT_MANIFEST_PATH=/srv/private/manifests/staging-1.jsonl
npm run import:wxr -- --file /srv/private/export.xml --uploads /srv/private/uploads --apply
echo $?
```

What to check afterwards: the printed exit code is 0, the QA report matches the rehearsal (4,343 published posts, about 1,348
approved comments), and the manifest exists. Watch `docker stats` during the first run in case memory runs short. Copy the
manifest and the printed report to your PC (private folder). Take a fresh database and media backup right after the import
(section 8).

### Step 4.4 Redirects

Import the Rank Math redirect list with the redirect tool (`import:redirects`, header `from,to,status`; dry run first, then
`--apply`; details in `api-contracts.md`). Because articles keep `/{slug}/`, the list should mostly cover categories, old
`?p=` ids, AMP and web stories. What to check afterwards: the report lists chains and loops as zero, and unresolved top-traffic
addresses is zero when compared with your private top-100 list.

## 5. QA checklist on staging

Tick each line. Anything unticked is a decision for your technical helper and you, not something to ignore.

### 5.1 Counts

| Check | Expected | Result |
| --- | --- | --- |
| Articles in the admin list | the QA report figure: 4,343 published posts minus any password-protected | [Number] |
| Approved comments | about 1,348 (spam excluded; the 485 pingbacks are skipped on purpose) | [Number] |
| Categories | the 15 from the old site, plus `News` (the fallback, holds about 1,400 posts) | [Number] |
| Media items | roughly the images in use (the old library has 6,142 attachments); unresolved images explained | [Number] |

### 5.2 Spot checks: open at least 50 articles

Pick: the 10 most visited, 10 oldest, 10 newest and 20 random, plus those from the lines below.

| Area | What to check |
| --- | --- |
| Articles | Title, date (archive date kept), byline, category, featured image, readable body |
| Tables | Open 5 articles with tables: rows and columns intact, header row looks right |
| YouTube blocks | Open 5 with video: the player appears; other video types appear as a plain link |
| Images and captions | Pictures show with captions; no broken image icons |
| Links | Internal links go to the new addresses; none point at the old server |
| Comments | Open 5 articles with comments: names, dates, text and replies show; **no email address anywhere** |
| Redirects | See 5.3 |
| Ads | Slots show "Advertisement"; an empty slot leaves no gap; no AdSense script while it is off |
| SEO | Page title and description present; staging is blocked from search engines |

### 5.3 Redirect and old-address checks

**[OWNER PC]** (or the `check-redirects` script the public-site developer supplies):

```
curl.exe -sI https://<staging-site>/<old-article-slug>/
curl.exe -sI "https://<staging-site>/?p=<old-numeric-id>"
curl.exe -sI https://<staging-site>/category/<old-category>/
```

What to check afterwards: one 301 hop to the right article (not two hops, not a loop); an unknown junk address gives 404
or 410. Your private top-100 list must give zero failures.

### 5.4 Comments privacy test

Look at three commented articles (view the page source and search for the at-sign). What to check afterwards: no real email
appears; text that looked like an email shows `[email removed]`.

Sign-off: your technical helper ____ [Date] ____ . No cutover until every line is ticked or consciously accepted.

## 6. Cutover

Principle: be reversible at every step. The old site stays untouched until the new one has proven itself. Do not change
the domain's mail or nameserver records at any point.

### Step 6.1 Soft launch on a subdomain

1. **[SERVER]** set up the public host on a subdomain such as `new.<your-domain>` (name agreed with your technical helper) with HTTPS.
   Search engines stay blocked (`PUBLIC_INDEXABLE` not set to true).
2. **[OWNER PC]** at your DNS provider add a record for the subdomain only. The main domain is untouched.
3. Invite staff and a few trusted readers for 3 to 7 days. Test on phones; submit a test story, the contact form and a
   newsletter sign-up with a test address.
4. Run the health checks on the CMS address (`/api/health/live` and `/api/health/ready`, see section 4.1) and set up an
   outside uptime monitor on them (see the hardening guide, section 9).
5. If web push (OneSignal) is used, test it here: subscribers only carry over if the final site address is the same.

What to check afterwards: the site loads on a phone, forms deliver, admin login works, and the logs show no error spikes:

**[SERVER]**

```
journalctl -u <service-name> --since "1 hour ago" | tail -50
```

### Step 6.2 Lower the TTL (48 hours before cutover)

**[OWNER PC]** at the DNS provider, find the records for the main domain and `www` and set TTL to 300 seconds. Write the
old value here to restore it later: [Old TTL].

What to check afterwards: after 48 hours, `nslookup -type=A <your-domain>` shows a TTL counting down from 300 or less.

### Step 6.3 Final content refresh and pre-flight

1. Agree a time to stop publishing on WordPress: [Date/Time]. Take a fresh export (step 2.1).
2. **[SERVER]** run the dry run, then apply with a NEW manifest name. Already imported articles stay untouched.
3. Take a CMS database backup (section 8.2) and save a screenshot or text copy of the current DNS records.
4. Run the redirect smoke check against the new host with the top-100 list (`check-redirects`, per the public-site docs).
   Never run it against the live old server unless you approve.

What to check afterwards: zero failures on the top-100 list; the backup file exists and is not empty.

### Step 6.4 Switch DNS

**[OWNER PC]** at the DNS provider, change only the A/AAAA (or CNAME) record for the main domain and `www` to the new
host. Do not touch MX (mail), TXT (SPF, DKIM) or nameserver records.

```
nslookup <your-domain>
curl.exe -sI https://<your-domain>/
curl.exe -sI https://<your-domain>/<old-article-slug>/
```

What to check afterwards: the new host answers, the certificate is valid, and the old article address gives the expected
redirect or page. Open the home page and 10 articles on your phone using mobile data.

### Step 6.5 Switch indexing on

**[SERVER]** set `PUBLIC_INDEXABLE=true`, restart the public host (the command from the host kit), then check that
`https://<your-domain>/robots.txt` allows crawling and the sitemap loads. Submit the sitemap in Search Console.

### Step 6.6 Rollback plan

Decide the trigger in advance, for example: "more than [Number] percent of the top-100 addresses failing, admin login
broken, or forms not delivering, within [Number] hours".

| Situation | Action | Where |
| --- | --- | --- |
| DNS problem or fatal error in the first hours | Put the old DNS records back (saved in 6.3). With TTL 300, most visitors move back in about 5 minutes | [OWNER PC], DNS provider |
| Bad release of the public host | Point the release link back to the previous release and restart (host kit runbook) | [SERVER] |
| Bad import | `import:rollback` with the manifest, dry run first (step 3.5) | [CMS HOST] |
| Server unusable | Restore the last backup onto a clean machine (section 8.4) | [SERVER] |

Keep the old WordPress as an offline backup only; do not leave it exposed as a login site (see the hardening guide).

### Step 6.7 What to watch for 72 hours

| When | Watch | Where | Worry if |
| --- | --- | --- | --- |
| Hours 0 to 6, hourly | Home page, 5 articles, admin login, uptime alerts | Phone, monitor email | Any failure |
| Day 1 | Server logs for 404 and 5xx; Search Console crawl errors | Server, Search Console | 404s on addresses that existed; any 5xx |
| Day 1 | Contact, story-tip and newsletter test messages arrive | Staff mailbox | Nothing arrives |
| Day 2 | Traffic against the previous week (lower is expected where consent is declined) | Analytics | A drop of more than [Number] percent not explained |
| Day 2 | Disk space, memory, last backup finished | Server | Backup missing; disk over 80 percent |
| Day 3 | Indexed pages, sitemap status; run the top-100 check again | Search Console, check script | Rising "not found" |
| Day 3 | If all quiet, raise the DNS TTL back to the old value | DNS provider | Only after the green light |

## 7. Afterwards: media map for the public host

Old image addresses (`/wp-content/uploads/...`) should keep working so search images and hotlinks do not break. The CMS can
export an offline media map for the public host (`export:media-map`, merged).

**[CMS HOST]** run it from `apps/cms` against the database that holds the imported media, with output OUTSIDE the repository:

```
npm run export:media-map --
npm run export:media-map -- --out D:\churchtimes-private\media-map.json --detail-file D:\churchtimes-private\media-map-details.txt
```

The first line is a dry run (counts only, writes nothing). The second writes the map and a `media-map.json.sha256` file
next to it. Only images that anonymous readers can see are exported. Give BOTH files to your technical helper over a private channel; on
the public host, `sha256sum -c media-map.json.sha256` must say OK before the map is swapped in. Never commit either file.
Export again after each import or on a schedule, and replace the map and its `.sha256` together. What to check afterwards: a
sample old image address returns the picture on the public host, and an unpublished article's image stops being served.

## 8. Backups and the restore test

### 8.1 What to back up

| Item | How often | Kept where |
| --- | --- | --- |
| CMS PostgreSQL database | Nightly, and before every import or upgrade | Off the server (3-2-1, see the hardening guide) |
| Media folder (images the CMS stores) | Nightly | Off the server |
| Environment file (secrets) | When it changes | Password manager, never GitHub |
| Import manifests and the original `export.xml` | Once | Private storage |

### 8.2 Backups with the supplied scripts

The CMS ships tested scripts (`apps/cms/scripts/backup.sh`, `verify-backup.sh`, `restore.sh`; full text in `operations.md`,
section 6). your technical helper sets them up as a nightly timer. They make one folder per run with the database dump, a media archive,
checksums and row counts; they encrypt with a PUBLIC key (`age`), so the private key never sits on the server; and they
refuse to run in unsafe ways. A failed backup returns an error, so alert on it, and also alert if no new folder appears
for 26 hours.

**[SERVER]** as root, a manual backup before an import or an upgrade (the command line is the one in `operations.md`):

```
sudo ls -la /var/backups/churchtimes/predeploy
```

What to check afterwards: a new `churchtimes-<UTC date>` folder, mode 700, containing `db.dump` (or `db.dump.age`),
`media.tar.gz` (or `.age`), `SHA256SUMS` and `counts.txt`, with sensible sizes. The private decryption key lives in the
password managers of two people, not on the server.

### 8.3 Off-site copy

Copy each finished backup folder to a second place at a different provider using a write-only or pull-only method (3-2-1;
`operations.md`, "Off-site copy"). A compromised server must not be able to delete its own backups. Never copy the
`.partial-*` or `.tmp-*` folders.

### 8.4 The restore test (before cutover, then every quarter)

A backup that was never restored is only a hope.

**[REHEARSAL MACHINE]** (a clean machine with PostgreSQL 16, not the server). Get a backup folder from the OFF-SITE copy
(this also proves the off-site copy works), supply the decryption key for this drill only, and remove it afterwards:

```
./scripts/verify-backup.sh --backup <backup-folder>
./scripts/restore.sh --backup <backup-folder> --target-db churchtimes_drill --media-target <empty-folder>
```

What to check afterwards: `verify-backup.sh` prints `VERIFIED`; `restore.sh` exits 0 and its counts table shows `ok` on every
row (articles, media, comments); start a test CMS against `churchtimes_drill` with its own test secrets (never the production
ones), log in, and open 5 articles with their images. Record: your technical helper [Date] [Minutes taken]. Delete the test database,
media copy, decrypted files and the machine afterwards.

## 9. Who does what

| Step | Who | Backup person | Done on |
| --- | --- | --- | --- |
| Decide D1 to D8 | Owner | your technical helper | [Date] |
| New clean server and hardening | your technical helper | your technical helper | [Date] |
| WordPress export and uploads pack | Owner | your technical helper | [Date] |
| Malware scan of uploads | your technical helper | Owner | [Date] |
| Rehearsal and rollback test | your technical helper | your technical helper | [Date] |
| Real import on staging and QA report | your technical helper | your technical helper | [Date] |
| Editorial QA: 50-article sample | Editor your technical helper | Owner | [Date] |
| Redirect map and top-100 check | your technical helper | Owner | [Date] |
| Soft launch on subdomain | your technical helper | Owner | [Date] |
| Lower DNS TTL | Owner | your technical helper | [Date] |
| Go / no-go decision | Owner | none | [Date] |
| DNS switch | Owner | your technical helper | [Date] |
| Indexing on, sitemap submission | your technical helper | Owner | [Date] |
| 72-hour watch rota | your technical helper, your technical helper | Owner | [Date] |
| Media map export and public host setup | your technical helper | your technical helper | [Date] |
| Backups running, off-site copy proven, restore test passed | your technical helper | Owner | [Date] |
| Retire old WordPress | Owner | your technical helper | [Date] |

## 10. If something goes wrong

Stop, do not retry in a loop, and keep the exact output. Do not paste real data or secrets when asking for help; the import
prints counts and codes only, so its output is safe to share. Contact: your technical helper, [Phone or channel].


## 11. Note for people who raise pull requests

`docker-smoke` and `public-quality` are required checks but only run when files under `apps/cms/**` change. A pull request
that touches only other folders (for example `apps/newsroom/**` or workflow files) shows just `verify` and GitHub blocks the
merge. Until the filters are widened, include a genuine change under `apps/cms/` (a documentation note is enough) in such a
pull request. This document lives under `apps/cms/docs/` for that reason.
