# Optional public reader features (Wave 2)

No main merge, deployment or production service activation is included. CMS C3–C5 are proposed contracts; test servers and synthetic GA4 IDs are **STUBS**, not real CMS or measurement integrations. Claude's real cross-app tests are still required.

## Analytics / privacy

`VITE_PUBLIC_GA4_ID` is public configuration, never a secret. A valid configured ID, `VITE_PUBLIC_INDEXABLE=true` (staging defaults off), and explicit analytics permission in the existing privacy dialog are all required. Unset values make no SDK request. No identifier is supplied by this PR. Consent choices are versioned browser-local booleans; newsletter/form content is not stored. Revocation disables new events immediately; reload removes an already loaded provider. Query strings, newsletter tokens and automatic history events are excluded from page views; Google signals and ad personalisation are disabled. Optional Clarity is unsupported/inert and remains off, with no loader or ID.

No CSP directives changed. Deployments that impose their own CSP must review `script-src https://www.googletagmanager.com` and provider-specific `connect-src` policy before any owner-approved GA4 activation. This PR does not widen production policy or activate scripts.
