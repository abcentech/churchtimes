# Public frontend mappings to the merged CMS

Based on integration commit `ba1d653` (including merged #8/#9/#10) and the actual Payload submission endpoint,
article/category/media collections, and Lexical seed helper under `apps/cms`.
Changes are confined to public frontend adapters, rendering, tests and docs.
No backend file, authentication, approval workflow, initial migration, live event
or newsroom dashboard was modified.

`agent/cms-field-mappings` starts from the merged integration branch and incorporates
the pending public frontend through #5. It depends on #3/#4/#5 until those changes
are integrated. #1 and backend #6 are already merged. Existing PR branches remain
unchanged; update this branch against the integration branch after dependencies
merge, without merging or deploying automatically.

## Submissions

The actual anonymous endpoint is `POST /api/public/submissions`:

| Form value | CMS field |
| --- | --- |
| name/email/phone | name/email/phone |
| headline | title |
| story text | body |
| section suggestion | categorySuggestion (text, not category relationship ID) |
| optional location | location |
| normal reader honeypot | website: empty string |
| verification token | turnstileToken |

The browser sends no status, reviewer notes, role, reference or article approval
fields. Consent remains a required frontend acknowledgement; it is not a stored
field in this endpoint. Phone remains required by the existing public product UX,
although the CMS accepts it as optional. Story limits match the server: name
2–120, title 5–200, body 30–20,000, location up to 120, phone up to 40 characters.
Phone format still follows the public form's 7–15-digit rule. The serialized
request also respects the endpoint's 64KiB byte limit.

`201 { ok: true, reference, message }` confirms receipt; display the returned
reference only. The public page promises review, never publication. `ok: true`
without a reference, `ok: false`, malformed/empty receipt JSON and network/timeouts
do not become success. Legacy `accepted`/`pending` acknowledgements are rejected,
and a valid receipt must use HTTP 201.

Field errors are arrays (`errors: [{ field, message }]`), with known aliases
mapped back to inputs using safe local messages. No private server diagnostics
are echoed. Turnstile field failures are verification errors; a different 403 is
an unavailable/forbidden connection. 409 indicates an already-received submission,
413 an oversized request, 429 a cooldown using Retry-After when readable, and
missing/incompatible endpoints a configuration issue. Text is preserved on all
failures, with no automatic retries or fabricated receipts. Navigation cancellation
and timeouts remain distinct.

**Contact is a separate contract:** the CMS does not implement a contact endpoint.
An unconfigured contact form stays disabled with its email alternative. Do not
route contact enquiries into story submissions or invent a CMS endpoint.
`VITE_PUBLIC_CONTACT_URL` still explicitly opts into a separate service using
subject/message, with the same explicit 201 receipt requirement. `VITE_TURNSTILE_ACTION` defaults to `submit-story` and must match the backend.
Turnstile/site keys are
public configuration; no server secret enters the frontend.

## Published articles

Requests remain anonymous GETs with published-only filtering, depth=1, newest-first
ordering and pagination. Approved, scheduled, archived and draft records do not
render. Public view models map `category.title`, `bylineName`, `publishedAt`,
`featuredImage`, `content` and correction history. They do not derive bylines
from private `author` user records or render review notes.

Media relationships resolve their relative URL against the CMS origin, not the
Vite site. Same-origin `/api/media/file/` JPEG/PNG/WebP metadata with valid dimensions produces responsive
card/hero candidates, intrinsic dimensions, alt text, caption and credit.
Unpopulated IDs, malformed media and unsafe URLs produce no broken markup. Failed
images collapse without removing article text or corrections.

Lexical supports safe paragraphs, headings, lists, quotes, external HTTP(S)/mailto
links, bold/italic/underline/strike/code/subscript/superscript and populated media
upload nodes. Raw HTML, unsafe URLs and unsupported embeddings remain excluded.
Unpopulated upload/internal-link relationships are not guessed or fetched through
privileged routes. Existing depth/node bounds remain enforced. Corrections show
escaped public notes and valid server timestamps, never approval actions.

HTTP status, configuration, malformed JSON/shape, timeout, network and navigation
cancellation are distinguishable. Readers get a safe error description, retry
control and current-edition alternative. Pagination failures preserve earlier
reports. No failure substitutes fictional articles or private server responses.

## Validation boundary

`unit-tests/cms-submission-contract.test.js` imports and executes the actual merged
CMS endpoint and its validator/Turnstile logic, unchanged. Node 24's native type
stripping and a scoped extension resolver avoid adding backend dependencies.
Only persistence and the Siteverify HTTP transport are test doubles, in the
backend's existing test-only seam. It verifies the returned reference, stored
categorySuggestion/location and `new` status, duplicate/challenge failures and
field error arrays. It also renders content from the actual CMS Lexical seed
helper. This is stronger than a hand-written response fixture, but does **not**
claim a deployed PostgreSQL or real Cloudflare integration.

Browser regressions verify actual CMS-shaped receipts/errors, public bylines,
media/credits, corrections, malformed responses, permissions, narrow layouts,
keyboard and axe behaviour. The merged `npm run test:cms` suite additionally
starts a disposable local PostgreSQL database and exercises real Payload REST
handlers. Its Turnstile widget and Siteverify transport are test doubles; it
makes no claim about deployed Cloudflare verification. Backend sources and
workflows remain identical to the integrated base. Contact service configuration
and live external verification remain runtime prerequisites.

Validation on the updated integration: 33 unit/contract, 56 public, 42 newsroom,
34 form and 22 advertising checks passed, plus 6 real Payload REST/PostgreSQL
browser checks. Build, compiled export consistency and whitespace checks passed.
Ports 5185 and 5187 were used through temporary external configurations because
5175/5177 were occupied; committed test configurations and backend code were
unchanged. The Siteverify transport remains stubbed in these tests.

CMS-shaped public article screenshots (synthetic image/article fixture):
[desktop](cms-field-mappings/desktop.png) and
[Android-sized Pixel 7](cms-field-mappings/android.png). Existing homepage
screenshots and advertising contract remain in the #5 documentation.
