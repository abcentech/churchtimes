# Old site hosts: `.org` and `.com` default to `.net`

Owner decision: `churchtimesnigeria.org` and `churchtimesnigeria.com` (and the `www.` forms of `.org`, `.com` and `.net`) all mean the primary host `https://churchtimesnigeria.net`. A path is never different on another host.

## What the CMS side does (done)

- The link rewriter, the link audit and the converter treat every one of those hosts exactly as the primary host: a link `https://churchtimesnigeria.org/<path>` becomes the root-relative `<path>` (the article path when the article is imported, otherwise the same path as written, so the link stays on `.net`).
- Configuration: `LEGACY_SITE_HOSTS` (comma list of bare host names; default `churchtimesnigeria.org,churchtimesnigeria.com`) and the primary host from `PUBLIC_SITE_URL` (default `churchtimesnigeria.net`). For `import:redirects`, `LEGACY_SITE_HOSTS` is the list of hosts a `legacyUrl` may carry; its default now includes `.net`, `.org`, `.com` and the `www.` forms.
- Path rules (`--redirects-out`, `import:redirects`) have no host, so the host default is NOT a path rule; it is the public host's job (below). `import:link-audit` prints a reminder when it writes `--redirects-out`.

## Paste-ready note for the public host (Codex lane: `tools/serve-public.mjs`, `LEGACY_SITE_HOSTS` in the relay)

> Any request whose `Host` is `churchtimesnigeria.org`, `churchtimesnigeria.com`, or the `www.` form of `.org`, `.com` or `.net` must get a `301` to `https://churchtimesnigeria.net` plus the SAME path and query string (for example `https://churchtimesnigeria.org/some-article/?a=1` goes to `https://churchtimesnigeria.net/some-article/?a=1`), BEFORE the exact and pattern redirect rules run, so that the path rules apply once, on the primary host. Take the host list from `LEGACY_SITE_HOSTS` (default: `.org` and `.com`, plus the `www.` forms), the target host from `PUBLIC_SITE_URL`, keep the scheme `https`, never redirect to a host that is not the configured primary, and never copy the incoming `Host` header into the `Location`. DNS for `.org`, `.com` and the `www.` names must point at the public host for this to be reachable.
