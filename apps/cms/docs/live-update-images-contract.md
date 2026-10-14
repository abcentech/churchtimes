# Live update photos: contract addition and rendering guidance for the public site

Status: implemented in the CMS (contract v1.4, migration `20261014_203617_live_update_image`). Additive: nothing that
exists today changes. This file is the text the public-site team can paste into `docs/public-live-coverage.md`
(contract section); that file is not edited from the CMS side.

## 1. Contract addition: `GET /api/live-events/:slug/updates`

Every item in `docs` gains one key, `image`:

```json
{
  "id": 41,
  "sequence": 7,
  "body": "Delegates vote on the amendment.",
  "occurredAt": "2026-10-13T10:15:00.000Z",
  "approvedAt": "2026-10-13T10:16:02.000Z",
  "image": {
    "url": "https://cms.example.org/api/media/file/vote.jpg",
    "alt": "Delegates raising voting cards in the synod hall",
    "width": 1600,
    "height": 900,
    "mimeType": "image/jpeg"
  }
}
```

An update without a photo has `"image": null`. The key is always present.

| Field | Type | Guarantees |
| --- | --- | --- |
| `image` | object or `null` | `null` when the update has no photo (or the attached file is not a usable image). |
| `image.url` | string | Same form as `featuredImage.url` of articles: absolute `${CMS_PUBLIC_URL}/api/media/file/<name>` in production, root-relative `/api/media/file/<name>` only in a local CMS without `CMS_PUBLIC_URL`. The path always starts with `/api/media/file/`. Run it through the same check as article media (`normalizePublicMedia` / `mediaUrl` in `src/lib/published-articles.js`: http(s) only, same origin as the configured CMS, path prefix `/api/media/file/`). |
| `image.alt` | string | Never empty (the CMS refuses to attach, or to approve, an image without alt text). Plain text, up to 300 characters. |
| `image.width`, `image.height` | positive integer or `null` | Intrinsic pixel size of the file at `url`. `null` only if the CMS does not know them. |
| `image.mimeType` | string | One of `image/jpeg`, `image/png`, `image/webp`. |

Exactly these five keys are returned. No filename, caption, credit, resized variants, uploader or other staff field is
exposed. The image of a pending or rejected update is never in the feed (only approved updates are), and an update that
is rejected after approval disappears from the feed together with its image, as before.

Unchanged: ordering by publication `sequence`, `since` / `nextSince`, `limit`, status codes, `Cache-Control: public, max-age=10`.
The image of an approved update can change (an editor can swap or remove it). As with `body`, key rendered items by `id`;
if you re-render an item you already hold, use the latest `image` you received. A client that does not look at `image`
keeps working. A client or test that asserts the exact key set of a feed item must now expect
`['approvedAt', 'body', 'id', 'image', 'occurredAt', 'sequence']` (the three existing exact-key assertions in the repository
were updated accordingly: `apps/cms/tests/integration/live.test.ts`, `apps/cms/e2e/cross-app/07-live-coverage.spec.ts`,
`cms-integration-tests/public-live.spec.js`).

## 2. Rendering guidance

- Show the photo **above** the update text, inside the update item (a `<figure>` with the `<img>`, then the text).
- Build the element with DOM APIs (`document.createElement('img')`, set `src`, `alt`, `width`, `height` as properties or
  attributes). **Never put `image.*` into `innerHTML`**, and never render any of it as HTML. `alt` is text; set it via
  the `alt` attribute or `textContent`, never interpolated into markup.
- `alt={image.alt}` always. Do not fall back to an empty alt (the field is guaranteed non-empty), and do not repeat the
  update body as alt.
- `loading="lazy"` and `decoding="async"`. A timeline can hold up to 100 items per poll, so only the images near the
  viewport should load. (The first image above the fold may stay eager if the page wants it; lazy is the safe default.)
- Always set `width` and `height` from `image.width` / `image.height` when present, and let CSS scale the image
  (`max-width: 100%; height: auto;`). The browser then reserves the right space and live updates do not shift the page.
  When `width`/`height` are `null`, give the figure a reasonable `aspect-ratio` placeholder (for example `16 / 9`) instead.
- Remove the `<figure>` if the image fails to load (`error` event), as `bindCMSImages` already does for article images,
  so the update text remains and no broken icon is shown.
- Do not wrap the image in a link to the media URL, and do not use `image.url` as a CSS `background-image` string without
  the same URL validation.
- New items arrive via polling: when you append or update an item, create the figure with the same code path as the
  initial render, so lazy loading and the error handler apply to polled items as well.
- Images are not keyed by URL: if the same `id` arrives again with a different (or `null`) `image`, replace or remove the
  figure to match.

## 3. Staff side (for the newsroom app)

`POST /api/live-updates { event, body, image?: <media id> }` and `PATCH /api/live-updates/:id { image: <media id> | null }`.
Upload the file first (`POST /api/media`, multipart, `alt` required) and send the returned `id`. Refusals are `400` with
one of: *The attached image does not exist or is not available to you.*, *The attached file must be a JPEG, PNG or WebP
image.*, *The attached image needs alt text. Add a description to the image first.* The edit rules are those of `body`
(reporters: own `pending` updates only; editors in scope: any time; trusted publishers: their own updates). An image change
is audited as `live-update.image`. Non-editors cannot edit the media of an approved update (`403`).
Full detail: `apps/cms/docs/api-contracts.md` §4.3, §6.2 and §9 (v1.4).
