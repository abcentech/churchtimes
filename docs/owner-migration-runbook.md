# Owner migration runbook: from WordPress to the new site

Status: a guide for the owner. Nothing here has been run on live systems. Every step that touches the old site, DNS or
production needs your explicit "go" first. Read it once start to finish before running anything.

Related: [go-live-plan.md](go-live-plan.md), [go-live-build-spec.md](go-live-build-spec.md),
[codex-wave4-spec.md](codex-wave4-spec.md), [owner-security-hardening.md](owner-security-hardening.md),
and (on the CMS branch) `apps/cms/docs/import.md` and `apps/cms/docs/operations.md`.

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
- Replace every `<angle-bracket>` value with your own. Never paste a real password or key into a document.
- If a "what to check" line does not match, stop and ask. Do not carry on hoping.

## 1. Prerequisites and decisions

### 1.1 What you need before starting

| Item | Who | Check |
| --- | --- | --- |
| A new, clean server (see the hardening guide), not the old one | [Name] | You can log in with an SSH key |
| The CMS deployed on that server per `operations.md` | [Name] | Admin login page loads over HTTPS |
| A private folder on your PC with free space of about 3x the uploads size | Owner | `D:\churchtimes-private\` exists |
| WordPress admin access (read-only use) | Owner | You can open Tools, then Export |
| The Rank Math redirects export (CSV) | Owner | File exists in the private folder |
| DNS access (registrar or host) | Owner | You can see the current TTL values |
| A list of the 100 most-visited old addresses (Search Console or analytics) | Owner | Kept privately, never in GitHub |

### 1.2 Decisions D1 to D8 and their defaults

If you do not decide, the default applies. Write your answer and the date in the last two columns.

| # | Decision | Default | Your answer | Date |
| --- | --- | --- | --- | --- |
| D1 | Article address shape | `/<slug>/` as today (fewest redirects). See the note below | [Answer] | [Date] |
| D2 | Where the public site is hosted | A host that can send 301 redirects: Caddy on the new server | [Answer] | [Date] |
| D3 | Comments | Archive read-only, no new comments | [Answer] | [Date] |
| D4 | Ads | Direct sponsor campaigns; AdSense only after you approve and supply the publisher line | [Answer] | [Date] |
| D5 | Newsletter | Reuse the existing Mailchimp audience if it is active; the CMS stores consent | [Answer] | [Date] |
| D6 | Analytics | Keep the existing GA4, only after visitor consent, off on staging | [Answer] | [Date] |
| D7 | AMP and Web Stories | Retire, with 301 redirects to the normal article | [Answer] | [Date] |
| D8 | Auto-post to social | After launch; share links only at launch | [Answer] | [Date] |

Note on D1: the two planning documents disagree. `go-live-build-spec.md` recommends keeping `/<slug>/`;
`codex-wave4-spec.md` tells the public-site developer to assume `/reports/{slug}/` until you decide. Decide this FIRST,
because the redirect map and the sitemap depend on it. Keeping the old shape means fewer redirects and less search risk.

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
Do not open it. Delete those files, tell [Name], and run a full anti-virus scan of the folder before continuing. Then
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
deleted at the end. The commands come from `apps/cms/docs/import.md` on branch `feat/newsroom-mvp`.

Two extra tools arrive from open pull requests and may not be in your copy yet:

- `import:inspect` (open PR): a read-only look at the export. Use it if present.
- `export:media-map` (open PR): makes the file the public host needs for old image addresses (section 7).

If npm says "missing script", that PR is not merged yet. Ask [Name] before skipping it.

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
output to [Name].

### Step 3.3 Parse-only report on your real export

Copy `export.xml` to the rehearsal machine (for example `D:\churchtimes-private\export.xml`).

**[CMS HOST]**

```
npm run import:wxr-report -- --file D:\churchtimes-private\export.xml
npm run import:inspect -- --file D:\churchtimes-private\export.xml
```

The second line works only once its open PR is merged. The first prints counts only (no titles, names or emails).

What to check afterwards:

| Item | Expected |
| --- | --- |
| Published posts | about 4,346 (the report prints the difference) |
| Approved comments on published posts | about 1,833 |
| Posts without a slug, duplicate slugs, password-protected | small numbers; write them down |
| An error code such as `WXR_ENCODING` or `WXR_TRUNCATED` | none; if present, export again (step 2.1) |

### Step 3.4 Dry run of the import

Point the CMS at a scratch database first (never staging or production).

**[CMS HOST]**

```
$env:DATABASE_URL = '<scratch-database-address>'
npm run import:wxr -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads
```

A dry run writes nothing. What to check afterwards: it prints the QA report; "published posts accounted for X of Y" shows
every post accounted for (counting the password-protected ones as skipped); failures are 0; unresolved images are a
small, explainable number (reasons such as `missing-file`). Save the output to a private text file for later comparison.

### Step 3.5 Apply, repeat, and roll back

**[CMS HOST]** the manifest file must not exist yet and must be OUTSIDE the repository. It is the only way to undo a run.

```
$env:IMPORT_MANIFEST_PATH = 'D:\churchtimes-private\manifests\rehearsal-1.jsonl'
npm run import:wxr -- --file D:\churchtimes-private\export.xml --uploads D:\churchtimes-private\uploads --apply
```

Allow about 8 minutes for 4,346 posts. What to check afterwards: the end report matches the dry run, the run exits cleanly
and the manifest file exists.

Run the same command a second time with a new manifest name (for example `rehearsal-2.jsonl`). What to check afterwards:
everything is "unchanged" and nothing new is written. That proves the import can be repeated safely.

Now prove the rollback. Dry run first and read the counts, then apply:

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

What to check afterwards: no real files remain on the rehearsal machine. Record the go-ahead decision with [Name] in
section 9.

## 4. Real import into the staging CMS

Staging is the CMS on the new server, not yet public, with search engines blocked.

### Step 4.1 Move the private files to the server safely

**[OWNER PC]**

```
scp D:\churchtimes-private\export.xml <user>@<server-address>:/srv/private/export.xml
scp -r D:\churchtimes-private\uploads <user>@<server-address>:/srv/private/uploads
```

What to check afterwards: on **[SERVER]**, `ls -la /srv/private` shows both items and the folder is readable only by the
deploy user (`drwx------`). It must be outside the code folder. Remove the files once the import is accepted.

### Step 4.2 Dry run, then apply

**[SERVER]**

```
cd /srv/churchtimes/apps/cms
npm run import:wxr -- --file /srv/private/export.xml --uploads /srv/private/uploads
```

What to check afterwards: same as step 3.4. Then apply:

```
export IMPORT_MANIFEST_PATH=/srv/private/manifests/staging-1.jsonl
npm run import:wxr -- --file /srv/private/export.xml --uploads /srv/private/uploads --apply
echo $?
```

What to check afterwards: the exit code printed is 0, the QA report matches the rehearsal, and the manifest exists. Copy the
manifest and the printed report to your PC (private folder). The manifest is your undo button, kept OUTSIDE the repository.

### Step 4.3 Redirects

Import the Rank Math redirect list and generate the map with the redirect tool described in `apps/cms/docs/`
(`import:redirects`). What to check afterwards: the report lists chains and loops as zero, and unresolved top-traffic
addresses is zero when compared with your private top-100 list.

## 5. QA checklist on staging

Tick each line. Anything unticked is a decision for [Name] and you, not something to ignore.

### 5.1 Counts

| Check | Expected | Result |
| --- | --- | --- |
| Articles in the admin list | the QA report figure (published posts minus password-protected) | [Number] |
| Approved comments | about 1,833 (spam excluded) | [Number] |
| Categories | match the old list; the `uncategorised` fallback is small | [Number] |
| Media items | roughly the images in use; unresolved images explained | [Number] |

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

Sign-off: [Name] ____ [Date] ____ . No cutover until every line is ticked or consciously accepted.

## 6. Cutover

Principle: be reversible at every step. The old site stays untouched until the new one has proven itself. Do not change
the domain's mail or nameserver records at any point.

### Step 6.1 Soft launch on a subdomain

1. **[SERVER]** set up the public host on a subdomain such as `new.<your-domain>` (name agreed with [Name]) with HTTPS.
   Search engines stay blocked (`PUBLIC_INDEXABLE` not set to true).
2. **[OWNER PC]** at your DNS provider add a record for the subdomain only. The main domain is untouched.
3. Invite staff and a few trusted readers for 3 to 7 days. Test on phones; submit a test story, the contact form and a
   newsletter sign-up with a test address.
4. If web push (OneSignal) is used, test it here: subscribers only carry over if the final site address is the same.

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

Old image addresses (`/wp-content/uploads/...`) should keep working so search images and hotlinks do not break. The CMS
will export an offline media map (`export:media-map`, from an open PR; the public site's A12 package waits for it).

**[CMS HOST]** once available (exact options come with that PR):

```
npm run export:media-map -- --out D:\churchtimes-private\media-map.json
```

Give the file to [Name] to place on the public host. What to check afterwards: a sample old image address returns the
picture on the public host, and an unapproved or removed file stops being served within the agreed window.

## 8. Backups and the restore test

### 8.1 What to back up

| Item | How often | Kept where |
| --- | --- | --- |
| CMS PostgreSQL database | Nightly, and before every import or upgrade | Off the server (3-2-1, see the hardening guide) |
| Media folder (images the CMS stores) | Nightly | Off the server |
| Environment file (secrets) | When it changes | Password manager, never GitHub |
| Import manifests and the original `export.xml` | Once | Private storage |

### 8.2 Database backup

**[SERVER]**

```
mkdir -p /srv/backups
pg_dump --format=custom --file=/srv/backups/cms-$(date +%F).dump "<database-address>"
ls -la /srv/backups
```

What to check afterwards: the file is not empty and today's date is in its name. Encrypt it before it leaves the server,
as `operations.md` describes.

### 8.3 Media backup

**[SERVER]**

```
tar -czf /srv/backups/media-$(date +%F).tar.gz -C <media-folder-parent> <media-folder-name>
tar -tzf /srv/backups/media-$(date +%F).tar.gz | head
```

What to check afterwards: the listing shows image files and the archive size is similar to the media folder.

### 8.4 The restore test (before cutover, then every quarter)

A backup that was never restored is only a hope.

**[REHEARSAL MACHINE]** (a clean machine, not the server)

```
createdb cms_restore_test
pg_restore --no-owner --dbname=cms_restore_test cms-<date>.dump
```

Then unpack the media archive, start the CMS against `cms_restore_test`, and log in.

What to check afterwards: the same article count as production; 5 articles open with their images; admin login works.
Record: [Name] [Date] [Minutes taken]. Delete the test database and machine afterwards.

## 9. Who does what

| Step | Who | Backup person | Done on |
| --- | --- | --- | --- |
| Decide D1 to D8 | Owner | [Name] | [Date] |
| New clean server and hardening | [Name] | [Name] | [Date] |
| WordPress export and uploads pack | Owner | [Name] | [Date] |
| Malware scan of uploads | [Name] | Owner | [Date] |
| Rehearsal and rollback test | [Name] | [Name] | [Date] |
| Real import on staging and QA report | [Name] | [Name] | [Date] |
| Editorial QA: 50-article sample | Editor [Name] | Owner | [Date] |
| Redirect map and top-100 check | [Name] | Owner | [Date] |
| Soft launch on subdomain | [Name] | Owner | [Date] |
| Lower DNS TTL | Owner | [Name] | [Date] |
| Go / no-go decision | Owner | none | [Date] |
| DNS switch | Owner | [Name] | [Date] |
| Indexing on, sitemap submission | [Name] | Owner | [Date] |
| 72-hour watch rota | [Name], [Name] | Owner | [Date] |
| Media map export and public host setup | [Name] | [Name] | [Date] |
| Backups running, restore test passed | [Name] | Owner | [Date] |
| Retire old WordPress | Owner | [Name] | [Date] |

## 10. If something goes wrong

Stop, do not retry in a loop, and keep the exact output. Do not paste real data or secrets when asking for help; the import
prints counts and codes only, so its output is safe to share. Contact: [Name], [Phone or channel].
