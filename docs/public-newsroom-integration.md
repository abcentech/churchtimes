# Public newsroom integration

The public website remains Vite. The current static edition, source attribution,
search and browser-local reading list remain available independently of the CMS.
No production WordPress, DNS or `main` deployment changes are part of this work.

## Enable the feed

Set `VITE_PUBLIC_CMS_URL` to the CMS HTTP(S) origin before starting Vite or building.
This is a **public build-time value**, never an API token. Leave it unset to use
the current edition with an explanatory newsroom page. For local development:

```bash
VITE_PUBLIC_CMS_URL=http://localhost:3000 npm run dev -- --port 5173 --strictPort
```

Use the backend's actual port when available. The backend must allow anonymous
GET requests and CORS from the frontend origin. Production builds require an HTTPS
CMS origin. No cookies, authentication headers, privileged endpoints or draft
preview tokens are sent by the adapter.

`#latest` lists reports, newest first, with pagination and retry controls.
`#report/<slug>` opens a published report and supports direct links and sharing.
The homepage adds up to three published reports when configured; an unavailable
CMS leaves the current edition intact. CMS stories are not yet included in the
static edition's search or reading list.

## Contract awaiting backend verification

Only the sprint's API v0 and existing frontend adapter were available when this
change was implemented. Browser integration is tested against fixtures, **not a
running Payload backend**. Confirm these fields with the backend owner before
enabling the feed on a deployed site:

- `GET /api/articles` returns Payload pagination (`docs`, `hasNextPage`, `nextPage`).
- The adapter sends `where[status][equals]=published`, `sort=-publishedAt`,
  `depth=1`, `limit`, and `page`. Article lookup adds `where[slug][equals]`.
- Documents require `status: published`, a lowercase hyphenated `slug`, and `title`.
- Optional fields: `excerpt` (or `summary`), `publishedAt` (ISO timestamp),
  `category` (string or a populated relation with `title`), and `content`.
- `content` supports plain text or Payload Lexical `{ root: ... }`. The renderer
  supports paragraphs, headings (h2–h4), bold/italic text, lists, quotes and
  absolute HTTP(S)/mailto links. Unsupported nodes, raw HTML and uploads are
  omitted. Images, author relations, internal document links and live updates
  need a confirmed contract before rendering.

Client filtering is defense in depth. Payload must enforce published-only access
on the server; returning draft data to an anonymous client is a backend defect
even when the website refuses to display it. Approval alone does not make a record
public. Invalid article URLs and unavailable/unpublished records render an
unavailable state without showing draft content.

## Verification

```bash
npm run test:unit
npm run build
npm test -- --workers=2
npm run test:newsroom -- --workers=2
```

The newsroom browser suite starts its own Vite server on port 5174 with a local
CMS origin and intercepts the API. It checks desktop/mobile reading, safe rich
text, unpublished records, pagination, retries and stale responses. The standard
suite checks the existing edition and the unconfigured newsroom fallback. Run it
with `VITE_PUBLIC_CMS_URL` unset.

Keep the compiled branch export in sync before committing website changes:

```bash
npm run export:pages
npm run check:pages
```

This updates `index.html` and `site/` on the development branch. Opening a PR into
`feat/newsroom-mvp` does not change the production branch or deploy the site.
