# Archive Engine — reviewer acceptance matrix (2026-10-13)

**Purpose:** independent review of Jules's forthcoming PR. This document contains no private archive content and is not a claim that the tests have passed.

| Gate | Required demonstration | Failure blocks merge? |
| --- | --- | --- |
| Source preservation | Original HTML and SHA-256 retained outside GitHub; deterministic export and rollback manifest | Yes |
| Word fidelity | Ordered visible text, named entities, quotations, numbers, dates and scripture references match source; differences listed per article | Yes |
| Structure | Paragraphs, H2–H6, lists, quotes, links, tables and images survive convert/save/reload in Payload 3.90.2 | Yes |
| Video-only | Iframe-only article retains a video/embed representation, not empty content | Yes |
| Security | Script/event-handler sanitization, no external HTML execution, drafts not exposed | Yes |
| Images | Attachment IDs mapped to verified binary files; unresolved sources reported, never falsely marked recovered | Yes |
| Dates | Original publication timestamp/time zone preserved after Payload save/reload | Yes |
| Identity | Idempotent source + publication + legacy ID mapping; no duplication with seed | Yes |
| Categories | Every fallback labelled and listed; no fabricated editorial classifications | Yes |
| Isolation | Church Times and InvestNaira synthetic fixtures cannot read/write each other's content | Yes |
| Dry run | Import defaults to read-only dry-run; staging write requires explicit flag and environment allowlist | Yes |
| Live safety | No production secrets, deployment, DNS, WordPress or Truehost changes | Yes |

## Suggested reproducible test fixtures (synthetic only)
1. Two paragraphs with inline bold, italic, links and accented Nigerian names.
2. Q&A interview with alternating question labels, quotations and scripture citations.
3. Figure with image URL, alt text and figcaption; absent binary case.
4. Table with header, colspan and nested list; require either faithful support or flagged review.
5. Gutenberg comments plus unknown shortcode; require visible staging placeholder and preserved original.
6. YouTube iframe as the *only* body content; require non-empty result.
7. Duplicate legacy ID across two publications; require no cross-publication collision.
8. Existing seed article with same legacy URL; require reconciliation, not duplicate.
9. Old published timestamp, daylight-saving/timezone variation and no category.
10. Malicious inline script/event handler and a draft; neither may become public.

## Reviewer evidence Jules should attach to PR
- Exact commit SHA, commands run and results, Payload and PostgreSQL versions.
- Before/after synthetic examples and save/reload evidence.
- Counts for pass, warning, blocker and untested records, separately; never equate warning-free with publication-ready.
- Media coverage: URLs vs verified local binaries vs missing assets.
- Any unsupported formatting with an explicit non-lossy fallback.
- Staging-only import log, rollback procedure and collision report.
- Explicit declaration that private WXR and extracted article bodies were not committed.

## Coordination
Jules owns implementation. This checklist is an independent quality gate; do not modify Jules's code concurrently. Branch `agent/publication-archive-engine`; proposed PR target `feat/newsroom-mvp`. Human sign-off required before merge and before any publication.
