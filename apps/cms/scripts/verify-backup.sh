#!/bin/sh
# Prove a backup is restorable: verify checksums, restore into a throwaway database, compare row
# counts and the media manifest, then drop the throwaway database.
#
# Usage: verify-backup.sh --backup DIR [--keep-db]
# Connection: libpq variables. Encrypted backups: AGE_IDENTITY_FILE (age) or your gpg keyring.
# Exit status 0 only when everything matches.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=backup-lib.sh
. "$SCRIPT_DIR/backup-lib.sh"

BACKUP=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP="${2:?--backup needs a value}"; shift 2 ;;
    --keep-db) KEEP=1; shift ;;
    -h | --help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$BACKUP" ] || die "--backup DIR is required"
need pg_restore psql tar

THROW="churchtimes_verify_$(date -u +%Y%m%dT%H%M%SZ)_$$"
MEDIA_DIR=$(mktemp -d)
CREATED=0
cleanup() {
  rm -rf "$MEDIA_DIR"
  if [ "$CREATED" = 1 ] && [ "$KEEP" != 1 ]; then
    drop_db "$THROW" || log "WARNING: could not drop throwaway database $THROW"
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# restore.sh creates the database, so claim the name first for cleanup, then let it run.
CREATED=1
LOG="$MEDIA_DIR/restore.log"
if ! "$SCRIPT_DIR/restore.sh" --backup "$BACKUP" --target-db "$THROW" --media-target "$MEDIA_DIR/media" >"$LOG.out" 2>"$LOG"; then
  cat "$LOG" >&2
  die "verification FAILED: restore or comparison did not succeed"
fi
cat "$LOG" >&2
log "VERIFIED: $BACKUP restores cleanly (checksums, media manifest and row counts match)"
