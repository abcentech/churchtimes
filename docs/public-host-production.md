# Draft public Node host kit (Wave 3 A10)

This is a reference for owner review, not a production installation or a D2
hosting decision. Nothing has been provisioned, started as a service, deployed,
or changed on WordPress, DNS, mail or `main`. The kit depends on the public
routing host from PR #50 (including its local reload hook) and the source-build
policy from PR #57. It does not run the CMS or newsroom.

## Runtime and build

Use the repository's pinned Node major (`.nvmrc`, currently 24). Build from the
reviewed source with `npm ci` and `npm run build`; serve `dist`, not a mixture
of stale committed bundles and new source. The existing source validator checks
that the actual compiled assets are local and present. The final committed
Pages export remains a separate dedicated rebuild PR.

`tools/public-host.mjs` is the runtime entry point. It requires an explicit
`PUBLIC_SITE_URL`, binds only to loopback, defaults to staging noindex, validates
the compiled build, pins the resolved immutable build path for the life of the process, waits for
the initial redirect generation, and provides a
bounded graceful stop. It never installs a service or changes the network.
The proposed file layout is:

| Path | Purpose |
| --- | --- |
| `/opt/churchtimes-public/releases/<reviewed-sha>/` | Immutable reviewed code and build; readable by the public service user |
| `/opt/churchtimes-public/current` | Operator-controlled link to the selected release |
| `/etc/churchtimes/public-host.env` | Private runtime configuration, readable only by the operator/service group |
| `/etc/churchtimes/private/redirects.json` | Optional private validated C7 map, outside the web root and Git |

The operator must create/protect these paths on the approved host; this task
has not done so. Do not put real map files, URL inventories, tokens or exports
in GitHub, browser fixtures or CI artifacts. The sample env contains synthetic
origins and no secrets. Prefer mode `0600`, or `0640` with the dedicated service
group, for private configuration/maps. Application code and builds remain
read-only to the runtime account.

## Runtime configuration

| Setting | Default / rule |
| --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `5373`; loopback only. Port `0` is supported only for disposable smoke tests. |
| `PUBLIC_DIST` | `dist` relative to the working directory; must contain a complete actual build. |
| `PUBLIC_SITE_URL` | Required bare HTTPS origin, or loopback HTTP for local tests. It controls public canonical URLs. |
| `PUBLIC_CMS_URL` | Approved anonymous CMS API origin; HTTPS or loopback HTTP, no credentials. Unset means genuine unavailable states, not sample success. |
| `PUBLIC_BASE_PATH` | `/`; a mount prefix is supported, but newsletter email-link hosting requires the public root per C4. |
| `PUBLIC_INDEXABLE` | Only exact `true` permits indexing; everything else remains staging/noindex. Owner approval is required before setting it. |
| `PUBLIC_ARTICLE_PATH_TEMPLATE` | `/reports/{slug}/`; `/{slug}/` is available only after the owner settles D1. |
| `PUBLIC_REDIRECTS_FILE` | Optional absolute private C7 map path. The file takes precedence over a configured endpoint. |
| `PUBLIC_REDIRECTS_URL` | Optional reviewed `/api/public/redirects` endpoint. No inferred network endpoint. |
| `PUBLIC_REDIRECT_ALLOWED_HOSTS`, `REDIRECT_ALLOWED_HOSTS` | Must agree when both exist, and match the CMS allowlist. No external target is inferred. |
| `PUBLIC_REDIRECT_PATTERNS` | Unset; proposed category/tag/author/AMP targets stay inactive until approved. |
| `PUBLIC_HOST_SHUTDOWN_MS` | 10000; bounded 1000–60000 ms. The reference unit allows 20 seconds for shutdown; increase that unit limit if the approved runtime deadline is raised above it. |
| `PUBLIC_ADS_TXT_LINE`, `PUBLIC_SEARCH_CONSOLE_VERIFICATION` | Unset. Supply only reviewed owner values; this kit introduces no advertising or analytics script. |

CMS credentials, provider keys, SMTP details and Turnstile secrets do not belong
in this public process. Build-time `VITE_*` settings are public and must retain
all existing configuration/consent gates; this kit does not enable any of them.

## Start, health, refresh and stop

The smoke test starts the actual runtime using the same Node env-file entry
point shown here, with a temporary env file and a disposable local build. For a
manual disposable run, set `public_env_file` to that local test configuration:

```sh
node --env-file="$public_env_file" tools/public-host.mjs &
public_host_pid=$!
node --env-file="$public_env_file" tools/public-host-health.mjs
kill -HUP "$public_host_pid"
kill -TERM "$public_host_pid"
wait "$public_host_pid"
```

The readiness event contains only the actual listening port. The health command
uses local `/robots.txt`, checks staging indexing protection, and does no CMS
request. For indexable mode it requires Allow and Sitemap lines. With a mount,
the health command uses `PUBLIC_BASE_PATH`; adjust the reference Caddy health URI
to the same prefix. Health means this public process can answer a cheap route;
it does not prove CMS readiness, editorial functionality or launch approval.

SIGHUP invokes the existing in-process redirect refresh without restarting the
HTTP listener or adding an HTTP administration route. Existing requests keep
working. Replace the private map atomically in its own directory, preserving
permissions, then request refresh and rerun redirect checks. A refresh-finished
message means the attempt finished; inspect the counted
`public_redirect_refresh_failed` warning and actual expected redirects before
accepting a generation. Invalid files retain the last good map. The normal
background refresh also remains active. SIGHUP does not reread env/build-time
settings; changing those requires an approved process restart.

SIGTERM/SIGINT stop accepting connections and drain active work. Idle keepalive
connections close immediately; the configured deadline closes remaining HTTP
connections and marks an unclean drain as a failure. Fixed runtime events and
counted warnings omit map paths, publisher IDs and response bodies.

## Reverse proxy and service references

`deploy/public-host/Caddyfile` and `churchtimes-public.service` are **drafts**.
The Caddy reference terminates TLS and proxies only to the loopback Node process.
It retains Node cache headers, adds `Referrer-Policy: no-referrer`, and configures
no request/access log, since newsletter query strings can hold private tokens.
Keep the existing application CSP/consent policy; do not invent a weaker proxy
CSP or blanket-cache HTML and errors. Hashed assets are immutable; HTML/errors
remain no-store, robots/ads use their short server cache, and redirects retain
their existing short cache. CMS availability is deliberately not a proxy health
condition.

Before any installation, the owner/operator must settle D2, replace the
synthetic hostname, validate TLS/origin/CMS access on that host, provision the
dedicated unprivileged account, and confirm the installed absolute Node path.
The reference systemd unit uses `/usr/bin/node`; this sandbox uses a different
Node path. A disposable unit copy with only that executable path substituted
passed `systemd-analyze verify`; the original production path is not verified
here. Caddy is not installed in this environment, so Caddy configuration syntax
and TLS provisioning remain pending validation with the selected version.
No privileged service manager or DNS command was executed.

## Validation and remaining gates

```sh
node --test unit-tests/public-host-kit.test.js
```

This builds the actual frontend into a temporary directory, starts the actual
Node host through `--env-file`, exercises the CLI health command, ads GET/HEAD,
cache/noindex/security headers, one-hop/410 synthetic redirects, atomic valid
and invalid map reloads, the quiet cutover CLI, explicit-target refusal and
SIGTERM cleanup and build pinning across a release-link change. A labelled local CMS **STUB** counts calls: these routes make
zero CMS requests. No real CMS integration or owner staging result is claimed.
The installed systemd analyzer checks a disposable reference-unit copy; there
is no service installation.

Owner review, D1/D2, real staging commands and cross-app journeys, actual TLS,
resource sizing, monitoring, operational ownership and production approval
remain outstanding. Follow the separate public cutover runbook after those
prerequisites are approved.
