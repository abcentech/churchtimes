#!/usr/bin/env bash
# Update the staging stack on a machine prepared by setup.sh. Run as root.
#
#   ./update.sh [IMAGE_TAG] [--ref GIT_REF] [--skip-static]
#
#   IMAGE_TAG   CMS image tag to pull from GHCR: "staging" (default, moves with every publish) or a full git SHA
#               (pins an exact build; use an older SHA to roll the CMS back).
#   --ref REF   git branch/tag/commit of this repository to check out first (static files, Caddyfile, compose file,
#               the public host script). Default: the ref recorded by setup.sh.
#   --skip-static   do not rebuild the public site / newsroom.
#
# Order: checkout, static build, pull image, DATABASE BACKUP, stop CMS, migrate, start, wait healthy.
# Refuses to run unless setup.sh has prepared this machine (/etc/churchtimes-staging).
set -euo pipefail

SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
# shellcheck source=common.sh
. "$(dirname "$SCRIPT")/common.sh"

main() {
  local tag=staging ref="" skip_static=0
  while [ $# -gt 0 ]; do
    case $1 in
      --ref) [ $# -ge 2 ] || die "--ref needs a value"; ref=$2; shift 2 ;;
      --skip-static) skip_static=1; shift ;;
      -h | --help) sed -n '2,14p' "$SCRIPT"; exit 0 ;;
      -*) die "unknown option: $1" ;;
      *) tag=$1; shift ;;
    esac
  done
  [[ $tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid image tag '$tag'."

  require_root
  require_kit_server
  load_env

  [ -n "$ref" ] || ref="$(get_kv "$STAGING_DIR/.env" REPO_REF)"
  [ -n "$ref" ] || ref=feat/newsroom-mvp
  checkout_ref "$ref"
  set_kv "$STAGING_DIR/.env" REPO_REF "$ref"
  # The new image tag is written to .env only after it has been pulled successfully.
  CMS_IMAGE="$CMS_IMAGE_REPO:$tag"
  export CMS_IMAGE

  log "pulling images (CMS: $CMS_IMAGE)"
  dc pull --quiet postgres caddy public || die "pulling base images failed (nothing was stopped)."
  dc pull --quiet cms || die "could not pull $CMS_IMAGE (nothing was stopped). Is the tag published and the ghcr.io login still valid?"

  set_kv "$STAGING_DIR/.env" CMS_IMAGE "$CMS_IMAGE"

  # Always back up before touching the schema.
  backup_db "pre-update"

  # The CMS and the public host are stopped first: on a 2 GB VPS the static build (about 1.4 GB) and the running CMS
  # (up to 900 MB) must not compete for memory. Caddy and PostgreSQL stay up.
  log "stopping the CMS and the public host"
  dc stop cms public >/dev/null 2>&1 || true

  if [ "$skip_static" -eq 0 ]; then
    log "rebuilding the public site and the newsroom (the live copy is replaced only if the build succeeds)"
    if ! "$STAGING_DIR/build-static.sh"; then
      die "static build failed. Nothing was migrated; the previous static files are still in place. The CMS and public host are left STOPPED (the new image may need the migration). Fix the cause and run update.sh again, or roll back with: $SCRIPT <previous-image-tag-or-sha> --ref <previous-git-ref>"
    fi
  fi

  if ! run_migrations; then
    cat >&2 <<MSG

[staging] MIGRATION FAILED. The CMS is left stopped on purpose. The pre-update dump is in $BACKUP_DIR.
[staging] Roll back the code with:  $SCRIPT <previous-image-tag-or-sha> --ref <previous-git-ref>
[staging] Restore the data only if a migration half-applied (README, "Rollback").
MSG
    exit 1
  fi

  log "starting the stack"
  dc up -d
  # The static directories were replaced by the build: restart so the containers pick up the new directories.
  dc restart caddy public >/dev/null
  wait_healthy cms 300
  wait_healthy public 60
  log "update complete: image $CMS_IMAGE, git $(git_d rev-parse --short=12 HEAD)"
}

# Everything is inside main so that a checkout that rewrites this file cannot corrupt the running script.
main "$@"
exit 0
