#!/usr/bin/env bash
# Automated backup and restore drill for the production-like CMS stack (docker-compose.production.yml).
#
# Usage: restore-drill.sh --work DIR [--artifacts DIR] [--articles N]
# Needs: docker compose v2, curl, jq, openssl, gpg, GNU tar, sudo (or root) for chown of the media folder.
# Environment: CMS_IMAGE and CMS_MIGRATOR_IMAGE (images built from this commit; see .github/workflows/restore-drill.yml).
#
# What it does (docs/operations.md, "Automated restore drill"):
#   1 bring up postgres + migrate + seed ~500 synthetic articles, comments and media files + first admin + search index + cms
#   2 backup.sh (database + media, gpg-signed checksum list), verify-backup.sh
#   3 tamper tests: one flipped byte in db.dump and in media.tar.gz must fail verify-backup.sh AND restore.sh
#   4 WIPE (docker compose down -v, media folder removed), fresh postgres, restore.sh, migrate, reindex, start cms
#   5 assert: per-table row counts and content checksums identical, every media file hash identical, health ready,
#     /api/public/search finds the seeded articles, admin login works with the right password only, first-register refused
# Everything secret is generated per run inside --work (0700) and never printed. Exit status is non-zero on any failed check.
# --artifacts DIR receives results.json, summary.md, drill.log and redacted container logs (no secrets).
set -euo pipefail
set +x
umask 077

WORK=""
ART=""
ARTICLES=500
while [ $# -gt 0 ]; do
  case "$1" in
    --work) WORK="${2:?--work needs a value}"; shift 2 ;;
    --artifacts) ART="${2:?--artifacts needs a value}"; shift 2 ;;
    --articles) ARTICLES="${2:?--articles needs a value}"; shift 2 ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$WORK" ] || { echo "--work DIR is required" >&2; exit 2; }
: "${CMS_IMAGE:?set CMS_IMAGE}" "${CMS_MIGRATOR_IMAGE:?set CMS_MIGRATOR_IMAGE}"
case "$ARTICLES" in '' | *[!0-9]*) echo "--articles must be a number" >&2; exit 2 ;; esac

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CMS_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
[ -z "$ART" ] || { mkdir -p "$ART"; ART=$(cd "$ART" && pwd); }
SUDO=""
[ "$(id -u)" = 0 ] || SUDO="sudo"

log() { printf '[drill %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { printf '[drill] FAIL: %s\n' "$*" >&2; exit 1; }
now() { date +%s; }

# ---- per-run secrets (never printed) ----------------------------------------------------------------------------------
mkdir -p "$WORK/secrets" "$WORK/backups" "$WORK/logs" "$WORK/state"
chmod 700 "$WORK"
hex() { openssl rand -hex "$1"; }
PGPW="ci-only-$(hex 16)"
SECRET_A="ci-only-$(hex 32)"
SECRET_B="ci-only-$(hex 32)"
SECRET_C="ci-only-$(hex 32)"
SALT="ci-only-$(hex 16)"
ADMIN_EMAIL="drill-admin@ci.example.org"
ADMIN_NEW_PASSWORD="Drill-Aa1-$(hex 12)"
SECRETS="$PGPW $SECRET_A $SECRET_B $SECRET_C $SALT $ADMIN_NEW_PASSWORD"
if [ -n "${GITHUB_ACTIONS:-}" ]; then for v in $SECRETS; do echo "::add-mask::$v"; done; fi
printf '%s' "$PGPW" >"$WORK/secrets/postgres_password"
cat >"$WORK/cms.env" <<EOF
DATABASE_URL=postgres://churchtimes:${PGPW}@postgres:5432/churchtimes
PAYLOAD_SECRET=${SECRET_A}
PREVIEW_SECRET=${SECRET_B}
NEWSLETTER_TOKEN_SECRET=${SECRET_C}
IP_HASH_SALT=${SALT}
TURNSTILE_SECRET_KEY=0x4AAAAAAAci-only-not-a-real-secret
TURNSTILE_ALLOWED_HOSTNAMES=www.ci.example.org
TURNSTILE_EXPECTED_ACTION=submit-story,contact-message,newsletter-subscribe
CMS_PUBLIC_URL=https://cms.ci.example.org
CMS_CORS_ORIGINS=https://www.ci.example.org
CMS_CSRF_ORIGINS=https://www.ci.example.org
PUBLIC_SUBMISSION_ORIGINS=https://www.ci.example.org
PUBLIC_SITE_URL=https://www.ci.example.org
SMTP_HOST=smtp.ci.example.org
EMAIL_FROM_ADDRESS=cms@ci.example.org
TRUST_PROXY=true
TRUST_PROXY_HOPS=1
PAYLOAD_DB_PUSH=false
SEARCH_RATE_LIMIT=1000
AUTH_LOGIN_RATE_LIMIT=1000
EOF
# ALLOW_FIRST_REGISTER is deliberately NOT set: the production default policy (refuse) is what the drill asserts.
export CMS_ENV_FILE="$WORK/cms.env" CMS_MEDIA_DIR="$WORK/media" POSTGRES_PASSWORD_FILE_PATH="$WORK/secrets/postgres_password"
export ADMIN_EMAIL ADMIN_NEW_PASSWORD
cd "$CMS_DIR"
C="docker compose -f docker-compose.production.yml"
PGX="$C exec -T -e PGUSER=churchtimes postgres"
BASE="http://127.0.0.1:3000"

# Remove every secret from a stream (container logs go to the artifact).
redact() {
  local f="$1" s
  for s in $SECRETS; do
    [ -z "$s" ] || sed -i "s|$s|[redacted]|g" "$f"
  done
}
collect_logs() {
  [ -n "$ART" ] || return 0
  mkdir -p "$ART"
  for svc in cms postgres; do
    $C logs --no-color --tail 2000 "$svc" >"$ART/$svc.log" 2>&1 || true
    redact "$ART/$svc.log"
  done
}
on_exit() {
  rc=$?
  if [ "$rc" -ne 0 ]; then log "drill FAILED (exit $rc)"; collect_logs; fi
  $C down -v --remove-orphans >/dev/null 2>&1 || true
  $SUDO rm -rf "$WORK/media" >/dev/null 2>&1 || true
  # Plaintext secrets must not outlive the run, whatever the outcome.
  rm -rf "$WORK/secrets" "$WORK/cms.env" "$WORK/gnupg" "$WORK/login.json" "$WORK/state/cookies" 2>/dev/null || true
}
trap on_exit EXIT

# ---- helpers ----------------------------------------------------------------------------------------------------------
wait_cms() {
  $C up -d --wait --wait-timeout 180 cms
}
check_health() {
  curl -fsS --max-time 30 "$BASE/api/health/live" | jq -e '.status == "ok"' >/dev/null || fail "live check failed"
  curl -fsS --max-time 30 "$BASE/api/health/ready" | jq -e '.status == "ready" and .database and .migrations and .media' >/dev/null ||
    fail "ready check failed"
}
# Row counts and a content checksum per key table. Output is stable, one line per table.
snapshot_db() {
  $PGX psql -U churchtimes -d churchtimes -v ON_ERROR_STOP=1 -Atq <<'SQL'
select 'articles|' || count(*) || '|' || coalesce(md5(string_agg(id || ':' || title || ':' || slug || ':' || status::text || ':' || md5(content::text), ',' order by id)), '-') from articles;
select 'legacy_comments|' || count(*) || '|' || coalesce(md5(string_agg(id || ':' || article_id || ':' || legacy_id || ':' || md5(content), ',' order by id)), '-') from legacy_comments;
select 'media|' || count(*) || '|' || coalesce(md5(string_agg(id || ':' || filename || ':' || alt, ',' order by id)), '-') from media;
select 'categories|' || count(*) || '|' || coalesce(md5(string_agg(id || ':' || slug, ',' order by id)), '-') from categories;
select 'users|' || count(*) || '|' || coalesce(md5(string_agg(id || ':' || email::text, ',' order by id)), '-') from users;
select 'article_search|' || count(*) || '|-' from article_search;
select 'payload_migrations|' || count(*) || '|' || coalesce(md5(string_agg(name, ',' order by name)), '-') from payload_migrations;
SQL
}
media_hashes() {
  (cd "$WORK/media" && find . -type f -print0 | sort -z | xargs -0 sha256sum)
}
search_total() {
  curl -fsS --max-time 30 "$BASE/api/public/search?q=drill&limit=5" | jq -er '.totalDocs'
}
http_code_json() { # method url jsonfile [extra curl args]
  local m="$1" u="$2" f="$3"
  shift 3
  curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X "$m" "$u" -H 'Content-Type: application/json' -H 'X-Forwarded-For: 203.0.113.7' --data @"$f" "$@"
}

# ---- 1. stack, migrate, seed -----------------------------------------------------------------------------------------
T_START=$(now)
log "1/6 preparing the stack"
mkdir -p "$WORK/media"
$SUDO chown 1000:1000 "$WORK/media"
$SUDO chmod 755 "$WORK/media"
$C up -d --wait --wait-timeout 120 postgres
$C --profile ops run --rm migrate
log "seeding $ARTICLES articles, comments and media rows"
$PGX psql -U churchtimes -d churchtimes -v ON_ERROR_STOP=1 -q <<SQL
insert into categories (title, slug) values ('News', 'news'), ('Features', 'features');
insert into media (alt, filename, mime_type, filesize, url)
  select 'Synthetic drill image ' || g, 'drill-' || g || '.bin', 'application/octet-stream', 4096, '/api/media/file/drill-' || g || '.bin'
  from generate_series(1, 60) g;
insert into articles (title, slug, excerpt, content, category_id, status, published_at, legacy_id, byline_name)
  select 'Synthetic drill article ' || g, 'drill-article-' || g, 'Excerpt for drill article ' || g,
         jsonb_build_object('root', jsonb_build_object('type', 'root', 'children', jsonb_build_array(
           jsonb_build_object('type', 'paragraph', 'children', jsonb_build_array(
             jsonb_build_object('type', 'text', 'text', 'Synthetic drill body ' || g || ' about parish councils, choirs and the harvest festival.'))))),
         (select min(id) from categories), 'published', now() - (g || ' minutes')::interval, 900000 + g, 'Drill Desk'
  from generate_series(1, $ARTICLES) g;
insert into legacy_comments (article_id, author_name, content, commented_at, legacy_id)
  select a.id, 'Drill reader ' || k, 'Synthetic comment ' || k || ' on article ' || a.id, now() - (k || ' hours')::interval, a.id * 10 + k
  from articles a, generate_series(1, 3) k;
SQL
# Media files: random bytes in a dated tree, owned by the app user (uid 1000), readable by the backup user.
for n in $(seq 1 60); do
  d="$WORK/media/2026/$(printf '%02d' $((n % 12 + 1)))"
  mkdir -p "$d"
  head -c 4096 /dev/urandom >"$d/drill-$n.bin"
done
$SUDO chown -R 1000:1000 "$WORK/media"
$SUDO find "$WORK/media" -type d -exec chmod 755 {} +
$SUDO find "$WORK/media" -type f -exec chmod 644 {} +
$C --profile ops run --rm -e ADMIN_EMAIL -e ADMIN_NEW_PASSWORD migrate npm run admin:create >/dev/null
$C --profile ops run --rm migrate npm run search:reindex
wait_cms
check_health
[ "$(search_total)" -ge 1 ] || fail "search finds nothing before the backup"
snapshot_db >"$WORK/state/db.before"
media_hashes >"$WORK/state/media.before"
MEDIA_FILES=$(wc -l <"$WORK/state/media.before" | tr -d ' ')
[ "$MEDIA_FILES" = 60 ] || fail "expected 60 media files, found $MEDIA_FILES"
T_LAST_WRITE=$(now)
log "baseline (table|rows): $(cut -d'|' -f1,2 "$WORK/state/db.before" | tr '\n' ' ')"

# ---- 2. backup + verify ----------------------------------------------------------------------------------------------
log "2/6 backup (database + media, signed)"
export GNUPGHOME="$WORK/gnupg"
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-generate-key "Restore Drill <drill@ci.example.org>" ed25519 sign never >/dev/null 2>&1
export GPG_SIGN_KEY="drill@ci.example.org"
export BACKUP_COUNT_TABLES="articles media legacy_comments categories users article_search"
export PG_EXEC="$PGX"
T_BACKUP_START=$(now)
sh "$SCRIPT_DIR/backup.sh" --out "$WORK/backups" --media "$WORK/media" --db churchtimes --sign gpg --allow-plaintext
T_BACKUP_END=$(now)
BACKUP=$(find "$WORK/backups" -maxdepth 1 -type d -name 'churchtimes-*' | sort | tail -n 1)
[ -n "$BACKUP" ] || fail "no backup directory was produced"
BACKUP_BYTES=$(du -sb "$BACKUP" | cut -f1)
log "verify-backup.sh"
sh "$SCRIPT_DIR/verify-backup.sh" --backup "$BACKUP" --verify-sig gpg
T_VERIFY_END=$(now)

# ---- 3. tamper tests -------------------------------------------------------------------------------------------------
log "3/6 tamper tests"
flip_byte() { # file: invert the byte at offset 100
  local f="$1" b
  b=$(dd if="$f" bs=1 skip=100 count=1 2>/dev/null | od -An -tu1 | tr -d ' ')
  printf "\\$(printf '%03o' $(((b + 1) % 256)))" | dd of="$f" bs=1 seek=100 conv=notrunc 2>/dev/null
}
for victim in db.dump media.tar.gz; do
  T="$WORK/tamper-$victim"
  cp -a "$BACKUP" "$T"
  chmod u+w "$T/$victim"
  flip_byte "$T/$victim"
  if sh "$SCRIPT_DIR/verify-backup.sh" --backup "$T" --verify-sig gpg >"$WORK/state/tamper.out" 2>&1; then
    fail "verify-backup.sh ACCEPTED a backup with a corrupted $victim"
  fi
  log "verify-backup.sh refused the corrupted $victim (as required)"
  if sh "$SCRIPT_DIR/restore.sh" --backup "$T" --target-db churchtimes_tamper --verify-sig gpg --media-target "$WORK/tamper-media" >"$WORK/state/tamper.out" 2>&1; then
    fail "restore.sh ACCEPTED a backup with a corrupted $victim"
  fi
  [ -z "$($PGX psql -U churchtimes -d postgres -Atc "select 1 from pg_database where datname='churchtimes_tamper'")" ] ||
    fail "restore.sh created a database from a tampered backup"
  [ ! -e "$WORK/tamper-media" ] || fail "restore.sh extracted media from a tampered backup"
  log "restore.sh refused the corrupted $victim and touched nothing (as required)"
  rm -rf "$T"
done
T_TAMPER_END=$(now)

# ---- 4. wipe -------------------------------------------------------------------------------------------------------------
log "4/6 WIPE: dropping containers, volumes and the media folder"
T_WIPE=$(now)
$C down -v --remove-orphans
$SUDO rm -rf "$WORK/media"
[ -z "$(docker volume ls -q --filter 'name=churchtimes-cms-prod_pgdata')" ] || fail "the database volume survived the wipe"

# ---- 5. restore into a fresh stack -----------------------------------------------------------------------------------
log "5/6 restore into a fresh stack"
$C up -d --wait --wait-timeout 120 postgres
[ "$($PGX psql -U churchtimes -d churchtimes -Atc "select count(*) from information_schema.tables where table_schema='public'")" = 0 ] ||
  fail "the fresh database is not empty"
T_RESTORE_START=$(now)
sh "$SCRIPT_DIR/restore.sh" --backup "$BACKUP" --target-db churchtimes --verify-sig gpg --media-target "$WORK/media"
T_RESTORE_END=$(now)
$SUDO chown -R 1000:1000 "$WORK/media"
$C --profile ops run --rm migrate
T_MIGRATE_END=$(now)
$C --profile ops run --rm migrate npm run search:reindex
wait_cms
T_READY=$(now)

# ---- 6. assertions -----------------------------------------------------------------------------------------------------
log "6/6 assertions"
check_health
snapshot_db >"$WORK/state/db.after"
if ! diff "$WORK/state/db.before" "$WORK/state/db.after" >"$WORK/state/db.diff"; then
  # Print table names and counts only, never row content.
  cut -d'|' -f1,2 "$WORK/state/db.diff" >&2 || true
  fail "row counts or content checksums differ after the restore"
fi
log "row counts and content checksums identical for: $(cut -d'|' -f1 "$WORK/state/db.after" | tr '\n' ' ')"
media_hashes >"$WORK/state/media.after"
diff -q "$WORK/state/media.before" "$WORK/state/media.after" >/dev/null || fail "media file hashes differ after the restore"
log "all $MEDIA_FILES media file hashes identical"
TOTAL=$(search_total)
[ "$TOTAL" -ge "$ARTICLES" ] || fail "search finds $TOTAL articles after reindex, expected at least $ARTICLES"
log "/api/public/search?q=drill returns totalDocs=$TOTAL after search:reindex"

# Admin login policy. The restored users table is non-empty, so ALLOW_FIRST_REGISTER (unset = production default) must not matter:
# the staff login works with the right password only, and first-register is refused.
umask 077
printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$ADMIN_NEW_PASSWORD" >"$WORK/login.json"
[ "$(http_code_json POST "$BASE/api/users/login" "$WORK/login.json")" = 200 ] || fail "admin login failed after the restore"
printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "Wrong-Aa1-not-the-password" >"$WORK/login.json"
code=$(http_code_json POST "$BASE/api/users/login" "$WORK/login.json")
case "$code" in 401 | 403) ;; *) fail "a wrong admin password was not rejected (status $code)" ;; esac
printf '{"email":"mallory@ci.example.org","name":"Mallory","password":"Correct-Horse-Battery-9"}' >"$WORK/login.json"
code=$(http_code_json POST "$BASE/api/users/first-register" "$WORK/login.json")
[ "$code" = 403 ] || fail "first-register was not refused (status $code)"
[ "$($PGX psql -U churchtimes -d churchtimes -Atc "select count(*) from users where email='mallory@ci.example.org'")" = 0 ] ||
  fail "first-register created a user"
log "admin login accepted with the right password only; first-register refused (ALLOW_FIRST_REGISTER unset)"

# ---- results -----------------------------------------------------------------------------------------------------------
RPO_EXPOSURE=$((T_BACKUP_END - T_LAST_WRITE))
RTO_TOTAL=$((T_READY - T_WIPE))
if [ -n "$ART" ]; then
  collect_logs
  jq -n \
    --argjson articles "$ARTICLES" --argjson media "$MEDIA_FILES" --argjson bytes "$BACKUP_BYTES" \
    --argjson backup "$((T_BACKUP_END - T_BACKUP_START))" --argjson verify "$((T_VERIFY_END - T_BACKUP_END))" \
    --argjson restore "$((T_RESTORE_END - T_RESTORE_START))" --argjson migrate "$((T_MIGRATE_END - T_RESTORE_END))" \
    --argjson rto "$RTO_TOTAL" --argjson rpo "$RPO_EXPOSURE" --argjson total "$(($(now) - T_START))" \
    '{articles:$articles, media_files:$media, backup_bytes:$bytes, seconds:{backup:$backup, verify:$verify, restore:$restore, migrate:$migrate, rto_wipe_to_ready:$rto, rpo_last_write_to_backup_end:$rpo, drill_total:$total}}' \
    >"$ART/results.json"
  {
    echo "## Restore drill"
    echo
    echo "| Measure | Value |"
    echo "| --- | --- |"
    echo "| Synthetic data | $ARTICLES articles, 3 comments each, $MEDIA_FILES media files |"
    echo "| Backup size | $BACKUP_BYTES bytes |"
    echo "| backup.sh | $((T_BACKUP_END - T_BACKUP_START)) s |"
    echo "| verify-backup.sh | $((T_VERIFY_END - T_BACKUP_END)) s |"
    echo "| restore.sh | $((T_RESTORE_END - T_RESTORE_START)) s |"
    echo "| migrate after restore | $((T_MIGRATE_END - T_RESTORE_END)) s |"
    echo "| **RTO** (wipe to health ready, search and login verified stack) | **$RTO_TOTAL s** |"
    echo "| **RPO exposure** (last write to end of backup) | **$RPO_EXPOSURE s** (policy: one backup interval, 24 h nightly) |"
  } >"$ART/summary.md"
  [ -z "${GITHUB_STEP_SUMMARY:-}" ] || cat "$ART/summary.md" >>"$GITHUB_STEP_SUMMARY"
fi
log "RESULT RTO=${RTO_TOTAL}s (wipe to ready) restore.sh=$((T_RESTORE_END - T_RESTORE_START))s backup.sh=$((T_BACKUP_END - T_BACKUP_START))s RPO-exposure=${RPO_EXPOSURE}s (last write to end of backup; policy = backup interval)"
log "DRILL PASSED"
