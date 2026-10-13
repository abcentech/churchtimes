# Church Times Nigeria — historical article presentation standard (v1)

**Status:** Editorial acceptance specification. This is NOT authorization to rewrite historical journalism or to publish converted records.

## Non-negotiable preservation contract
1. Store the original source HTML, original URL, original publication date, author/byline, media references and SHA-256 in private, immutable archival storage. Do not commit originals to GitHub.
2. The public display may be reformatted, but the **words, ordering, quotations, scripture references, names, numbers, punctuation with meaning, citations and attribution** must remain intact. Never hallucinate missing text or complete an unfinished sentence.
3. Keep a per-article conversion manifest: source hash, converter version, output hash, conversion warnings, media statuses, human decisions and timestamps. Re-running conversion must be reproducible.
4. Uncertain changes are **suggestions**, not automatically accepted edits. Every manual intervention must be reversible and attributed.
5. Drafts and private material must remain private; do not import comments or author contact details into public articles.

## Deterministic display normalization (allowed automatically)
- Remove empty spacer paragraphs and duplicated whitespace **only when** it does not change meaningful line breaks, poetry, scripture quotations, Q&A labels, or preformatted material.
- Preserve paragraph boundaries and headings already represented by HTML. Preserve strong/emphasis, ordered and unordered lists, nested lists, hyperlinks, block quotes, tables, image order, alt text, captions, and embed URLs.
- Standardize heading hierarchy for display (e.g. page title is H1; body starts at H2), but retain original heading level in the conversion manifest.
- Strip unsafe scripts and event handlers from rendered HTML. Preserve the original HTML privately for audit.
- Replace unsupported WordPress shortcodes, tables, galleries and embeds with **visible placeholders** in staging plus review flags; never silently omit them.
- A video-only article is valid content: preserve embed URL and show a video component or an explicit review placeholder, not an empty article.
- If an image binary is missing, retain its original URL/reference and position in the private manifest and show a review placeholder in staging. Do not publish broken image tags.

## Editorial suggestions requiring human approval
- Inserting paragraphs where the original is one long text block without structural cues.
- Reclassifying text as a headline, subtitle, scripture quote, interview question or pull quote.
- Correcting spelling, grammar, punctuation, attribution, capitalization, broken links, or changing scripture translations.
- Adding descriptions, alt text, captions, tags, categories or contextual notes not present in the source.
- Removing duplicated passages or adjusting chronology.

## Article QA severity
- **BLOCKER:** source text lost, reordered, invented, altered quotation/date/name; missing non-text-only content; draft exposed; source checksum mismatch; dangerous HTML or media.
- **HIGH:** image missing/incorrect placement, broken internal link, table/list/Q&A collapsed, paragraph split with meaning change, unhandled shortcode.
- **MEDIUM:** missing alt text, heading hierarchy, long paragraph suggestion, missing explicit category, minor whitespace differences.
- **INFO:** formatting normalization that passed structural and textual checks.

## Acceptance tests Jules should implement
- Extract and compare normalized visible text from original HTML and converted Lexical, preserving punctuation and text order. Use both strict and whitespace-tolerant comparisons; whitespace-tolerant matches are not proof of complete fidelity.
- Compare ordered inventories of images (src, alt, caption), links (href and anchor text), headings, tables, list items, quotes and embeds before and after conversion.
- Round-trip representative synthetic fixtures through **actual Payload 3.90.2 Lexical editor**, save/reload and compare again. Include nested formatting, malformed WordPress HTML, Gutenberg comments, shortcode, iframe-only article, image caption, Q&A, scripture, and Nigerian names/diacritics.
- Classify every article into `ready_for_editorial_review`, `requires_manual_repair`, or `blocked`; **none are automatically approved for publication**.
- Test publication isolation (Church Times vs InvestNaira), idempotent import, preserved original dates and draft exclusion in disposable PostgreSQL.

## Operational guardrails
Work on `agent/publication-archive-engine`; avoid editing Jules-owned implementation files concurrently. Keep private WXR, full-text manifests and binaries outside GitHub. No deployment, merge or live WordPress modifications without owner approval.

## Reviewer sampling protocol
Review all BLOCKER and HIGH cases. Independently inspect a stratified sample of at least 100 articles from the remaining set (older/newer articles; plain text; images; embeds; tables; interviews; long-form). Log pass/fail by category and expand sampling if any critical fidelity defect appears. No claim of zero loss based on automated tests alone.
