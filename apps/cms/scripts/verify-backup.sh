#!/bin/sh
# Prove a backup is restorable: verify checksums, restore into a throwaway database, compare row
# counts and the media manifest, then drop the throwaway database.
#
# Usage: verify-backup.sh --backup DIR [--pg-exec 'CMD PREFIX'] [--skip-media] [--verify-sig gpg|minisign]
#        [--tmpdir DIR] [--keep-db]
# Connection: libpq variables, or --pg-exec / PG_EXEC. Encrypted backups: AGE_IDENTITY_FILE (age) or
# your gpg keyring. Exit status 0 only when everything matches.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=backup-lib.sh
. "$SCRIPT_DIR/backup-lib.sh"

BACKUP=""
KEEP=0
SKIP_MEDIA=""
SIG=""
TMPBASE="${BACKUP_TMPDIR:-${TMPDIR:-/tmp}}"
while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP="${2:?--backup needs a value}"; shift 2 ;;
    --pg-exec) PG_EXEC="${2:?--pg-exec needs a value}"; shift 2 ;;
    --skip-media) SKIP_MEDIA=--skip-media; shift ;;
    --verify-sig) SIG="${2:?--verify-sig needs a value}"; shift 2 ;;
    --tmpdir) TMPBASE="${2:?--tmpdir needs a value}"; shift 2 ;;
    --keep-db) KEEP=1; shift ;;
    -h | --help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$BACKUP" ] || die "--backup DIR is required"
[ -d "$TMPBASE" ] || die "temp directory not found: $TMPBASE"
need_pg
need_gnu_tar

THROW="churchtimes_verify_$(date -u +%Y%m%dT%H%M%SZ)_$$"
WORK=$(mktemp -d "$TMPBASE/ct-verify-XXXXXX")
CREATED=0
cleanup() {
  rm -rf "$WORK"
  if [ "$CREATED" = 1 ] && [ "$KEEP" != 1 ]; then
    drop_db "$THROW" || log "WARNING: could not drop throwaway database $THROW"
  fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Claim the database name for cleanup before restore.sh creates it.
CREATED=1
set -- --backup "$BACKUP" --target-db "$THROW" --tmpdir "$TMPBASE"
[ -z "$PG_EXEC" ] || set -- "$@" --pg-exec "$PG_EXEC"
[ -z "$SIG" ] || set -- "$@" --verify-sig "$SIG"
if [ -n "$SKIP_MEDIA" ]; then
  set -- "$@" --skip-media
else
  set -- "$@" --media-target "$WORK/media"
fi
if ! "$SCRIPT_DIR/restore.sh" "$@" >"$WORK/restore.out" 2>"$WORK/restore.log"; then
  cat "$WORK/restore.log" >&2
  die "verification FAILED: restore or comparison did not succeed"
fi
cat "$WORK/restore.log" >&2
log "VERIFIED: $BACKUP restores cleanly (checksums, media manifest and row counts match)"
