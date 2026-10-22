#!/bin/sh
# Shared helpers for backup.sh, restore.sh and verify-backup.sh. Sourced, not executed.
# POSIX sh. Connection settings come from the standard libpq variables (PGHOST, PGPORT, PGUSER,
# PGPASSWORD or ~/.pgpass, PGDATABASE). Passwords are never put on a command line or in a log.

umask 077

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

# sha256 of a single file: prints the hex digest only.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# Verify the "<hex>  <relative path>" list file $2 against files under directory $1.
sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$1" && sha256sum -c --quiet "$2" >/dev/null)
  else
    (cd "$1" && shasum -a 256 -c --quiet "$2" >/dev/null)
  fi
}

# Table names are interpolated into SQL, so only plain identifiers are accepted.
COUNT_TABLES_DEFAULT='articles media legacy_comments'
valid_tables() {
  for _t in $1; do
    case "$_t" in
      '' | *[!a-z0-9_]* | [0-9]*) die "invalid table name in BACKUP_COUNT_TABLES: $_t" ;;
    esac
  done
}

# psql wrapper: quiet, no psqlrc, stops on first error. Args: database, then psql args.
psql_q() {
  _db="$1"
  shift
  psql -X -q -v ON_ERROR_STOP=1 -d "$_db" "$@" </dev/null
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

# Locate artifact "$2" (plain name) in backup directory "$1": prints the stored path.
find_artifact() {
  for _s in '' .age .gpg; do
    if [ -f "$1/$2$_s" ]; then
      printf '%s\n' "$1/$2$_s"
      return 0
    fi
  done
  return 1
}

# Verify SHA256SUMS of backup dir $1, then decrypt dump/media/counts into work dir $2 and check
# them. Sets DUMP_FILE, MEDIA_TAR and COUNTS_FILE (the last two may be empty).
prepare_backup() {
  _dir="$1"
  _work="$2"
  [ -d "$_dir" ] || die "backup directory not found: $_dir"
  [ -f "$_dir/SHA256SUMS" ] || die "missing SHA256SUMS in $_dir"
  sha256_check "$_dir" SHA256SUMS || die "checksum verification FAILED for $_dir (corrupt or tampered backup)"
  log "checksums OK"
  _d=$(find_artifact "$_dir" db.dump) || die "db.dump not found in $_dir"
  DUMP_FILE="$_work/db.dump"
  decrypt_to "$_d" "$DUMP_FILE"
  MEDIA_TAR=""
  if _m=$(find_artifact "$_dir" media.tar.gz); then
    MEDIA_TAR="$_work/media.tar.gz"
    decrypt_to "$_m" "$MEDIA_TAR"
  fi
  COUNTS_FILE=""
  if _c=$(find_artifact "$_dir" counts.txt); then
    COUNTS_FILE="$_work/counts.txt"
    decrypt_to "$_c" "$COUNTS_FILE"
  fi
  # The custom-format dump must be readable before anything is restored.
  pg_restore --list "$DUMP_FILE" >/dev/null || die "pg_restore cannot read the dump"
  if [ -n "$MEDIA_TAR" ]; then
    # Recompute every media hash from the archive and compare with the manifest stored inside it.
    mkdir "$_work/mediachk"
    tar -xzf "$MEDIA_TAR" -C "$_work/mediachk" || die "media archive is unreadable"
    [ -f "$_work/mediachk/.manifest.sha256" ] || die "media archive has no manifest"
    sha256_check "$_work/mediachk" .manifest.sha256 || die "media manifest verification FAILED"
    log "media manifest OK"
    rm -rf "$_work/mediachk"
  fi
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
    _now=$(count_rows "$_db" "$_t" | cut -d ' ' -f 2)
    if [ "$_b" = absent ] || [ "$_now" = absent ]; then
      if [ "$_b" = "$_now" ]; then _ok=1; else _ok=0; fi
    else
      _lo=$_b
      _hi=$_a
      [ "$_a" -ge "$_b" ] || { _lo=$_a; _hi=$_b; }
      if [ "$_now" -ge "$_lo" ] && [ "$_now" -le "$_hi" ]; then _ok=1; else _ok=0; fi
    fi
    if [ "$_ok" = 1 ]; then _s=ok; else _s=MISMATCH; _bad=1; fi
    printf '  %-16s backup=%s..%s restored=%s %s\n' "$_t" "$_b" "$_a" "$_now" "$_s" >&2
  done <"$2"
  return "$_bad"
}
