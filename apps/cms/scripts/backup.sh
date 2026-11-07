#!/bin/sh
# Back up the Church Times CMS: PostgreSQL (pg_dump custom format) plus the media folder.
#
# Usage: backup.sh --out DIR [--media DIR] [--db NAME] [--pg-exec 'CMD PREFIX'] [--keep-days N]
#        [--keep-min N] [--encrypt none|auto|age|gpg] [--allow-plaintext] [--sign gpg|minisign]
#        [--allow-empty-media] [--tmpdir DIR]
#
# Connection: libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD or ~/.pgpass), or container mode with
# --pg-exec / PG_EXEC (see backup-lib.sh and operations.md). Never pass a password as an argument.
# --db defaults to $PGDATABASE, else "churchtimes". --media defaults to $CMS_MEDIA_DIR, else /srv/churchtimes/media.
# Output: DIR/churchtimes-<UTC timestamp>/ (0700) holding db.dump, media.tar.gz, media.manifest.sha256,
# counts.txt and SHA256SUMS (all 0600), each possibly with .age/.gpg. It is built as DIR/.partial-* and
# renamed into place only when complete. Plaintext scratch files live in a private temp dir OUTSIDE DIR.
# Encryption (age: AGE_RECIPIENT, gpg: GPG_RECIPIENT) uses PUBLIC keys only; this script never stores
# or generates keys. --encrypt auto fails unless --allow-plaintext, when neither is configured.
# --sign signs SHA256SUMS (gpg: GPG_SIGN_KEY, minisign: MINISIGN_SECRET_KEY file).
# --keep-days prunes older backups but always keeps the newest --keep-min (default 3).
# DIR must be outside the git checkout. Exit status is non-zero on any failure; partial output is removed.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=backup-lib.sh
. "$SCRIPT_DIR/backup-lib.sh"

OUT="${BACKUP_DIR:-}"
MEDIA="${CMS_MEDIA_DIR:-/srv/churchtimes/media}"
DB="${PGDATABASE:-churchtimes}"
KEEP_DAYS=""
KEEP_MIN=3
ENC="none"
ALLOW_PLAINTEXT=0
ALLOW_EMPTY=0
SIGN=""
TMPBASE="${BACKUP_TMPDIR:-${TMPDIR:-/tmp}}"
TABLES="${BACKUP_COUNT_TABLES:-$COUNT_TABLES_DEFAULT}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --media) MEDIA="${2:?--media needs a value}"; shift 2 ;;
    --db) DB="${2:?--db needs a value}"; shift 2 ;;
    --pg-exec) PG_EXEC="${2:?--pg-exec needs a value}"; shift 2 ;;
    --keep-days) KEEP_DAYS="${2:?--keep-days needs a value}"; shift 2 ;;
    --keep-min) KEEP_MIN="${2:?--keep-min needs a value}"; shift 2 ;;
    --encrypt) ENC="${2:?--encrypt needs a value}"; shift 2 ;;
    --allow-plaintext) ALLOW_PLAINTEXT=1; shift ;;
    --allow-empty-media) ALLOW_EMPTY=1; shift ;;
    --sign) SIGN="${2:?--sign needs a value}"; shift 2 ;;
    --tmpdir) TMPBASE="${2:?--tmpdir needs a value}"; shift 2 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$OUT" ] || die "--out DIR (or BACKUP_DIR) is required"
valid_dbname "$DB"
valid_tables "$TABLES"
case "$KEEP_DAYS" in
  '') ;;
  *[!0-9]*) die "--keep-days must be a whole number" ;;
  0) die "--keep-days 0 would delete every backup" ;;
esac
case "$KEEP_MIN" in '' | *[!0-9]*) die "--keep-min must be a whole number" ;; esac
case "$ENC" in none | auto | age | gpg) ;; *) die "--encrypt must be none, auto, age or gpg" ;; esac
case "$SIGN" in '' | gpg | minisign) ;; *) die "--sign must be gpg or minisign" ;; esac
[ -d "$MEDIA" ] || die "media directory not found: $MEDIA"
[ -d "$TMPBASE" ] || die "temp directory not found: $TMPBASE"
need_pg
need_gnu_tar
need find xargs sha256sum

# Choose the encryption mode up front so a misconfiguration fails before any work is done.
if [ "$ENC" = auto ]; then
  if command -v age >/dev/null 2>&1 && [ -n "${AGE_RECIPIENT:-}" ]; then
    ENC=age
  elif command -v gpg >/dev/null 2>&1 && [ -n "${GPG_RECIPIENT:-}" ]; then
    ENC=gpg
  elif [ "$ALLOW_PLAINTEXT" = 1 ]; then
    ENC=none
    log "WARNING: no encryption available (need age+AGE_RECIPIENT or gpg+GPG_RECIPIENT); backup will be unencrypted"
  else
    die "--encrypt auto found no usable encryption (age+AGE_RECIPIENT or gpg+GPG_RECIPIENT); configure one, or pass --allow-plaintext"
  fi
fi
case "$ENC" in
  age)
    need age
    [ -n "${AGE_RECIPIENT:-}" ] || die "AGE_RECIPIENT (public key) is required for --encrypt age"
    ;;
  gpg)
    need gpg
    [ -n "${GPG_RECIPIENT:-}" ] || die "GPG_RECIPIENT is required for --encrypt gpg"
    ;;
esac
case "$SIGN" in
  gpg) need gpg; [ -n "${GPG_SIGN_KEY:-}" ] || die "GPG_SIGN_KEY is required for --sign gpg" ;;
  minisign) need minisign; [ -f "${MINISIGN_SECRET_KEY:-}" ] || die "MINISIGN_SECRET_KEY (key file) is required for --sign minisign" ;;
esac

CREATED_OUT=0
if [ ! -d "$OUT" ]; then
  mkdir -p "$OUT"
  CREATED_OUT=1
fi
OUT=$(cd "$OUT" && pwd)
MEDIA=$(cd "$MEDIA" && pwd)
if TOP=$(git -C "$OUT" rev-parse --show-toplevel 2>/dev/null); then
  [ "$CREATED_OUT" != 1 ] || rmdir "$OUT" 2>/dev/null || true
  die "backup directory $OUT is inside the git checkout $TOP; choose a path outside the repository"
fi
# Only tighten permissions on a directory this script created; refuse one owned by someone else.
if [ "$CREATED_OUT" = 1 ]; then
  chmod 700 "$OUT"
else
  [ -O "$OUT" ] || die "backup directory $OUT is not owned by the current user; refusing"
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="$OUT/churchtimes-$STAMP"
PARTIAL="$OUT/.partial-$STAMP-$$"
[ ! -e "$DEST" ] || die "$DEST already exists"
OK=0
TMP=""
cleanup() {
  [ -z "$TMP" ] || rm -rf "$TMP"
  if [ "$OK" != 1 ]; then
    rm -rf "$PARTIAL"
    log "backup FAILED; partial output removed"
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Remove debris from crashed runs (never synced off-site: rsync examples exclude these names).
find "$OUT" -maxdepth 1 -name '.partial-*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
find "$OUT" -maxdepth 1 -name '.tmp-*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true

mkdir "$PARTIAL"
TMP=$(mktemp -d "$TMPBASE/ct-backup-XXXXXX")
case "$TMP" in "$OUT"/*) die "temp directory must be outside the backup directory" ;; esac

# Row counts before and after the dump bracket whatever a live database did meanwhile.
log "counting rows in $DB"
count_rows "$DB" "$TABLES" >"$TMP/counts.before" || die "cannot read the database $DB"

log "dumping database $DB"
pgrun pg_dump -Fc --no-owner --no-privileges -d "$DB" >"$TMP/db.dump" || die "pg_dump failed"
[ -s "$TMP/db.dump" ] || die "pg_dump produced an empty file"
pgrun pg_restore --list <"$TMP/db.dump" >/dev/null || die "the dump is not readable by pg_restore"
count_rows "$DB" "$TABLES" >"$TMP/counts.after" || die "cannot read the database $DB"
{
  echo "# table count_before count_after"
  paste -d ' ' "$TMP/counts.before" "$TMP/counts.after" | awk '{ print $1, $2, $4 }'
} >"$TMP/counts.txt"

log "scanning media in $MEDIA"
# Each step checks find's own status: a pipe into sort would hide an unreadable directory.
(cd "$MEDIA" && find . -type l) >"$TMP/media.links" || die "cannot scan the media folder (unreadable directory?)"
[ ! -s "$TMP/media.links" ] || die "the media folder contains symlinks (first: $(head -n 1 "$TMP/media.links")); refusing, they would be silently skipped or followed"
(cd "$MEDIA" && find . ! -type f ! -type d) >"$TMP/media.special" || die "cannot scan the media folder"
[ ! -s "$TMP/media.special" ] || die "the media folder contains special files (first: $(head -n 1 "$TMP/media.special"))"
(cd "$MEDIA" && find . -name .manifest.sha256) >"$TMP/media.clash" || die "cannot scan the media folder"
[ ! -s "$TMP/media.clash" ] || die "the media folder contains a file named .manifest.sha256, which the archive reserves"
(cd "$MEDIA" && find . -type f -print0) >"$TMP/media.list0" || die "cannot list the media folder"
FILES=$(tr -cd '\0' <"$TMP/media.list0" | wc -c | tr -d ' ')
if [ "$FILES" = 0 ] && [ "$ALLOW_EMPTY" != 1 ]; then
  die "the media folder $MEDIA holds no files (wrong path or unmounted volume?); pass --allow-empty-media if that is expected"
fi

log "archiving $FILES media files"
STAGE="$TMP/media-stage"
mkdir "$STAGE"
(cd "$MEDIA" && xargs -0 -r sha256sum <"$TMP/media.list0") >"$STAGE/.manifest.sha256" || die "hashing the media files failed (unreadable file?)"
[ "$(wc -l <"$STAGE/.manifest.sha256" | tr -d ' ')" = "$FILES" ] || die "media manifest does not list every file"
# Archive exactly the listed files plus the manifest, so a file added mid-run cannot desync them.
tar -czf "$TMP/media.tar.gz" --null --no-unquote --verbatim-files-from -C "$MEDIA" -T "$TMP/media.list0" \
  -C "$STAGE" ./.manifest.sha256 || die "tar of the media folder failed"
check_media_archive "$TMP/media.tar.gz" "$TMP/mediachk"
cp "$STAGE/.manifest.sha256" "$TMP/media.manifest.sha256"
rm -rf "$STAGE"

for f in db.dump media.tar.gz media.manifest.sha256 counts.txt; do
  case "$ENC" in
    age) age -r "$AGE_RECIPIENT" -o "$PARTIAL/$f.age" "$TMP/$f" || die "age encryption failed" ;;
    gpg) gpg --batch --yes --quiet --trust-model always -e -r "$GPG_RECIPIENT" -o "$PARTIAL/$f.gpg" "$TMP/$f" || die "gpg encryption failed" ;;
    *) cp "$TMP/$f" "$PARTIAL/$f" ;;
  esac
done
chmod 600 "$PARTIAL"/*

# SHA256SUMS covers the stored (possibly encrypted) artifacts.
: >"$PARTIAL/SHA256SUMS"
for f in "$PARTIAL"/*; do
  b=$(basename "$f")
  [ "$b" = SHA256SUMS ] && continue
  printf '%s  %s\n' "$(sha256_of "$f")" "$b" >>"$PARTIAL/SHA256SUMS"
done
sha256_check "$PARTIAL" SHA256SUMS || die "post-write checksum verification failed"
case "$SIGN" in
  gpg) gpg --batch --yes --quiet --detach-sign -u "$GPG_SIGN_KEY" -o "$PARTIAL/SHA256SUMS.sig" "$PARTIAL/SHA256SUMS" || die "gpg signing failed" ;;
  minisign) minisign -S -q -s "$MINISIGN_SECRET_KEY" -m "$PARTIAL/SHA256SUMS" -x "$PARTIAL/SHA256SUMS.minisig" || die "minisign signing failed" ;;
esac
chmod 600 "$PARTIAL"/*
chmod 700 "$PARTIAL"
mv "$PARTIAL" "$DEST" || die "could not move the finished backup into place"
OK=1
log "backup complete: $DEST (encryption: $ENC, media files: $FILES)"
printf '%s\n' "$DEST"

if [ -n "$KEEP_DAYS" ]; then
  log "pruning backups older than $KEEP_DAYS days in $OUT (always keeping the newest $KEEP_MIN)"
  ls -1d "$OUT"/churchtimes-[0-9]*T[0-9]*Z 2>/dev/null | sort -r >"$TMP/prune.list" || true
  RANK=0
  while IFS= read -r d; do
    [ -d "$d" ] || continue
    RANK=$((RANK + 1))
    [ "$RANK" -gt "$KEEP_MIN" ] || continue
    if [ -n "$(find "$d" -maxdepth 0 -mtime "+$KEEP_DAYS")" ]; then
      rm -rf "$d" || die "pruning $d failed (the new backup itself is intact)"
    fi
  done <"$TMP/prune.list"
fi
