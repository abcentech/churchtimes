# Staff related-articles retriever (for Codex E5.3)

`POST /api/staff/related-articles` returns past **published** Church Times articles related to a draft or to some text, each with a citation (canonical
path and URL). It is a **retriever only**: it reads the existing `article_search` projection (go-live C8) and returns what is already published. It
**does not generate, summarise, rewrite or score with a model**, it does not write anything, and it is not audited. Full contract: `docs/api-contracts.md` §6.4.

## Request

Staff session cookie or `Authorization: JWT <token>`; any staff role. Cookie sessions are CSRF-checked (a foreign `Origin` is anonymous: 401).

```json
{ "text": "free text (optional)", "articleId": 123, "limit": 10 }
```

- One of `text` / `articleId` is required. `articleId` loads the draft with the caller's own access rules (404 if not readable) and excludes it from results.
- `limit` 1-20 (default 10; larger values are clamped to 20).
- Input is capped at 20,000 characters; the response says `"truncated": true` when it was cut. Body limit 256 KiB (413).

## Response

```json
{
  "ok": true, "limit": 10, "truncated": false,
  "results": [{
    "id": 42, "title": "...", "slug": "some-story",
    "canonicalPath": "/some-story/", "canonicalUrl": "https://www.example.org/some-story/",
    "publishedAt": "2025-03-01T09:00:00.000Z",
    "snippet": "plain text, at most 240 characters", "score": 0.0759, "matchedTerms": ["synod", "bishop"]
  }]
}
```

- Cite `canonicalUrl` (falls back to the `CMS_PUBLIC_URL` origin; `null` only if neither origin is configured, then use `canonicalPath`).
- Never returns drafts, in-review, scheduled or archived (withdrawn) articles, nor the article asked about.
- Every response, errors included, is `Cache-Control: private, no-store`. Rate limit per user (default 30 per 60 s, `429` + `Retry-After`).

## How the query is built

Title (weighted x3) + first 1,000 characters + the rest of the body, lowercased, letters/digits only, English stopwords and bare numbers removed, top 24 terms
by frequency, searched as `to_tsquery('english', 'a | b | c')` (OR) and ranked by `ts_rank`. Text is reduced to plain terms first, so it can never act as
tsquery syntax (`src/lib/staffRetriever.ts`, unit-tested against injection). The submitted text is never logged.

## Not included

No generation, no embeddings, no cross-language handling (English configuration), no pagination (top `limit` only), no category filtering.
