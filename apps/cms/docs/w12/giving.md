# Giving (Agent D, waves 1-2)

One-time gifts to the publication through **Paystack's hosted checkout**. Card, bank-transfer and USSD details are
typed on Paystack's page, never on ours: this system never receives, logs or stores card data.

**Off by default.** Nothing happens unless BOTH:

1. `PAYSTACK_SECRET_KEY` is set on the CMS, and
2. CMS Admin > Giving settings > **Enabled** is ticked (plus at least one currency Paystack supports, and
   `PUBLIC_SITE_URL` so Paystack knows where to send the reader back).

Without the key no giving endpoint reads the settings or calls the network. The public build shows no Give page and no
"Support our journalism" ask unless it was built with `VITE_PUBLIC_GIVING_URL`.

Free/paid: our side is free. Paystack charges a fee per successful payment (see "Fees" below); nothing is charged
for a gift that is not made.

## 1. Paystack facts this is built on (checked 30 Oct 2026)

paystack.com/docs refuses automated fetches (HTTP 403), so the API details were checked against Paystack's own
open-source sources for those pages: the **official OpenAPI specification** and the **official documentation code
snippets**, plus docs-v2.paystack.com and the Paystack support centre. Re-check before going live.

| Topic | Finding | Source |
|---|---|---|
| Initialise | `POST https://api.paystack.co/transaction/initialize`, `Authorization: Bearer <secret key>`, JSON `{ email (required), amount (required, integer in the currency's subunit), currency, reference, callback_url, channels, metadata }`. Answer `data.authorization_url` (on `checkout.paystack.com`), `access_code`, `reference`. | [OpenAPI `TransactionInitialize`](https://github.com/PaystackOSS/openapi/blob/main/dist/paystack.yaml), [snippet](https://github.com/PaystackOSS/doc-code-snippets/tree/main/dist/api/transactions/initialize), [API page](https://paystack.com/docs/api/transaction/#initialize) |
| Reference | "Unique transaction reference. Only `-`, `.`, `=` and alphanumeric characters allowed." Ours: `CTG-` + 32 hex (128 random bits). | OpenAPI `TransactionInitialize.reference` |
| Verify | `GET /transaction/verify/:reference`. `data.status` is `success`, `failed`, `abandoned`, `reversed` or an in-flight state (`ongoing`, `pending`, `processing`, `queued`); also `amount`, `requested_amount` (differs when the payer bears the fee), `currency`, `channel`, `paid_at`, `id`. An initialised but unpaid transaction reads `abandoned`. | [OpenAPI `transaction_verify`](https://github.com/PaystackOSS/openapi/blob/main/dist/paystack.yaml), [verify response example](https://github.com/PaystackOSS/doc-code-snippets/blob/main/dist/api/transactions/verify/response.json) |
| List | `GET /transaction?perPage&page&from&to&status` (reconciliation). | OpenAPI `transaction_list` |
| Webhook signature | Header `x-paystack-signature` = hex **HMAC-SHA512 of the raw request body, keyed with the secret key** (there is no separate webhook secret). | [docs-v2 webhooks](https://docs-v2.paystack.com/docs/payments/webhooks/), [official verify snippet](https://github.com/PaystackOSS/doc-code-snippets/blob/main/dist/doc/payments/webhooks/verifying-transaction.js) |
| Webhook sources | 52.31.139.75, 52.49.173.169, 52.214.14.220 (test and live). | docs-v2 webhooks |
| Webhook retries | Any answer other than 200 is a failure. Live: every 3 minutes for the first 4 tries, then hourly for 72 hours. Test: docs-v2 says hourly for 72 hours; other copies of the page say hourly for 10 hours. Acknowledge quickly. | docs-v2 webhooks |
| Replay | The signature covers the body only (no timestamp), so a captured delivery stays valid. Handled below. | (consequence of the scheme above) |
| Currencies | NGN (kobo), USD (cent), GHS, ZAR, KES. **No GBP, no EUR.** USD is only for businesses registered in Nigeria or Kenya, after Paystack approves international payments; USD payouts need a USD domiciliary account (Zenith Bank per the support centre). "Currency not supported by merchant" is the error otherwise. | [docs-v2 API (supported currencies)](https://docs-v2.paystack.com/docs/api/), OpenAPI `Currency`, [support: USD](https://support.paystack.com/hc/en-us/articles/360009973799), [support: international payments](https://support.paystack.com/hc/en-us/articles/360009973779) |
| Minimums | NGN 50.00 and USD 2.00 per transaction (enforced as a floor here; CMS minimums can only raise it). | Paystack supported-currency table (paystack.com/docs/api/#supported-currency; confirm) |
| Channels | Hosted checkout offers what the dashboard enables: card, bank, bank transfer, USSD, QR, mobile money, Apple Pay (per `channels` enum). We do not restrict channels. | OpenAPI `TransactionInitialize.channels` |
| Test mode | `sk_test_...` keys; test cards for success, PIN/OTP, bank-auth and failures; any future expiry. No real money. | [docs-v2 test payments](https://docs-v2.paystack.com/docs/payments/test-payments/) |
| Fees (Nigeria) | Local: **1.5% + NGN 100**, the NGN 100 waived under NGN 2,500, **capped at NGN 2,000**. International cards: **3.9% + NGN 100** (Mastercard, Visa, Verve), 4.5% American Express. USD transactions: 3.9% (4.5% Amex). | [support: pricing](https://support.paystack.com/hc/en-us/articles/360009881920) |

## 2. How it works

```
reader  --POST /api/public/giving/init-->  CMS: validate, store `pending` row (server reference, consent time)
                                            CMS --initialize--> Paystack  -> checkout URL
reader  <-- 201 { reference, checkoutUrl } -- browser goes to checkout.paystack.com (pays there)
Paystack --POST /api/public/giving/webhook/paystack (signed)--> CMS: HMAC check -> VERIFY call -> `succeeded` -> receipt
reader  <-- back to /give/thanks/?reference=  -- page polls GET /api/public/giving/status (server re-verifies while recent)
```

Security invariants (each has tests):

1. **Never trust the client or the webhook body for money.** The browser sends only its choices (amount in minor
   units, currency, cause, email, optional name, anonymous, consent, Turnstile token); unknown fields such as `status` or
   `reference` are refused. A row becomes `succeeded` only after our own server-to-server verify call returns `success`
   for that exact reference **and** the provider's currency equals the row's **and** the amount equals the row's (or,
   when the payer bore the fee, `requested_amount` equals ours and at least that much was charged). Otherwise the row
   stays as it was and the log says `amount-or-currency-mismatch`.
2. **Webhook authentication:** HMAC-SHA512 over the **raw bytes** (read capped at 64 KB before any parsing), compared
   with `crypto.timingSafeEqual` on the decoded digests after a strict 128-hex check. Bad signatures: 401 (throttled per
   source to 429). Optional `PAYSTACK_WEBHOOK_IPS` allow-list on top.
3. **Idempotent and replay-safe:** every state change is one conditional `UPDATE ... WHERE status IN (...)`, so of
   concurrent deliveries and status polls exactly one wins; `succeeded` is final (a later `failed`/`reversed` never
   downgrades it). Handled deliveries are also remembered (SHA-256 of the body, 72 h, in memory) and answered 200
   without work. A replay after a restart still changes nothing and sends nothing.
4. **Retries when unsure:** if the provider cannot be reached, or the body says success but verify does not (yet), the
   webhook answers 503 so Paystack retries; nothing is recorded.
5. **One receipt**, plain text, only after confirmed success, claimed atomically (`receiptSentAt`); a failed send is
   released and retried on the next confirmation. Contains reference, amount, date, cause, payment method type. Never
   card details.
6. **Logs** carry the reference, an outcome code and error class only: never e-mail, name, key or payload. The key is
   sent only in the `Authorization` header to the API origin; redirects are refused; `PAYSTACK_API_BASE` (the local fake)
   is ignored in production and for anything but loopback.
7. **Money is integers** (kobo/cents) end to end; the Give page converts typed amounts with string arithmetic.
8. Rate limits and Turnstile on init (action `giving-init`), per-IP and per-address; Origin allow-list and CORS like
   the other public endpoints; JSON only; 4 KB body cap.

Expiry: Paystack shows an unpaid checkout as `abandoned` from the start, so `abandoned` is only believed after 30
minutes. The public status check stops asking Paystack about a `pending` row after 24 hours and reports
`expired: true`; a later signed webhook that verifies as success still records the gift (money was taken).

## 3. API

All under the CMS `/api`. Error shape `{ ok: false, errors: [{ field?, message }] }` like the other public endpoints.

- `GET /public/giving/settings` -> `{ enabled: false }`, or `{ enabled: true, provider, testMode, currencies: [{ currency, label, presets: number[] (minor), minimumMinor, maximumMinor }], causes: [{ key, label }], thankYouNote, bankTransferNote }`. Only currencies Paystack can charge are listed (NGN first). `Cache-Control: private, max-age=60`.
- `POST /public/giving/init` body `{ amountMinor, currency, cause?, email, name?, anonymous?, consent: true, turnstileToken, website? (honeypot) }` -> 201 `{ ok, reference, checkoutUrl }`. 400 validation, 403 origin/Turnstile, 404 giving off, 413/415, 429 + Retry-After, 502 provider unreachable (nothing charged), 503 provider key rejected.
- `POST /public/giving/webhook/paystack` (Paystack only) -> 200 handled or ignored, 401 bad signature, 404 no key / other provider, 413, 415, 400 unparsable, 503 retry later.
- `GET /public/giving/status?reference=CTG-...` -> `{ ok, reference, status: pending|succeeded|failed|abandoned, amountMinor, currency, expired }`. No e-mail or name. 400 malformed, 404 unknown or giving off (no key). `no-store`. Verifies with Paystack at most every 5 s per reference while the row is pending and under 24 h old.
- `GET /giving/stats?days=30` (admin, editor-in-chief) -> `{ ok, days, byCurrency: { NGN: { succeededMinor, counts: { pending, succeeded, ... } } }, accepting, mode, offReason }`. No personal data. For an admin dashboard widget.

## 4. What we store and why (NDPA)

| Field | Why | Notes |
|---|---|---|
| reference, provider, providerRef | Match our record to Paystack's for support and reconciliation | not personal on their own |
| amountMinor, currency, cause, status, channel, paidAt | The gift itself; accounting | channel is e.g. `card`, `bank_transfer`, `ussd` |
| email | Paystack requires it to open a checkout; we send the receipt to it | admin-only in the CMS |
| name | Optional, for the receipt greeting | **not stored** when "Give anonymously" is ticked |
| anonymous | The reader's choice | |
| consentAt | When the reader ticked the consent box (NDPA lawful basis record) | consent wording version `giving-v1` (lib/giving/validate.ts) |
| receiptSentAt | One receipt only | |

Never stored: card numbers, CVV, bank details, provider payloads, IP addresses. The consent notice on the Give page
reads: *"We use your email address to send your receipt and, if needed, to contact you about this gift. Your name is
optional and is not stored if you give anonymously. Paystack processes the payment under its own privacy terms; we never
see or store your card details. We keep donation records for as long as the law requires for financial records, then
delete the personal details."* The reader must tick "I agree ..." (server requires `consent: true`).

**Retention** (owner to confirm with the accountant): keep succeeded rows for the statutory book-keeping period
(commonly 6-7 years); an admin may delete `pending`/`abandoned`/`failed` rows older than 90 days; blank `email`/`name`
earlier on a data-subject request (the amount, reference and dates are enough for the books). Erasure: an admin deletes
the personal fields or the row in CMS Admin > Giving > Donations (deletes are audited).

The privacy dialog on the public site now says gifts are paid on Paystack's page and card details never reach us.

## 5. Owner setup (step by step)

1. Create a Paystack business account (https://dashboard.paystack.com), complete compliance for the business
   (Churchtimes Agency Ltd) and add the NGN settlement bank account.
2. Dashboard > Settings > API Keys & Webhooks: copy the **test secret key** (`sk_test_...`). Set on the CMS server only
   (never in a `VITE_` variable, never committed): `PAYSTACK_SECRET_KEY=sk_test_...`. Optional `GIVING_PROVIDER=paystack`.
3. Same page, **Test Webhook URL**: `https://<CMS host>/api/public/giving/webhook/paystack`. (Callback URL can stay
   empty: we send `callback_url` per transaction = `<PUBLIC_SITE_URL>/give/thanks/`, or `GIVING_RETURN_URL`.)
4. Make sure the CMS has `PUBLIC_SITE_URL` (https), SMTP (for receipts), Turnstile (`TURNSTILE_EXPECTED_ACTION` must
   include `giving-init` when that list is set) and `PUBLIC_SUBMISSION_ORIGINS` (the public site origin).
5. CMS Admin > Giving settings: add currencies (NGN first; presets in **kobo**, e.g. 200000 = NGN 2,000), minimum and
   maximum, causes, thank-you note and bank-transfer note; tick **Enabled**.
6. Build the public site with `VITE_PUBLIC_GIVING_URL=https://<CMS host>/api/public/giving` (and the existing
   `VITE_TURNSTILE_SITE_KEY`). The Give page is `/give/`; the ask appears at the end of articles and in the footer.
7. Test with Paystack test cards (docs-v2 test payments): success, decline, bank transfer. Check the receipt, the row in
   CMS Admin > Giving > Donations, and `npm run giving:reconcile`.

**Going-live checklist**

- [ ] Paystack business activated; settlement account verified.
- [ ] For diaspora USD: "Request international payments" approved, USD domiciliary payout account added; otherwise list
      NGN only (international cards can still pay NGN, at the international card fee).
- [ ] Live secret key set (`sk_live_...`), **Live Webhook URL** set to the same path; test key removed.
- [ ] One real small gift end to end (card), then a bank transfer; receipt arrives; reconcile shows no issues.
- [ ] Optional: `PAYSTACK_WEBHOOK_IPS` with Paystack's three addresses (only with `TRUST_PROXY=true` and a correct
      client-IP header, or every webhook is refused).
- [ ] Privacy policy page mentions donations, Paystack as processor, and the retention period.
- [ ] Someone owns refunds/chargebacks and the weekly reconcile.

## 6. Operations

**Reconciliation** (read-only): `npm run giving:reconcile -- --days 7` (root or apps/cms; needs the CMS env and
database). Lists, by reference: Paystack success not recorded here (a status check or webhook retry will settle it),
recorded success not at Paystack, reversed at Paystack, amount/currency mismatch, our transaction at Paystack with no row,
pending over 24 h; and per-currency totals. Exit 0 clean, 2 issues, 1 could not run. Prints no personal data.

**Refunds and chargebacks** are done in the Paystack dashboard (Transactions > Refund; Disputes). We do not process
`refund.*`/`charge.dispute.*` webhooks: they are acknowledged and ignored, a refunded gift stays `succeeded` here and
the reconcile report flags it as reversed. Note the refund in the row's admin record if needed. Respond to disputes
within Paystack's deadline with the receipt and the reference.

**Troubleshooting**: Give page says unavailable -> check `GET /api/giving/stats` (`offReason`). Webhook 401s -> the
dashboard key and `PAYSTACK_SECRET_KEY` are from different modes (test vs live). "currency-not-enabled" in the log ->
Paystack has not enabled that currency for the account.

## 7. Testing offline

Everything runs without the network against `apps/cms/scripts/fake-paystack.mjs` (loopback only, `sk_test_` keys only,
same shapes as Paystack's published examples; it also serves a tiny test "checkout" page that completes, declines or
cancels and then sends a signed webhook).

- `cd apps/cms && npx vitest run --project unit tests/unit/givingCore.test.ts tests/unit/givingService.test.ts tests/unit/givingEndpoints.test.ts tests/unit/givingReconcile.test.ts`
  (signature, tamper, forged key, re-serialised body, duplicate and simultaneous webhooks, replay after restart,
  wrong amount, wrong currency, fee-bearer amounts, answer for another reference, expired reference, abandoned grace,
  provider down, receipt once / retry, feature off with no DB read and no network, logs free of personal data).
- `cd apps/cms && npx vitest run --project integration tests/integration/giving.test.ts` (real schema + PostgreSQL).
- `node --test unit-tests/giving-public.test.js` (integer money parsing, checkout allow-list, /give/ host routes).
- Manual: `PAYSTACK_SECRET_KEY=sk_test_<anything 16+ chars> node apps/cms/scripts/fake-paystack.mjs --port 3291 --webhook http://127.0.0.1:<cms port>/api/public/giving/webhook/paystack`,
  then run the CMS with `PAYSTACK_API_BASE=http://127.0.0.1:3291` and the same key (never in production: refused there).

## 8. Diaspora and currencies (risk)

- Paystack cannot charge **GBP or EUR** at all. A GBP/EUR row in Giving settings is ignored (not shown, init refused).
- **USD** works only after Paystack approves international payments for the Nigerian business and a USD payout account
  exists; 3.9% fee (4.5% Amex). Until then list NGN only.
- Readers abroad can always pay **NGN with an international card**: their bank converts; we pay 3.9% + NGN 100 instead
  of 1.5% + NGN 100. The Give page says so under the currency choice.
- GBP/EUR in their own currency need a second provider (Flutterwave supports them): add `lib/giving/flutterwave.ts`
  implementing `GivingProvider` (initialise, verify, webhook check with its `verif-hash`/signature scheme, list), select
  it with `GIVING_PROVIDER=flutterwave` and the settings `provider`, and extend `resolveGivingProvider`. Not built (time).

## 9. Not built / later

- **Recurring giving** (COULD, document only): Paystack Plans + Subscriptions (`plan` on initialise) would need
  subscription webhooks (`subscription.create`, `invoice.*`), a cancel flow and a stored authorisation code (a token, not
  card data). Needs its own consent wording and a manage/cancel link in every receipt. Not built.
- Flutterwave adapter (see 8).
- Admin dashboard widget UI: the data endpoint `GET /api/giving/stats` exists; the admin list/CSV is Agent B's.

## 10. Files

CMS: `src/lib/giving/*` (currency, reference, signature, provider, paystack, settings, validate, store, service,
receipt, runtime, reconcile), `src/endpoints/publicGiving.ts`, `src/scripts/givingReconcile.ts`, `scripts/fake-paystack.mjs`,
tests `tests/unit/giving*.test.ts`, `tests/integration/giving.test.ts`. Public: `src/features/giving/*` (lazy chunks:
`entry`, `give-page` + `give.css`, `ask` + `ask.css`), `tools/public-routes/giving.mjs`, one route line each in
`src/main.js`, `src/lib/public-page-routes.js`, `tools/serve-public.mjs`; reserved root slugs `give`, `giving`, `donate`.

Budget: with `VITE_PUBLIC_GIVING_URL` set, +175 B gzip initial JS (allocation 200 B); without it +77 B (route, reserved
slugs, privacy sentence). Initial CSS +0 B (all giving CSS is in the lazy chunks).
