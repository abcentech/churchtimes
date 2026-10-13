# Public submissions and contact forms

The Vite `#submit` form implements the merged CMS contract v1.2:
[API contracts](../apps/cms/docs/api-contracts.md) and
[frontend integration notes](../apps/cms/docs/frontend-integration.md).
All public story submissions require editorial review. They are stored as `new`
and never published automatically. Conversion creates a draft; approval and
publication require authorized staff. No newsroom dashboard code is changed.

## Configuration

Set public values in `.env.local` for development or in the Vite build environment:

| Variable | Purpose |
| --- | --- |
| `VITE_PUBLIC_CMS_URL` | CMS origin for published articles and default `/api/public/submissions`. |
| `VITE_PUBLIC_SUBMISSIONS_URL` | Optional full story-endpoint override, e.g. a same-origin reverse proxy. |
| `VITE_TURNSTILE_SITE_KEY` | Public Cloudflare site key registered for the frontend hostname. |
| `VITE_TURNSTILE_ACTION` | Public action metadata; defaults to `submit-story` and must match the CMS `TURNSTILE_EXPECTED_ACTION`. |
| `VITE_PUBLIC_CONTACT_URL` | Separate contact endpoint, if one is implemented. The merged CMS has **no contact endpoint**; leave this unset to retain email contact and disabled online sending. |

Every `VITE_` value is public. Never include a Turnstile secret, CMS token or staff
credentials. Restart Vite/rebuild after changes. Remote submission endpoints must
use HTTPS; loopback HTTP is accepted for local development. Credentials in URLs
are rejected. No endpoint/site key means no sending and no widget load.

The CMS must list the exact frontend origin in `CMS_CORS_ORIGINS` and
`PUBLIC_SUBMISSION_ORIGINS`. Anonymous requests use `credentials: omit`, not staff
cookies. Cloudflare scripts/frames/connects at `https://challenges.cloudflare.com`
must be allowed by the browser/network/CSP. Production Siteverify uses a backend-only
secret. The backend validates hostname/action, expiry and single-use tokens.

## Wire mapping

The UI names are mapped in `src/lib/public-submissions.js`:

```json
{
  "name": "Reader name",
  "email": "reader@example.test",
  "phone": "+234 803 123 4567",
  "title": "A local community story",
  "body": "Plain text and source links, with enough detail for review.",
  "categorySuggestion": "News",
  "location": "Lagos",
  "website": "",
  "turnstileToken": "opaque, single-use widget token"
}
```

`categorySuggestion` is a plain-text hint, not an article category relation ID.
`location` is optional; `website` is always empty (reserved backend honeypot).
The client does not send role, status, reference, consent flags or other privileged
fields. The consent checkbox is a client acknowledgement and is not stored by the CMS.

Name: 2–120 characters; email: valid, ≤254; title: 5–200; story: 30–20,000;
location: ≤120. **Phone remains required in the public UI**, as requested by the
publisher (7–15 digits, ≤40 characters, local/international formatting). The backend
contract permits an omitted phone; this UI applies a stricter requirement. The section
hint and consent acknowledgement are also required in the UI. JSON above 64 KiB is
blocked before sending. Server validation remains authoritative.

Only `201 {ok:true, reference, message}` with a nonempty reference confirms receipt.
The UI reads `reference` directly, never `res.data`, and does not invent receipts.
HTTP 200, old `{accepted:true}`/`{status:'pending'}` shapes, or missing confirmation
are treated as unconfirmed. Public forms do not have a mock fallback.

CMS errors are arrays: `{ok:false, errors:[{field?, message}]}`. Known field names
map to inline errors/error-summary links; raw diagnostics/HTML are not echoed.
Turnstile field errors (400/403) require a new challenge; 409 explains that a matching
submission already exists without claiming a new receipt; 413 explains the size
limit; 401/403 origin/permission denials offer email contact; 415 indicates endpoint
configuration. 429 disables retries using a readable `Retry-After` header (60-second
client cooldown when timing is unavailable). Network/timeout/unconfirmed responses
preserve text and warn that receipt is uncertain; no automatic retries occur.

**Backend follow-up:** cross-origin JavaScript can only read `Retry-After` if it is
exposed through `Access-Control-Expose-Headers`. The current CMS custom endpoint
sets `Retry-After` but does not expose it. Its rate limits still enforce server-side;
precise cross-origin retry timing requires Claude's header change or a same-origin
proxy. The fallback cooldown does not guarantee the server's window has elapsed.

Tokens are memory-only, reset after every attempted POST, expiry or layout-driven
widget recreation. Double clicks are blocked while a request is pending. Navigation
removes the widget and aborts the client request. Submitted text is never saved in
localStorage/sessionStorage, cookies or analytics. Success/navigation clears controls;
errors retain them only in the current page. Cloudflare privacy/terms are linked.

The contact form uses separate `name,email,phone,subject,message,turnstileToken` fields
and the same explicit receipt requirements if a compatible endpoint is provided.
It is not connected to the story inbox by assumption and was not verified against
an actual contact service.

## Verification

```bash
npm ci
npm ci --prefix apps/cms
npm run test:unit
npm run test:forms -- --workers=2
npm run test:cms
npm test -- --workers=2
npm run test:newsroom -- --workers=2
npm run export:pages
npm run check:pages
```

`test:forms` mocks widget/API responses for exhaustive UX states. `test:cms` creates
an ephemeral PostgreSQL cluster (or uses a disposable loopback `TEST_DATABASE_URL`
whose database name contains `test`), mounts **real Payload REST handlers**, applies
committed migrations, and tests desktop/mobile submission → new inbox record →
editor conversion → draft invisibility → review/approval/publication → public Vite
reading. It also verifies reporter denial, duplicate rejection, rejected/spent tokens,
public media and staff-field filtering. No API responses are mocked in that suite.

The test host in `tools/public-cms-test-server.ts` is **loopback-only and requires
NODE_ENV=test**. Its fixture-control routes are test infrastructure, never an
application/deployment server. Only the external Turnstile script and Siteverify
HTTP transport use test doubles through the backend's existing test-only seam.
This proves application/DB integration, not real Cloudflare spam protection.
Real provider verification and production deployment require separate validation.
