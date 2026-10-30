# Growth, discovery and newsletter (waves 1-2, Agent E)

Everything here is free to run. Nothing calls a paid per-use service, no AI is involved, and every feature that sends mail or does outbound work is OFF until configured and has a hard cap.

| Feature | Default | Switch | Cost |
|---|---|---|---|
| Daily newsletter digest | off | CMS **Newsletter settings** (`enabled` + `dailyDigestEnabled`), then `NEWSLETTER_DIGEST_SEND=true` | free SMTP relay tier |
| One-click unsubscribe | always on (only does anything for a valid signed token) | none | free |
| Share cards (Open Graph PNG) | off | CMS `SHARE_CARDS_ENABLED=true` + public host `PUBLIC_SHARE_CARDS` | CPU only |
| WhatsApp daily brief | manual command | `npm run whatsapp:brief` | free |
| Verse of the day, scripture cards, church calendar | on (static, bundled public-domain text) | none | free |

## 1. Mail: SMTP relay (Brevo or Resend free tier)

The CMS sends through Payload's nodemailer adapter (`SMTP_*` in `apps/cms/.env.example`). Any SMTP relay works: there is no provider SDK and no provider API call. Both Brevo and Resend offer SMTP on their free tier.

| | Brevo | Resend |
|---|---|---|
| `SMTP_HOST` | `smtp-relay.brevo.com` (the server is shown on Brevo's **SMTP & API** page; confirm it there) | `smtp.resend.com` |
| `SMTP_PORT` / `SMTP_SECURE` | `587` / `false` (STARTTLS; 2525 is Brevo's alternative port). `465` / `true` for implicit TLS | `587` / `false` (STARTTLS; 25 and 2587 also). `465` / `true` (implicit TLS; 2465 also) |
| `SMTP_USER` | the SMTP **login** shown on the SMTP & API page (not your account e-mail unless the page says so) | `resend` |
| `SMTP_PASS` | an **SMTP key** generated on that page (not an API key, not your password) | a Resend **API key** |
| Free limit (check current limits) | 300 e-mails per day | 100 e-mails per day, 3,000 per month |
| Sources (checked 30 Oct 2026) | developers.brevo.com/docs/smtp-integration; brevo.com/free-smtp-server | resend.com/docs/send-with-smtp; resend.com/pricing |

Production requires STARTTLS on 587 (`requireTLS` is set in production when `SMTP_SECURE` is not `true`).

Before the first real send, on the provider's dashboard: verify the sending domain and publish the SPF/DKIM records it gives, and add a DMARC record (start with `p=none`). Set `EMAIL_FROM_ADDRESS` to an address on that verified domain. Read the provider's acceptable-use terms for newsletter (bulk) mail on their SMTP relay.

Match the caps to the plan: `newsletter-settings.dailySendCap` (the digest's hard stop) and `MAIL_HTML_DAILY_CAP` (per-process ceiling on all HTML mail, default 300) must both be at or below the provider's daily free limit. For Resend free set both to at most 100. Confirmation mails (plain text) are separate and limited by the existing per-address guards.

### `sendHtmlMail` (apps/cms/src/lib/mailer.ts)
- One recipient per message (list mail never puts several readers in To).
- Every header value is stripped of CR/LF; the one-click URL must be https (loopback http only outside production) and is refused otherwise.
- Adds `List-Unsubscribe: <one-click url>`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 2369 + RFC 8058) and `List-Id`.
- The HTML body must be a `TrustedEmailHtml`, which only `lib/emailTemplate.ts` can produce: its `html` template tag escapes every interpolated value, and `safeHref` admits only absolute http(s) URLs. No CMS, reader or imported markup can reach a mail.
- Takes a slot from the per-process, per-Lagos-day `MAIL_HTML_DAILY_CAP` before sending; a refused relay attempt still uses its slot.
- `sendPlainMail` is unchanged (confirmation mails, receipts).

## 2. Unsubscribe (NDPA: honoured immediately, nothing new logged)

- Every digest carries the reader's own signed token (`u1.<id>.<HMAC>`, `NEWSLETTER_TOKEN_SECRET`) in two places:
  - the body link `PUBLIC_SITE_URL/newsletter/unsubscribe?token=…` (the existing public page; the reader presses **Unsubscribe**);
  - the `List-Unsubscribe` header `CMS_PUBLIC_URL/api/public/newsletter/one-click?token=…`.
- `POST /api/public/newsletter/one-click?token=…` with body `List-Unsubscribe=One-Click` (form-urlencoded or multipart, as Gmail, Yahoo and Apple Mail send it) unsubscribes at once and answers 200 text/plain. No Origin, cookie, CORS or Turnstile requirement (the mailbox provider's server calls it); the HMAC token is the only credential, and the body marker is required. Per-IP limit `NEWSLETTER_ONE_CLICK_RATE_LIMIT` per 15 min (default 600, providers share egress IPs).
- `GET` on the same URL never changes anything (mail scanners pre-fetch links): 303 to the public unsubscribe page.
- Both paths share `unsubscribeByToken` with the existing page endpoint: idempotent, `erased` stays erased, the same single `subscriber.unsubscribe` audit row as before and nothing else.

## 3. Daily digest

Code: `lib/newsletterDigest.ts` (pure: selection and templates), `lib/newsletterDigestRunner.ts` (database and relay), `endpoints/newsletterDigestStaff.ts`, `seed/newsletterDigest.ts`.

**Content (deterministic, no AI).** Published articles with `publishedAt` after the previous sent issue (or the last 24 hours; never more than 7 days back) and not in the future, newest first, ties by id, de-duplicated by slug, at most `maxStoriesPerDigest`. Each story: label (category, or **Sponsored** for `contentType = sponsored`), headline linked to the public URL (`PUBLIC_ARTICLE_PATH_TEMPLATE`; reserved slugs are never linked), excerpt up to 280 characters. Optional verse of the day (below). Footer: why the reader gets it, the unsubscribe link, the publisher's name. Plain text and HTML (one table, inline styles, system fonts, no images, no scripts, no tracking pixels, no open or click tracking). Subject: `Church Times Nigeria daily briefing, <date>: <lead headline>` (max 150 characters). No day without new stories gets a mail.

**Switches and safety.**
1. Nothing is scheduled unless `newsletter-settings.enabled` AND `dailyDigestEnabled` are on (both off by default; a missing or unreadable global counts as off).
2. The check runs inside the existing scheduler loop (`SCHEDULER_ENABLED`, every `SCHEDULER_INTERVAL_SECONDS`), on its own in-flight guard so it never delays scheduled publishing. `NEWSLETTER_DIGEST_SCHEDULER=false` turns only the digest check off. It acts once the Lagos hour reaches `sendHourLagos`, at most once per Lagos day per process.
3. Until `NEWSLETTER_DIGEST_SEND=true`, a scheduled run is a **dry run**: it writes today's issue as a `draft` newsletter-issue (at most one per day) and sends nothing.
4. Live sending also needs `SMTP_HOST`, `PUBLIC_SITE_URL`, `NEWSLETTER_TOKEN_SECRET` and an https `CMS_PUBLIC_URL`; without any of them nothing is claimed or sent.
5. Only `confirmed` subscribers are mailed (never `pending`, `unsubscribed`, `bounced` or `erased`), in id order, one message each, paged 50 at a time so an unsubscribe during a run is honoured for the rest of it.
6. `dailySendCap` is a hard stop per Lagos day across issues; `capApplied` is set on the issue when it bites. `MAIL_HTML_DAILY_CAP` sits underneath per process.
7. One live issue per Lagos day: the issue is claimed (created as `sending`) inside a transaction under a PostgreSQL advisory lock, so two CMS processes cannot both send. A `sending` or `failed` issue is **never resumed automatically** (that could mail some readers twice); staff decide (delete a `failed` issue in the admin to allow a new one).
8. Relay errors are counted (`failedCount`); five consecutive errors stop the run. `lastError` and the logs carry the error class and code only, never an address, a token or article text.
9. `NEWSLETTER_DIGEST_THROTTLE_MS` (default 250) spaces the mails out to stay under the relay's per-second limit.

**Staff tools** (editors and admins; reporters get 403):
- `POST /api/newsletter/digest/dry-run`: writes today's issue as a draft, sends nothing.
- `POST /api/newsletter/digest/test-send`: sends today's issue, subject `[TEST] …`, to the signed-in staff member's own address only (an address in the request is ignored), without list headers or a subscriber token. 5 per hour per user. Needs SMTP.
- Command line on the server: `npm run newsletter:digest` (dry run) and `npm run newsletter:digest -- --test-send <address of a staff account>` (refused for any address that is not a staff account).
- The issues are listed in the CMS admin (`newsletter-issues`, Agent B): subject, status, counts, `capApplied`, `lastError`, the stored text and HTML (with a generic unsubscribe link, no token).

**Going live checklist.** Relay account and verified domain (section 1) → `SMTP_*`, `EMAIL_FROM_ADDRESS`, `PUBLIC_SITE_URL`, `NEWSLETTER_TOKEN_SECRET`, `CMS_PUBLIC_URL` → `npm run newsletter:digest -- --test-send you@…` and read it on a phone → in the CMS set `dailySendCap` and `MAIL_HTML_DAILY_CAP` within the free limit, `sendHourLagos`, `fromName`, `replyTo`, then switch on `enabled` and `dailyDigestEnabled` → leave it a day in dry-run and read the draft → set `NEWSLETTER_DIGEST_SEND=true`.

**Verse of the day in the digest.** With `includeDevotional` on, the runner reads the site's own `PUBLIC_SITE_URL/scripture/verse-of-the-day.json?date=<Lagos date>` (served by the public host from the bundled KJV, the same verse the site shows; 4 s timeout). Only `version: "KJV"` with the matching date is accepted. If it fails the mail simply goes without a verse.

**Tests.** Unit: `tests/unit/mailerHtml.test.ts`, `newsletterDigest.test.ts`, `newsletterDigestRunner.test.ts`, `newsletterDigestStaff.test.ts`, `newsletterOneClick.test.ts`. Integration (real schema, the real nodemailer adapter, a local SMTP sink in `tests/integration/smtpSink.ts`): `tests/integration/newsletter-digest.test.ts` checks the wire format (multipart, `List-Unsubscribe`, `List-Unsubscribe-Post`, `List-Id`, one recipient per message), confirmed-only delivery, the dry run, once-per-day, the advisory lock under two concurrent senders, the cap, relay rejections, one-click from the header, and the staff tools.

## 4. Share cards (Open Graph images) and the WhatsApp brief card

**Renderer:** `apps/cms/src/lib/shareCard.ts` draws a 1200x630 article card and a 1080x1080 daily-brief card on the CPU. No network, no AI, and the same input always gives the same PNG.

**Why sharp, with no new dependency:** sharp 0.35.5 is already a CMS dependency (media resizing). Licences: Apache-2.0 for sharp, LGPL-3.0 for its prebuilt libvips. Nothing is added to the lock file, the Docker image or the browser bundle, so satori/resvg were not needed. The background is an SVG made only of shapes; text is drawn by sharp's text input (libvips + Pango) with an explicit font file, and every string is escaped first, so CMS text cannot inject markup.

**Font:** `apps/cms/src/assets/fonts/Newsreader-opsz-wght.ttf`, unmodified from google/fonts at a pinned commit (source and SHA-256 in `SOURCE.txt`), SIL Open Font License 1.1 (`OFL-Newsreader.txt`), 452 KB, server-side only. A TTF is needed because sharp's prebuilt font loader does not read woff2. Covers Yoruba and Igbo letters (ẹ ọ ṣ ụ ń and tone marks); not the Hausa letters ɓ ɗ ƙ (the site's web fonts lack them too), which would show as boxes on a card.

**Docker:** the runtime image is `node:24-bookworm-slim` (glibc), which sharp's prebuilt binaries support (media resizing already relies on it). The runtime stage copies `src/` to `/app/src`, so the font is at `/app/src/assets/fonts` (`SHARE_CARD_FONT_DIR` overrides). The image has no system font configuration: expect a one-time harmless "Fontconfig error" warning, the font is loaded by explicit path. Not verified in Docker locally (no Docker on the build machine): after deploy, open `/api/public/share-card/<slug>.png` on staging.

**Endpoint:** `GET|HEAD /api/public/share-card/:slug` (`.png` also works). Off unless `SHARE_CARDS_ENABLED=true` (404 `no-store` while off). Published articles only; the slug is validated before any query. Per-IP `SHARE_CARD_RATE_LIMIT` (60) per `SHARE_CARD_RATE_WINDOW_SECONDS` (60), 429 with Retry-After. ETag from headline, label, date and renderer version (304 without rendering). `Cache-Control: public, max-age=86400`, `X-Content-Type-Options: nosniff`. In-memory cache `SHARE_CARD_CACHE_MAX` (50) and at most 25 MB. At most `SHARE_CARD_MAX_CONCURRENT` (2) renders at once, identical requests share one render, 503 Retry-After 5 beyond. `warmShareCard(payload, articleId)` can pre-render after publishing (not wired: a collection hook is Agent B's; without it the first social-network request renders the card).

**Public host:** `PUBLIC_SHARE_CARDS` in `deploy/public-host/public-host.env.example` (`tools/public-routes/share-card-meta.mjs`): unset/`false` = no card tags; `fallback` = card only for articles without a featured image; `always` = every article. It sets `og:image` (versioned with `?v=<updatedAt>` so networks refetch after an edit), type, 1200x630, alt = headline, `twitter:image` and `twitter:card=summary_large_image`. Must match the CMS flag or the tags point at a 404.

**CPU cost (Windows dev laptop):** first render in a process about 380-460 ms (font load), then 110-250 ms per 1200x630 card; PNG about 35-60 KB.

**WhatsApp brief:** `npm run whatsapp:brief -- [--date YYYY-MM-DD] [--out dir] [--limit 5] [--cms-url URL]` (repo root or `apps/cms`).
- Reads only the CMS's public list of published articles, so it needs no database access or credentials.
- Picks the stories published that Africa/Lagos day, newest first, ties by id. With fewer than 3, it uses the latest stories up to that day and the text says so.
- Writes `whatsapp-brief-<date>.txt` (numbered bold headlines, excerpts up to 140 characters, article links from `PUBLIC_SITE_URL` + `PUBLIC_ARTICLE_PATH_TEMPLATE`, reserved slugs never linked, WhatsApp formatting characters stripped from CMS text, the WhatsApp group link and a newsletter line) and `whatsapp-brief-<date>.png` (1080x1080, up to five headlines) to `apps/cms/private-reports/whatsapp/` (git-ignored).
- The group link comes from `src/lib/social-links.js` (it is a group invite, not a channel); `WHATSAPP_GROUP_URL` overrides it.
- Needs tsx (a dev dependency): run it from a checkout, not the production image.

## 5. Scripture and church calendar (free, no external calls)

- **Text:** King James Version (1769 standard text), public domain, from eBible.org `eng-kjv_vpl.zip`, converted offline by `node tools/scripture/build-kjv.mjs <eng-kjv_vpl.txt>` into `public/scripture/kjv/<book>.json` (66 books, 31,102 verses, 4.2 MB raw, about 1.3 MB gzip in total, fetched one book at a time from the same site; John is about 30 KB over the wire). Translators' supplied-word brackets and pilcrows are removed. No NIV/ESV/NLT text and no scripture API. Every display carries "KJV" / "King James Version (public domain)". (KJV printing is under Crown letters patent in the UK only.) The source puts psalm titles inside verse 1 (Psalm 23:1 begins "A Psalm of David."); cards show the source as it is, and the daily list avoids such verses (a test enforces it).
- **`mountDailyVerse(element, {date?})`:** deterministic verse for the Lagos date from season lists (Advent, Christmas, Epiphany, Lent, Holy Week, Easter, Ordinary Time), fixed verses on principal feasts; hides itself if the text cannot load.
- **`mountScriptureRefs(root, {limit=6})`:** links references in article text (text nodes only; skips headings, links and code). Cards open on hover, focus or click and close with Esc, the close button or an outside click (WCAG 1.4.13), cap at 6 verses then "…", say so when offline. Returns `dispose()`. Abbreviations need a verse ("Ps 23:1"); a bare chapter only links for an unambiguous full book name ("Psalm 23" yes, "Mark 2" no).
- **`src/features/growth/liturgical.js`:** `westernEaster`, `orthodoxEaster`, `adventSunday`, `baptismOfTheLord`, `liturgicalYear(year)`, `seasonFor(isoDate)`, `lagosDate()` (years 1583-4099). Colours follow common Roman Catholic and Anglican usage; local practice varies and the page says so.
- **`/church-calendar/`** (`?year=1900-2199`, 400 otherwise): server-rendered, readable without JavaScript, canonical and indexable only for the default view.
- **`/scripture/verse-of-the-day.json[?date=YYYY-MM-DD]`** (`tools/public-routes/verse-of-the-day.mjs`): the same verse as JSON for the digest; 400 on a bad date, 503 with Retry-After if the text was not built; `public, max-age=3600`.
- `church-calendar` must be added to the reserved slugs in `apps/cms/src/lib/reservedSlugs.ts` and `src/lib/public-routes.js` together (a test requires the two lists to match); until then an article with that slug would be shadowed by the page.

## 6. Environment variables (all optional; features stay off when unset)

CMS (`apps/cms/.env.example`): `MAIL_HTML_DAILY_CAP`, `NEWSLETTER_DIGEST_SEND`, `NEWSLETTER_DIGEST_THROTTLE_MS`, `NEWSLETTER_DIGEST_SCHEDULER`, `NEWSLETTER_ONE_CLICK_RATE_LIMIT`, `SHARE_CARDS_ENABLED`, `SHARE_CARD_RATE_LIMIT`, `SHARE_CARD_RATE_WINDOW_SECONDS`, `SHARE_CARD_MAX_CONCURRENT`, `SHARE_CARD_CACHE_MAX`, `SHARE_CARD_FONT_DIR`, `WHATSAPP_GROUP_URL`. Existing ones now also used: `SMTP_*`, `EMAIL_FROM_ADDRESS`, `PUBLIC_SITE_URL`, `NEWSLETTER_TOKEN_SECRET`, `CMS_PUBLIC_URL`, `PUBLIC_ARTICLE_PATH_TEMPLATE`.

Public host (`deploy/public-host/public-host.env.example`): `PUBLIC_SHARE_CARDS`.

## 7. Known limits

- Caps, rate limits and the share-card cache are per process: with several CMS processes the effective limits multiply (the advisory lock still allows only one digest issue per day).
- Without `TRUST_PROXY` every visitor shares one rate-limit bucket (existing behaviour of all public endpoints).
- A digest run that crashes mid-way (process killed) leaves its issue `sending`; it is not resumed (by design, no duplicates) and that Lagos day gets no further issue. The next day's issue goes out normally with the stories published after the stuck issue started (readers the stuck run did not reach miss that day's stories).
