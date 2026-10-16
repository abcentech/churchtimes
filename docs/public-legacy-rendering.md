# Wave 1 P10: legacy-rendering groundwork

This public-only PR implements standard serialized Lexical table rendering,
normalizes content heading levels beneath the article headline, and exercises a
50-article synthetic corpus through the existing anonymous article API. It does
not edit `apps/cms` or `apps/newsroom`, run an import, or change live WordPress.

## Rendering contract used now

The current public contract remains a published article whose `content.root`
contains serialized Lexical nodes. Existing text/formatting, paragraphs, h2–h4,
quotes, lists, links and populated media uploads remain supported. Content
headings cannot skip a level below the page's h1. Links with credentials are
rendered as plain text, like unsafe schemes.

Tables use the standard node types `table` → `tablerow` → `tablecell`.
`headerState` follows Lexical's row/column header bitmask (1/2); supported spans
are positive integer `colSpan` / `rowSpan`, capped at 20. Headers have appropriate
scope. Unknown attributes, inline styles and raw HTML are never copied. The
renderer shares its node/depth budget with rows/cells and bounds a table to 100
rows × 20 cells. A labelled, keyboard-focusable scrolling wrapper keeps a wide
table inside the article on narrow screens. Empty or malformed tables disappear.

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
errors. Evidence contains all 50 checked slugs per device, plus screenshots.
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
- YouTube/other embed node shapes wait for C1's written contract. Raw HTML and
  unsupported embeds remain excluded. Existing safe links remain links; no
  iframe, SDK or third-party script is introduced. An eventual allowlisted
  embed must also satisfy the approved host's CSP/privacy policy.
- No P1/P4/P5/P6 or P7–P9 work is included.

See [synthetic results](evidence/wave1-legacy/README.md).
