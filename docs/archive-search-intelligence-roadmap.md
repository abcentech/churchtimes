# Archive Search & Editorial Intelligence — isolated development lane

**Status 14 Oct 2026:** private offline proof of concept complete; production PostgreSQL and CMS search/API integration **not** implemented or deployed.

## Verified offline work
- Strictly parsed owner-private WordPress WXR and indexed **4,343/4,343 published posts** in a local SQLite FTS5 database, excluding **101 drafts**.
- Searchable full text, headline, byline, category/tag metadata, year and original URLs; ranked snippets and source SHA-256 checksums; source articles remain private and unchanged.
- Generated **4,343 article-level candidate keyword rows** (not approved taxonomy or SEO tags) and metadata-only shortlist of **80 recent articles** for editorial style review.
- Standalone Python standard-library toolkit with **8 passing synthetic tests**; offline search checked on actual private WXR.
- **No live WordPress, staging or database writes; no model training, external AI upload or money spent.**
- Private database and reports remain private outside GitHub. Public-safe toolkit is available from owner-controlled ChatGPT artifacts.

## Architecture decision
Source of truth remains **Payload CMS 3.90.2 + PostgreSQL**. Implement **publication-scoped, published-only search projection** using PostgreSQL GIN full-text indexes first. Maintain original URL, author/byline, publication timestamps, approved taxonomies, source provenance/capture time, corrections/version history and SHA-256. Distinguish recovered historical .org/.com from current reports.

Consider **pgvector later**, after provider approval, embedding rights, cost/retention review and benchmark. Fuse word-based and semantic retrieval without requiring Elasticsearch or another hosted service at initial scale.

Editorial drafting: permission-scoped RAG with editor-approved current brand/voice examples, verified source ledger, historical/current claim separation, no invented interviews/quotes/scripture/facts, no auto-publish. Do NOT train on all 4,343 articles indiscriminately. InvestNaira requires separate DB/credentials/voice profile and no cross-site retrieval.

## Prerequisites
1. Archive import safety/fidelity per issues #14 and #28; 4,343/4,343 verified actual Payload imports and original binary media still outstanding.
2. CMS owner reviews SQL migrations and publish/update/unpublish propagation; retracted/draft material must never appear to anonymous readers.
3. Staff and public search API with safe filters, synonyms, pagination, text highlights, rate limits, indexed author/date/topic, citations/provenance.
4. Benchmark accuracy/relevance and accessible UX, canonical URLs, redirects, category hierarchy and search metrics.
5. Internal staff-authenticated draft assistant using approved style examples and licensed materials; source ledger and human approval gate.
6. Test hard publication/role isolation. Coordinate integration; do **not** touch main, production WordPress, DNS, Truehost or paid AI services.

The temporary SQLite index and keyword CSV are **demonstration assets only**, not a live production search.