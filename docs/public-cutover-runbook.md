# Draft public cutover runbook (Wave 3 A11)

**Pending owner review and real staging execution.** This is a reviewable public
lane plan, not authorization to deploy, switch DNS, change WordPress, merge to
`main`, activate scripts or touch a production database. The owner chooses the
operator and separately approves soft launch and cutover. Claude owns CMS data,
credentials, backups/restore and newsroom acceptance. Codex owns the public host,
redirect/rendering checks and evidence; neither lane executes the other's work.

## Before an owner-approved soft launch

1. Record the chosen D1 article URL template and D2 host, approved staging and
   final public origins, operator, rollback authority and monitoring contact.
   Keep `/reports/{slug}/` and staging noindex until those choices are made.
2. Finish and review the public feature PRs and CMS contracts; perform one
   dedicated generated-site rebuild after source integration. Record exact
   release commits privately. Green stub tests do not satisfy real CMS gates.
3. Claude supplies a validated private migration/redirect generation and proves
   database **and media** restore, real anonymous endpoints, staff journeys and
   key/origin setup. No real exports, private URL lists or personal data go into
   GitHub or public evidence.
4. The operator prepares the draft Node/Caddy/service kit on the selected host,
   validates its installed executable/TLS/configuration, and records resource
   limits and restart/rollback behavior. Keep staging `PUBLIC_INDEXABLE=false`,
   AdSense/analytics/push inactive until their separate approvals, and no public
   access logs containing newsletter tokens.
5. Before a future DNS switch, the DNS operator records the **existing** A/AAAA
   values and TTLs and proposes an owner-approved lower TTL early enough for
   the old TTL to expire. Do not alter MX, mail routing or nameservers. No TTL
   or address change has been executed by this task.

## Disposable rehearsal and then real staging

The automated host-kit smoke test exercises the following Node entry point,
local health command and quiet redirect checker against a temporary local host
with synthetic inputs. This is a **CMS STUB rehearsal**, not the owner's staging.
The owner/operator must repeat the appropriate commands on real staging and
record their results privately before accepting this runbook.

```sh
node --test unit-tests/public-host-kit.test.js
node --env-file="$public_env_file" tools/public-host.mjs &
public_host_pid=$!
node --env-file="$public_env_file" tools/public-host-health.mjs
node tools/check-redirects.mjs --target "$approved_public_origin" --urls "$private_checks_file" --rate 2 --quiet
```

Variables above are explicit operator inputs, never production defaults.
`public_env_file` is outside Git with restricted permissions;
`approved_public_origin` is the explicitly approved rehearsal/staging origin;
`private_checks_file` is the private old-path/title/status inventory. The checker
refuses a missing target and logs only aggregate counts in quiet mode. Use the
full private inventory (at least the agreed legacy sample and top traffic
paths) on real staging; do not substitute the two synthetic smoke rows for that
inventory. No tool has been run against a real public target here.

On real staging, independently verify homepage/latest/article/live on desktop,
Pixel 7 and keyboard; canonical/share/schema/feed/sitemap consistency for the
chosen path; anonymous CMS-backed article/media behavior; clean 404/410 and
exactly one redirect hop, including no-slash/non-ASCII/AMP approved mappings.
Verify genuine 429/503/error states, consent withdrawal, and owner-enabled
newsletter/contact journeys in Claude's real cross-app lane. Check that no
private fields or action tokens appear in logs/evidence. Owner phone sign-off,
Caddy/TLS checks and CMS recovery evidence remain mandatory human gates.

## Private map refresh and release changes

Publish a prevalidated map by an atomic same-directory file replacement while
preserving ownership/permissions. Keep the previous validated generation
privately. Then request refresh, check the counted failure warnings and rerun
health plus the full quiet redirect inventory:

```sh
kill -HUP "$public_host_pid"
node --env-file="$public_env_file" tools/public-host-health.mjs
node tools/check-redirects.mjs --target "$approved_public_origin" --urls "$private_checks_file" --rate 2 --quiet
```

These operations are tested with valid and malformed synthetic files; malformed
reloads retain the last good map. A finished refresh event does not certify a
new generation. An approved change to origin, indexability, build or runtime
configuration needs a process restart, not SIGHUP. In the foreground/disposable
rehearsal, graceful shutdown is:

```sh
kill -TERM "$public_host_pid"
wait "$public_host_pid"
```

The reference service manager would perform equivalent signals; installing or
controlling it on a real host is a separately approved operator action.

## Owner-approved soft launch and eventual cutover

The owner accepts real staging evidence before the operator exposes the soft
launch subdomain. Keep it non-indexable, run the complete private redirect and
public/CMS acceptance checks again through the actual TLS proxy, and observe a
full agreed period with staff. Do not enable external scripts merely because a
public environment variable exists.

For the later cutover, the owner explicitly approves the origin/address switch,
chosen URL template, CMS write/migration plan and rollback window. The DNS
operator changes only the approved web A/AAAA records; mail and nameservers stay
unchanged. The public operator selects the reviewed release/config/map, checks
health and the full redirect list against the explicitly approved final origin,
and verifies final canonicals/feeds before enabling indexing under the owner's
instruction. Recheck both old and new DNS answers during propagation, TLS,
robots/sitemap and the known owner-approved article/media samples. No such
switch or indexing change has been made by this task.

## Rollback and observation

Agree the rollback trigger and authority **before** the window. Triggers include
failed health/TLS, wrong canonicals/origin, redirect loops or missing important
paths, elevated public 5xx/CMS failures, broken article/media rendering, consent
leaks or a failed owner/staff journey. A cheap healthy robots response alone is
not sufficient to continue a broken launch.

Rollback commands (the operator runs them on the public host; paths follow `docs/public-host-production.md`; <previous-sha> is the recorded last good release):

```sh
# 1. Switch the release link atomically (keep the old target recorded before the window).
ln -sfn /opt/churchtimes-public/releases/<previous-sha> /opt/churchtimes-public/current.next
mv -T /opt/churchtimes-public/current.next /opt/churchtimes-public/current
# 2. Restore the matching reviewed env file and private redirect map (atomic same-directory rename), then RESTART.
#    A reload (SIGHUP) is not enough: the process pins its build's real path at start and reads env only at start.
sudo systemctl restart churchtimes-public
# 3. Verify before telling anyone it is back.
systemctl is-active churchtimes-public
node tools/public-host-health.mjs                        # local health (robots, nosniff, indexing policy)
node tools/check-redirects.mjs --target https://<final-hostname> --urls <private-checks.json> --rate 2 --quiet
curl -sI https://<final-hostname>/ | grep -i -E '^(HTTP|x-frame-options|content-security-policy|x-robots-tag)'
```

The restart drops in-flight requests after the drain deadline (`PUBLIC_HOST_SHUTDOWN_MS`, default 10 seconds). A rollback is complete only when the
health check passes, the redirect checks report zero failures, the canonical address and `X-Robots-Tag` match the intended state, and the owner or
staff journey is repeated. CMS and database rollback stay with Claude (data-loss tradeoff).

DNS TTL rule. Record the current TTL of every web A/AAAA record before the window. At least one full old TTL before the cutover, the DNS operator
lowers the web records to 300 seconds (5 minutes); the cutover and the rollback window run at 300 seconds. If the approved web DNS switch itself is
reverted, the DNS operator restores only the recorded web address values (mail and nameservers are never touched) and the old WordPress service must still be
running; clients follow within about one TTL. Return the TTL to its recorded normal value (or 3600 seconds when none was recorded) only after the owner
releases the rollback gate, and keep the old WordPress service until then.

Monitor public status/latency, redirect failure counters and agreed missing-path
counts, CMS availability, host memory/restarts, TLS and owner/staff reports.
Use aggregate metrics; never upload real reader submissions, tokens or private
URL inventories. Record who accepted each gate and any unresolved issue in
private operations records. Restore normal TTLs or retire the old host only
under a further explicit owner instruction.

## Acceptance still pending

The owner has **not** reviewed/accepted this runbook, selected production hosting,
approved DNS/TTL changes or launch, or signed off real staging commands. Caddy
syntax/TLS verification and the reference unit's production Node path remain
pending on the chosen host. The local synthetic rehearsal proves tooling
behavior only. A11's owner-review and real-staging acceptance gates remain open.
