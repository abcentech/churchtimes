#!/bin/sh
# Shared helpers for backup.sh, restore.sh and verify-backup.sh. Sourced, not executed.
# POSIX sh. Connection settings come from the standard libpq variables (PGHOST, PGPORT, PGUSER,
# PGPASSWORD or ~/.pgpass, PGDATABASE). Passwords are never put on a command line or in a log.
#
# Container mode: set PG_EXEC (or --pg-exec) to a command prefix that runs a program inside the
# database container, for example
#   PG_EXEC='docker compose -f /srv/churchtimes/app/apps/cms/docker-compose.production.yml exec -T -e PGUSER=churchtimes postgres'
# pg_dump, pg_restore and psql then run through it. Data always travels over stdin/stdout, never as a
# path, so the container needs no shared files. PG_EXEC is trusted administrator configuration: it is
# split on spaces (no shell quoting) and run as written.

umask 077

PG_EXEC="${PG_EXEC:-}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

need() {
  for _t in "$@"; do
    command -v "$_t" >/dev/null 2>&1 || die "required tool not found: $_t"
  done
}

# Tools needed to talk to PostgreSQL: the PG_EXEC launcher in container mode, else the client tools.
need_pg() {
  if [ -n "$PG_EXEC" ]; then
    # shellcheck disable=SC2086 # intentional word splitting of the trusted prefix
    set -- $PG_EXEC
    need "$1"
  else
    need pg_dump pg_restore psql
  fi
}

# Run a PostgreSQL client program, through PG_EXEC when set.
pgrun() {
  if [ -n "$PG_EXEC" ]; then
    set -f
    # shellcheck disable=SC2086 # intentional word splitting of the trusted prefix
    $PG_EXEC "$@"
    _rc=$?
    set +f
    return "$_rc"
  fi
  "$@"
}

# GNU tar is required (--null, --verbatim-files-from).
need_gnu_tar() {
  need tar
  tar --version 2>/dev/null | grep -q 'GNU tar' || die "GNU tar is required"
}

# sha256 of a single file: prints the hex digest only.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# Verify the checksum list file $2 against files under directory $1. Strict: malformed lines fail.
sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$1" && sha256sum -c --strict --quiet "$2" >/dev/null)
  else
    (cd "$1" && shasum -a 256 -c --strict --quiet "$2" >/dev/null)
  fi
}

# Table names are interpolated into SQL, so only plain identifiers are accepted.
COUNT_TABLES_DEFAULT='articles media legacy_comments'
valid_tables() {
  for _t in $1; do
    case "$_t" in
      '' | *[!a-z0-9_]* | [0-9]*) die "invalid table name: $_t" ;;
    esac
  done
}

# psql wrapper: quiet, no psqlrc, stops on first error. Args: database, then psql args.
psql_q() {
  _db="$1"
  shift
  pgrun psql -X -q -v ON_ERROR_STOP=1 -d "$_db" "$@" </dev/null
}

# Prints "<table> <count|absent>" for each table, one per line. Args: database, tables.
count_rows() {
  _db="$1"
  for _t in $2; do
    _exists=$(psql_q "$_db" -At -c "select to_regclass('public.$_t') is not null") || return 1
    if [ "$_exists" = t ]; then
      _n=$(psql_q "$_db" -At -c "select count(*) from public.\"$_t\"") || return 1
      printf '%s %s\n' "$_t" "$_n"
    else
      printf '%s absent\n' "$_t"
    fi
  done
}

# Decrypt $1 (*.age, *.gpg) to $2, or copy when not encrypted. Keys are never handled here:
# age reads the identity file named by AGE_IDENTITY_FILE; gpg uses the caller's keyring or agent.
decrypt_to() {
  case "$1" in
    *.age)
      need age
      [ -n "${AGE_IDENTITY_FILE:-}" ] || die "AGE_IDENTITY_FILE must point to the age identity (private key) file"
      age -d -i "$AGE_IDENTITY_FILE" -o "$2" "$1" || die "age decryption failed: $1"
      ;;
    *.gpg)
      need gpg
      gpg --batch --yes --quiet -o "$2" -d "$1" || die "gpg decryption failed: $1"
      ;;
    *) cp "$1" "$2" ;;
  esac
}

# Verify the detached signature over SHA256SUMS of backup dir $1 with method $2 (gpg|minisign).
verify_signature() {
  case "$2" in
    gpg)
      need gpg
      [ -f "$1/SHA256SUMS.sig" ] || die "no SHA256SUMS.sig in $1 but a signature is required"
      gpg --batch --quiet --verify "$1/SHA256SUMS.sig" "$1/SHA256SUMS" 2>/dev/null ||
        die "signature verification FAILED for $1"
      ;;
    minisign)
      need minisign
      [ -n "${MINISIGN_PUBLIC_KEY:-}" ] || die "MINISIGN_PUBLIC_KEY (public key file) is required for --verify-sig minisign"
      [ -f "$1/SHA256SUMS.minisig" ] || die "no SHA256SUMS.minisig in $1 but a signature is required"
      minisign -V -q -p "$MINISIGN_PUBLIC_KEY" -m "$1/SHA256SUMS" -x "$1/SHA256SUMS.minisig" ||
        die "signature verification FAILED for $1"
      ;;
    *) die "--verify-sig must be gpg or minisign" ;;
  esac
  log "signature OK"
}

# Names listed in SHA256SUMS of dir $1, one per line.
listed_names() { sed 's/^[0-9a-f]\{64\}  //' "$1/SHA256SUMS"; }

# Name of the single SHA256SUMS entry matching regex $2 (e.g. 'db\.dump'), with optional .age/.gpg.
# $3 is a description for the error message.
listed_one() {
  _hits=$(listed_names "$1" | grep -E "^$2(\\.age|\\.gpg)?\$") || true
  _n=$(printf '%s\n' "$_hits" | grep -c .) || true
  [ "$_n" = 1 ] || die "SHA256SUMS must list exactly one $3 artifact (found $_n)"
  printf '%s\n' "$_hits"
}

# Verify backup dir $1, then decrypt what SHA256SUMS lists into work dir $2 and check it.
# Optional $3 = "skip-media": do not extract or check the media archive. $4 = signature method.
# Sets DUMP_FILE, MEDIA_TAR and COUNTS_FILE (MEDIA_TAR is empty with skip-media).
prepare_backup() {
  _dir="$1"
  _work="$2"
  _skipmedia="${3:-}"
  _sig="${4:-}"
  [ -d "$_dir" ] || die "backup directory not found: $_dir"
  { [ -f "$_dir/SHA256SUMS" ] && [ ! -L "$_dir/SHA256SUMS" ]; } || die "missing SHA256SUMS in $_dir"
  [ -z "$_sig" ] || verify_signature "$_dir" "$_sig"
  # Only plain "<64 hex>  <simple name>" lines are acceptable (no escapes, paths or oddities).
  if grep -Ev '^[0-9a-f]{64}  [A-Za-z0-9._-]+$' "$_dir/SHA256SUMS" >/dev/null; then
    die "SHA256SUMS contains malformed or unexpected lines"
  fi
  sha256_check "$_dir" SHA256SUMS || die "checksum verification FAILED for $_dir (corrupt or tampered backup)"
  # Every artifact must be listed and exactly one variant of each must exist: nothing unchecked is used.
  _dumpname=$(listed_one "$_dir" 'db\.dump' "database dump") || exit 1
  _medianame=$(listed_one "$_dir" 'media\.tar\.gz' "media archive") || exit 1
  _countsname=$(listed_one "$_dir" 'counts\.txt' "counts") || exit 1
  listed_one "$_dir" 'media\.manifest\.sha256' "media manifest" >/dev/null || exit 1
  for _p in "$_dir"/* "$_dir"/.[!.]* "$_dir"/..?*; do
    [ -e "$_p" ] || [ -L "$_p" ] || continue
    _b=$(basename "$_p")
    case "$_b" in SHA256SUMS | SHA256SUMS.sig | SHA256SUMS.minisig) continue ;; esac
    if [ -L "$_p" ] || [ ! -f "$_p" ] || ! listed_names "$_dir" | grep -qxF "$_b"; then
      die "unlisted or unsafe entry in the backup directory: $_b (refusing; not covered by SHA256SUMS)"
    fi
  done
  log "checksums OK"
  DUMP_FILE="$_work/db.dump"
  decrypt_to "$_dir/$_dumpname" "$DUMP_FILE"
  COUNTS_FILE="$_work/counts.txt"
  decrypt_to "$_dir/$_countsname" "$COUNTS_FILE"
  # The custom-format dump must be readable before anything is restored.
  pgrun pg_restore --list <"$DUMP_FILE" >/dev/null || die "pg_restore cannot read the dump"
  MEDIA_TAR=""
  if [ "$_skipmedia" != skip-media ]; then
    MEDIA_TAR="$_work/media.tar.gz"
    decrypt_to "$_dir/$_medianame" "$MEDIA_TAR"
    check_media_archive "$MEDIA_TAR" "$_work/mediachk"
  fi
}

# Reject unsafe archive members, then recompute every hash and compare with the stored manifest.
# Args: archive, scratch directory path (created and removed here).
check_media_archive() {
  need_gnu_tar
  tar -tzf "$1" >"$2.names" || die "media archive is unreadable"
  if grep -E '(^|/)\.\.(/|$)|^/' "$2.names" >/dev/null; then
    die "media archive contains absolute or parent-relative paths"
  fi
  # First character of each verbose line is the entry type: only plain files and directories pass.
  tar -tvzf "$1" | cut -c1 >"$2.types" || die "media archive is unreadable"
  if grep -v '^[-d]$' "$2.types" >/dev/null; then
    die "media archive contains links or special files; refusing"
  fi
  rm -f "$2.names" "$2.types"
  mkdir "$2"
  tar -xzf "$1" -C "$2" || die "media archive is unreadable"
  [ -f "$2/.manifest.sha256" ] || die "media archive has no manifest"
  sha256_check "$2" .manifest.sha256 || die "media manifest verification FAILED"
  _files=$(find "$2" -type f ! -name .manifest.sha256 | wc -l | tr -d ' ')
  _listed=$(wc -l <"$2/.manifest.sha256" | tr -d ' ')
  [ "$_files" = "$_listed" ] || die "media archive holds $_files files but its manifest lists $_listed"
  log "media manifest OK ($_files files)"
  rm -rf "$2"
}

# Database helpers. The maintenance database is "postgres" (override with PGMAINT_DB).
create_db() {
  psql_q "${PGMAINT_DB:-postgres}" -c "create database \"$1\" encoding 'UTF8' template template0"
}
drop_db() {
  psql_q "${PGMAINT_DB:-postgres}" -c "drop database if exists \"$1\""
}
db_exists() {
  [ "$(psql_q "${PGMAINT_DB:-postgres}" -At -c "select 1 from pg_database where datname = '$1'")" = 1 ]
}
db_table_count() {
  psql_q "$1" -At -c "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')"
}
valid_dbname() {
  case "$1" in '' | *[!A-Za-z0-9_]*) die "database names may only contain letters, digits and underscore: $1" ;; esac
}

# Compare restored counts in database $1 with counts file $2 ("table before after").
# A restored count must lie between the before and after counts taken around the dump.
# Prints a table; returns non-zero on any mismatch.
compare_counts() {
  _db="$1"
  _bad=0
  while read -r _t _b _a; do
    case "$_t" in '#'* | '') continue ;; esac
    valid_tables "$_t"
    _now=$(count_rows "$_db" "$_t" | cut -d ' ' -f 2)
    case "$_b$_a$_now" in *[!0-9a-z]*) die "malformed counts line for $_t" ;; esac
    if [ "$_b" = absent ] || [ "$_now" = absent ]; then
      if [ "$_b" = "$_now" ]; then _ok=1; else _ok=0; fi
    else
      _lo=$_b
      _hi=$_a
      [ "$_a" -ge "$_b" ] || {
        _lo=$_a
        _hi=$_b
      }
      if [ "$_now" -ge "$_lo" ] && [ "$_now" -le "$_hi" ]; then _ok=1; else _ok=0; fi
    fi
    if [ "$_ok" = 1 ]; then _s=ok; else _s=MISMATCH; _bad=1; fi
    printf '  %-16s backup=%s..%s restored=%s %s\n' "$_t" "$_b" "$_a" "$_now" "$_s" >&2
  done <"$2"
  return "$_bad"
}
