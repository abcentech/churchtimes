#!/usr/bin/env bash
# Stop the staging stack; optionally delete its data. Run as root, only on a machine prepared by setup.sh.
#
#   ./teardown.sh                                   stop and remove the containers; ALL DATA KEPT
#   ./teardown.sh --wipe-volumes --confirm-wipe     ALSO delete the database and the uploaded media volumes
#                    [--include-certs]              ... and the Caddy certificate volume (re-issuing counts against
#                                                   Let's Encrypt rate limits; leave it unless you are retiring the host)
#                    [--remove-secrets]             ... and delete .env.cms, .env.postgres and the credentials file
#
# Wiping needs BOTH --wipe-volumes and --confirm-wipe. A final database dump is taken first when PostgreSQL is running
# (kept in /var/backups/churchtimes-staging, which this script never deletes).
set -euo pipefail

SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
# shellcheck source=common.sh
. "$(dirname "$SCRIPT")/common.sh"

main() {
  local wipe=0 confirm=0 certs=0 secrets=0
  while [ $# -gt 0 ]; do
    case $1 in
      --wipe-volumes) wipe=1; shift ;;
      --confirm-wipe) confirm=1; shift ;;
      --include-certs) certs=1; shift ;;
      --remove-secrets) secrets=1; shift ;;
      -h | --help) sed -n '2,13p' "$SCRIPT"; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  require_root
  require_kit_server
  if [ "$wipe" -eq 0 ] && { [ "$confirm" -eq 1 ] || [ "$certs" -eq 1 ] || [ "$secrets" -eq 1 ]; }; then
    die "--confirm-wipe, --include-certs and --remove-secrets only apply together with --wipe-volumes."
  fi
  if [ "$wipe" -eq 1 ] && [ "$confirm" -eq 0 ]; then
    die "wiping deletes the staging database and media. Add --confirm-wipe to do it."
  fi

  [ -f "$STAGING_DIR/.env" ] && load_env || true
  if [ "$wipe" -eq 1 ]; then backup_db "pre-teardown" || warn "no backup was taken"; fi

  log "stopping and removing the containers"
  dc --profile tools down --remove-orphans

  if [ "$wipe" -eq 1 ]; then
    log "deleting volumes"
    docker volume rm "${COMPOSE_PROJECT}_pgdata" "${COMPOSE_PROJECT}_cms-media" 2>/dev/null || true
    if [ "$certs" -eq 1 ]; then docker volume rm "${COMPOSE_PROJECT}_caddy-data" "${COMPOSE_PROJECT}_caddy-config" 2>/dev/null || true; fi
    if [ "$secrets" -eq 1 ]; then
      local cred
      cred="$(get_kv "$STAGING_DIR/.env" SEED_CREDENTIALS_FILE)"
      rm -f -- "$STAGING_DIR/.env.cms" "$STAGING_DIR/.env.postgres" "${cred:-/root/churchtimes-staging-credentials.json}"
      log "secrets and the synthetic credentials file deleted"
    fi
    log "wiped. Run setup.sh again to rebuild from scratch."
  else
    log "stopped. Data volumes are kept; start again with: docker compose up -d (in $STAGING_DIR) or update.sh"
  fi
}

main "$@"
exit 0
