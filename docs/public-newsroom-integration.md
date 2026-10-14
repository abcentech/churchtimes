# Public newsroom integration

> Current staging behavior and validation supersede the historical notes below:
> see [issue #15 public staging guide](public-staging.md).

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

## Verified CMS contract v1.2

The adapter follows [the merged CMS API contract](../apps/cms/docs/api-contracts.md).
Real Payload REST handlers and PostgreSQL are exercised by `npm run test:cms`;
local Next.js dev-server reads were also verified. No staff credentials are sent
by public views.

- `GET /api/articles` returns Payload pagination (`docs`, `hasNextPage`, `nextPage`).
- The adapter sends `where[status][equals]=published`, `sort=-publishedAt`,
  `depth=1`, `limit`, and `page`. Article lookup adds `where[slug][equals]`.
- Records require published status, a valid slug and title. Public fields include
  `excerpt`, `publishedAt`, populated `category.title`, `bylineName`, `content`,
  `featuredImage`, `corrections` and the original `legacyUrl`.
- Featured/card/hero and populated Lexical media URLs are resolved against the CMS
  origin. Only HTTP(S) `/api/media/file/` images from that origin with supported
  JPEG/PNG/WebP MIME are rendered. SVG, HTML, unsafe/foreign URLs and unpopulated
  upload IDs are dropped. Images carry alt text, intrinsic dimensions when available,
  captions and credits. No anonymous media-library discovery is added.
- Corrections retain their server-provided order and dates and render as escaped text.
  Byline uses public `bylineName`, never staff `author`. Validated HTTPS original
  Church Times URLs remain available as attribution links.
- Lexical paragraphs, headings, lists, quotes, bold/italic, safe absolute links and
  populated media nodes are supported. Raw HTML/unknown blocks are omitted.
  Internal document-link schema and live timelines remain outside this change.

Client filtering is defense in depth. Payload must enforce published-only access
on the server; returning draft data to an anonymous client is a backend defect
even when the website refuses to display it. Approval alone does not make a record
public. Invalid article URLs and unavailable/unpublished records render an
unavailable state without showing draft content.

## Verification

```bash
npm run test:unit
npm run test:cms
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
