# Public live coverage — CMS contract from PR #25

Branch `agent/public-live-coverage` starts from integrated `d2ae1c7` after #22/#25
merged. It adds the public reading interface and retires L6b's expected-failure
marker. Backend source, staff UI, authentication, approvals, initial migrations and
live-event management stay unchanged. The only `apps/cms` change is the existing
public UI regression in `e2e/cross-app/07-live-coverage.spec.ts`.

## Routes and interface

- `#live` discovers live/ended events and opens the newest active event, or the
  newest ended archive when none is live. Event links provide explicit selection.
- `#live/<slug>` opens a particular event. Desktop navigation, mobile menu and
  footer expose live coverage. Missing CMS configuration has an honest fallback.
- Discovery is `GET {CMS}/api/live-events?where[status][in]=live,ended&sort=-startedAt`
  with depth=0, a 12-event page and normal Payload next-page fields.
- Updates are `GET {CMS}/api/live-events/:slug/updates?since=0&limit=50`, yielding
  `{event,docs:[{id,sequence,body,occurredAt,approvedAt}],nextSince}`. The wire
  sequence is **publication order**, not creation time or occurrence time. A late
  approval remains reachable after the cursor has passed its creation sequence.
- The adapter validates slugs, public event states and monotonic publication
  cursors; it whitelists fields and renders update bodies through `textContent`.
  HTML-looking text stays literal. No author, approver, review notes or staff fields
  are displayed. A draft/missing event is a 404, never fabricated public coverage.
- Existing CMS URLs use `VITE_PUBLIC_CMS_URL`; no new environment values or secret
  are needed. All live reads are GETs with `credentials: omit`, no token/cookie
  headers, a six-second timeout and the existing HTTPS/loopback URL policy.

## Refresh behavior

One selected event is read at a time, with no overlapping reads. Live events poll
every 15 seconds; a full 50-update batch drains incrementally at one-second intervals.
Publication IDs/sequences deduplicate responses, and updates append without
replacing the timeline or moving keyboard focus. An accessible status announces
new counts, while timestamps show publication time (occurrence time fallback) in WAT.

Readers can pause/resume, refresh manually and load more published batches. Hidden
tabs stop polling; returning resumes it. Navigation aborts outstanding reads and
removes timers/listeners. Ended events stop automatic polling but keep their
archives and manual batch/refresh controls. HTTP/JSON/network failures retain
published updates, show safe messages and use bounded retry backoff; 429 respects
Retry-After. A newly unavailable event clears its visible timeline/cursor and stops polling;
manual retry can reload it if the event becomes public again.

The feed is an append/publication cursor contract. Existing-row edits/retractions
are not an additional server-supplied change stream; no such API or staff workflow
is invented here. The public page performs no editorial writes or approvals.

## Validation

```bash
npm ci
npm ci --prefix apps/cms
npm run test:unit
npm run test:cms
npm test -- --workers=2
npm run test:newsroom -- --workers=2
npm run test:forms -- --workers=2
npm run test:advertising -- --workers=2
npm run export:pages
npm run check:pages
```

43 unit/contract, 58 public browser, 58 newsroom, 34 form, 22 advertising and
18 real CMS/PostgreSQL browser checks passed (233 total). Targeted live browser
checks were repeated after the final accessibility/error-state fixes. Build/export
consistency, whitespace and CMS TypeScript checks passed. Local public/forms suites
used temporary port-only configs (5293/5295) to avoid existing servers; CI uses
normal committed configs. No tests were skipped or marked expected-failure in this
public change.

The live acceptance test creates synthetic live/draft/ended events using real
Payload collection hooks in a disposable PostgreSQL database. It approves an older
pending update through the actual staff PATCH handler, then checks the real anonymous
feed and rendered order 1/2/3, deduplication, pending/rejected/draft hiding, ended
archives, overflow and axe WCAG checks on desktop and Android-sized Pixel 7.
No live API responses or persistence are mocked in that lane. The inherited form
checks use a test widget/Siteverify transport seam; live coverage needs neither.
The harness is loopback/NODE_ENV=test guarded and cleans up synthetic records.

L6b in the existing cross-app lane now asserts real public UI success at `#live`
without `test.fail`. Its staff journeys and permissions assertions are retained.
The full external-provider/cross-browser cross-app lane is separately reproducible
from `apps/cms` with `npm run test:e2e:cross-app`; it is not counted in these results.
The local harness mounts the actual Payload REST handlers, not the deployed Next
proxy. Production TLS, physical devices/Safari and live Cloudflare remain outside
this test claim.

## Screenshots

Synthetic events and update bodies, no production data:

| State | Desktop | Android-sized Pixel 7 |
| --- | --- | --- |
| Live, delayed approval appended | [image](public-live/live-desktop.png) | [image](public-live/live-mobile.png) |
| Ended archive | [image](public-live/ended-desktop.png) | [image](public-live/ended-mobile.png) |

Refresh evidence intentionally with `CAPTURE_PUBLIC_LIVE=1 npm run test:cms`.
Normal CI does not rewrite screenshots.

This is the requested hash-route reading page, requiring JavaScript; article SSR
from #22 is unchanged. No live-feed SSR/SEO deployment claim is made. Main,
production WordPress, DNS, VPS, AdSense and other PR branches remain untouched.
No automatic merge or deployment.
