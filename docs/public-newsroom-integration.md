# Public newsroom integration

The public Vite site reads anonymous, published-only content independently of
its selected static edition. Staff credentials, preview tokens and approval
controls are not used by the public reader.

## Configuration and routes

Set `VITE_PUBLIC_CMS_URL` to the CMS HTTP(S) origin before starting Vite/building.
Use HTTPS in production; localhost HTTP is supported for development. This is
public configuration, never an API token. Without it, the newsroom route gives
an explanatory state and the static edition stays available.

`#latest` lists published reports newest first, with pagination and manual retry.
`#report/<slug>` reads a published article with its public byline, featured media,
body and correction history. It supports direct URLs and sharing. The homepage
adds up to three distinct published reports when configured; failures leave the
static edition intact. CMS reports are not yet part of the static reading list
or its search index.

The backend must permit anonymous published-only GETs and CORS from the public
site origin. Requests omit cookies/authorization and use `where[status][equals]=published`,
`sort=-publishedAt`, `depth=1`, `limit` and `page`; a slug lookup adds
`where[slug][equals]`. Payload pagination must provide `docs`, `hasNextPage` and
`nextPage`. Client filtering excludes drafts, approvals, scheduled and archived
records even if the API is misconfigured, but does not replace server permissions.

## Mapped fields and rendering

[Verified mapping notes](cms-field-mappings.md) reference the merged CMS source.
Public models use title/slug/excerpt/publishedAt, populated `category.title`,
`bylineName`, `featuredImage`, `content` and `corrections`. Private staff `author`
records, review notes and scheduling/approval actions are not rendered.

Media URLs are resolved against the CMS origin; supported JPEG/PNG/WebP metadata
supplies intrinsic sizes, responsive variants, alt text, caption and credit.
Unpopulated IDs and invalid/unsafe media are omitted. Failed images collapse
while article text and correction history remain readable.

Lexical renders safe paragraphs, headings, quotes, lists, HTTP(S)/mailto links,
text formatting and populated media uploads. Unsupported embeds, raw HTML and
unsafe URLs are omitted. Unpopulated/internal document links are not guessed.
Content depth/node limits remain enforced; plain strings render as escaped text.

Configuration, HTTP errors, malformed responses, timeout, cancellation and
network failures are classified without leaking server diagnostics or showing
fake articles. Retryable pages retain links to the static edition; failed
pagination retains previously loaded reporting.

## Validation

```bash
npm run test:unit
npm run build
npm test -- --workers=2
npm run test:newsroom -- --workers=2
npm run export:pages
npm run check:pages
```

Newsroom browser tests intercept API/media responses with real-schema fixtures;
submission contract tests additionally execute the actual merged handler with
isolated test persistence and verification transport. Live database, CORS and
real Cloudflare verification are separate from these checks. No production
WordPress, authentication, approval or live-event change was made.
