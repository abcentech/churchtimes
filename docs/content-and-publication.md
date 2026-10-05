# Current-content rebuild and GitHub publication

5 October 2026.

## What changed

The earlier concept site has been replaced by a photographic editorial design using **21 real stories** from churchtimesnigeria.net. Headlines, original dates, category assignments and source URLs come from its public WordPress API. Named bylines are taken from the article bodies when the generic publisher account differs. All 21 article images were downloaded from the original publication and are served locally, retaining their source URLs in the manifest.

The interface now has the journal homepage, seven sections, 21 story briefings, contributor/topic search, browser-local reading lists, about, contact and advertising views. The original concept articles and illustrated homepage are no longer used by the site.

The visual system uses a dark ink masthead/nav, warm paper, restrained clay accents, Newsreader editorial typography and DM Sans interface text. Font packages are self-hosted under their open-font licences. Images retain their original appearance; no generated photographs are presented as reported events.

## Source and editorial boundary

Source endpoint: `https://churchtimesnigeria.net/wp-json/wp/v2/posts?per_page=12&_embed`; additional requests collected two items each from Health, Education, Interviews, Publisher's Note and Business. One duplicate left 21 unique articles. The retrieval date is 5 October 2026. The dataset is in `src/data/stories.json`; per-story sources and media are in `docs/current-content-manifest.json`.

Headlines, dates, source categories and photographs are the publication's existing material. Briefings are newly written summaries, not copies of the full original article bodies. Each briefing explicitly links to the complete original report, its context and its original image. Sensitive or disputed accounts retain attribution; opinion, interviews and devotional content are not converted into independent newsroom findings.

This is a selected static edition, not a claim of a complete migration or real-time CMS synchronisation. Existing source article URLs remain intact. To update it, retrieve approved posts and their media, review the summaries/bylines, update the dataset and manifest, then build and publish a new commit. Keep unavailable content and corrections under editorial review rather than silently changing dates.

Public contact details are taken from the existing contact page. Email links compose requests using the reader's mail client; there is no falsely successful signup, anonymous form submission or payment backend. The update request clearly states that it does not automatically subscribe the reader. No vendor social profiles are used as company accounts.

## Website and production boundaries

The code can be hosted as a static website. A `./` asset base supports GitHub Pages repository paths. Hash routes support navigation without server rewrite rules; they do not provide individually rendered search-engine/share metadata for every story. For the production newsroom, integrate the approved design with the existing WordPress content system or add a proper server-rendered publishing layer and per-article metadata.

No production DNS, WordPress database, administrator settings or existing-site files were changed. No analytics trackers or payment collection were added. Reading-list IDs are saved only in the browser and can be cleared. The current site's source image licences and publication rights remain the publisher's responsibility; source locations are documented for the publisher's migration review.

The previous brand and financial strategy files remain available in the repository as working proposals. They are not presented as current newsroom policy, current advertising prices or approved business results. The new website removes strategy calculators and template-pack promotions from reader navigation.

## GitHub and optional hosting

Target repository: `abcentech/churchtimes`, branch `main`. Publishing source to GitHub does not change churchtimesnigeria.net or automatically enable hosting.

`Website checks` builds and runs desktop/mobile tests for pushes to main and pull requests. `Deploy website to GitHub Pages` is a manual workflow. To host the site on Pages, enable GitHub Actions as the Pages source in repository settings and run that workflow. Its deployment job exposes the resulting URL in GitHub. No deployment URL should be claimed before a successful deployment.

## Validation

- Frozen npm install and production build.
- Desktop/mobile browser coverage for real headlines and images, section filters, pagination, author search, reading-list persistence/clearing, source links/bylines/dates, keyboard dialogs, skip navigation, XSS-safe search text and all sections/company pages.
- Production build served beneath `/churchtimes/` to verify repository-path assets, fonts, images and routing.
- Desktop/mobile previews saved after lazy-loaded images have rendered.

Final execution outcomes are recorded in the README after checks complete. GitHub Actions execution is separate and is not claimed as passed merely because local tests pass.
