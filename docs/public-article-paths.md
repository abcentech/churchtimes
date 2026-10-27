# Public article paths and optional CMS SEO

`PUBLIC_ARTICLE_PATH_TEMPLATE` accepts exactly `/{slug}/` or `/reports/{slug}/`. Owner decision D1 is settled: the public host
defaults to `/{slug}/` when the variable is unset or empty, and the value must equal the CMS's own
`PUBLIC_ARTICLE_PATH_TEMPLATE` (also default `/{slug}/`). Set `/reports/{slug}/` only for a rollback. Anything else stops startup.
Under `/{slug}/` the host refuses to treat a first path segment owned by a real route as an article. The list mirrors the CMS
`apps/cms/src/lib/reservedSlugs.ts` (`admin`, `api`, `newsletter`, `search`, `wp-admin`, `about`, `latest` and so on); the CMS renames an
imported slug that collides, and any new top-level public route must be added to both lists.

The Node public host uses one template for clean article routing, canonical tags, JSON-LD URL, social-card URL, sitemap,
RSS and server-rendered latest/category links. It emits an escaped `public-article-path-template` meta value on HTML
responses so browser-generated article links and navigation use the same value. With no runtime value (a
standalone static export, which cannot serve root slugs) the browser library falls back to `/reports/{slug}/`; every server-rendered
page carries the meta value. A static host cannot supply server redirects.
Changing only the template does not create legacy redirects; use the separate C7 redirect engine when that PR lands.

C2 fields are optional: the title tag and social title use `seoTitle` then `title`; meta/social/structured description use
`seoDescription` then `excerpt`. The visible editorial heading and deck keep `title` and `excerpt`. RSS remains editorial
`title`/`excerpt`. Canonicals are always derived, never taken from a CMS override. Values are escaped in HTML and inert JSON.

Validation in `unit-tests/public-path-template.test.js` uses synthetic C2 fixtures and an anonymous API **STUB**. It tests
both templates with a non-root site base, escaped SEO metadata, unchanged editorial text, canonical slash handling,
latest links, sitemap and RSS. This does not prove a real C2 CMS projection: Claude owns that integration after C2 lands.

`npx playwright test --config playwright.routing.config.js` builds the actual frontend with a synthetic public CMS origin
into a disposable directory, then exercises both templates in desktop Chrome and Pixel 7. It checks SSR hydration, SEO
metadata and latest-to-article navigation. CMS responses are **STUBBED**; no real endpoint or data is involved. The dedicated
Public routing fixtures workflow runs this browser coverage on relevant public code/build changes.

Review follow-up: empty/whitespace-only template settings use the unchanged default, matching the CMS contract. Under
`/{slug}/`, a reserved article slug is skipped in RSS and the article portion of sitemap output; other valid stories and
static-page sitemap entries remain available. The import/editor must still resolve the collision before that article can
have a public root URL. The new reserved-slug coverage remains an explicitly synthetic API fixture.

C2 is now implemented in integration by CMS PR #53. `cms-integration-tests/public-c2-seo.spec.js` seeds only synthetic
metadata through real Payload, confirms the fields on the anonymous REST projection, and checks both article templates in
the compiled browser on desktop and Pixel 7, including SSR hydration, fallback fields, JSON-LD and unchanged RSS excerpts.
The older unit fixtures remain labelled fixtures. This proves C2 projection/consumption, not C7 redirects or a real archive import.
