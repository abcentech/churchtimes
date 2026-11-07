# Go-live plan: from the old WordPress site to the new site, CMS and newsroom

Status: **a proposal for the owner to decide on. Nothing in this plan has been done by this document.** No DNS, hosting,
WordPress or database change is made by it. Every step that touches production needs the owner's explicit approval.
Refreshed 2026-11-07 against `feat/newsroom-mvp`.

This page is the short map. The detail is maintained in the documents it links to; do not copy it here.

## 1. Where things stand

| Part | State | Where the detail is |
| --- | --- | --- |
| Old WordPress site | Truehost VPS (1 CPU / 2 GB), also runs the domain's mail. **Compromised in October 2026** (root malware, database down). It is treated as untrusted. | [owner-security-hardening.md](../apps/cms/docs/owner-security-hardening.md), [backend-manual.md](../apps/cms/docs/backend-manual.md) section 16 |
| New public site | Node public host serving prebuilt pages, article path `/{slug}/` (decision D1 is settled). | [public-host-production.md](public-host-production.md), [public-article-paths.md](public-article-paths.md) |
| CMS and newsroom | Payload CMS + PostgreSQL and the newsroom app, merged into `feat/newsroom-mvp`. Production Docker setup, backups, restore drill and health endpoints are documented. | [operations.md](../apps/cms/docs/operations.md) |
| Content migration | Importer, rehearsal and uploads check exist. A real run needs the owner's WordPress export and uploads copy. | [owner-migration-runbook.md](../apps/cms/docs/owner-migration-runbook.md), [import.md](../apps/cms/docs/import.md) |
| Contracts (SEO, ads, newsletter, contact, comments, redirects) | Written in `go-live-contracts.md`; items land one by one. | [go-live-contracts.md](../apps/cms/docs/go-live-contracts.md), [go-live-build-spec.md](go-live-build-spec.md) |

The old server cannot host the CMS (1 CPU, 2 GB; the CMS needs 2 vCPU and 4 GB, see `operations.md` section 1). Do not
install anything on it, and rebuild or replace it on a clean machine.

## 2. Order of work (summary only)

1. **Rebuild the hosting.** New clean server for the CMS and public host, hardened per the hardening guide, secrets rotated,
   nightly off-server backups and one passed restore drill. Gate: health checks pass and the `operations.md` section 10
   security checklist is ticked.
2. **Migrate content.** Fresh WordPress export kept off the server, rehearsal on a throw-away machine, then staging import
   and the editor QA sample. Gate: the QA checklist in the runbook passes, redirect map has no unresolved top-traffic URLs.
3. **Soft launch on a subdomain.** Main address unchanged. Gate: written owner approval.
4. **Cutover and rollback.** Exactly as written in [owner-migration-runbook.md section 6](../apps/cms/docs/owner-migration-runbook.md#6-cutover)
   (lower TTL 48 hours before, change web records only, saved DNS records for rollback, 72-hour watch).
5. **After launch.** Keep the old site offline as a backup only. Monthly restore test and security updates, a named
   maintainer.

The owner's checklist, including the open decisions D2 to D8 and their written defaults, is
[backend-manual.md section 16](../apps/cms/docs/backend-manual.md#16-owner-go-live-checklist).

## 3. What must not happen

- No merge to `main`, no deploy, and no change to live DNS, WordPress, hosting, AdSense or a production database without
  the owner's explicit approval for that step.
- No mock success in live mode; mocked results are never reported as full end-to-end.
- No secrets and no real personal data in the repo or in chat.
- Do not change the domain's nameservers or its mail records (MX, SPF, DKIM) as part of this launch. Moving mail is a
  separate project.

## 4. Uptime monitoring (free tools only)

The monitor targets and alert rules are in [operations.md section 9.1](../apps/cms/docs/operations.md#91-health-endpoints-and-external-monitors)
and [owner-security-hardening.md section 9](../apps/cms/docs/owner-security-hardening.md). This is the short setup.

1. Create an account on a **free tier** of an outside uptime monitor (for example UptimeRobot or Better Stack), using a
   mailbox that more than one person can read. Check the provider's current free-plan limits and terms yourself; they change.
2. Add HTTPS monitors, checked every 1 to 5 minutes:
   - the CMS `https://<cms-host>/api/health/live` with keyword `ok`;
   - the CMS `https://<cms-host>/api/health/ready` with keyword `ready`;
   - the public home page, with a keyword check on a word that always appears (catches a blank page that still returns 200);
   - one article page and the newsroom login page.
3. Alert two people by email and one by phone push. Free plans limit the interval and the channels; if the free tier
   cannot do 1 minute, use 5.
4. For backups, use a free **heartbeat** monitor (for example healthchecks.io free plan): the nightly backup pings its URL
   when it finishes, and you are alerted if no ping arrives within 26 hours.
5. Disk (alert at 80 percent) and certificate expiry (alert 14 days ahead) are covered in `operations.md` section 9.1.
6. Verify once: stop the web service for a minute on a quiet night and confirm the alert reaches everyone.

The old WordPress site is not monitored: it is not a service to keep alive.

## 5. Next actions

1. Owner: choose hosting and the domain structure, and decide D2 to D8 (or accept the defaults).
2. Owner: provide the WordPress export and uploads copy through private storage (never GitHub).
3. Helper: build the new server and set up monitoring (section 4).
4. Both lanes: continue the items in [go-live-build-spec.md](go-live-build-spec.md).
