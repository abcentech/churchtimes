# Read-only archived comment components (Wave 3 B8 / P9)

Status: public component foundation against the proposed C6 contract. C6 is not implemented in this branch. The dedicated browser harness and all response fixtures are labelled **STUBS**. They prove renderer/transport behavior, not real anonymous access control, import reconciliation, publication filtering or CMS cross-app integration. No CMS/newsroom changes, production activation, owner decision, generated bundle, merge or deploy is included.

## Configuration and article integration

`VITE_PUBLIC_COMMENTS_URL` is an explicit public endpoint, for example `https://cms.example.test/api/legacy-comments`. Unset or invalid configuration returns no markup and makes no API request. The endpoint must use HTTPS except loopback development, contain no credentials/query/fragment and end in `/api/legacy-comments`. No endpoint is inferred from the ordinary article CMS setting.

`src/comments/public-comments.js` exports `commentsMarkup(articleId, config?)` and `bindPublicComments(root?, options?)`, which returns a disposer. The reader shell must dynamically import this module only when configured, insert its markup beneath an already resolved **published** CMS article body, and bind the new section. Do not insert it under static sample stories, unavailable articles, drafts, saved lists or live pages. Call the disposer on navigation and guard late imports against a changed route. This prerequisite component PR does not itself change `src/main.js`; the separately coordinated reader integration supplies that small hook.

Only positive safe-integer article IDs are accepted, matching this repository's PostgreSQL Payload relationships. Anonymous requests are GET with `credentials: omit`, no-store and no-referrer. They send the C6 query: `where[article][equals]`, `sort=commentedAt`, `limit=100`, `page=N`, `depth=0`. Each additional page requires a reader action; there is no background crawl or automatic retry. At most twenty pages can be requested, with an explicit truncation message at that cap. Invalid/looping pagination fails instead of silently dropping comments. Duplicate IDs are displayed once.

## Projection and privacy

The normalizer constructs exactly `{id, authorName, content, commentedAt, parentLegacyId}`. It never copies email, IP, website, staff fields, arbitrary objects or API error text. The C6 anonymous projection omits `status`, so its absence is accepted; when `status` is supplied, only `approved` is accepted. IDs and dates must be valid. Author names and body text are bounded to the contract lengths. The CMS remains responsible for returning only approved comments attached to a published article; a browser query cannot replace that access-control proof.

The DOM uses `textContent` for names and bodies, preserves body line breaks, and never creates links or HTML from comment text. It makes no storage writes and contains no submission form or third-party loader. Date labels use Africa/Lagos. Errors and malformed responses produce a compact, honest unavailable notice rather than a false empty archive; an actually empty valid response says no archived comments are available. A partial invalid page is labelled as incomplete. Existing displayed comments survive a later page failure. An explicit retry is available, subject to a bounded Retry-After cooldown (up to 86,400 seconds). Reads time out after six seconds, including stalled response bodies, and navigation aborts them.

## Threading contract limitation

C6 exposes a new CMS `id` and `parentLegacyId`, but omits the legacy ID of each returned comment. Those identifiers cannot be joined reliably. This renderer therefore shows a chronological **flat** list (depth one, safely below the maximum depth two), retaining only the permitted parent identifier in its in-memory model. It does not invent a parent relationship or expose a private legacy export. Nested threads require a reviewed public mapping such as each comment's `legacyId` or an actual public parent relation. This is a contract follow-up, not a reason to invent fields or change the CMS lane.

## Validation

Run `node --test unit-tests/public-comments.test.js` and `npx playwright test --config playwright.comments.config.js`. The isolated harness uses port 6194 and its own HTML entry, with synthetic comments and stubbed responses. It checks anonymous query/pagination, projection privacy, omitted status, hidden rows, invalid dates/IDs, malformed/oversized responses, timeout/cancellation, empty and HTTP failure states, one explicit retry, XSS-as-text, absence of email fields, line breaks, keyboard focus, axe WCAG/best-practice rules and desktop/Pixel 7 overflow. Dedicated CI runs these checks.

The source-only build policy depends on PR #57. Compiled site exports remain for the dedicated rebuild after approved integration; no committed-export freshness is claimed here.
