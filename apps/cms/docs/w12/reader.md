# Reader experience and trust (W12, Agent A)

Public site only. No schema changes: everything reads the fields and endpoints in `schema-contract.md`.

## What readers get

| Feature | Where | Notes |
|---|---|---|
| Light, dark and high-contrast themes | every page | Follows the device (`prefers-color-scheme`, `prefers-contrast`) until the reader chooses in **Display settings** (nav button). Saved in this browser only (`ct-theme`, `ct-contrast`, `ct-text`). Applied by the inline head script `#reader-prefs-bootstrap` before first paint, so there is no flash. With JavaScript off, a dark device still gets the dark theme (CSS fallback); high contrast then follows only the manual choice, which needs JavaScript. |
| Article text size | article pages | Five steps (Smaller to Largest). Zooms the reading column, deck and key points only; ads, forms and the original-article call-out keep their size. |
| 12 px type floor | every page | No interface text is below 12 px (`unit-tests/reader-prefs.test.js` guards every stylesheet). |
| Reading progress | article pages (CMS and demo briefings) | Scroll-driven CSS (`view-timeline`); a lazy scroll listener draws it where that is unsupported. Decorative, never announced. |
| Content-type label | article header and newsroom cards | News, Analysis, Opinion, Sponsored, Explainer, Fact-check. Opinion and Sponsored also show a one-line disclosure under the deck. |
| Kicker | article header | Optional short line above the headline. |
| Byline link | article header | Links to `/author/{slug}/` when the byline profile is public; otherwise the plain `bylineName`. |
| Updated stamp | article header | Only when an editor set `lastSubstantiveUpdate` and it is later than publication. Never automatic. |
| Reading time | article header | Body words / 220, at least 1 minute (pull quotes and gallery captions are not counted). |
| What you need to know | above the body | Up to 5 key points. |
| Pull quote, gallery | in the body | Text only; gallery images must be published media with alt text (max 12). |
| Author pages | `/author/{slug}/` | Photo, role, bio, links (`rel="me"`), latest 20 stories, paging. 404 for non-public profiles. |
| Trust pages | `/about/editorial-standards/`, `/about/ownership/`, `/corrections/` | Rendered from the **Site trust** global. A page whose text is empty, or the whole global while `published` is off, answers 404 and is not linked or listed in the sitemap. `/corrections/` always answers: policy text (if published) plus the corrections log. |
| Print | article, author and trust pages | Prints the story, labels, key points and corrections; hides navigation, ads, sharing and forms; shows link URLs. |

All of it is server-rendered by the public host (`tools/public-routes/reader-pages.mjs`, `tools/serve-public.mjs`), so it reads without JavaScript. The browser takes over from the embedded page data without fetching it again.

## Before launch (owner / editor-in-chief)

1. In the CMS admin, fill **Site trust**: editorial standards, ownership and funding, ethics and corrections policy, contact text. Tick **published**. Until then the two `/about/...` pages are 404 and only `/corrections/` is linked (footer).
2. Create author profiles for staff who should have a public page and tick **isPublic**; set **Byline author** on their stories.
3. Use **Content type** honestly: anything paid for is **Sponsored**.

## SEO

- `NewsArticle`: `author.url` (author page) and `dateModified` (the Updated date).
- Author pages: `ProfilePage` + `Person` (`jobTitle`, `sameAs` from the profile links) and breadcrumbs.
- Trust pages: `WebPage` about a `NewsMediaOrganization` with `publishingPrinciples`, `ownershipFundingInfo` and `correctionsPolicy` (only for published pages) and breadcrumbs.
- Sitemap: `/corrections/`, the published trust pages and every public author.

## CMS fields and endpoints used

Articles (REST `/api/articles?depth=1`, unchanged request): `kicker`, `contentType`, `keyPoints[].text`, `lastSubstantiveUpdate`,
`bylineAuthor` (`name`, `slug`, `isPublic`), `bylineName`, `corrections[].note/correctedAt`, `content` blocks `pullQuote`
(`quote`, `attribution`) and `gallery` (`images[].image` populated media with `alt`, `caption`, `credit`, sizes; `images[].caption`).
Endpoints: `GET /api/public/authors` (sitemap), `GET /api/public/authors/:slug?page=`, `GET /api/public/site-trust`,
`GET /api/public/corrections?page=`. No new environment variables; no paid services.

## Tests

`npm run test:unit` (`reader-prefs.test.js`, `reader-pages.test.js`), `npm run test:reader-trust` (Playwright, synthetic CMS),
`tests/reader-display.spec.js` (themes, settings dialog, axe WCAG 2.2 AA in light, dark and both high-contrast themes, progress bar).

## Budget

Initial JS bundle +727 B gzip; the inline head script is a further 292 B gzip (not counted by `check:reader-budget`).
Initial CSS +757 B gzip (including 19 B for the no-JavaScript dark fallback). Furniture, author/trust page and print
styles are a lazy stylesheet (`reader-pages-*.css`, about 1.8 KB gzip). The public host links it in the head of the pages
it server-renders (articles, author and trust pages), so they are styled and print correctly with JavaScript off and do
not shift when the client takes over; it finds the hashed file by the `--reader-pages-sheet` marker and never picks a
stylesheet the page already links. `unit-tests/reader-pages.test.js` checks this against a fake build and, after
`npm run build`, against the real one.
