#!/bin/sh
# Restore a backup made by backup.sh into a NEW, empty database (never over production by default).
#
# Usage: restore.sh --backup DIR [--target-db NAME] [--pg-exec 'CMD PREFIX'] [--media-target DIR]
#        [--skip-media] [--overwrite-db] [--overwrite-media] [--role ROLE] [--verify-sig gpg|minisign]
#        [--tmpdir DIR]
#
# Checksums (every artifact must be listed in SHA256SUMS, nothing unlisted is accepted), an optional
# signature, and the media manifest are verified before anything is touched. By default the target
# database is "churchtimes_restore_<UTC timestamp>" and is created fresh. An existing database that
# holds any tables is refused unless --overwrite-db is given (then objects are dropped first, in one
# transaction). Media is only extracted when --media-target is given; a non-empty target needs
# --overwrite-media. --skip-media restores the database only and ignores the media archive.
# --role ROLE runs the restore as that role so the restored objects are owned by it (dumps carry no owners).
# Connection: libpq variables, or --pg-exec / PG_EXEC. Encrypted backups: AGE_IDENTITY_FILE (age) or
# your gpg keyring. Needs CREATEDB (not superuser) unless the target database already exists.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=backup-lib.sh
. "$SCRIPT_DIR/backup-lib.sh"

BACKUP=""
TARGET=""
MEDIA_TARGET=""
OVERWRITE_DB=0
OVERWRITE_MEDIA=0
SKIP_MEDIA=""
ROLE=""
SIG=""
TMPBASE="${BACKUP_TMPDIR:-${TMPDIR:-/tmp}}"
TABLES="${BACKUP_COUNT_TABLES:-$COUNT_TABLES_DEFAULT}"

while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP="${2:?--backup needs a value}"; shift 2 ;;
    --target-db) TARGET="${2:?--target-db needs a value}"; shift 2 ;;
    --pg-exec) PG_EXEC="${2:?--pg-exec needs a value}"; shift 2 ;;
    --media-target) MEDIA_TARGET="${2:?--media-target needs a value}"; shift 2 ;;
    --skip-media) SKIP_MEDIA=skip-media; shift ;;
    --overwrite-db) OVERWRITE_DB=1; shift ;;
    --overwrite-media) OVERWRITE_MEDIA=1; shift ;;
    --role) ROLE="${2:?--role needs a value}"; shift 2 ;;
    --verify-sig) SIG="${2:?--verify-sig needs a value}"; shift 2 ;;
    --tmpdir) TMPBASE="${2:?--tmpdir needs a value}"; shift 2 ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$BACKUP" ] || die "--backup DIR is required"
[ -n "$TARGET" ] || TARGET="churchtimes_restore_$(date -u +%Y%m%dT%H%M%SZ)"
valid_dbname "$TARGET"
valid_tables "$TABLES"
[ -z "$ROLE" ] || valid_dbname "$ROLE"
[ -z "$SKIP_MEDIA" ] || [ -z "$MEDIA_TARGET" ] || die "--skip-media and --media-target contradict each other"
[ -d "$TMPBASE" ] || die "temp directory not found: $TMPBASE"
need_pg
need_gnu_tar

# Private scratch space (0700 via mktemp), removed on every exit path.
WORK=$(mktemp -d "$TMPBASE/ct-restore-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
trap 'exit 1' INT TERM

prepare_backup "$BACKUP" "$WORK" "$SKIP_MEDIA" "$SIG"

if [ -n "$MEDIA_TARGET" ]; then
  [ ! -L "$MEDIA_TARGET" ] || die "media target $MEDIA_TARGET is a symlink; refusing"
  if [ -d "$MEDIA_TARGET" ]; then
    if [ -n "$(ls -A "$MEDIA_TARGET")" ] && [ "$OVERWRITE_MEDIA" != 1 ]; then
      die "media target $MEDIA_TARGET is not empty; refusing. Use an empty directory, or --overwrite-media"
    fi
    [ -z "$(find "$MEDIA_TARGET" -type l)" ] || die "media target $MEDIA_TARGET contains symlinks; refusing to extract into it"
  fi
fi

# Decide about the target before restoring anything.
CLEAN=""
if db_exists "$TARGET"; then
  N=$(db_table_count "$TARGET")
  if [ "$N" != 0 ]; then
    [ "$OVERWRITE_DB" = 1 ] || die "database $TARGET already exists and holds $N tables; refusing. Use a new name, or --overwrite-db if you really mean it"
    log "WARNING: --overwrite-db given; existing objects in $TARGET will be dropped (single transaction)"
    CLEAN="--clean --if-exists --single-transaction"
  fi
else
  log "creating database $TARGET"
  create_db "$TARGET"
fi

log "restoring database into $TARGET"
set -- --no-owner --no-privileges --exit-on-error
[ -z "$ROLE" ] || set -- "$@" --role "$ROLE"
# shellcheck disable=SC2086 # CLEAN is a fixed set of flags or empty
pgrun pg_restore "$@" $CLEAN -d "$TARGET" <"$DUMP_FILE" ||
  die "pg_restore failed (target $TARGET may be incomplete; drop it and retry)"

if [ -n "$MEDIA_TARGET" ]; then
  mkdir -p "$MEDIA_TARGET"
  tar -xzf "$MEDIA_TAR" -C "$MEDIA_TARGET" --exclude ./.manifest.sha256 || die "media extraction failed"
  find "$MEDIA_TARGET" -type d -exec chmod 750 {} +
  find "$MEDIA_TARGET" -type f -exec chmod 640 {} +
  log "media restored to $MEDIA_TARGET (set ownership to the app user, see operations.md)"
fi

log "post-restore sanity counts in $TARGET"
compare_counts "$TARGET" "$COUNTS_FILE" || die "restored counts do not match the backup"
log "restore OK: database $TARGET"
printf '%s\n' "$TARGET"
