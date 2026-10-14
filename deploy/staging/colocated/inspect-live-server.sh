#!/usr/bin/env bash
# READ-ONLY inspection of the live web server (158.69.36.54), run BEFORE deciding whether a small,
# capped, on-demand staging can share it. This script changes nothing:
#   - no installs, no writes outside stdout, no service restarts, no firewall or config changes;
#   - it never prints passwords, environment variables, config file contents or process arguments
#     (process NAMES only), so the report is safe to share with Claude Code.
# Run it at a normal-to-busy time of day. It takes about 1 minute (it samples load for 60 s).
#
# From Git Bash on your PC, in the repository folder (you type the SSH password yourself; it is never stored):
#   ssh root@158.69.36.54 "tr -d '\r' | bash -s" < deploy/staging/colocated/inspect-live-server.sh > live-server-report.txt
# Or paste this whole file into the VPS panel's web console as root and copy the output.
# Then send live-server-report.txt (or the copied output) to Claude Code.
set -u
export LC_ALL=C

section() { printf '\n===== %s =====\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
run() { timeout 20 "$@" 2>&1 || true; }

section "identity"
echo "date_utc: $(date -u +%FT%TZ)"
echo "user: $(id -un) (uid $(id -u))"
. /etc/os-release 2>/dev/null && echo "os: ${PRETTY_NAME:-unknown}"
echo "kernel: $(uname -r)  arch: $(uname -m)"
echo "virtualization: $(systemd-detect-virt 2>/dev/null || echo unknown)"
echo "cgroup: $(stat -fc %T /sys/fs/cgroup 2>/dev/null) (cgroup2fs = v2, supports per-service memory caps)"
echo "uptime/load: $(uptime)"

section "cpu"
echo "cpus: $(nproc)"
run grep -m1 'model name' /proc/cpuinfo

section "memory (MB)"
run free -m
echo "swap devices:"; run swapon --show
echo "swappiness: $(cat /proc/sys/vm/swappiness 2>/dev/null)"

section "load sample: vmstat every 5 s for 60 s (si/so = swapping, wa = disk wait, id = idle CPU %)"
run vmstat -S M 5 13

section "top 15 processes by memory (name only, RSS MB)"
ps -eo rss=,pcpu=,user=,comm= --sort=-rss 2>/dev/null | head -15 | awk '{printf "%7.0f MB  cpu %5s%%  %-12s %s\n", $1/1024, $2, $3, $4}'

section "memory by program (sum of RSS MB)"
ps -eo rss=,comm= 2>/dev/null | awk '{m[$2]+=$1} END {for (c in m) printf "%7.0f MB  %s\n", m[c]/1024, c}' | sort -rn | head -12

section "past out-of-memory kills (kernel log)"
if have journalctl; then
  echo "count: $(journalctl -k --no-pager -q 2>/dev/null | grep -ciE 'out of memory|oom-kill' || true)"
  journalctl -k --no-pager -q 2>/dev/null | grep -iE 'out of memory|oom-kill' | tail -5 | cut -c1-160
else
  echo "count: $(dmesg 2>/dev/null | grep -ciE 'out of memory|oom-kill' || true)"
fi

section "memory history today (sysstat, if installed)"
if have sar; then run sar -r | tail -8; else echo "sysstat not installed (fine)"; fi

section "disk"
run df -h -x tmpfs -x devtmpfs -x overlay
echo "inodes:"; run df -i /

section "listening TCP ports (address:port and program)"
run ss -ltnpH | awk '{print $4, $6}' | sed -E 's/users:\(\("([^"]+)".*/\1/' | sort -u

section "web server and control panel detection"
for d in /usr/local/lsws /usr/local/CyberCP /usr/local/cpanel /usr/local/directadmin /usr/local/psa /usr/local/hestia /usr/local/vesta /etc/nginx /etc/apache2 /etc/httpd; do
  [ -e "$d" ] && echo "present: $d"
done
[ -x /usr/local/lsws/bin/lshttpd ] && echo "litespeed: $(/usr/local/lsws/bin/lshttpd -v 2>&1 | head -1)"
[ -f /usr/local/lsws/VERSION ] && echo "lsws VERSION file: $(cat /usr/local/lsws/VERSION)"
echo "litespeed vhost names (names only):"
ls -1 /usr/local/lsws/conf/vhosts 2>/dev/null | head -30
echo "running services of interest:"
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null \
  | awk '{print $1}' | grep -iE 'lsws|lshttpd|litespeed|openlitespeed|apache|httpd|nginx|mysql|mariadb|postgres|php|redis|memcached|docker|containerd|cpanel|cyberpanel|lscpd|directadmin|fail2ban|csf|lfd|firewalld|ufw|pure-ftpd|postfix|exim|dovecot|named|pdns' || true

section "databases and runtimes already installed"
have mysql && echo "mysql client: $(mysql --version 2>&1 | head -1)"
have mariadb && echo "mariadb client: $(mariadb --version 2>&1 | head -1)"
have psql && echo "postgres client: $(psql --version 2>&1)" || echo "postgres: not installed"
have node && echo "node: $(node --version 2>&1)" || echo "node: not installed"
have docker && echo "docker: $(docker --version 2>&1)" || echo "docker: not installed"
ls -1d /usr/local/lsws/lsphp* 2>/dev/null | sed 's#.*/#php build: #'

section "firewall (summary only)"
have ufw && run ufw status | head -15
have firewall-cmd && run firewall-cmd --list-all
have csf && echo "csf: installed"
echo "iptables rules: $(iptables -S 2>/dev/null | wc -l) ; nftables tables: $(nft list tables 2>/dev/null | wc -l)"

section "mail on this server? (ports 25/465/587/993)"
ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E ':(25|465|587|993)$' || echo "no mail ports listening"

section "backups / snapshots visible on the server (names only)"
ls -1d /backup* /home/backup* /var/backups/* 2>/dev/null | head -10 || true

section "done"
echo "Read-only inspection finished. Nothing was changed."
