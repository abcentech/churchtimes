# Publication Archive Engine

Automated migration and conversion engine for transferring legacy WordPress/WXR publication archives into Payload 3.90.2 Lexical content structures with zero data loss.

## Features & Track Overview

1. **Payload / Lexical Converter (`converter.js`)**
   - Parses WordPress HTML and Gutenberg block markup into Payload 3.90.2 Lexical AST.
   - Preserves original HTML string and computes SHA-256 hash for integrity verification.
   - Supports paragraphs, headings (`h1`–`h6`), inline formatting (bold, italic, underline, strikethrough, code), links, ordered and unordered lists, blockquotes, tables, figures, captions, and embeds.
   - Handles legacy article 20 (iframe-only YouTube embed) cleanly.
   - Wraps unknown or unhandled HTML blocks without silent text loss and raises `UNKNOWN_BLOCK_WRAP`.

2. **Media Reconciliation (`media.js`)**
   - Reconciles WXR attachment IDs and URLs with local binary directories.
   - Retains captions, alt text, titles, dimensions, and DOM positions.
   - Audits missing/unavailable binaries without making external HTTP network requests.

3. **Server-Side Importer (`importer.js` & `config.js`)**
   - Uses Payload Local API with `dryRun: true` enabled by default.
   - Multi-publication configuration supporting Church Times Nigeria and InvestNaira.
   - Validates staging hosts against a strict allowlist.
   - Preserves historical `publishedAt`, `bylineName`, `legacyId`, and `legacyUrl`.
   - Category fallback with audit logging when categories are missing.
   - Enforces idempotency on `(source, publication, legacyId)` and reconciles duplicate seeds.
   - Excludes draft articles from publication import.
   - Produces a JSON rollback manifest containing created record IDs for safe revert.

4. **Editorial QA Engine (`qa.js`)**
   - Calculates plain-text diffs and match ratios between source HTML and converted Lexical text.
   - Validates paragraph counts, heading counts, orphan image references, and embed conversions.
   - Raises review flags: `UNKNOWN_BLOCK_WRAP`, `ORPHAN_IMAGE_REFERENCE`, `EMBED_CONVERSION_MISMATCH`, `CATEGORY_FALLBACK_ASSIGNED`, `COMPLEX_HTML_STRUCTURE`, `MISSING_ALT_TEXT`, `TEXT_COMPARISON_WARNING`.
   - Enforces preservation policy: automated cleanup may fix presentation **only**, strictly guarding against modifications to factual statements, quotes, dates, names, scripture references, or authorial meaning.

## Privacy & Security Compliance

Commit **only source code, synthetic test fixtures (`fixtures/`), unit tests, and aggregate reports**. Never commit original WXR XML exports, private inventories, full article HTML, drafts, comments, private media binaries, or extracted customer content to Git repositories.

## Running Tests

Run the archive engine unit tests:

```bash
npm run test:unit
```
