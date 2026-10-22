#!/bin/sh
# Restore a backup made by backup.sh into a NEW, empty database (never over production by default).
#
# Usage: restore.sh --backup DIR [--target-db NAME] [--media-target DIR] [--overwrite-db]
#                   [--overwrite-media]
#
# Checksums and the media manifest are verified before anything is touched. By default the target
# database is "churchtimes_restore_<UTC timestamp>" and is created fresh. An existing database that
# holds any tables is refused unless --overwrite-db is given (then objects are dropped first).
# Media is only extracted when --media-target is given; a non-empty target needs --overwrite-media.
# Connection: libpq variables. Encrypted backups: AGE_IDENTITY_FILE (age) or your gpg keyring.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=backup-lib.sh
. "$SCRIPT_DIR/backup-lib.sh"

BACKUP=""
TARGET=""
MEDIA_TARGET=""
OVERWRITE_DB=0
OVERWRITE_MEDIA=0
TABLES="${BACKUP_COUNT_TABLES:-$COUNT_TABLES_DEFAULT}"

while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP="${2:?--backup needs a value}"; shift 2 ;;
    --target-db) TARGET="${2:?--target-db needs a value}"; shift 2 ;;
    --media-target) MEDIA_TARGET="${2:?--media-target needs a value}"; shift 2 ;;
    --overwrite-db) OVERWRITE_DB=1; shift ;;
    --overwrite-media) OVERWRITE_MEDIA=1; shift ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$BACKUP" ] || die "--backup DIR is required"
[ -n "$TARGET" ] || TARGET="churchtimes_restore_$(date -u +%Y%m%dT%H%M%SZ)"
valid_dbname "$TARGET"
valid_tables "$TABLES"
need pg_restore psql tar

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
trap 'exit 1' INT TERM

prepare_backup "$BACKUP" "$WORK"

if [ -n "$MEDIA_TARGET" ]; then
  if [ -d "$MEDIA_TARGET" ] && [ -n "$(ls -A "$MEDIA_TARGET")" ] && [ "$OVERWRITE_MEDIA" != 1 ]; then
    die "media target $MEDIA_TARGET is not empty; refusing. Use an empty directory, or --overwrite-media"
  fi
  [ -n "$MEDIA_TAR" ] || die "this backup contains no media archive"
fi

# Decide about the target before restoring anything.
CLEAN=""
if db_exists "$TARGET"; then
  N=$(db_table_count "$TARGET")
  if [ "$N" != 0 ]; then
    [ "$OVERWRITE_DB" = 1 ] || die "database $TARGET already exists and holds $N tables; refusing. Use a new name, or --overwrite-db if you really mean it"
    log "WARNING: --overwrite-db given; existing objects in $TARGET will be dropped"
    CLEAN="--clean --if-exists"
  fi
else
  log "creating database $TARGET"
  create_db "$TARGET"
fi

log "restoring database into $TARGET"
# shellcheck disable=SC2086 # CLEAN is a fixed pair of flags or empty
pg_restore --no-owner --no-privileges --exit-on-error $CLEAN -d "$TARGET" "$DUMP_FILE" ||
  die "pg_restore failed (target $TARGET is incomplete; drop it and retry)"

if [ -n "$MEDIA_TARGET" ]; then
  mkdir -p "$MEDIA_TARGET"
  tar -xzf "$MEDIA_TAR" -C "$MEDIA_TARGET" --exclude ./.manifest.sha256 || die "media extraction failed"
  find "$MEDIA_TARGET" -type d -exec chmod 750 {} +
  find "$MEDIA_TARGET" -type f -exec chmod 640 {} +
  log "media restored to $MEDIA_TARGET (set ownership to the app user, see operations.md)"
fi

log "post-restore sanity counts in $TARGET"
if [ -n "$COUNTS_FILE" ]; then
  compare_counts "$TARGET" "$COUNTS_FILE" || die "restored counts do not match the backup"
else
  count_rows "$TARGET" "$TABLES" | sed 's/^/  /' >&2
fi
log "restore OK: database $TARGET"
printf '%s\n' "$TARGET"
