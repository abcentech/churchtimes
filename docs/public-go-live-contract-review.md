# Public-site review of proposed go-live contracts

Review date: 2026-10-16. Source: [CMS contract proposal #39](https://github.com/abcentech/churchtimes/pull/39).
This records the public lane's compatibility findings; it does not approve owner
decisions, amend CMS code, implement an endpoint or activate an external service.
The proposal remains unimplemented until its respective CMS changes land.

## Answers to the public-lane questions

- **O6 / C1.1:** the proposed registered Lexical block shape is suitable for a
  future adapter: `type: block`, `fields.blockType: youtubeEmbed`, validated
  11-character `fields.videoId`, optional plain-text `fields.title`. The legacy
  renderer now accepts it as a safe link fallback (merged in #43, 2026-10-27; title capped at 200 characters). Do not interpret agreement with the shape
  as a shipped feature. It will need escaped, labelled link fallback in SSR and
  the browser, no iframe/network request before explicit reader consent, bounded
  title handling, and tests for malformed IDs, navigation and CSP. Raw iframe
  strings and arbitrary embed URLs remain unsupported. Until the registered
  block lands, retain the proposal's safe paragraph/link importer fallback.
- **O7 / C3.1:** change `mobile-banner` to **320×50**, mobile only. The proposal's
  320×100 conflicts with the exact dimension check in
  [`src/lib/advertising.js`](../src/lib/advertising.js) and would collapse. The
  other proposed sizes match: billboard 970×250 / 320×100; article-inline
  728×90 / 320×100. Do not silently change public inventory to accommodate the
  proposal. AdSense remains disabled and unimplemented pending owner approval.

## Integration details to preserve

### C2: SEO

Optional `seoTitle` and `seoDescription`, absent or null when unset, are suitable
additive fields. The public adapter will map only these documented fields once
the contract lands. Use the agreed title/excerpt fallbacks; keep editorial
headlines and RSS excerpts independent of SEO overrides. Escape every metadata
value and prove projection through actual anonymous published-article REST.
Deriving canonicals rather than accepting overrides avoids conflicting URL
sources. Keep `/reports/<slug>/` until the owner settles D1.

### C3: advertising delivery

Preserve the no-inventory and failure collapse behavior. A fixed 60-second cache
must not inadvertently promise immediate withdrawal: specify withdrawal latency,
bound freshness by campaign expiry, and revalidate expired inventory. The public
renderer repeats the inclusive-start/exclusive-end check. Delivery must arrive
before initial page rendering; adding an above-fold placement after first paint
would violate the existing layout-shift requirement. Public media URLs must meet
the renderer's URL policy and remain available for an already-served creative.
These details need agreement before P4 integration, after D4.

### C1 / C7: legacy paths and redirects

The proposed legacy fields do not by themselves make old upload paths work.
D2 must settle the public host and media mapping before promising compatibility.
The public host currently requires Node behind HTTPS for dynamic CMS HTML,
feeds, genuine error statuses and later redirect handling; a static Pages export
alone is insufficient. No host or article path has been selected here.

C7.1 rejects chains while C7.3 describes resolving chains. Clarify whether
generated inputs are flattened before final validation, or rejected outright;
the final delivered map must contain no chains or loops. Document query matching
and normalization with synthetic examples before P1 handles `/?p=ID` and AMP.

## Remaining gates

Wave 1 SEO and legacy adapters wait for landed, reviewed contracts and actual CMS
projections. P1/P3/P4/P5/P6 still require their owner decisions and contracts.
P7–P9 and cutover tooling remain in their later wave. No third-party script,
production setting, real export or personal data is introduced by this review.
Future fixture-only contract checks must be labelled **STUBS**, and cannot stand
in for real CMS integration or the CMS-owned staff cross-app launch gate.
