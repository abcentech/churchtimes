# Public story and contact forms

This work belongs to the public Vite site on `agent/codex-public-forms`.
It depends on **PR #1** (`agent/chatgpt-frontend`), which was still open when
this branch was created. Review this change after PR #1 or compare it directly
with that branch to isolate the forms work. Do not merge or change PR #1 as part
of this task. PR #2's newsroom app and Claude's CMS are untouched.

## Existing forms and new routes

The existing public forms were story-search controls. Contact, advertising and
publication updates used `mailto:`/telephone links, with no online delivery.
Those links and search behavior remain available.

- `#submit`: story/tip submission for editorial review, linked from the homepage,
  footer and mobile menu.
- `#contact`: a contact form below the existing published contact details.
- Both use labeled fields, required-field validation, an error summary with
  keyboard focus and links to invalid fields, inline errors, live status updates,
  loading indicators and repeat-click prevention.
- All submissions require review and are never automatically published. No
  article creation, publishing, accounts, dashboard changes or uploads are added.

## Public build-time configuration

Configure these values in `.env.local` for development or in the build environment.
Restart Vite/rebuild after changing them. Every `VITE_` value is public in the
browser bundle. **Never put a Turnstile secret or CMS credential in a VITE variable.**

| Variable | Purpose |
| --- | --- |
| `VITE_TURNSTILE_SITE_KEY` | Public Cloudflare Turnstile site key registered for the frontend hostname. Required for either online form. |
| `VITE_PUBLIC_SUBMISSIONS_URL` | Full anonymous story submission endpoint. Optional override of the CMS-derived default. |
| `VITE_PUBLIC_CMS_URL` | CMS origin; when no story override is set, derives `/api/public/submissions`. Also controls PR #1's article feed. |
| `VITE_PUBLIC_CONTACT_URL` | Full contact endpoint. Required independently; there is no assumed contact endpoint. |

Remote endpoints require HTTPS; HTTP is accepted only for loopback development.
Endpoint URLs containing credentials are rejected. If an endpoint or site key is
missing/invalid, sending is disabled with an email alternative, and Turnstile
is not loaded. No mock delivery or success is generated in application code.

Cloudflare's script is loaded only on a configured form:
`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`.
Frontend/network policy and CSP must permit the script and challenge frames at
`https://challenges.cloudflare.com` (including required connect access). Use
Cloudflare's current CSP guidance for the deployment; do not weaken the site's
policy globally. The widget uses explicit rendering, `public_story` or
`public_contact` actions, a flexible layout or compact mode below 300px, and
memory-only callbacks. Changing widget size, expiry or errors discards the token.
Navigating away removes the widget and aborts the client request.

## Provisional API contract: confirm with Claude

Only the sprint's `POST /api/public/submissions` endpoint was confirmed in docs.
No running backend, final field schema or contact contract was available.
All assumptions are isolated in `src/lib/public-submissions.js` and must be
confirmed before enabling real submissions.

Requests use anonymous JSON POST, `credentials: omit`, no authorization headers,
no-store caching and a 15-second timeout. The adapter makes no automatic retries.

Story payload:

```json
{
  "name": "Reader name",
  "email": "reader@example.test",
  "title": "Story subject",
  "category": "News",
  "body": "Plain text with source links",
  "consent": true,
  "turnstileToken": "opaque, single-use challenge token"
}
```

Contact payload: `name`, `email`, `subject`, `message`, `consent`,
`turnstileToken`. A contact message is not sent to the article endpoint.
There are no client-supplied workflow states, roles or privileges.
Categories are provisional human-readable labels; adjust the adapter if Claude's
backend requires relation IDs. Limits: name 100, email 254, title/subject 180,
body/message 12,000 characters; all fields and consent are required.

Expected responses:

- 2xx JSON with `accepted: true` or `status: "pending"` confirms receipt.
  Optional `reference` is displayed as text; the frontend never invents one.
- A 2xx response lacking confirmation is treated as unconfirmed, not success.
- 400/422 may return `errors` keyed by known field names. The UI maps them to
  local messages and does not echo raw server diagnostics or HTML.
- `code: "TURNSTILE_INVALID"` or `"TURNSTILE_EXPIRED"` requests a new challenge.
- 429 uses `Retry-After` (seconds or HTTP date; 60 seconds if absent) to disable
  sending during the waiting period. Cross-origin servers must expose that
  header through `Access-Control-Expose-Headers`.
- Network/timeout and unconfirmed responses preserve text in the current form
  and explain that receipt is uncertain. Readers are asked to contact the
  newsroom before resending to reduce duplicates. Duplicate-click prevention
  does not replace backend idempotency if receipt is lost.
- After every attempted POST the client discards the token and resets the
  challenge. A successful submission clears the form.

The backend must verify Turnstile **server-side**, using its secret and the
Cloudflare Siteverify API, including success, hostname and expected action.
Tokens expire and are single-use. Browser validation and challenge callbacks
are UX only, not security verification. Claude also owns server-side validation,
body limits, pending-only creation, rate limiting, origin/CORS/CSRF policy and
spam controls. No Siteverify requests or secret keys belong in this frontend.

## Privacy and verification

Submission text and tokens are not written to localStorage, sessionStorage,
cookies, analytics, logs or draft storage by the application. Text remains in
form controls during an error, and is cleared on success or route navigation.
Cloudflare has its own privacy terms, linked beside the widget. Browser autofill
is controlled by the reader's browser.

```bash
npm run test:unit
npm run test:forms -- --workers=2
npm test -- --workers=2
npm run test:newsroom -- --workers=2
npm run export:pages
npm run check:pages
```

The forms suite starts Vite on port 5175, uses Cloudflare's public test site key,
and **intercepts both the script and API with test doubles**. It covers validation,
keyboard errors, duplicate submits, expiry, loading/error/retry, rate limits,
network failures, receipt confirmation, contact routing, data cleanup, narrow
viewports and late widget loading. Standard tests verify the unconfigured forms
without any challenge or submission requests. PR CI runs both suites.

These tests do not prove real Cloudflare verification, server spam protection,
editorial receipt or publication. Live verification awaits Claude's backend,
a registered site key, suitable network/CSP/CORS configuration and an explicitly
approved test destination. No production WordPress changes or deployment occur.
