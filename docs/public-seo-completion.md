# Public SEO completion: A13

The existing server/browser SEO implementation now has real-CMS coverage for an archive-style article, complementing the
C2 override journeys added in #44. This branch depends on #50/#44 and source build policy #57, and targets
`feat/newsroom-mvp`. The production URL choice and indexing switch remain owner decisions. Nothing is deployed, merged,
or enabled on a public host by these tests.

`cms-integration-tests/public-seo-completion.spec.js` uses real anonymous Payload REST, disposable PostgreSQL and the actual
production frontend build. It seeds a **synthetic** article with a 2020 publication date, a synthetic legacy byline and a
geometric media image. It verifies both `/reports/{slug}/` and `/{slug}/`, staging noindex and explicitly indexable local
configuration, on desktop Chrome and Pixel 7. The article checks run with website JavaScript disabled to prove SSR output.
The separate `public-c2-seo.spec.js` real browser journeys also prove hydration retains C2 overrides and editorial fallbacks.

The added checks cover:

- NewsArticle JSON-LD with the original publication date, editorial headline, byline, section, publisher and large image;
  no private staff author fields. Canonical URL, JSON-LD, Open Graph and RSS addresses agree.
- Featured-image dimensions in structured data and social cards, real CMS media origin, reserved dimensions and no mobile
  horizontal overflow.
- XML parsed by a browser DOMParser: valid sitemap/RSS, editorial RSS excerpt/date/image, latest 30 cap, no draft slug,
  published archive article, category pages and the documented static pages.
- Robots policy, feed/sitemap `X-Robots-Tag` in staging, and sensible homepage Open Graph values in both configurations.
  One English edition needs no invented hreflang variants.

This proves public rendering/discovery against the existing anonymous article API and the landed C2 fields from #53. It
does **not** prove the archive importer, private WordPress export or real migration/editorial QA. The CMS content shapes (#54) and the
C7 redirect endpoint with its normalisation vectors (#55) are now merged, so A9 (real redirects integration against the CMS endpoint and the shared vectors in
`apps/cms/tests/fixtures/redirect-normalisation.json`) is unblocked and is the next step; the host already runs those vectors in
`unit-tests/public-redirect-contract-vectors.test.js`. The default article path is `/{slug}/` (owner decision D1).

## Reproduce locally

```sh
npm run test:cms -- public-c2-seo.spec.js public-seo-completion.spec.js
```

This boots disposable local services and performs no request to production. Only the existing external Turnstile
script/Siteverify transport in the harness is STUBBED; it is unused by these read-only SEO journeys. CMS reads, database,
media and SSR HTML are real.

Optional evidence capture:

```sh
CAPTURE_PUBLIC_SEO_EVIDENCE=1 npm run test:cms -- public-seo-completion.spec.js
```

The checked-in [desktop](evidence/wave3-seo/archive-desktop.png) and
[Pixel 7](evidence/wave3-seo/archive-mobile.png) screenshots and adjacent JSON summaries were captured **locally** from the
synthetic archive fixture, with JavaScript disabled, before this PR was pushed. They are not screenshots of an imported
article or a production site. CI executes the assertions against fresh real services; it does not regenerate the checked-in
images because the capture flag is unset. No real personal data, secrets or owner URL lists are part of the evidence.

This PR adds no runtime JavaScript and leaves generated Pages assets for the dedicated rebuild.
