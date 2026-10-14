# shellcheck shell=bash
# Shared helpers for build-static.sh, update.sh and teardown.sh (and for setup.sh once the repository is checked out).
# Source it; do not execute it. Never prints a secret.

STAGING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$STAGING_DIR/../.." && pwd)"
MARKER_FILE=/etc/churchtimes-staging
LIVE_SERVER_IP=158.69.36.54          # the LIVE production website. Staging must never run there.
DEPLOY_USER="${DEPLOY_USER:-deploy}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/churchtimes-staging}"
CMS_IMAGE_REPO="${CMS_IMAGE_REPO:-ghcr.io/abcentech/churchtimes-cms}"
# shellcheck disable=SC2034
COMPOSE_PROJECT=churchtimes-staging

log() { printf '[staging] %s\n' "$*"; }
warn() { printf '[staging] WARNING: %s\n' "$*" >&2; }
die() { printf '[staging] ERROR: %s\n' "$*" >&2; exit 1; }

require_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo)."; }

# update.sh / teardown.sh must only ever run on a machine that setup.sh prepared for staging.
require_kit_server() {
  [ -f "$MARKER_FILE" ] || die "$MARKER_FILE not found: this machine was not set up by deploy/staging/setup.sh. Refusing (these scripts restart containers and can delete data)."
  # The marker records the checkout it belongs to; refuse to act on a copy of this kit somewhere else.
  local recorded
  recorded="$(get_kv "$MARKER_FILE" repo_dir)"
  [ "$recorded" = "$REPO_DIR" ] || die "$MARKER_FILE belongs to a checkout at '$recorded', not '$REPO_DIR'. Refusing."
  # Local check only (no network): never on the live server's address.
  if ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -qx "$LIVE_SERVER_IP"; then
    die "this machine has the live server address $LIVE_SERVER_IP. Refusing."
  fi
}

# get_kv FILE KEY: print the value of KEY=value (first match), nothing if absent.
get_kv() {
  local file=$1 key=$2 line
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      "$key="*) printf '%s' "${line#*=}"; return 0 ;;
    esac
  done <"$file"
  return 0
}

# set_kv FILE KEY VALUE: update or append KEY=VALUE, keeping mode 600 and using only shell builtins for the value,
# so a secret never appears in a process argument list.
set_kv() {
  local file=$1 key=$2 value=$3 line found=0 tmp mode=600
  [ -f "$file" ] && mode="$(stat -c %a "$file")"
  tmp="$(umask 077; mktemp "${file}.XXXXXX")"
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case $line in
        "$key="*) printf '%s=%s\n' "$key" "$value" >>"$tmp"; found=1 ;;
        *) printf '%s\n' "$line" >>"$tmp" ;;
      esac
    done <"$file"
  fi
  [ "$found" -eq 1 ] || printf '%s=%s\n' "$key" "$value" >>"$tmp"
  chmod "$mode" "$tmp"
  mv "$tmp" "$file"
}

# Non-secret settings (.env). Exports STAGING_DOMAIN, TURNSTILE_SITE_KEY, TURNSTILE_ACTION, CMS_IMAGE.
load_env() {
  [ -f "$STAGING_DIR/.env" ] || die "$STAGING_DIR/.env not found (setup.sh creates it)."
  STAGING_DOMAIN="$(get_kv "$STAGING_DIR/.env" STAGING_DOMAIN)"
  TURNSTILE_SITE_KEY="$(get_kv "$STAGING_DIR/.env" TURNSTILE_SITE_KEY)"
  TURNSTILE_ACTION="$(get_kv "$STAGING_DIR/.env" TURNSTILE_ACTION)"
  CMS_IMAGE="$(get_kv "$STAGING_DIR/.env" CMS_IMAGE)"
  [ -n "$STAGING_DOMAIN" ] || die "STAGING_DOMAIN missing in $STAGING_DIR/.env"
  export STAGING_DOMAIN TURNSTILE_SITE_KEY TURNSTILE_ACTION CMS_IMAGE
}

# docker compose bound to this stack (project dir = this directory, so .env is read for interpolation).
dc() {
  docker compose --project-directory "$STAGING_DIR" -f "$STAGING_DIR/docker-compose.yml" "$@"
}

# git as the (non-root) deploy user, with a deploy key when one exists.
git_d() {
  local home key ssh_cmd=ssh
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  key="$home/.ssh/id_ed25519"
  [ -f "$key" ] && ssh_cmd="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  runuser -u "$DEPLOY_USER" -- env HOME="$home" GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$ssh_cmd" git -C "$REPO_DIR" "$@"
}

# Detached checkout of a branch (origin/<ref>), tag or commit.
checkout_ref() {
  local ref=$1 target
  git_d fetch --prune --tags origin '+refs/heads/*:refs/remotes/origin/*' || die "git fetch failed (private repository? see README, deploy key)."
  if git_d rev-parse -q --verify "refs/remotes/origin/$ref^{commit}" >/dev/null; then
    target="refs/remotes/origin/$ref"
  else
    target="$ref"
  fi
  git_d rev-parse -q --verify "$target^{commit}" >/dev/null || die "ref '$ref' not found in the repository."
  git_d checkout --force --detach "$target" >/dev/null 2>&1 || die "git checkout of '$ref' failed."
  log "checked out $(git_d rev-parse --short=12 HEAD) ($ref)"
}

# Wait until a compose service reports healthy. wait_healthy SERVICE [SECONDS]
wait_healthy() {
  local svc=$1 limit=${2:-240} waited=0 cid status
  while [ "$waited" -lt "$limit" ]; do
    cid="$(dc ps -q "$svc" 2>/dev/null || true)"
    if [ -n "$cid" ]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
      case $status in
        healthy | running) log "$svc is $status"; return 0 ;;
        exited | dead) break ;;
      esac
    fi
    sleep 5
    waited=$((waited + 5))
  done
  dc logs --tail 60 "$svc" >&2 || true
  die "$svc did not become healthy within ${limit}s (logs above)."
}

# Dump the staging database into the root-only backups directory (custom format) and keep the newest 10.
backup_db() {
  local label=${1:-manual} file
  install -d -m 700 -o root -g root "$BACKUP_DIR"
  file="$BACKUP_DIR/${label}-$(date -u +%Y%m%dT%H%M%SZ).dump"
  if [ -z "$(dc ps -q postgres 2>/dev/null)" ]; then
    log "postgres is not running: nothing to back up yet."
    return 0
  fi
  (umask 077; dc exec -T postgres pg_dump -U churchtimes -Fc churchtimes >"$file") || { rm -f "$file"; die "pg_dump failed; aborting before any migration."; }
  [ -s "$file" ] || { rm -f "$file"; die "pg_dump produced an empty file; aborting."; }
  chmod 600 "$file"
  log "database backup: $file ($(du -h "$file" | cut -f1))"
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | tail -n +11 | while IFS= read -r old; do rm -f -- "$old"; done
}

# Run migrations with the CMS image (it does not migrate on start). The CMS and public host stay stopped meanwhile.
run_migrations() {
  log "running database migrations"
  dc up -d --wait postgres || return 1
  dc --profile tools run --rm -T migrate || return 1
}
