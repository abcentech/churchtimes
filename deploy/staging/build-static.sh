#!/usr/bin/env bash
# Build the PUBLIC SITE and the NEWSROOM SPA for the staging hostnames.
#
#   ./build-static.sh [--site-key KEY] [--domain DOMAIN] [--action ACTION]
#
# Inputs (precedence: command line > environment > deploy/staging/.env > default):
#   STAGING_DOMAIN       base hostname              default staging.churchtimesnigeria.net
#   TURNSTILE_SITE_KEY   Cloudflare Turnstile SITE key (PUBLIC, it ends up in the browser bundle). Required.
#   TURNSTILE_ACTION     widget action              default submit-story (must equal TURNSTILE_EXPECTED_ACTION in .env.cms)
#   STATIC_BUILD_RUNNER  docker (default: pinned node:24 container, no Node needed on the host) or host (local node 24 + npm)
#
# Output (gitignored): deploy/staging/build/public  and  deploy/staging/build/newsroom
#
# Never put a secret here: every VITE_* value is compiled into files that anyone can download.
set -euo pipefail

STAGING_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$STAGING_DIR/../.." && pwd)"
NODE_IMAGE="node:24-bookworm-slim"

die() { printf '[build-static] ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[build-static] %s\n' "$*"; }

env_file_value() { # key
  local line
  [ -f "$STAGING_DIR/.env" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in "$1="*) printf '%s' "${line#*=}"; return 0 ;; esac
  done <"$STAGING_DIR/.env"
}

domain="${STAGING_DOMAIN:-}"
site_key="${TURNSTILE_SITE_KEY:-}"
action="${TURNSTILE_ACTION:-}"
while [ $# -gt 0 ]; do
  case $1 in
    --site-key) [ $# -ge 2 ] || die "--site-key needs a value"; site_key=$2; shift 2 ;;
    --domain) [ $# -ge 2 ] || die "--domain needs a value"; domain=$2; shift 2 ;;
    --action) [ $# -ge 2 ] || die "--action needs a value"; action=$2; shift 2 ;;
    -h | --help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$domain" ] || domain="$(env_file_value STAGING_DOMAIN)"
[ -n "$site_key" ] || site_key="$(env_file_value TURNSTILE_SITE_KEY)"
[ -n "$action" ] || action="$(env_file_value TURNSTILE_ACTION)"
domain="${domain:-staging.churchtimesnigeria.net}"
action="${action:-submit-story}"

# ---- validation ---------------------------------------------------------------------------------------------------
[[ $domain =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "STAGING_DOMAIN '$domain' is not a valid lower-case hostname."
[ -n "$site_key" ] || die "Turnstile SITE key missing: pass --site-key KEY or set TURNSTILE_SITE_KEY (it is public, not the secret)."
[[ $site_key =~ ^[A-Za-z0-9_-]{8,64}$ ]] || die "the Turnstile site key has an unexpected shape."
if [[ $site_key =~ ^[123]x0{10,} ]] && [ "${ALLOW_TURNSTILE_TEST_KEY:-}" != 1 ]; then
  die "that is one of Cloudflare's dummy TEST site keys; staging uses a real widget (set ALLOW_TURNSTILE_TEST_KEY=1 only for a throw-away build)."
fi
[[ $action =~ ^[A-Za-z0-9_-]{1,32}$ ]] || die "TURNSTILE_ACTION must be 1-32 chars of A-Z a-z 0-9 _ - (Cloudflare's rule)."
# The newsroom must be a LIVE-CMS build. Its vite config refuses mock builds too; refuse here as well, early.
if [ "${VITE_NEWSROOM_MOCK:-}" != "" ]; then die "VITE_NEWSROOM_MOCK is set in the environment: refusing to build the newsroom in mock mode."; fi
unset VITE_NEWSROOM_MOCK

runner="${STATIC_BUILD_RUNNER:-docker}"
case $runner in docker | host) ;; *) die "STATIC_BUILD_RUNNER must be docker or host." ;; esac

cms_url="https://cms.$domain"
public_url="https://$domain"
out_rel="deploy/staging/build"
log "domain=$domain  cms=$cms_url  turnstile action=$action  runner=$runner"

# ---- the build, as one script run either in a pinned node:24 container or on the host ------------------------------
# Public values only. VITE_PUBLIC_SITE_URL is left empty for the public site (no canonical/OG url on staging);
# the newsroom gets the public staging URL as the link target of its tip-form shortcut.
read -r -d '' BUILD_SCRIPT <<'INNER' || true
set -euo pipefail
cd "$REPO_ROOT"
unset NODE_ENV
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_update_notifier=false
export NODE_OPTIONS=--max-old-space-size=1024

# Ads must be OFF on staging. There is no build switch: the public site only renders direct campaigns listed in
# src/data/advertising.json and a reviewed AdSense unit, and it contains no AdSense script loader. Assert the data is empty.
node -e '
  const a = JSON.parse(require("node:fs").readFileSync("src/data/advertising.json", "utf8"));
  if ((a.campaigns || []).length !== 0 || a.adsense?.enabled !== false || a.adsense?.reviewed !== false) {
    console.error("src/data/advertising.json is not ads-off (campaigns must be [] and adsense disabled): refusing to build staging.");
    process.exit(1);
  }'

npm ci --include=dev --no-audit --no-fund

# Build into a fresh directory; the live one is replaced only after every check passed.
NEW="$OUT_REL.new"
rm -rf dist "$NEW"
mkdir -p "$NEW"

# 1. public site (vite build + tools/prepare-pages.mjs puts the compiled assets under dist/site, as `npm run build` does)
NODE_ENV=production \
VITE_PUBLIC_CMS_URL="$CMS_URL" \
VITE_PUBLIC_SITE_URL= \
VITE_PUBLIC_SUBMISSIONS_URL= \
VITE_PUBLIC_CONTACT_URL= \
VITE_TURNSTILE_SITE_KEY="$SITE_KEY" \
VITE_TURNSTILE_ACTION="$ACTION" \
  node node_modules/vite/bin/vite.js build
node tools/prepare-pages.mjs
mv dist "$NEW/public"

# 2. newsroom SPA (live CMS only; its vite config throws for mock mode)
NODE_ENV=production \
VITE_CMS_URL="$CMS_URL" \
VITE_PUBLIC_SITE_URL="$PUBLIC_URL" \
  node node_modules/vite/bin/vite.js build apps/newsroom --outDir "$REPO_ROOT/$NEW/newsroom" --emptyOutDir

# ---- post-build checks ----------------------------------------------------------------------------------------------
fail() { echo "post-build check failed: $*" >&2; exit 1; }
[ -f "$NEW/public/index.html" ] || fail "public index.html missing"
[ -f "$NEW/newsroom/index.html" ] || fail "newsroom index.html missing"
grep -rqF "$CMS_URL" "$NEW/public" || fail "public build does not contain $CMS_URL"
grep -rqF "$CMS_URL" "$NEW/newsroom" || fail "newsroom build does not contain $CMS_URL"
grep -rqF "$SITE_KEY" "$NEW/public" || fail "public build does not contain the Turnstile site key"
grep -rqF "$ACTION" "$NEW/public" || fail "public build does not contain the Turnstile action"
if grep -rqE "pagead2\.googlesyndication\.com|googletagservices|adsbygoogle\.js" "$NEW"; then fail "an ad script URL is present in the build"; fi
if grep -rqE "LOCAL MOCK MODE|Development mock backend" "$NEW/newsroom" 2>/dev/null; then fail "mock-mode strings found in the newsroom build"; fi
echo "post-build checks passed"

# Swap the finished build in. (Containers bind-mount these directories: restart caddy and public afterwards.)
rm -rf "$OUT_REL.old"
[ ! -d "$OUT_REL" ] || mv "$OUT_REL" "$OUT_REL.old"
mv "$NEW" "$OUT_REL"
rm -rf "$OUT_REL.old"
INNER

export CMS_URL="$cms_url" PUBLIC_URL="$public_url" SITE_KEY="$site_key" ACTION="$action" OUT_REL="$out_rel"

if [ "$runner" = docker ]; then
  command -v docker >/dev/null || die "docker not found (or use STATIC_BUILD_RUNNER=host)."
  # Run as the checkout's owner so build output and node_modules are not root-owned.
  uid_gid="$(stat -c '%u:%g' "$REPO_DIR")"
  docker run --rm --user "$uid_gid" --memory 1400m \
    -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
    -e CMS_URL -e PUBLIC_URL -e SITE_KEY -e ACTION -e OUT_REL -e REPO_ROOT=/repo \
    -v "$REPO_DIR:/repo" -w /repo "$NODE_IMAGE" bash -c "$BUILD_SCRIPT"
else
  command -v node >/dev/null && command -v npm >/dev/null || die "host runner needs node 24 and npm."
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || die "host runner needs Node 24 (see .nvmrc)."
  REPO_ROOT="$REPO_DIR" bash -c "$BUILD_SCRIPT"
fi

{
  echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "commit=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "domain=$domain"
  echo "turnstile_action=$action"
} >"$STAGING_DIR/build/BUILD_INFO"
log "done: $STAGING_DIR/build/public and $STAGING_DIR/build/newsroom"
