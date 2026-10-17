# B9: web push, built but inactive

The feature has no configured OneSignal application ID. The default public build generates no
`OneSignalSDKWorker.js`, requests no provider SDK, registers no push worker, and asks for no browser permission.
No provider script has been activated, and this PR does not approve activation.

`src/lib/public-push.js` exposes `validPushAppId(value)` and
`mountPublicPush({root, appId, hasConsent, subscribeConsent, requestConsent})`. The shell lazy-loads it only
for a configured application, then mounts it in the privacy dialog. The shared consent category is `push`;
it starts false. A checkbox alone does not load the provider: the reader must also select **Enable notifications**.
Unsupported/insecure browsers get a local explanation. Browser refusal stays off; failures offer a reload instead
of creating repeated SDK loads. Repeated mounting on the same panel does not add duplicate controls or listeners. A shared promise per browser/app
prevents duplicate SDK downloads and initialization when navigation replaces the privacy panel. Late SDK arrivals
after the ten-second deadline remain inert; late initialization completion triggers withdrawal cleanup.

The build helper `writePublicPushWorker({directory, appId})` in `tools/public-push-worker.mjs` generates the
root worker only for a validated owner-supplied public UUID. An unset configuration removes stale output.
The build/export integration must call it after moving compiled files under `site/`, so the worker remains at
**the origin root**, never `/site/OneSignalSDKWorker.js`. Export cleanup and freshness checks must include
this generated root file. A feature PR must not commit it. Production subpath hosting does not create a separate
push origin: owner review must cover the origin and existing root workers before enabling this feature.

## Consent and withdrawal

No initialization happens without current push consent. Initialization disables automatic resubscription,
the provider notification button and automatic slide-down prompts. The explicit reader button calls the
browser-permission API only while consent remains present. Withdrawal opts the current subscription out and
unregisters only the worker whose script is the same-origin `/OneSignalSDKWorker.js`; unrelated workers stay.
Withdrawal during SDK loading prevents initialization. Withdrawal during initialization causes cleanup after
initialization completes. An already downloaded third-party script remains in the current document: reload
removes its JavaScript. Browser notification permissions are controlled in browser settings. Client cleanup
cannot retract notifications already delivered or guarantee remote removal while offline; retry after restoring
connectivity and use browser permission settings to block delivery immediately.

## Owner-only activation checklist

Do not follow this checklist as part of this implementation. It requires explicit owner approval, the correct
public OneSignal app ID for the final HTTPS origin, and confirmation that subscriptions on the existing origin
are understood. No real application IDs or subscription records belong in test fixtures.

1. Review provider privacy, consent wording, origin ownership, root worker compatibility, and CSP.
2. Configure `VITE_PUBLIC_ONESIGNAL_APP_ID` for an approved build; keep staging unset.
3. Generate/export the root worker; serve it as JavaScript without an SPA fallback, with a short/revalidation
   cache policy. Keep the scope `/`; the path needs no broad `Service-Worker-Allowed` header.
4. Use explicit CSP origins only: page `script-src https://cdn.onesignal.com`, `connect-src https://onesignal.com
   https://api.onesignal.com`, `frame-src https://onesignal.com`, and `worker-src 'self'` if confirmed required
   by the reviewed provider version. The generated worker imports exactly
   `https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js`; its response policy must permit that exact script
   origin. These are a review inventory, not an automatic CSP patch. Provider behavior can change: validate a
   separately approved staging activation and add only observed, reviewed exact origins. Never add wildcards,
   `unsafe-inline` or `unsafe-eval` to make activation pass.
5. Test opt-in, browser refusal, withdrawal, offline errors and legacy-origin subscriptions before any live use.

## Validation

`node --test unit-tests/public-push.test.js` proves invalid/unset configuration is inert and generated workers
are omitted/removed. `npx playwright test tests/public-push.spec.js` exercises desktop and Android-sized Pixel 7,
keyboard activation, accessibility, current consent checks, duplicate mounting and worker-isolated withdrawal.
All SDK, service-worker and permission transports are explicitly **STUBS**, using the synthetic UUID
`11111111-1111-4111-8111-111111111111`; they neither contact OneSignal nor prove live notification delivery.
The shell integration and root export hooks are reviewed separately so feature PRs keep clear file ownership.
