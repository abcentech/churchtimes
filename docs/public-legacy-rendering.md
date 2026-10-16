# Wave 1 P10: legacy-rendering groundwork

This public-only PR implements standard serialized Lexical table rendering,
normalizes content heading levels beneath the article headline, and exercises a
50-article synthetic corpus through the existing anonymous article API. It does
not edit `apps/cms` or `apps/newsroom`, run an import, or change live WordPress.

## Rendering contract used now

The current public contract remains a published article whose `content.root`
contains serialized Lexical nodes. Existing text/formatting, paragraphs, h1–h6,
quotes, lists, links and populated media uploads remain supported. Content
headings start at h2 beneath the page's h1 and cannot skip a level. h5/h6 retain
their requested depth once the preceding outline permits it. Whitespace/NBSP-only
headings disappear without advancing that outline. Root-relative links remain
links; protocol-relative URLs, backslashes and controls are rejected.
Links with credentials are rendered as plain text, like unsafe schemes.

Tables use the standard node types `table` → `tablerow` → `tablecell`.
`headerState` follows Lexical's row/column header bitmask (1/2); supported spans
are positive integer `colSpan` / `rowSpan`, capped at 20. Headers have appropriate
scope. Unknown attributes, inline styles and raw HTML are never copied. The
renderer gives each table 10,000 nodes and all table content in an article a
20,000-node aggregate limit, independent of the 5,000-node article prose budget.
Nested tables share the same table budget; depth remains limited to 30. Tables
are bounded to 100 rows × 20 cells. A complete 100×20 table of ordinary
paragraph/text cells fits without hiding following article text. When row, cell,
node or depth limits shorten table content, a visible “Table shortened to keep
this article readable.” note appears. Integer spans over 20 are capped at 20. A labelled,
keyboard-focusable scrolling wrapper keeps a wide table inside the article
on narrow screens. Empty or malformed tables disappear.

This does not add an editor feature or prescribe Claude's import representation.
If C1 chooses a different node shape, agree it in a written contract before
adding its adapter. `tools/legacy-content-fixtures.mjs` documents the standard
shape tested here without copying a WordPress export.

## Synthetic evidence

`PUBLIC_LEGACY_SAMPLES=true npm run test:cms` creates 50 synthetic historical
articles in disposable PostgreSQL through existing Payload helpers. Dates,
contributors, titles and table values are artificial. The media fixture is a
geometric PNG generated locally, replacing the test host's edition photograph.
No real person, contact list, backup or export is used or copied into evidence.

Each sample is fetched through actual anonymous REST and rendered at its clean
article URL in both desktop and Pixel 7 browser projects. The journey checks
headings, prose, quotes/lists, links, responsive inline media and captions, table
headers, root overflow, dangerous markup exclusion, WCAG rules and console/page
errors. The varied corpus includes h1/h5/h6, whitespace/NBSP-only headings,
root-relative links, spans over 20, a 100×20 table, an oversized table, prose
after each table, and C1.1 `youtubeEmbed` contract fixtures. Axe includes
`best-practice` rules (including `heading-order` and `empty-heading`) as well as
WCAG tags. The browser also asserts zero third-party network requests. Evidence
contains all 50 checked slugs per device, plus screenshots.
CI explicitly enables the corpus and retains the synthetic test evidence.

The corpus is **not a stubbed API response**. The existing harness **stubs
external Turnstile transport**, unused by these rendering tests. Unit tests use
synthetic in-memory content only and are not end-to-end tests. These public
journeys do not replace the CMS-owned staff cross-app or editorial launch gates.

## Not claimed or implemented

- C1's import pipeline and real legacy-content mapping have not landed. This is
  no claim that real migrated articles or the 50-article editorial QA gate pass.
- `/wp-content/uploads/*` compatibility still needs C1's media reconciliation
  and the D1/D2/P1 host/path decision. The same-origin `/api/media/file/` safety
  policy is preserved; this PR does not allow arbitrary WordPress image URLs or
  create unapproved host aliases/redirects.
- C1.1 `block` / `fields.blockType=youtubeEmbed` is supported as a labelled
  external video link only. An exactly 11-character `[A-Za-z0-9_-]` video ID
  builds the YouTube watch URL; the optional title is escaped. The fixture
  follows the PR #39 contract; it does not prove CMS editor registration or
  importer support. No iframe, thumbnail, SDK, script, automatic request or
  consent feature is introduced. Raw HTML and unsupported embeds remain excluded.
  Any later inline video needs a separate approved consent/CSP implementation.
- No P1/P4/P5/P6 or P7–P9 work is included.

See [synthetic results](evidence/wave1-legacy/README.md).
