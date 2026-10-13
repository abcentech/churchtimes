# Archive engine: Jules engineering handoff

This branch is isolated from the Church Times newsroom integration branch. Work against issue #14. The offline v6 prototype is **not** a tested Payload importer.

## Jules task: four parallel tracks
1. **Payload/Lexical:** Build conversion from WordPress HTML/Gutenberg to Payload 3.90.2 Lexical; test render, read and save against disposable PostgreSQL. Preserve original HTML and SHA-256. Support paragraphs, headings, links, inline emphasis, ordered/unordered lists, block quotes, captions, tables, figures, YouTube/other embeds. Never silently discard unknown blocks. Handle legacy article 20, an iframe-only YouTube article.
2. **Media:** Reconcile WXR attachment IDs and image URLs with private wp-content/uploads binaries, retaining captions, alt text and positions. Report unavailable files; do not download arbitrary external URLs.
3. **Importer:** Server-side Payload Local API, staging allowlist, dry-run by default, original historical publishedAt and byline preserved, category fallback with audit, source+publication+legacyId idempotency, duplicate-seed reconciliation, rollback manifest and draft exclusion. No live WordPress access.
4. **Editorial QA:** Generate source-vs-converted text diff, paragraph/heading checks, orphan images, embed checks and review queue. Automated cleanup may fix presentation **only**, never rewrite factual claims, quotes, dates, names, scripture references or authorial meaning without explicit human approval.

## Verified project constraints
- Published WXR articles: 4,343; no explicit category: 3,050; no featured-image reference: 687.
- Previous offline v6 audit: 3,192 inline image references in 1,735 articles; 1,934 missing alt text; 434 articles with complex HTML; 1,366 text-comparison warnings. These are review flags, not confirmed losses.
- Current CMS collection `apps/cms/src/collections/Articles.ts`: title <=240, slug unique globally <=160, required Lexical content, required category relationship, optional featuredImage, bylineName, status, publishedAt, legacyUrl, legacyId. `publishedAt` is protected by hooks; do not bypass workflow via public REST.
- Reuse engine for InvestNaira via publication config; isolate deployments/databases until tenancy constraints are properly designed.

## GitHub privacy
Commit **only source code, synthetic fixtures, tests and aggregate reports**. Never commit original WXR XML, private inventories, full article HTML, drafts, comments, private media or extracted content. These inputs are held separately by the owner.

## Delivery gate
Open PR to `feat/newsroom-mvp` but do not merge. Include test logs, synthetic fixtures, staging integration evidence, per-article exceptions and explicit list of limitations. No DNS, deployment, live CMS or Truehost changes.
