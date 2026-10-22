#!/bin/sh
# Back up the Church Times CMS: PostgreSQL (pg_dump custom format) plus the media folder.
#
# Usage: backup.sh --out DIR [--media DIR] [--db NAME] [--keep-days N] [--encrypt none|auto|age|gpg]
#
# Connection: libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD or ~/.pgpass). Never pass a password
# as an argument. --db defaults to $PGDATABASE, else "churchtimes".
# Output: DIR/churchtimes-<UTC timestamp>/ (0700) holding db.dump, media.tar.gz, media.manifest.sha256,
# counts.txt and SHA256SUMS (all 0600). Encryption (age: AGE_RECIPIENT, gpg: GPG_RECIPIENT) uses
# PUBLIC keys only; this script never stores or generates keys. DIR must be outside the git checkout.
# Exit status is non-zero on any failure, and a partial backup directory is removed.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=backup-lib.sh
. "$SCRIPT_DIR/backup-lib.sh"

OUT="${BACKUP_DIR:-}"
MEDIA="${CMS_MEDIA_DIR:-$SCRIPT_DIR/../media}"
DB="${PGDATABASE:-churchtimes}"
KEEP_DAYS=""
ENC="none"
TABLES="${BACKUP_COUNT_TABLES:-$COUNT_TABLES_DEFAULT}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --media) MEDIA="${2:?--media needs a value}"; shift 2 ;;
    --db) DB="${2:?--db needs a value}"; shift 2 ;;
    --keep-days) KEEP_DAYS="${2:?--keep-days needs a value}"; shift 2 ;;
    --encrypt) ENC="${2:?--encrypt needs a value}"; shift 2 ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
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
case "$ENC" in none | auto | age | gpg) ;; *) die "--encrypt must be none, auto, age or gpg" ;; esac
[ -d "$MEDIA" ] || die "media directory not found: $MEDIA"
need pg_dump pg_restore psql tar find

# Choose the encryption mode up front so a misconfiguration fails before any work is done.
if [ "$ENC" = auto ]; then
  if command -v age >/dev/null 2>&1 && [ -n "${AGE_RECIPIENT:-}" ]; then
    ENC=age
  elif command -v gpg >/dev/null 2>&1 && [ -n "${GPG_RECIPIENT:-}" ]; then
    ENC=gpg
  else
    ENC=none
    log "WARNING: no encryption available (need age+AGE_RECIPIENT or gpg+GPG_RECIPIENT); backup will be unencrypted"
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

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
MEDIA=$(cd "$MEDIA" && pwd)
if TOP=$(git -C "$OUT" rev-parse --show-toplevel 2>/dev/null); then
  die "backup directory $OUT is inside the git checkout $TOP; choose a path outside the repository"
fi
chmod 700 "$OUT"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="$OUT/churchtimes-$STAMP"
[ ! -e "$DEST" ] || die "$DEST already exists"
mkdir "$DEST"
OK=0
TMP=""
cleanup() {
  [ -z "$TMP" ] || rm -rf "$TMP"
  if [ "$OK" != 1 ]; then
    rm -rf "$DEST"
    log "backup FAILED; partial output removed"
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM
TMP=$(mktemp -d "$OUT/.tmp-XXXXXX")

# Row counts before and after the dump bracket whatever a live database did meanwhile.
log "counting rows in $DB"
count_rows "$DB" "$TABLES" >"$TMP/counts.before" || die "cannot read the database $DB"

log "dumping database $DB"
pg_dump -Fc --no-owner --no-privileges -d "$DB" -f "$TMP/db.dump" || die "pg_dump failed"
pg_restore --list "$TMP/db.dump" >/dev/null || die "the dump is not readable by pg_restore"
count_rows "$DB" "$TABLES" >"$TMP/counts.after" || die "cannot read the database $DB"
{
  echo "# table count_before count_after"
  paste -d ' ' "$TMP/counts.before" "$TMP/counts.after" | awk '{ print $1, $2, $4 }'
} >"$TMP/counts.txt"

log "archiving media from $MEDIA"
(cd "$MEDIA" && find . -type f ! -name '.manifest.sha256' | LC_ALL=C sort) >"$TMP/media.list"
STAGE="$TMP/media-stage"
mkdir "$STAGE"
: >"$STAGE/.manifest.sha256"
while IFS= read -r f; do
  f=${f#./}
  printf '%s  %s\n' "$(sha256_of "$MEDIA/$f")" "$f" >>"$STAGE/.manifest.sha256"
done <"$TMP/media.list"
# Archive exactly the listed files plus the manifest, so a file added mid-run cannot desync them.
tar -czf "$TMP/media.tar.gz" -C "$MEDIA" -T "$TMP/media.list" -C "$STAGE" ./.manifest.sha256 ||
  die "tar of the media folder failed"
cp "$STAGE/.manifest.sha256" "$TMP/media.manifest.sha256"
FILES=$(wc -l <"$TMP/media.list" | tr -d ' ')
rm -rf "$STAGE"

for f in db.dump media.tar.gz media.manifest.sha256 counts.txt; do
  case "$ENC" in
    age) age -r "$AGE_RECIPIENT" -o "$DEST/$f.age" "$TMP/$f" || die "age encryption failed" ;;
    gpg) gpg --batch --yes --quiet --trust-model always -e -r "$GPG_RECIPIENT" -o "$DEST/$f.gpg" "$TMP/$f" || die "gpg encryption failed" ;;
    *) cp "$TMP/$f" "$DEST/$f" ;;
  esac
done
chmod 600 "$DEST"/*

# SHA256SUMS covers the stored (possibly encrypted) artifacts.
: >"$DEST/SHA256SUMS"
for f in "$DEST"/*; do
  b=$(basename "$f")
  [ "$b" = SHA256SUMS ] && continue
  printf '%s  %s\n' "$(sha256_of "$f")" "$b" >>"$DEST/SHA256SUMS"
done
chmod 700 "$DEST"
sha256_check "$DEST" SHA256SUMS || die "post-write checksum verification failed"
OK=1
log "backup complete: $DEST (encryption: $ENC, media files: $FILES)"
printf '%s\n' "$DEST"

if [ -n "$KEEP_DAYS" ]; then
  log "pruning backups older than $KEEP_DAYS days in $OUT"
  find "$OUT" -maxdepth 1 -type d -name 'churchtimes-[0-9]*T[0-9]*Z' -mtime "+$KEEP_DAYS" \
    -exec rm -rf {} + || die "pruning failed (the new backup itself is intact)"
fi
