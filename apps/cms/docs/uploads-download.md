# Getting the old site's pictures (uploads) safely

Plain-language guide for the owner. Goal: copy the folder `wp-content/uploads` (all the pictures of the old website, about 4.7 GB) from the old server to your own computer, check that the copy arrived complete, check that nothing dangerous came with it, and put it in a folder the new CMS can read.

Read this first, it is short:

- **What the fingerprints prove, and what they do not.** The list of fingerprints (SHA-256) in step 1c is made *by the hacked server*. Comparing it in step 3 only proves that the download was **intact** (nothing was cut off or damaged on the way). It does **not** prove that a picture is genuine: a hacked server can hand out altered files together with matching fingerprints. Safety does not come from the fingerprints. It comes from (1) the checks on your PC (step 4), (2) the allow-list of file types, and (3) the CMS itself: the Media collection accepts only JPEG, PNG and WebP (judged by the first bytes of the file, not the name), refuses anything over 40 megapixels, and **decodes and re-saves every picture**, so nothing hidden inside a picture (a script after the image data, metadata) is kept. The check in step 4 is a first filter; the re-save is the real protection.
- **The old server was hacked** (root malware, October 2026). Treat every single file that comes from it as untrusted, like an email attachment from a stranger.
- **Copy only the `uploads` folder.** Not the whole home folder, not `plugins`, not `themes`, not a full-site backup. Pictures live in `uploads`; the hacker's programs live elsewhere.
- **Never open, double-click, preview or run** anything you copied. Especially not `.php`, `.html`, `.js`, `.svg` or `.exe` files. You do not need to open anything: the computer checks the files for you.
- **Never type or paste a password into the chat with me or with any AI.** Type passwords only into the black terminal window (it will not show them as you type, that is normal). If you pasted a whole terminal session, look for passwords in it first.
- **Never run a command or script that was downloaded from the old server.** Every command in this guide is written here; run only those.
- **Know which computer a command is for.** Each block below is labelled **ON THE SERVER** (the prompt looks like `root@something:~#`) or **ON YOUR PC** (the prompt looks like `PS C:\Users\...>`). Mixing them up once put a file in the public website folder in the past. If unsure, stop and ask.
- Replace `DOMAIN` with the site's folder name on the server (it is the folder under `/home/` that holds `public_html`; `ls /home` on the server shows it) and `SERVER_IP` with the server's address. Everything in capitals is a placeholder.
- This is a read-only job: nothing here changes or deletes anything on the old server's website.

## What you will end up with

| Step | Where | Result |
|------|-------|--------|
| 1 | server | a temporary read-only account, and the server's own count and fingerprints |
| 2 | your PC | the uploads folder copied to `uploads-raw` |
| 3 | your PC | counts and fingerprints compared with the server |
| 4 | your PC | virus scan, then the CMS safety check |
| 5 | your PC | a clean, checked copy in `uploads-verified` |
| 6 | server | temporary account removed |

## Where the folders go

Make these folders on your PC. They must be **outside every Git folder** (that is, not inside `C:\Users\HP\Documents\churchtimes\churchtimes` or any other checkout of the project). The commands of the CMS refuse to work with a folder inside a Git folder.

```powershell
# ON YOUR PC (PowerShell)
$base = "C:\Users\HP\Documents\churchtimes\private"
New-Item -ItemType Directory -Force "$base\uploads-raw", "$base\uploads-verified", "$base\reports" | Out-Null
```

- `uploads-raw`: exactly what came from the server. Untrusted. Nothing reads from it except the checks.
- `uploads-verified`: only after every check passed. This is the folder the CMS importer is given.
- `reports`: the detail files of the checks (they contain real file names, so they stay private).

(On Linux or macOS use any folder outside the project, for example `~/churchtimes-private/uploads-raw`.)

## Step 1. On the server: temporary account, count and fingerprints

You will give a temporary user permission to **read** the uploads folder only, log in with a key (no password), pull, and then delete the user.

### 1a. On your PC: make a key (once)

```powershell
# ON YOUR PC (PowerShell). Choose a passphrase when asked; it is not shown as you type.
ssh-keygen -t ed25519 -f "$HOME\.ssh\ct_pull"
Get-Content "$HOME\.ssh\ct_pull.pub"
```

The last command prints one long line starting with `ssh-ed25519`. That line is the **public** key and is safe to copy. Never copy the file without `.pub`: that one is your private key.

### 1b. On the server: create the account

**Do not log in as root with the root password over ssh** if you can avoid it: the server is compromised, and a password typed into it (or into a fake login prompt on it) can be captured. Prefer, in this order:

1. The hosting provider's **web console / rescue mode** (Truehost panel: the VPS console, or a rescue boot) to run the commands below, so no password crosses the possibly hacked ssh service.
2. A **key-only** login (a key you already installed for root; password login switched off), not a typed password.

If you do have to type a password to get in, then **that password must be treated as stolen**: change it on every place you used it (the server, the hosting panel, e-mail, anything that shares it) **after** this job, from a clean computer, and never reuse it. The same holds for any password you have typed into this server before. Then, in the console (or your key-only session):

```bash
# ON THE SERVER (root@...)
useradd -m -s /bin/bash ctpull
mkdir -p /home/ctpull/.ssh
nano /home/ctpull/.ssh/authorized_keys     # paste the single ssh-ed25519 line, save with Ctrl+O, Enter, Ctrl+X
chown -R ctpull:ctpull /home/ctpull/.ssh
chmod 700 /home/ctpull/.ssh
chmod 600 /home/ctpull/.ssh/authorized_keys

# read-only access to the uploads folder and nothing else
setfacl -m u:ctpull:x /home/DOMAIN /home/DOMAIN/public_html /home/DOMAIN/public_html/wp-content
setfacl -R -m u:ctpull:rX /home/DOMAIN/public_html/wp-content/uploads
```

If `setfacl` says "command not found", run `apt-get install -y acl` (or `dnf install -y acl`) first. If you cannot install it, ask me for the alternative; do not give the account more rights than this.

### 1c. On the server: count and fingerprint the pictures

Types that must never come along are skipped, both here and in the copy: scripts, web pages, programs, archives and hidden files. The exclusions on the server side are a **courtesy** (they save time and space); a hacked server can ignore them or lie. The **real** check is the one on your PC in step 4, which looks at every file that arrived. First see how many such files exist (this number is interesting but not alarming; WordPress puts a harmless `index.php` in some folders):

```bash
# ON THE SERVER
cd /home/DOMAIN/public_html/wp-content/uploads
find . -type f \( -iname '*.php*' -o -iname '*.phtml' -o -iname '*.phar' -o -iname '*.pht' -o -iname '*.sh' -o -iname '*.js' -o -iname '*.html' -o -iname '*.htm' -o -iname '*.svg' -o -iname '*.exe' -o -iname '*.zip' -o -iname '*.tar' -o -iname '*.gz' -o -name '.*' \) | wc -l
find . -type l | wc -l
```

(The second number is the count of shortcuts/links; there should be 0.) Now the three numbers to compare later, counting only the files you will copy:

```bash
# ON THE SERVER, same folder
EXCL="! -iname *.php* ! -iname *.phtml ! -iname *.phar ! -iname *.pht ! -iname *.sh ! -iname *.js ! -iname *.html ! -iname *.htm ! -iname *.svg ! -iname *.exe ! -iname *.zip ! -iname *.tar ! -iname *.gz ! -name .*"
set -f      # no wildcard expansion while $EXCL is used (find gets the literal patterns)
echo "files:"; find . -type f $EXCL | wc -l
echo "bytes:"; find . -type f $EXCL -printf '%s\n' | awk '{s+=$1} END {print s}'
set +f      # wildcards must work again for the next line, otherwise it prints 0
echo "year folders:"; find . -mindepth 1 -maxdepth 1 -type d -name '[0-9][0-9][0-9][0-9]' | wc -l
set -f
# the fingerprint list (takes a few minutes: the server is small). It is written to the temporary user's home, NOT to /tmp and NOT to public_html.
find . -type f $EXCL -print0 | sort -z | xargs -0 sha256sum > /home/ctpull/uploads.sha256
set +f
chown ctpull:ctpull /home/ctpull/uploads.sha256
wc -l /home/ctpull/uploads.sha256
```

Write the three numbers (files, bytes, year folders) on paper or in a note on your PC. The fingerprint list has one line per file: a long code (SHA-256) and the file's path. If two files have the same code, they are identical copies.

## Step 2. On your PC: pull the folder

Pick **one** of the routes. The first is the preferred one; all of them use an encrypted connection. Do not use plain FTP (port 21): it sends the password in the open and should be closed on the server anyway.

All routes skip the dangerous file types, do not copy links, and put the result in `uploads-raw`. Keep your Windows up to date: a hacked server can also try to attack the program that downloads from it. (The skipping is done by your side of the command where the tool allows it; the server-side part is a courtesy, see step 1c. The check in step 4 is what counts.)

### Route A: rsync (Linux, macOS, or Windows with WSL "Ubuntu"), only with a patched rsync

rsync can stop and carry on exactly where it left off, which matters for 4.7 GB. **But rsync has had serious flaws in which a malicious server can write files on the computer that pulls from it** (CVE-2024-12086, CVE-2024-12087 and CVE-2024-12088, fixed in rsync 3.4.0). Pulling from a hacked server with an old rsync is exactly that situation. So:

```bash
# ON YOUR PC: in the WSL/Ubuntu terminal too. Windows' own tools do not count: WSL has its own copy.
rsync --version | head -1
```

It must say `version 3.4.0` or higher (a distribution may also have a patched older number; if in doubt, treat it as too old). If it is lower, run `sudo apt-get update && sudo apt-get install --only-upgrade rsync`, check again, and if it is still lower **use Route B or C (SFTP/tar) instead**. Those routes are the safer default for this job anyway.

```bash
# ON YOUR PC (a WSL/Ubuntu or Linux/macOS terminal). On Windows the PC folders are under /mnt/c/...
rsync -rt --no-links --partial --progress \
  --exclude='*.php*' --exclude='*.phtml' --exclude='*.phar' --exclude='*.pht' --exclude='*.sh' \
  --exclude='*.js' --exclude='*.html' --exclude='*.htm' --exclude='*.svg' --exclude='*.exe' \
  --exclude='*.zip' --exclude='*.tar' --exclude='*.gz' --exclude='.*' \
  -e "ssh -i /mnt/c/Users/HP/.ssh/ct_pull" \
  ctpull@SERVER_IP:/home/DOMAIN/public_html/wp-content/uploads/ \
  /mnt/c/Users/HP/Documents/churchtimes/private/uploads-raw/
```

(If WSL complains that the key file permissions are too open, copy the key into the WSL home folder first: `cp /mnt/c/Users/HP/.ssh/ct_pull ~/.ssh/ && chmod 600 ~/.ssh/ct_pull` and use that path.) If the connection drops, run the **same command again**: it continues.

### Route B: Windows PowerShell only (no WSL): tar over ssh, one year at a time

Windows has `ssh` and `tar` built in. This route makes one archive file per year, so a dropped connection costs one year, not everything. **Important:** use `cmd /c` for the redirect. PowerShell's own `>` damages binary files.

```powershell
# ON YOUR PC (PowerShell). Do this for each year folder; example for 2023.
$base = "C:\Users\HP\Documents\churchtimes\private"
$key  = "$HOME\.ssh\ct_pull"
$year = "2023"
cmd /c "ssh -i $key ctpull@SERVER_IP ""cd /home/DOMAIN/public_html/wp-content/uploads && tar -cf - --exclude='*.php*' --exclude='*.phtml' --exclude='*.phar' --exclude='*.pht' --exclude='*.sh' --exclude='*.js' --exclude='*.html' --exclude='*.htm' --exclude='*.svg' --exclude='*.exe' --exclude='*.zip' --exclude='*.tar' --exclude='*.gz' --exclude='.*' $year"" > ""$base\year-$year.tar"""
# extract into the raw folder (tar will refuse names that climb out of the folder). The patterns above are quoted so that the
# SERVER's shell does not expand them; they are a courtesy only, the check in step 4 is the real one.
tar -xf "$base\year-$year.tar" -C "$base\uploads-raw"
```

`ls /home/DOMAIN/public_html/wp-content/uploads` on the server shows which year folders exist (and any folders that are not years: pull those too, the same way, only if the export refers to them; the check in step 4 tells you). Delete each `.tar` after it extracted without errors. If `tar` prints errors about links, that is fine: links are not wanted.

### Route C: WinSCP (a normal Windows program, point-and-click)

1. Install WinSCP from winscp.net (the official site).
2. New session: File protocol **SFTP**, host name `SERVER_IP`, port 22, user name `ctpull`. Under **Advanced > SSH > Authentication** choose the private key. WinSCP converts it to its own format; accept that.
3. Left panel: your `uploads-raw` folder. Right panel: `/home/DOMAIN/public_html/wp-content/uploads`.
4. **Options > Preferences > Transfer > Edit** (the default transfer settings): turn on *Resume/transfer to temporary filename*, and in the **File mask** box type: `| *.php*; *.phtml; *.phar; *.pht; *.sh; *.js; *.html; *.htm; *.svg; *.exe; *.zip; *.tar; *.gz; .*`
5. Drag the year folders from right to left, one year at a time, so that a drop costs little.

### If the server's ssh is closed or you have no key

- Ask the hosting company (Truehost) for **SFTP access limited to the uploads folder**, or for the folder as a download link that they create outside the website folder. They already hold a full site copy.
- **Host file-manager zip** (the CyberPanel *File Manager > Compress*): only as a last resort. The zip is created inside the website folder, which means anyone can download it while it exists. Give it a random name, download it at once, delete it from the server at once. Do the zip of `wp-content/uploads` only. Extract it on your PC into a **new, empty** folder, never into the project.
- **A backup**: a full-site backup (CyberPanel backup, a WP Staging backup, or the copy held by Truehost) contains the uploads folder together with the hacked program files. On 15 October 2026 a 6.4 GB WP Staging backup was moved to `/root/churchtimes-private-backup-20261015/` on the server (readable by root only); it was meant to be a copy from before the break-in (16 October), but **that is not verified**: the break-in may be older than the backup, and the backup sits on the compromised server, so it could have been changed. Check its date and contents (file dates, size, what is inside) before trusting it, and treat it exactly like the live folder: the same checks in steps 3 to 5 apply. Download it with one of the routes above (move it where `ctpull` can read it rather than logging in as root), then extract **only** the `wp-content/uploads` part on your PC, into a **new, empty** folder next to `uploads-raw` first, with 7-Zip or, with GNU tar (Linux, macOS or WSL; the `tar` that comes with Windows is bsdtar and its options differ, so use 7-Zip there):

```bash
# ON YOUR PC (GNU tar: WSL/Linux). DEST must exist, be empty and be outside every Git folder.
tar -xzf backup.tar.gz -C DEST --wildcards '*wp-content/uploads/*'
```

then move the `wp-content/uploads` folder inside it to `uploads-raw`. The WP Staging `.wpstg` format may need that plugin to open: if so, ask me before trying anything else.

### If your internet is slow or limited

- **Resume instead of restart**: rsync `--partial` (route A), a year at a time (route B or C). Run it overnight; it is fine to stop and start.
- **Skip the thumbnails first.** WordPress keeps 5 to 10 small copies of every picture (names like `photo-300x200.jpg`). The importer only needs the original (`photo.jpg`); it looks for the original when the exact file is missing. Add `--exclude='*-[0-9]*x[0-9]*.*'` to the rsync command (or the same pattern to the WinSCP mask) and the download is probably a third or less of 4.7 GB. Then run step 4. If it reports pictures that are **missing** or that exist **only as size variants**, pull those years again without the exclusion. (A few real originals are named like `banner-1920x1080.jpg`; the check shows them as missing, and you pull them in a second round.)
- Compare counts after each year, so that you do not discover a problem at the end.

## Step 3. On your PC: did everything arrive unchanged?

```powershell
# ON YOUR PC (PowerShell)
$base = "C:\Users\HP\Documents\churchtimes\private"
$raw  = "$base\uploads-raw"
$files = Get-ChildItem -LiteralPath $raw -Recurse -File -Force
"files: " + $files.Count
"bytes: " + ($files | Measure-Object Length -Sum).Sum
"year folders: " + (Get-ChildItem -LiteralPath $raw -Directory | Where-Object Name -match '^\d{4}$' | Measure-Object).Count
```

These three numbers must equal the ones from step 1c. (If you skipped thumbnails, they will be lower; then compare with the server count of the same kind, or skip to the fingerprints, which tolerate that.)

Fetch the fingerprint list (it is small) and compare every file:

```powershell
# ON YOUR PC (PowerShell)
scp -i "$HOME\.ssh\ct_pull" ctpull@SERVER_IP:/home/ctpull/uploads.sha256 "$base\reports\uploads.sha256"

$ok = 0; $changed = 0; $missing = 0; $escaped = 0
Get-Content -LiteralPath "$base\reports\uploads.sha256" -Encoding UTF8 | ForEach-Object {
  if ($_.StartsWith('\')) { $script:escaped++; return }          # odd file names (newline or backslash): counted, not compared
  $hash = $_.Substring(0, 64)
  $rel  = $_.Substring(66); if ($rel.StartsWith('./')) { $rel = $rel.Substring(2) }
  # the list comes from the hacked server: never follow a path that climbs out of the raw folder or is absolute
  if ($rel -match '(^|/)\.\.(/|$)' -or $rel.Contains(':') -or $rel.StartsWith('/') -or $rel.Contains('\')) { $script:escaped++; return }
  $path = Join-Path $raw ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $path)) { $script:missing++ }
  elseif ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ieq $hash) { $script:ok++ }
  else { $script:changed++ }
}
"same: $ok   changed: $changed   not on this PC: $missing   odd names: $escaped"
```

This prints counts only. Good result: `changed: 0`. `not on this PC` must be 0 unless you skipped thumbnails or years on purpose. Any `changed` means a file was damaged or altered: pull that year again. (This can take several minutes.)

Linux/macOS/WSL version of the same check:

```bash
cd uploads-raw && sha256sum -c --quiet ../reports/uploads.sha256 | wc -l    # prints the number of problems; 0 is good
```

(If you skipped thumbnails: `sha256sum -c --ignore-missing --quiet`.)

## Step 4. On your PC: scan, then the CMS check

### 4a. Virus scan (Windows Defender)

```powershell
# ON YOUR PC (PowerShell, as Administrator for the scan; update the definitions first)
Update-MpSignature
Start-MpScan -ScanType CustomScan -ScanPath "C:\Users\HP\Documents\churchtimes\private\uploads-raw"
(Get-MpThreatDetection | Measure-Object).Count
```

0 is the good answer. If Defender quarantines something, that is Defender doing its job: do not restore it. Optional second opinion with ClamAV (WSL or Linux): `sudo apt-get install -y clamav && sudo freshclam && clamscan -r -i uploads-raw` (prints only infected files; `Infected files: 0` is good).

Keep Windows' preview pane off in Explorer for these folders and do not open any file in it.

### 4b. The CMS safety check and reconciliation with the export

```powershell
# ON YOUR PC (PowerShell), in the project's apps\cms folder
cd C:\Users\HP\Documents\churchtimes\churchtimes\apps\cms
npm run import:uploads-check -- --uploads C:\Users\HP\Documents\churchtimes\private\uploads-raw --wxr C:\Users\HP\Documents\churchtimes\private\export.xml --out C:\Users\HP\Documents\churchtimes\private\reports\uploads-detail.jsonl
```

(`export.xml` is the WordPress export file, kept outside the project too.) It prints **only counts**: how many files, how many were refused and why, how many of the export's pictures are present, missing, only available as size variants, or differently named (capital letters or accented letters written another way), how many look like duplicates. Nothing is changed or opened as a program; the detail with real names goes to the `--out` file. What the numbers mean is in `docs/import.md`, section "Checking the uploads folder".

Only JPEG, PNG and WebP pictures (`.jpg`, `.jpeg`, `.png`, `.webp`, up to 10 MB each) and the audio/video types of the article block (`.mp4`, `.m4v`, `.webm`, `.mp3`, `.m4a`, `.ogg`, `.oga`) are importable. Everything else is counted under its own reason and removed in step 5: `unsupported-type` (a gif, bmp, ico, avif or pdf: real files, but the CMS does not take them), `too-large` (over 10 MB for a picture), `not-media` (any other extension, or none), `dangerous-extension`, `hard-link`, and so on. A script marker (`<?php`, `<script`) *inside a picture* is only reported as a **warning count**: random picture data can contain such bytes, and the CMS re-saves the picture, which removes anything hidden in it. The `--out` file must be a **new** file (the command refuses an existing file, the export itself, or a place inside the uploads folder, so it can never overwrite your export); delete an old detail file first if you run it again.

The exact exit result: `0` clean, `3` some unsafe files were found (the loader refuses them anyway), `2` a folder is in the wrong place (inside Git), `1` failed.

### What to count and write down (send me only these numbers)

- files on the server / files copied; total bytes on both; number of year folders on both
- fingerprints: same / changed / not on this PC
- number of excluded (dangerous-type) files on the server, and links on the server
- Defender detections (0 expected)
- from the CMS check: files, rejected by reason, attachments present / missing / only size variants, body images present / missing, featured images present / missing, duplicate groups, unreferenced files

## Step 5. Make the verified copy

Only when step 3 shows `changed: 0`, Defender found nothing, and you have read the step 4b numbers.

1. If step 4b reported rejected files, remove exactly those from `uploads-raw` (this does not print names). **Careful with links:** in Windows PowerShell 5.1, `Remove-Item` on a folder link (a junction or symbolic link) can delete the contents of the folder the link points to. So files are removed with .NET, links and junctions are removed as links only (never followed), and you **preview first** with `-WhatIf` (nothing is deleted while `$WhatIf = $true`):

```powershell
# ON YOUR PC (PowerShell). First run: preview only. It prints one line per removal; look at the count, not at the names.
$WhatIf = $true            # change to $false only after the preview count matches the rejected count of step 4b
$base = "C:\Users\HP\Documents\churchtimes\private"; $raw = "$base\uploads-raw"
$rawFull = [IO.Path]::GetFullPath($raw).TrimEnd('\') + '\'
$n = 0
Get-Content -LiteralPath "$base\reports\uploads-detail.jsonl" -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.kind -eq 'file' -and $_.status -ne 'safe' } |
  ForEach-Object {
    $rel = $_.path
    if ($rel -match '(^|/)\.\.(/|$)' -or $rel.Contains(':') -or $rel.StartsWith('/')) { return }   # never touch a path outside the raw folder
    $full = [IO.Path]::GetFullPath((Join-Path $raw ($rel -replace '/', '\')))
    if (-not $full.StartsWith($rawFull, [StringComparison]::OrdinalIgnoreCase)) { return }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    $n++
    if ($WhatIf) { return }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      # a link or junction (status symlink / not-a-file): remove the LINK ITSELF, never what it points to
      if ($item.PSIsContainer) { [IO.Directory]::Delete($full) } else { [IO.File]::Delete($full) }
    } elseif ($item.PSIsContainer) {
      cmd /c rmdir "$full"      # only removes an EMPTY folder; a non-empty one stays and is reported by the next check
    } else {
      [IO.File]::Delete($full)
    }
  }
"entries " + $(if ($WhatIf) { "that would be removed: " } else { "removed: " }) + $n
```

   Run it once with `$WhatIf = $true`, compare the count with the number of rejected files in the step 4b report, then set `$WhatIf = $false` and run it again. (Use `[IO.Directory]::Delete` or `cmd /c rmdir` on a link, never `Remove-Item -Recurse`.)

2. Run step 4b again. It must now exit with `0` and show `rejected as unsafe: (none)`.
3. Copy to the verified folder (no junctions, no permissions, data only):

```powershell
robocopy "$base\uploads-raw" "$base\uploads-verified" /E /COPY:D /XJ /R:1 /W:1 /NFL /NDL /NP
```

4. Run step 4b on `uploads-verified` too (same command with that folder; exit `0`), then write its own fingerprint list and make the folder read-only:

```powershell
Get-ChildItem -LiteralPath "$base\uploads-verified" -Recurse -File | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower() + "  " + $_.FullName.Substring("$base\uploads-verified\".Length).Replace('\','/') } | Set-Content -Encoding UTF8 "$base\reports\uploads-verified.sha256"
attrib +R "$base\uploads-verified\*" /S
```

5. Keep `uploads-raw` until the import is finished, then delete it (or keep it on an offline disk).

Use `uploads-verified` for the importer, for example:

```powershell
npm run import:rehearse -- --file C:\Users\HP\Documents\churchtimes\private\export.xml --uploads C:\Users\HP\Documents\churchtimes\private\uploads-verified --uploads-detail-file C:\Users\HP\Documents\churchtimes\private\reports\uploads-detail-2.jsonl --detail-file C:\Users\HP\Documents\churchtimes\private\reports\rehearse-detail.json
```

That runs the whole rehearsal (real export plus real pictures, on a throwaway database, nothing real stored): it prints the uploads check first and then the import counts, including pictures resolved, rejected and missing, and featured pictures resolved and rejected. The importer repeats the safety checks on every file by itself, so even a mistake in the steps above cannot put a script into the CMS. A separate general-purpose "uploads pack" verifier may be added to the project's `tools` folder; this guide and the CMS checks work without it.

## Step 6. Remove the temporary account

```bash
# ON THE SERVER (root@...)
setfacl -R -x u:ctpull /home/DOMAIN/public_html/wp-content/uploads
setfacl -x u:ctpull /home/DOMAIN /home/DOMAIN/public_html /home/DOMAIN/public_html/wp-content
userdel -r ctpull
```

Also delete the key on your PC if you will not need it again: `Remove-Item "$HOME\.ssh\ct_pull", "$HOME\.ssh\ct_pull.pub"`.

## Something looks wrong?

- **A command asked for a password you do not know**: stop. Do not guess. Ask.
- **`Permission denied`** on the server step: the `setfacl` lines were not run, or `DOMAIN` is wrong.
- **Defender or ClamAV found something**: do not open it, do not restore it. Tell me the number only; the file names stay on your PC.
- **Counts differ by a few files**: write down the numbers and pull that year again; do not go on.
- **Plan B for the whole job**: the rebuilt server and the new CMS do not need the old server's uploads at all if the pictures come from the verified folder. Never copy files from the old server straight onto the new one.
