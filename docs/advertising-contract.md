# Public advertising delivery contract for Claude

This is a proposed frontend delivery contract, not a Payload implementation.
No schema, billing system, permissions, newsroom dashboard or production
WordPress configuration was changed.

## Prepared frontend

`src/lib/advertising.js` provides reusable homepage billboard, article-inline
and mobile-banner slots. Paid direct campaigns take precedence. An unavailable,
inactive, invalid or unsupported slot produces no label, creative, network
request or reserved gap. A failed image removes its slot. Available campaigns
have a visible **Advertisement** label and advertiser name, independent of
editorial headings and cards. Links use `rel="sponsored noopener noreferrer"`
and identify their advertiser and new-tab behaviour to assistive technology.

The current bootstrap is `src/data/advertising.json`, bundled at build time:

```json
{"campaigns": [], "adsense": {"enabled": false, "reviewed": false}}
```

It intentionally contains no live campaigns, AdSense IDs or scripts. Approved
campaign data can be supplied to this bootstrap before a build. No advertising
API is called yet. The public renderer does not accept arbitrary advertiser HTML,
JavaScript, tracking pixels or iframe snippets as direct creative.

## Delivery data

Claude should expose an anonymous, read-only public delivery projection, for
example a future `GET /api/public/advertising`. The endpoint name is proposed,
not implemented or assumed available. Its response/bootstrap shape should be:

```json
{
  "campaigns": [
    {
      "id": "example-only-campaign",
      "status": "active",
      "sponsor": "Example advertiser",
      "alt": "Describe the offer and destination",
      "destinationUrl": "https://example.org/offer",
      "startsAt": "2026-10-14T00:00:00Z",
      "endsAt": "2026-10-31T00:00:00Z",
      "priority": 10,
      "placements": ["homepage-billboard"],
      "creatives": {
        "homepage-billboard": {
          "desktop": {"src": "campaigns/example-desktop.webp", "width": 970, "height": 250},
          "mobile": {"src": "campaigns/example-mobile.webp", "width": 320, "height": 100}
        }
      }
    }
  ],
  "adsense": {"enabled": false, "reviewed": false}
}
```

**Example only: this record is not an active campaign or an offer to readers.**
All fields are public display data. Do not expose invoices, payment records,
customer contact details, private bookings, approval notes or authentication.

- `active` must mean paid/approved for delivery, with commercial approval and
  creative rights established **server-side**. Payment and billing state stays
  private. The frontend cannot verify payment from public delivery data.
- Enforce schedule, paused/cancelled/expired status and placement eligibility on
  the backend. The frontend repeats status/time/dimension checks as a safeguard.
  Start is inclusive; end is exclusive. Send valid ISO timestamps with timezone.
- A campaign can cover multiple placements but must include a complete creative
  set for each. Highest numeric priority wins; ID breaks ties deterministically.
  Use a stable string ID and bounded numeric priority. No rotation/tracking is
  implemented in this task.
- Sponsor and alt text are required. The renderer bounds them at 100 and 240
  characters, renders text safely, and preserves image alternative text.
- Destinations must be absolute HTTPS URLs without credentials. Images may use
  an approved HTTPS media URL or a path relative to public assets. Traversal,
  protocol-relative, HTTP, data and JavaScript image URLs are rejected. Prefer
  publisher-hosted, compressed static media; validate MIME/content and dimensions
  before publishing creatives.
- Use content-hashed media URLs and normal asset caching. Bound delivery-cache
  lifetime by schedule expiry and campaign withdrawal requirements. Return empty
  campaigns during no inventory, and define behaviour for a delivery outage.
- Before adding live requests, confirm CORS/cache behaviour and how bootstrap
  data arrives before initial page rendering. Do not insert a late, above-fold
  advert after the page has already painted: that would add layout shift.

## Supported inventory

The mobile breakpoint is 760px. Values below are intrinsic creative dimensions;
CSS scales them down to fit smaller reading areas without changing the ratio.
Both variants are required for billboard/article campaigns; unsupported
placements/creative sets collapse instead of stretching the wrong creative.

| Placement | Desktop creative | Mobile creative | Position |
| --- | --- | --- | --- |
| `homepage-billboard` | 970×250 | 320×100 | After the lead/headline group, before latest stories |
| `article-inline` | 728×90 | 320×100 | After article text, before the continuation/end links; briefings and CMS reports |
| `mobile-banner` | Not displayed | 320×50 | After latest homepage stories, before perspectives |

Campaigns are selected synchronously with the page content. Intrinsic image
sizes, an art-directed `picture` and the slot's fixed aspect ratio reserve space
before image delivery. Images load lazily, without autoplay or overlays. Hidden
desktop mobile-banner slots consume no layout space. Failed creatives collapse;
a failed-image removal can still move following content, so the backend should
validate and reliably host assets before activating a booking.

## Optional AdSense fallback — gated until review

No AdSense loader or publisher/slot ID was found in this frontend checkout.
The production WordPress publisher configuration has **not** been reviewed or
changed. `enabled` and `reviewed` remain false; setting flags alone does not
activate fallback because the app does not provide an AdSense adapter.

A future independently reviewed integration can pass a `reviewedAdSense`
provider to `mountAdvertisingPlacements(root, config, options)`. Its synchronous
`getFilledSlot(placement)` must return a detached, already-filled `ins.adsbygoogle`
element from the same document with `data-ad-status="filled"`, compatible fixed
slot dimensions, and no descendant scripts; otherwise the placement collapses.
The module consumes that ready element only if no eligible direct campaign
exists and both flags are true. It never loads Google's SDK, calls an ad queue,
creates an `ins`, changes IDs, or waits on an empty fallback placeholder.

The existing publisher account, IDs, slots, loader ownership, consent/privacy
handling and responsive behaviour must be reviewed before supplying this
provider. Unfilled/blocked units remain collapsed for that page render. Live
Google fill and consent behaviour are not proven by the mocked adapter test.
The actual reviewed loader must be integrated separately; this task does not
approve or deploy AdSense.

## Verification boundary

Browser fixtures are explicitly labelled **TEST FIXTURE — NOT A LIVE ADVERT**.
Tests prove frontend selection, labels, mobile fitting, reserved creative size,
keyboard/axe behaviour, empty/error collapse and fallback precedence. They do not
prove billing, commercial delivery, Google fill, impression counts or revenue.
No impression/click reporting, paid booking or production deployment occurred.
