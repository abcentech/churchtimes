#!/usr/bin/env bash
# Church Times STAGING: first-time setup of a NEW, EMPTY, SEPARATE Ubuntu 22.04 / 24.04 VPS. Run as root. Idempotent.
#
#   scp deploy/staging/setup.sh root@<new-vps-ip>:/root/ && ssh root@<new-vps-ip> bash /root/setup.sh
#
# !!! NEVER run this on the live web server (158.69.36.54, WordPress on LiteSpeed) or on any server that hosts anything.
# !!! It installs Docker, changes the firewall, creates swap and takes over ports 80 and 443.
#
# Options (or environment variables):
#   --ref REF                 git branch/tag/commit to deploy         (REPO_REF,   default feat/newsroom-mvp)
#   --repo-url URL            repository to clone                     (REPO_URL,   default https://github.com/abcentech/churchtimes)
#   --image-tag TAG           CMS image tag to pull from GHCR         (CMS_IMAGE_TAG, default staging)
#   --domain DOMAIN           base staging hostname                   (STAGING_DOMAIN, default staging.churchtimesnigeria.net)
#   --site-key KEY            Turnstile SITE key (public)             (TURNSTILE_SITE_KEY; prompted if missing)
#   --rotate-turnstile        prompt again for the Turnstile SECRET even if one is stored
#   --relogin-ghcr            prompt again for the GHCR login even if one is stored
#   --skip-seed               do not create the synthetic staff users
#   --i-understand-this-is-not-a-fresh-server
#                             skip ONLY the "web server / panel / database / :80 :443 / /var/www" refusals. NOT for servers
#                             that host anything. There is no override for the live-server IP check or the RAM check.
#
# Secrets are read with hidden input (read -rs) from the terminal, never from arguments or the environment, and are never
# printed. Non-interactive use: TURNSTILE_SECRET_FILE=/path and GHCR_USER=name GHCR_TOKEN_FILE=/path (files you delete after).
set -euo pipefail

LIVE_SERVER_IP=158.69.36.54
MARKER_FILE=/etc/churchtimes-staging
MIN_MEM_KB=1800000                         # about 1.8 GB (a 2 GB VPS reports roughly 1.9 GB)

STAGING_DOMAIN="${STAGING_DOMAIN:-staging.churchtimesnigeria.net}"
REPO_URL="${REPO_URL:-https://github.com/abcentech/churchtimes}"
REPO_REF="${REPO_REF:-feat/newsroom-mvp}"
REPO_DIR="${REPO_DIR:-/srv/churchtimes}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
CMS_IMAGE_TAG="${CMS_IMAGE_TAG:-staging}"
CMS_IMAGE_REPO="${CMS_IMAGE_REPO:-ghcr.io/abcentech/churchtimes-cms}"
TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY:-}"
TURNSTILE_ACTION="${TURNSTILE_ACTION:-submit-story}"
CRED_FILE="${SEED_CREDENTIALS_FILE:-/root/churchtimes-staging-credentials.json}"
ROTATE_TURNSTILE=0
RELOGIN_GHCR=0
SKIP_SEED=0
NOT_FRESH_OK=0

log() { printf '[setup] %s\n' "$*"; }
warn() { printf '[setup] WARNING: %s\n' "$*" >&2; }
die() { printf '[setup] ERROR: %s\n' "$*" >&2; exit 1; }
refuse() { printf '\n[setup] REFUSING TO CONTINUE: %s\n[setup] Nothing has been changed on this machine.\n' "$*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case $1 in
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; REPO_REF=$2; shift 2 ;;
    --repo-url) [ $# -ge 2 ] || die "--repo-url needs a value"; REPO_URL=$2; shift 2 ;;
    --image-tag) [ $# -ge 2 ] || die "--image-tag needs a value"; CMS_IMAGE_TAG=$2; shift 2 ;;
    --domain) [ $# -ge 2 ] || die "--domain needs a value"; STAGING_DOMAIN=$2; shift 2 ;;
    --site-key) [ $# -ge 2 ] || die "--site-key needs a value"; TURNSTILE_SITE_KEY=$2; shift 2 ;;
    --rotate-turnstile) ROTATE_TURNSTILE=1; shift ;;
    --relogin-ghcr) RELOGIN_GHCR=1; shift ;;
    --skip-seed) SKIP_SEED=1; shift ;;
    --i-understand-this-is-not-a-fresh-server) NOT_FRESH_OK=1; shift ;;
    -h | --help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# =====================================================================================================================
# 0. SAFETY GUARDS. Everything in this section is read-only. Nothing is installed or changed before it all passes.
# =====================================================================================================================
[ "$(id -u)" -eq 0 ] || die "run as root."
[[ $STAGING_DOMAIN =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "STAGING_DOMAIN '$STAGING_DOMAIN' is not a valid lower-case hostname."
[[ $CMS_IMAGE_TAG =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid --image-tag."

guard_live_server_ip() {
  # No override exists for this check.
  local ips="" ip found=""
  if ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -qx "$LIVE_SERVER_IP"; then
    refuse "this machine has the LIVE server address $LIVE_SERVER_IP on a network interface. Staging must never run on the live web server."
  fi
  command -v curl >/dev/null 2>&1 || refuse "curl is not installed, so the public IP address cannot be checked. Run 'apt-get install -y curl' and start again."
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -4 -fsS -m 8 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then found=$ip; break; fi
  done
  [ -n "$found" ] || refuse "could not determine this machine's public IPv4 address (no internet, or the lookup services are blocked), so it cannot be proven that this is not the live server."
  [ "$found" != "$LIVE_SERVER_IP" ] || refuse "this machine's public IP is $LIVE_SERVER_IP: that is the LIVE production web server. Staging must never run there."
  PUBLIC_IP=$found
  ips=$found
  log "public IPv4: $ips (not the live server)"
}

guard_memory() {
  local kb
  kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  [ "${kb:-0}" -ge "$MIN_MEM_KB" ] || refuse "only $((kb / 1024)) MB of RAM; the staging stack needs a 2 GB VPS (minimum 1.8 GB visible)."
}

guard_fresh_server() {
  local problems=() line unit pkg dir name
  # Something already listening on 80/443. (A re-run of this script on a staging box that is already serving is allowed:
  # then the listener is our own Caddy container.)
  line="$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E '[:.](80|443)$' | sort -u | tr '\n' ' ' || true)"
  if [ -n "$line" ]; then
    if [ -f "$MARKER_FILE" ] && command -v docker >/dev/null 2>&1 \
      && [ -n "$(docker ps -q --filter name=churchtimes-staging-caddy 2>/dev/null || true)" ]; then
      log "ports 80/443 are held by this kit's own Caddy container (re-run): ok"
    else
      problems+=("something is already listening on TCP port 80/443 ($line)")
    fi
  fi
  # Installed or running web servers / hosting panels / MySQL.
  local units
  units="$(systemctl list-unit-files --no-legend 2>/dev/null | awk '{print $1}' || true)"
  for unit in lsws lshttpd litespeed openlitespeed apache2 httpd nginx cpanel cpsrvd lscpd cyberpanel psa plesk sw-cp-server directadmin mysql mysqld mariadb; do
    if printf '%s\n' "$units" | grep -qE "^${unit}(\.service)?$"; then
      problems+=("a service unit '$unit' is installed (web server, hosting panel or MySQL/MariaDB)")
    fi
  done
  for pkg in apache2 nginx openlitespeed litespeed lsws mysql-server mariadb-server plesk-core cyberpanel directadmin cpanel; do
    if dpkg -l 2>/dev/null | awk '$1=="ii" {print $2}' | grep -qE "^${pkg}(:|$)"; then
      problems+=("package '$pkg' is installed")
    fi
  done
  for dir in /usr/local/lsws /usr/local/cpanel /usr/local/CyberCP /usr/local/psa /usr/local/directadmin /usr/local/lscp /etc/apache2 /etc/nginx; do
    [ -e "$dir" ] && problems+=("$dir exists")
  done
  for name in nginx apache2 httpd litespeed lshttpd openlitespeed lsws mysqld mariadbd mysqld_safe cpsrvd; do
    pgrep -x "$name" >/dev/null 2>&1 && problems+=("process '$name' is running")
  done
  if [ -d /var/www ] && [ -n "$(ls -A /var/www 2>/dev/null || true)" ]; then
    problems+=("/var/www exists and has content (a website)")
  fi
  if [ "${#problems[@]}" -gt 0 ]; then
    if [ "$NOT_FRESH_OK" -eq 1 ]; then
      warn "continuing despite these findings because --i-understand-this-is-not-a-fresh-server was given:"
      printf '[setup]   - %s\n' "${problems[@]}" >&2
      return 0
    fi
    printf '\n[setup] This does not look like a fresh, empty server:\n' >&2
    printf '[setup]   - %s\n' "${problems[@]}" >&2
    refuse "staging must run on its own NEW VPS that hosts nothing else. (Override for the checks above only: --i-understand-this-is-not-a-fresh-server, which is NOT for servers that host anything.)"
  fi
}

guard_os() {
  local id="" ver=""
  # shellcheck disable=SC1091
  id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  # shellcheck disable=SC1091
  ver="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
  [ "$id" = ubuntu ] && { [ "$ver" = 22.04 ] || [ "$ver" = 24.04 ]; } || refuse "Ubuntu 22.04 or 24.04 LTS required (found ${id:-unknown} ${ver:-?})."
}

PUBLIC_IP=""
guard_live_server_ip
guard_memory
guard_fresh_server
guard_os
log "safety guards passed"

# Marker: update.sh and teardown.sh refuse to run on a machine without it.
umask 022
{
  echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "repo_dir=$REPO_DIR"
  echo "domain=$STAGING_DOMAIN"
  echo "public_ip=$PUBLIC_IP"
} >"$MARKER_FILE"
chmod 644 "$MARKER_FILE"

# =====================================================================================================================
# 1. Base packages, swap
# =====================================================================================================================
export DEBIAN_FRONTEND=noninteractive
log "installing base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw openssl git >/dev/null

# 2 GB swapfile if the machine has no swap at all (next/payload need it on a 2 GB VPS). Idempotent.
if [ -z "$(swapon --show --noheadings 2>/dev/null || true)" ]; then
  log "no swap found: creating a 2 GB swapfile at /swapfile"
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -qE '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
else
  log "swap already present: $(swapon --show --noheadings | awk '{print $1":"$3}' | tr '\n' ' ')"
fi
echo 'vm.swappiness=10' >/etc/sysctl.d/99-churchtimes-swap.conf
sysctl -q -w vm.swappiness=10 >/dev/null

# =====================================================================================================================
# 2. Docker Engine + compose plugin from Docker's official apt repository
# =====================================================================================================================
if docker compose version >/dev/null 2>&1; then
  log "docker and the compose plugin are already installed"
else
  log "installing Docker Engine from download.docker.com"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  codename="$(. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "docker compose plugin is not working after installation."

# =====================================================================================================================
# 3. Firewall: only SSH, 80, 443
# =====================================================================================================================
ssh_ports="$( (sshd -T 2>/dev/null | awk '$1=="port" {print $2}') || true)"
[ -n "$ssh_ports" ] || ssh_ports=22
log "configuring ufw (ssh: $(echo "$ssh_ports" | tr '\n' ' '), 80, 443)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for p in $ssh_ports; do
  [ "$p" = 22 ] || warn "sshd listens on port $p: allowing it so you are not locked out."
  ufw allow "$p/tcp" >/dev/null
done
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
# NOTE: Docker-published ports bypass ufw. That is fine here: only Caddy publishes ports (80, 443). PostgreSQL, the
# CMS and the public host are NOT published; they are reachable only inside the compose network.

# =====================================================================================================================
# 4. Non-root deploy user and the repository checkout
# =====================================================================================================================
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  log "creating user $DEPLOY_USER (no password, no sudo, not in the docker group)"
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
  passwd -l "$DEPLOY_USER" >/dev/null
fi
deploy_home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$(dirname "$REPO_DIR")" 2>/dev/null || true
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$REPO_DIR"

sgit() {
  local key="$deploy_home/.ssh/id_ed25519" ssh_cmd=ssh
  [ -f "$key" ] && ssh_cmd="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  runuser -u "$DEPLOY_USER" -- env HOME="$deploy_home" GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$ssh_cmd" git "$@"
}

deploy_key_help() {
  local key="$deploy_home/.ssh/id_ed25519"
  if [ ! -f "$key" ]; then
    install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 700 "$deploy_home/.ssh"
    runuser -u "$DEPLOY_USER" -- ssh-keygen -q -t ed25519 -N '' -C "churchtimes-staging-deploy@$(hostname)" -f "$key"
  fi
  cat >&2 <<EOF

[setup] Could not clone $REPO_URL (private repository?).
[setup] Add this PUBLIC key as a READ-ONLY deploy key in GitHub (repository Settings > Deploy keys > Add deploy key,
[setup] leave "Allow write access" unticked), then run setup.sh again with:  --repo-url git@github.com:abcentech/churchtimes.git

$(cat "$key.pub")

EOF
  exit 1
}

if [ ! -d "$REPO_DIR/.git" ]; then
  log "cloning $REPO_URL"
  sgit clone --no-checkout "$REPO_URL" "$REPO_DIR" || deploy_key_help
else
  sgit -C "$REPO_DIR" remote set-url origin "$REPO_URL"
fi
sgit -C "$REPO_DIR" fetch --prune --tags origin '+refs/heads/*:refs/remotes/origin/*' || deploy_key_help
if sgit -C "$REPO_DIR" rev-parse -q --verify "refs/remotes/origin/$REPO_REF^{commit}" >/dev/null; then
  target="refs/remotes/origin/$REPO_REF"
else
  target="$REPO_REF"
fi
sgit -C "$REPO_DIR" rev-parse -q --verify "$target^{commit}" >/dev/null || die "ref '$REPO_REF' not found in $REPO_URL."
sgit -C "$REPO_DIR" checkout --force --detach "$target" >/dev/null 2>&1 || die "git checkout of '$REPO_REF' failed."
log "checked out $(sgit -C "$REPO_DIR" rev-parse --short=12 HEAD) ($REPO_REF)"

[ -f "$REPO_DIR/deploy/staging/common.sh" ] || die "deploy/staging is missing in ref '$REPO_REF'. Use --ref with a branch that contains the staging kit."
# shellcheck source=common.sh
. "$REPO_DIR/deploy/staging/common.sh"

# =====================================================================================================================
# 5. Settings and secrets (all generated here with openssl; none is ever printed)
# =====================================================================================================================
ENV_FILE="$STAGING_DIR/.env"
ENV_CMS="$STAGING_DIR/.env.cms"
ENV_PG="$STAGING_DIR/.env.postgres"
for f in "$ENV_FILE" "$ENV_CMS" "$ENV_PG"; do
  [ -f "$f" ] || install -m 600 -o root -g root /dev/null "$f"
done
chmod 644 "$ENV_FILE"

prompt_visible() { # prompt -> value on stdout (reads the terminal)
  local v
  [ -r /dev/tty ] || return 1
  printf '%s' "$1" >/dev/tty
  IFS= read -r v </dev/tty
  printf '%s' "$v"
}
prompt_hidden() { # prompt -> value on stdout, input not echoed, not in history
  local v
  [ -r /dev/tty ] || return 1
  printf '%s' "$1" >/dev/tty
  IFS= read -rs v </dev/tty
  printf '\n' >/dev/tty
  printf '%s' "$v"
}

# Turnstile SITE key (public).
[ -n "$TURNSTILE_SITE_KEY" ] || TURNSTILE_SITE_KEY="$(get_kv "$ENV_FILE" TURNSTILE_SITE_KEY)"
if [ -z "$TURNSTILE_SITE_KEY" ]; then
  TURNSTILE_SITE_KEY="$(prompt_visible 'Cloudflare Turnstile SITE key (public, starts with 0x4): ')" \
    || die "no terminal for the Turnstile site key prompt; pass --site-key KEY."
fi
[[ $TURNSTILE_SITE_KEY =~ ^[A-Za-z0-9_-]{8,64}$ ]] || die "the Turnstile site key has an unexpected shape."
[[ ! $TURNSTILE_SITE_KEY =~ ^[123]x0{10,} ]] || die "that is one of Cloudflare's dummy test site keys; create a real widget (README step 2)."

set_kv "$ENV_FILE" STAGING_DOMAIN "$STAGING_DOMAIN"
set_kv "$ENV_FILE" TURNSTILE_SITE_KEY "$TURNSTILE_SITE_KEY"
set_kv "$ENV_FILE" TURNSTILE_ACTION "$TURNSTILE_ACTION"
set_kv "$ENV_FILE" REPO_REF "$REPO_REF"
set_kv "$ENV_FILE" CMS_IMAGE "$CMS_IMAGE_REPO:$CMS_IMAGE_TAG"
[ -n "$(get_kv "$ENV_FILE" ACME_CA)" ] || set_kv "$ENV_FILE" ACME_CA "https://acme-v02.api.letsencrypt.org/directory"
set_kv "$ENV_FILE" SEED_CREDENTIALS_FILE "$CRED_FILE"
chmod 644 "$ENV_FILE"

# PostgreSQL credentials.
pg_pass="$(get_kv "$ENV_PG" POSTGRES_PASSWORD)"
[ -n "$pg_pass" ] || pg_pass="$(openssl rand -hex 24)"
set_kv "$ENV_PG" POSTGRES_USER churchtimes
set_kv "$ENV_PG" POSTGRES_DB churchtimes
set_kv "$ENV_PG" POSTGRES_PASSWORD "$pg_pass"

# CMS secrets: generated once, kept on re-runs (changing PAYLOAD_SECRET signs everyone out).
keep_or_generate() { # KEY BYTES
  local cur
  cur="$(get_kv "$ENV_CMS" "$1")"
  [ -n "$cur" ] || set_kv "$ENV_CMS" "$1" "$(openssl rand -hex "$2")"
}
keep_or_generate PAYLOAD_SECRET 32
keep_or_generate PREVIEW_SECRET 32
keep_or_generate IP_HASH_SALT 16
set_kv "$ENV_CMS" DATABASE_URL "postgres://churchtimes:${pg_pass}@postgres:5432/churchtimes"
unset pg_pass

# Turnstile SECRET: hidden prompt, stored only in .env.cms (mode 600).
is_dummy_turnstile() { [[ $1 =~ ^[123]x0{20,}AA$ ]]; }
cur_secret="$(get_kv "$ENV_CMS" TURNSTILE_SECRET_KEY)"
if [ -z "$cur_secret" ] || is_dummy_turnstile "$cur_secret" || [ "$ROTATE_TURNSTILE" -eq 1 ]; then
  new_secret=""
  if [ -n "${TURNSTILE_SECRET_FILE:-}" ]; then
    [ -r "$TURNSTILE_SECRET_FILE" ] || die "TURNSTILE_SECRET_FILE is not readable."
    IFS= read -r new_secret <"$TURNSTILE_SECRET_FILE" || true
  else
    new_secret="$(prompt_hidden 'Cloudflare Turnstile SECRET key (input hidden, never shown or logged): ')" \
      || die "no terminal for the hidden Turnstile secret prompt; use TURNSTILE_SECRET_FILE=/path (then delete that file)."
  fi
  [[ $new_secret =~ ^[A-Za-z0-9_-]{20,128}$ ]] || die "that does not look like a Turnstile secret key (expected 20-128 characters of A-Z a-z 0-9 _ -)."
  ! is_dummy_turnstile "$new_secret" || die "that is one of Cloudflare's dummy TEST secrets; production mode rejects it. Use the real secret of the widget created for $STAGING_DOMAIN."
  set_kv "$ENV_CMS" TURNSTILE_SECRET_KEY "$new_secret"
  unset new_secret
else
  log "keeping the stored Turnstile secret (use --rotate-turnstile to replace it)"
fi
unset cur_secret

# Origins and behaviour. Derived from STAGING_DOMAIN, so they always match the static builds.
public_origin="https://$STAGING_DOMAIN"
newsroom_origin="https://newsroom.$STAGING_DOMAIN"
cms_origin="https://cms.$STAGING_DOMAIN"
set_kv "$ENV_CMS" CMS_PUBLIC_URL "$cms_origin"
set_kv "$ENV_CMS" CMS_CORS_ORIGINS "$public_origin,$newsroom_origin"
set_kv "$ENV_CMS" CMS_CSRF_ORIGINS "$newsroom_origin,$cms_origin"
set_kv "$ENV_CMS" PUBLIC_SUBMISSION_ORIGINS "$public_origin"
set_kv "$ENV_CMS" TURNSTILE_ALLOWED_HOSTNAMES "$STAGING_DOMAIN"
set_kv "$ENV_CMS" TURNSTILE_EXPECTED_ACTION "$TURNSTILE_ACTION"
set_kv "$ENV_CMS" TRUST_PROXY true
set_kv "$ENV_CMS" TRUST_PROXY_HOPS 1
set_kv "$ENV_CMS" SCHEDULER_ENABLED true
set_kv "$ENV_CMS" PAYLOAD_DB_PUSH false
chmod 600 "$ENV_CMS" "$ENV_PG"
log "wrote $ENV_FILE, $ENV_CMS (mode 600) and $ENV_PG (mode 600)"

# Synthetic staff logins: passwords only in a root-only file (never printed).
if [ ! -s "$CRED_FILE" ]; then
  (
    umask 077
    {
      printf '{\n  "generatedAt": "%s",\n  "note": "SYNTHETIC staging staff logins. Root-only. Never copy into chat, issues or git.",\n  "users": {\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      first=1
      for key in admin editor-in-chief section-editor trusted-publisher reporter; do
        [ "$first" -eq 1 ] || printf ',\n'
        first=0
        printf '    "%s": {"email": "staging-%s@staging.invalid", "password": "Stg-%s", "role": "%s"}' "$key" "$key" "$(openssl rand -hex 12)" "$key"
      done
      printf '\n  }\n}\n'
    } >"$CRED_FILE"
  )
  chown root:root "$CRED_FILE"
  chmod 600 "$CRED_FILE"
fi

# =====================================================================================================================
# 6. GHCR login (private package). Read-only token, hidden input, stored by Docker in /root/.docker/config.json
# =====================================================================================================================
if [ "$RELOGIN_GHCR" -eq 1 ] || ! grep -qs '"ghcr.io"' /root/.docker/config.json; then
  ghcr_user="${GHCR_USER:-}"
  [ -n "$ghcr_user" ] || ghcr_user="$(prompt_visible 'GitHub username for ghcr.io: ')" || die "no terminal for the GHCR prompt; set GHCR_USER and GHCR_TOKEN_FILE."
  ghcr_token=""
  if [ -n "${GHCR_TOKEN_FILE:-}" ]; then
    [ -r "$GHCR_TOKEN_FILE" ] || die "GHCR_TOKEN_FILE is not readable."
    IFS= read -r ghcr_token <"$GHCR_TOKEN_FILE" || true
  else
    ghcr_token="$(prompt_hidden 'GitHub token with read:packages ONLY (input hidden, never shown or logged): ')" || die "no terminal for the GHCR token prompt."
  fi
  [ -n "$ghcr_user" ] && [ -n "$ghcr_token" ] || die "GitHub username and token are both required."
  # The token travels over a pipe built from a shell builtin: never in an argument list or the environment of a child.
  printf '%s' "$ghcr_token" | docker login ghcr.io -u "$ghcr_user" --password-stdin >/dev/null 2>&1 \
    || die "docker login ghcr.io failed (wrong user/token, or the token lacks read:packages)."
  unset ghcr_token ghcr_user
  log "logged in to ghcr.io (Docker stores the credential in /root/.docker/config.json; keep that file root-only)"
else
  log "already logged in to ghcr.io (use --relogin-ghcr to replace it)"
fi

# =====================================================================================================================
# 7. DNS sanity (warning only), static builds, images, migrations, seed, start
# =====================================================================================================================
for host in "$STAGING_DOMAIN" "newsroom.$STAGING_DOMAIN" "cms.$STAGING_DOMAIN"; do
  resolved="$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1; exit}' || true)"
  if [ "$resolved" != "$PUBLIC_IP" ]; then
    warn "$host resolves to '${resolved:-nothing}', not to this server ($PUBLIC_IP). Add the DNS A record first: Caddy cannot get its https certificate until it does."
  fi
done

log "building the public site and the newsroom (static files)"
"$STAGING_DIR/build-static.sh"

load_env
log "pulling images (the CMS image comes from GHCR: $CMS_IMAGE)"
dc pull --quiet postgres caddy public || die "pulling the base images failed."
dc pull --quiet cms || die "could not pull $CMS_IMAGE. Check: the GitHub Actions publish job has run, the token has read:packages, and the account can read the private package."

log "starting PostgreSQL and applying migrations"
dc stop cms public caddy >/dev/null 2>&1 || true
run_migrations

if [ "$SKIP_SEED" -eq 1 ]; then
  log "skipping the synthetic seed (--skip-seed)"
else
  log "seeding SYNTHETIC staff users and fixtures (idempotent)"
  dc --profile tools run --rm -T seed >/dev/null || die "the staging seed failed; run: docker compose --profile tools run --rm -T seed   (in $STAGING_DIR)"
fi

log "starting the stack"
dc up -d
wait_healthy cms 300
wait_healthy public 60

cat <<EOF

[setup] Done.

  public    https://$STAGING_DOMAIN
  newsroom  https://newsroom.$STAGING_DOMAIN
  CMS       https://cms.$STAGING_DOMAIN/admin

  Synthetic staff logins (generated, root-only; the file is NOT printed): $CRED_FILE
  Database backups go to: $BACKUP_DIR   (created by update.sh)
  Secrets: $ENV_CMS, $ENV_PG (mode 600).

  Next: follow "How to verify" in deploy/staging/README.md. Caddy obtains the certificates on the first request once the
  three DNS A records point at $PUBLIC_IP and ports 80/443 are reachable from the internet.
EOF
