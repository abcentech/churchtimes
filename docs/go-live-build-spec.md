# Go-live build spec: what the new site still needs before launch

Status: **a proposal for the owner to approve.** Nothing here has been built or deployed. It extends
[go-live-plan.md](go-live-plan.md) (phases and gates) with the concrete build work found by auditing the live WordPress site
on 2026-10-15. Every item that touches production needs the owner's explicit approval first.

## 0. How to use this spec

**Lanes (unchanged):**
- **Codex** owns the public site: `src/`, `index.html`, `tools/`, public-host code, public tests.
- **Claude** owns the CMS and newsroom: `apps/cms`, `apps/newsroom`, their docs and tests.
- Neither lane edits the other's directories. Cross-lane work goes through a written **contract** in `docs/` (the
  advertising contract is the model), reviewed before either side builds on it.

**Rules that apply to every item:**
- No merge to `main`, no deploy, and no change to live WordPress, Truehost, DNS, hosting, AdSense or production
  databases without explicit owner approval for that step.
- No mock success in live mode. Results from stubs or mock servers are labelled as such and never reported as full
  end-to-end. "Ready" needs real browser journeys against a real CMS (the `apps/cms` cross-app Playwright lane).
- No secrets in the repo or in frontend code. `VITE_*` values are public. Turnstile secrets, API keys and tokens live in
  server-side environment variables.
- **No real personal data in GitHub**: no contact lists, comment exports, WordPress exports or backups. Tests use synthetic
  fixtures only. Real exports stay on private storage the owner approves.
- Every PR targets `feat/newsroom-mvp` (never `main`), stays small, and states exactly what was and was not tested.

## 1. What the audit found (facts, 2026-10-15)

| Fact | Detail |
| --- | --- |
| Content size | **4,346** published articles to migrate (24,649 rows in the posts table incl. pages, revisions, attachments). |
| Article URLs today | Articles live at the root: `/<slug>/`. The new site's route design uses `/reports/<slug>/` (PR #24/#30). |
| Active plugins that matter | Rank Math + Rank Math Pro (SEO, **redirect manager**), Google Site Kit (analytics/Search Console), OneSignal (web push), Blog2Social (auto-posting to social), three ad plugins (Ad Inserter, Insert Post Ads, Easy AdSense), Contact Form 7 and WPForms Lite, Penci Soledad AMP, Akismet, Custom CSS & JS and Easy Code Manager (custom code). |
| Installed but inactive | Yoast Premium, MonsterInsights, Clarity, Mailchimp for WP, OptinMonster, Add to Any, booking and event calendars, Web Stories. Not part of the live behaviour. |
| Comments | **1,833** approved comments from about **935** distinct commenters (plus 714 spam). The new site has no comments. |
| Forms | Form messages were only emailed. The database holds no subscriber table and no stored form entries. |
| Shortcodes | 0 articles contain `[penci...]`; 1 page contains a form shortcode. Low migration risk, but re-check on the real export. |
| Already built | Story/tip submission with Turnstile, advertising slot renderer (no live campaigns, AdSense off), live coverage with photos, share dialog, privacy dialog. |
| Open PRs this builds on | #30 (sitemap, RSS, share cards, responsive images), #31/#34 (live photos), #18/#19 (archive recovery and import engine), #24 (clean report routes), #27 (staging kit), #35 (go-live plan). |

## 2. Owner decisions (each has a recommended default so work can start)

| # | Decision | Recommended default | Blocks |
| --- | --- | --- | --- |
| D1 | **Article URL shape.** Keep `/<slug>/` as today, or move to `/reports/<slug>/` and redirect everything. | **Keep `/<slug>/`.** Fewest redirects, least search risk. Make the article path configurable. | P1, C7 |
| D2 | **Production host for the public site.** A static host cannot send per-URL 301s. | A host that supports server-side redirects and clean 404s (Caddy on the CMS server, Cloudflare Pages/Workers, Netlify). Codex to confirm what PR #30's public host needs. | P1, hosting |
| D3 | **Comments.** Archive read-only, rebuild with moderation, or drop. | **Archive read-only** (no new comments at launch). | P9, C6 |
| D4 | **Ads.** Keep AdSense? Sell direct campaigns? | Direct campaigns on the built slots; **AdSense only after the owner approves and supplies the publisher line.** | P4, C3 |
| D5 | **Newsletter.** Which provider and does the Mailchimp account still exist? | Reuse the existing Mailchimp audience if it is active; the CMS stores consent, Mailchimp sends. | P5, C4 |
| D6 | **Analytics and consent.** Keep the existing GA4 property? | Yes, behind consent; no analytics on staging. | P3 |
| D7 | **Retire AMP and Web Stories.** | Retire, with 301s to the canonical article. | P1 |
| D8 | **Auto-post to social at launch?** (Blog2Social today.) | Post-launch; manual sharing at launch. | C8 |

## 3. Public-site lane: Codex

Sizes: S under a day, M one to three days, L more.

| ID | Item | Size | Needs | Done when |
| --- | --- | --- | --- | --- |
| **P1** | **URL compatibility and redirects.** Configurable article path (D1). Redirect engine that reads a generated `redirects.json` (`from`, `to`, `status`): exact matches first, then patterns for `/category/*`, `/tag/*`, `/author/*`, `/page/N/`, `/feed/`, AMP variants, `/?p=ID`. Never more than one hop, no loops. Junk such as `tel:` paths answers 404/410 cheaply and is never cached per-URL (a `tel:` crawler trap took the old server down). Clean 404 page. | L | D1, D2, C7 | Unit tests on a synthetic map; a script that, given a list of old URLs, asserts the status, a single hop and the final title. Documented for the chosen host. |
| **P2** | **SEO completion.** Land PR #30. Add `robots.txt` (indexable only when `PUBLIC_INDEXABLE=true`, staging noindex retained), an `ads.txt` placeholder that contains **only** a line the owner supplies, sitemap coverage for categories and pages, canonical tags that match D1, per-article SEO title/description overrides from the CMS (C2), Search Console verification token supplied by the owner. | M | #30, C2 | Real-browser check of head tags, sitemap, RSS and share cards on a synthetic article; no staging indexing. |
| **P3** | **Analytics with consent.** GA4 loader gated on consent from the existing privacy dialog. Measurement ID is a public env value. CSP updated. Off on staging by default. Optional Clarity flag, default off. | S | D6 | No analytics request before consent; request after; CSP passes; documented env vars. |
| **P4** | **Ads delivery.** Wire `src/lib/advertising.js` to the CMS projection (C3). AdSense stays behind `adsense.enabled && adsense.reviewed` and loads **nothing** until the owner approves. Slots keep their "Advertisement" label, `rel="sponsored noopener noreferrer"`, and reserve no gap when empty. | M | D4, C3 | Contract tests against the real endpoint on staging; zero layout shift measured; no script when disabled. |
| **P5** | **Newsletter sign-up.** Accessible form with Turnstile posting to the CMS endpoint (C4). Clear success, error and "check your email" states. No third-party scripts. | S | D5, C4 | Real-browser journey against the real CMS on staging; rate-limit and error paths shown. |
| **P6** | **Contact form.** Replace "email contact, online sending disabled" with the CMS contact endpoint (C5), same Turnstile pattern as the tip form. | S | C5 | Real-browser journey; honest disabled state if the endpoint is unset. |
| **P7** | **Web push (OneSignal).** Load the SDK only with consent, serve the service-worker file at the site root, take the app ID from a public env value. Subscribers only carry over if the site origin stays the same, so this is verified at the soft-launch subdomain and again at cutover. | M | Owner supplies app ID | Subscribe and receive on a test device; SDK absent when no app ID is set. |
| **P8** | **Sharing and "Listen".** Copy-link in the share dialog. Optional "Listen" button using the browser speech API as progressive enhancement (replaces the Penci text-to-speech plugin). | S | | Works without JavaScript errors; hidden where unsupported. |
| **P9** | **Archived comments display** (read-only) under migrated articles, from the CMS projection (C6). Names and dates only; never emails. | M | D3, C6 | Renders from real CMS data on staging; no emails in the payload or DOM. |
| **P10** | **Legacy content rendering.** Check migrated Lexical content: embeds (YouTube allowlist), images, captions, tables, links, headings. Keep `/wp-content/uploads/*` image URLs working (same path on the new host or mapped by P1) so Google Images and hotlinks do not break. | M | C1 | A sample of at least 50 synthetic-fixture articles renders cleanly in the real browser lane. |
| **P11** | **Quality gates.** Mobile and accessibility checks, performance budget, no console errors, on every journey above. | S | | Evidence added under `docs/evidence/`. |
| **P12** | **Cutover smoke tooling.** A read-only, rate-limited script that checks a supplied list of old URLs (50+ legacy articles plus the top 100 by traffic, supplied privately by the owner) against the new host. Never run against the live server without the owner's say. | S | P1 | Dry run on synthetic data passes. |

## 4. CMS lane: Claude (Codex consumes these through contracts)

| ID | Item | Size | Needs | Done when |
| --- | --- | --- | --- | --- |
| **C1** | **Import pipeline.** Review, test and merge #18/#19. Run the import against the owner's real WordPress export (kept private): 4,346 articles, categories, authors, dates (archive dates kept), media reconciliation, shortcode inventory. Fill `legacyUrl` and `legacyId`. | L | Owner export; #18/#19 | Dry run into a disposable database; editorial QA report; 50-article sample checked by an editor. |
| **C2** | **SEO fields.** Add `seoTitle` and `seoDescription` (and an optional canonical override) to articles, imported from Rank Math values where they exist; expose them on the public article projection. | M | Rank Math data | Migration, API contract doc, tests. |
| **C3** | **Advertising manager.** Advertiser and campaign records with an approval step, schedule, placement and creative checks, and the read-only public projection described in `docs/advertising-contract.md` (`GET /api/public/advertising`). Payment and billing data never public. | L | D4 | Contract doc first; CMS tests; staff-only editing; audit log. |
| **C4** | **Newsletter subscribe endpoint.** Anonymous POST with Turnstile and rate limits; stores email, consent time, source; double opt-in email; unsubscribe; export to the provider (server-side key) or CSV; import of an owner-supplied Mailchimp export with consent status (private, never in GitHub). | L | D5; SMTP | Contract doc; privacy review; tests including abuse paths. |
| **C5** | **Contact endpoint.** Stored message plus email to a staff mailbox, with Turnstile, rate limits and origin checks like the submissions endpoint. | M | SMTP | Contract doc; tests. |
| **C6** | **Comments archive.** Import the 1,833 approved comments as read-only records linked to articles; public projection shows display name, date and text only; spam excluded; emails never exposed. | M | D3 | Importer tests on synthetic data; privacy test on the projection. |
| **C7** | **Redirect map.** Generate `redirects.json` from `legacyUrl` plus the Rank Math redirect export (supplied privately); validate no loops or chains; expose it as a build artifact or `GET /api/public/redirects`. | M | C1, D1 | Validator tests; report of unresolved top-traffic URLs (target: zero). |
| **C8** | **Social auto-post hook** (post-launch). Outbox on publish, server-side tokens, per-channel failure handling. | M | D8 | Deferred unless D8 says otherwise. |
| **C9** | **Production hosting and operations.** Deploy per `apps/cms/docs/operations.md` on a new separate server; off-server nightly backups of the database **and** media; a full restore test; real Turnstile keys; SMTP; monitoring; staging restart with rotated secrets; review and test #31, #30, #34 against the merged CMS. | L | Owner picks host | Operations checklist ticked; restore test recorded. |

## 5. Contracts and order of work

Contracts are written first, as docs-only PRs, so both lanes can build in parallel:

1. Claude writes the contracts for C2, C3, C4, C5, C6 and C7 (request/response, errors, limits, privacy fields).
2. Codex reviews them, then builds P-items against fixtures. Stubs are labelled as stubs.
3. Real integration is proven in the cross-app browser lane against the real CMS, as with images (`10-images.spec.ts`).

**Waves:**
- **Wave 1, start now, no decisions needed:** P2, P10 groundwork, P11; C1, C2, C7, contracts; C9 planning.
- **Wave 2, after D1/D2/D4/D5/D6:** P1, P3, P4, P5, P6; C3, C4, C5.
- **Wave 3, before the soft launch:** P7, P8, P9, P12; C6.
- **After launch:** C8.

## 6. Maps to the go-live plan phases

| Plan phase | Needs from this spec |
| --- | --- |
| 1. Finish staging | Merge #30/#31/#34 with the `I4` update; P2, P11 |
| 2. Build real hosting | C9, D2 |
| 3. Migrate content | C1, C2, C6, C7, P10 |
| 4. Soft launch (subdomain) | P1, P3 to P9, P12; owner approves |
| 5. Cutover | P12, redirect map with zero unresolved top-traffic URLs |

## 7. Must not happen

- Moving the site to a path structure that drops the old addresses without a tested redirect map.
- Turning on AdSense, analytics, push or any third-party script before the owner approves it.
- Putting any real contact, comment, subscriber or export file in GitHub, in a fixture, or in a test.
- Moving the domain's mail or changing nameservers as part of launch.
- Calling any mocked or stubbed result a full end-to-end pass.
