# Public story submissions and contact forms

Public forms are independent of staff credentials, authentication and approval
controls. Stories await review and are never automatically published.

Set these public Vite values before development/build; never put secrets in VITE_
variables:

- `VITE_PUBLIC_CMS_URL`: CMS origin; derives `/api/public/submissions` for stories.
- `VITE_PUBLIC_SUBMISSIONS_URL`: explicit story endpoint override.
- `VITE_TURNSTILE_SITE_KEY`: public site key for browser verification.
- `VITE_PUBLIC_CONTACT_URL`: explicitly configured separate contact service.

Without endpoint and site key, sending is disabled and the email alternative
remains available. The actual CMS has no contact endpoint, so the frontend does
not assume one or send contact messages to the story queue.

[Current field mappings and response/error contract](cms-field-mappings.md) are
verified against the merged CMS source. Stories send name/email/phone/title/body,
categorySuggestion, optional location, an empty website honeypot, and turnstileToken.
Phone and consent remain required in the public form UX. Name/title/body limits
and minimums match the CMS. Contact retains subject/message/consent and its separate
service limits. The frontend never sends publication status or privileged fields.

A real story receipt is `201 { ok: true, reference, message }`; only the server's
returned reference is displayed. Known field errors map to accessible inputs.
Duplicate, verification, forbidden, oversized, throttled, malformed/unconfirmed,
network and timeout responses preserve text without a false success or automatic
resubmission. Readers are asked to contact the newsroom before resending when
receipt is uncertain. The server remains responsible for persistent duplicate
protection, validation, rate limits, Turnstile verification and origin policy.

The form disposes verification/widgets and releases values on navigation. No
submission text/token is stored in localStorage, cookies, analytics or draft
storage. Reading-list storage is separate. Native browser autofill remains under
the reader's control.

```bash
npm run test:unit
npm run test:forms -- --workers=2
npm test -- --workers=2
npm run test:newsroom -- --workers=2
npm run export:pages
npm run check:pages
```

Browser tests intercept the challenge script and APIs. Contract tests additionally
execute the real CMS endpoint with test persistence/Siteverify transport. Neither
proves deployed database receipt or real Cloudflare verification. No backend,
authentication, article-approval, live-event or production WordPress change is
part of these fixes.
