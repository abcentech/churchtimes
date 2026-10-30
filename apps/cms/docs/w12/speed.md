# Speed, PWA, offline and data saver (wave 1-2, Agent C)

Everything here is free (no paid service, no new dependency) and degrades to the normal site: a browser
without service workers, speculation rules, view transitions, AVIF or `Save-Data` simply gets the site as it was.

## What shipped

| Area | Files | Notes |
|---|---|---|
| Service worker, manifest, offline page | `tools/public-routes/pwa.mjs` (host), `src/features/pwa/sw-core.js` + `sw-events.js` (worker source) | Served by the public host at `{base}sw.js`, `{base}manifest.webmanifest`, `{base}offline.html`. Not in the JS bundle. |
| Registration, install prompt, offline labels, data-saver UI | `src/features/pwa/enhance.js` + `enhance.css` (lazy chunk, loaded at idle after `load`) | |
| Initial hooks | `src/features/pwa/boot.js`, `lite.js`, `pwa.css` | Data-saver flag, image filter, document-navigation choice, prerender activation guard. |
| AVIF + LQIP | `src/lib/published-articles.js` (`normalizePublicMedia`), `src/lib/cms-media.js` (`cmsImage`, `cmsPreload`) | Uses Agent B's `lqip`, `cardAvif`, `heroAvif` (schema contract section 2). |
| Diacritics | `src/fonts.css`, `tools/check-font-coverage.mjs` (`npm run check:fonts`) | |
| Reports | `tools/public-responsiveness.mjs` (INP proxy), TBT/FCP rows in `quality.json`, `tools/benchmark-competitors.mjs` | Reports only, never gates. |
| Tests | `unit-tests/pwa.test.js`, `pwa-tests/pwa.spec.js` (`npm run test:pwa`) | The unit tests run the real generated worker in a `vm` with an in-memory Cache Storage. |

Shared-file edits (all surgical): `src/main.js` (2 imports, `picture()` passes through the data-saver filter,
comments wait for a tap in data-saver mode, a "Data saver" toggle next to "Privacy & reading list" in the footer,
article clicks are not intercepted when a document navigation is better, first `render()` goes through `startPWA`),
`tools/serve-public.mjs` (import + one route line + one construction line), `tools/public-response.mjs`
(optional per-request HTML transform), `src/lib/public-push.js` (push scope), `tools/audit-public.mjs` and
`tools/public-quality-report.mjs` (non-failing reports).

## Browser support (verified 30 Oct 2026)

| Feature | Support | Source | Fallback |
|---|---|---|---|
| Cross-document view transitions (`@view-transition`) | Chrome/Edge/Opera/Samsung/Android WebView 126+, Safari 18.2+; Firefox no | MDN browser-compat-data `css/at-rules/view-transition.json` | Normal navigation. |
| Speculation rules | Chromium only. Document rules + `eagerness`: Chrome 121+. Moderate on mobile uses viewport heuristics since Aug 2025; at most 2 moderate prefetches and 2 prerenders (FIFO). Chrome skips speculation under Save-Data, Energy Saver, low memory, "Preload pages" off and in background tabs. Prefetch of service-worker-controlled URLs: Chrome 138+ | MDN `speculationrules`; developer.chrome.com "Prerender pages"; Samsung "prefetch with service worker enabled" policy page | Links work normally; the shell keeps intercepting article clicks in browsers without them. |
| `document.prerendering` / `prerenderingchange` | Chromium (experimental, not Baseline); exact first version not confirmed from a primary table | MDN pages (tables did not render) | Feature-detected: when absent the app renders at once. |
| `navigator.connection.saveData` | Chrome 65+, Edge, Opera, Samsung, Android WebView; Firefox and Safari no | MDN browser-compat-data `api/NetworkInformation.json` | The manual "Data saver" toggle works everywhere; the server also honours the `Save-Data: on` request header. |
| Service workers, Cache Storage | Baseline (all current engines) | MDN | Site works without them (no offline). |
| Navigation preload | Chrome 59, Edge 18, Firefox 99, Safari 15.4 | MDN compat table (w3cub mirror) | Feature-detected in `activate`. |
| AVIF | Chrome 85, Firefox 93 (still images), Safari 16.4 (16.1-16.3 partial) | caniuse, web-features | `<picture>` falls back to the WebP/JPEG `<img>`. |
| `beforeinstallprompt` | Chromium only | MDN | No install banner; browsers' own "Add to Home screen" still works with the manifest. |

## Navigation model (decision)

The shell intercepted clicks on article links and rendered them client-side (`history.pushState`). Speculation
rules and cross-document view transitions only work for real document navigations, and only document navigations
let the worker keep the article for offline reading. Article links therefore become normal navigations when
`documentNav()` is true: a service worker controls the page, OR the browser is offline, OR speculation rules are
supported and data saver is off. Otherwise (first visit in Safari/Firefox, data saver in Chromium without a
worker yet) the existing interception is unchanged. The server-rendered article is already complete HTML, so a
prefetched or prerendered page shows the story at first paint; the app then hydrates as before.

## Service worker

- Scope: the public base path (`PUBLIC_BASE_PATH`, default `/`); registered with `updateViaCache: 'none'`.
  Headers: `sw.js` and `offline.html` `Cache-Control: no-cache`; manifest `public, max-age=3600`.
- Versioned by a hash of the compiled `index.html`, the worker source, the manifest and the offline page:
  every deploy installs a new worker (`skipWaiting` + `clients.claim`) and deletes the previous `ct-shell-*` cache.
- Caches (all same-origin, all `GET`):
  - `ct-shell-<version>`: offline page, manifest, icons, the front page (the bundled edition renders offline) and
    the default `/church-calendar/` view (network-first, offline copy).
  - `ct-assets-v1`: hashed `/assets/` JS, CSS and fonts (cache-first, immutable), entry assets precached at
    install, capped at 80 entries (oldest first). Not versioned, so articles saved under an older build still
    find their scripts after a deploy until evicted.
  - `ct-pages-v1`: the last **25** articles read (network-first; served from cache when offline or when the host
    answers 5xx). Pages over 1 MB are not stored. The title is kept in a header for the offline list.
  - `ct-scripture-v1`: opened public-domain KJV book files (cache-first, capped at 12).
- Never cached or touched (the worker does not even answer them): any non-GET, any other origin (CMS API, media,
  third parties), `admin`, `api`, `graphql`, `newsroom`, `login`, `logout`, `account`, `preview`, `newsletter`,
  `subscribe`, `unsubscribe`, `give`, `giving`, `donate`, `donation(s)`, `comments`, feeds, sitemaps, `sw.js`,
  `OneSignalSDKWorker.js`, `push/`, range requests and file downloads. Responses marked `private`, carrying
  `Set-Cookie`, redirected, non-200 or not HTML (for pages) are refused.
- Offline: a read article opens from cache; anything else shows `offline.html`, which lists the saved stories
  (newest first) and has a "Remove saved copies from this device" button. Articles saved offline show
  "Saved for offline reading on this device."; while offline, cards of saved stories show "Available offline".
- Storage: about 25 x 30-60 KB HTML + up to 80 assets (a few MB at most) + up to 12 KJV books.

### Push (OneSignal) coexistence

Only one worker can control a scope. OneSignal's documentation recommends a dedicated sub-scope when a site
has its own worker, so `public-push.js` now registers OneSignal with `serviceWorkerParam.scope: '/push/onesignal/'`
(the worker file stays at `/OneSignalSDKWorker.js`; push delivery does not depend on scope). The offline worker
keeps `/`. Safety net: if a reader already has OneSignal registered at the root scope (push was never enabled in
production, but just in case), the offline worker does **not** register, so push keeps working for that reader.
Both cases are covered by `pwa-tests`.

## Data saver ("lite")

- On when the reader turns on "Data saver" (footer toggle, `aria-pressed`), or automatically when
  `navigator.connection.saveData` is true and the reader has not turned it off. Stored in `localStorage` and a
  first-party preference cookie `ct-lite=on|off` (no identifier) so server-rendered pages honour it; the host
  also honours the `Save-Data: on` request header.
- Effects: images are not downloaded (placeholder with the exact aspect ratio, LQIP blur when available; no
  layout shift when revealed); "Show images" in the page flow, or tap an image outside a link; no speculation
  rules; comments load on "Show comments"; no install prompt; the hero image preload is removed server-side.

## Images: AVIF and blur-up

`normalizePublicMedia` keeps `image/avif` sizes out of the `<img>` candidates (contract section 2) and exposes them
as `avif[]`. `cmsImage` wraps them in `<picture><source type="image/avif">` only when their aspect ratio matches the
`<img>` (else a different box could shift layout); width/height stay on the `<img>`. The validated LQIP
(`data:image/webp|jpeg|png;base64`, at most 1,500 chars) is painted as the image background and removed on load.
The hero preload follows the AVIF set (typed preload, ignored by browsers without AVIF).

## Fonts and Nigerian languages

`npm run check:fonts` reads the real WOFF2 `cmap` tables:

- Newsreader has ẹ ọ ị ụ (and capitals) only in its Vietnamese subset; tone marks U+0300/0301 and dot below
  U+0323 are in the Latin subset. The Vietnamese subset (about 12 KB per style) is now declared with
  `unicode-range`, so only pages containing those letters download it (tested both ways).
- Neither Newsreader nor DM Sans contains ṣ ṅ ɓ ɗ ƙ ƴ (any subset), and DM Sans has no ẹ ọ ị ụ. Those letters
  render in the system fallback font (readable, slightly different style). No subset can fix that; a future
  change of typeface (or adding a Noto face) would, at a font-budget cost.
- Font bytes: 183,548 of 196,608 (before: 159,536).

## Measurements

See the hand-back table (filled from `npm run test:quality` runs; mobile Lighthouse profile).

## Reports

- `quality.json` rows now include `tbtMs` and `fcpMs` (reported, never gated).
- `responsiveness.json`: INP proxy (largest event duration of each interaction) for real taps on a Pixel 7
  profile with CPU x4: open menu, open search, data-saver toggle. Report only.
- `node tools/benchmark-competitors.mjs [--ours https://…] [--runs 1-3] [--pause ≥5] [--only host,…] [--dry-run]`:
  Lighthouse mobile on 8 Nigerian news front pages, strictly sequential, one fresh browser per load, pause between
  sites, output only in git-ignored `private-reports/` (aggregate metrics, no content).

## Budgets (gzip)

Initial JS +0.9 KB of the 1.0 KB allocation; initial CSS +0.17 KB of 0.2 KB; the worker, offline page and manifest
are served separately; lazy `enhance` chunk 2.8 KB JS + 0.5 KB CSS.

## Risks and follow-ups

- Article links are now document navigations in Chromium and wherever the worker is active. Back/forward is a
  real navigation (pages are `no-store`, so they do not enter the back/forward cache).
- Prerender runs the page's network requests (CMS API) before activation; rendering, analytics and ads wait for
  activation. At most 2 prerenders (lead newsroom story, moderate eagerness).
- The static GitHub Pages export does not serve `sw.js`: registration fails quietly and no manifest is linked.
