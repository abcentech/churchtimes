# Church Times Nigeria — Staff Newsroom App

Vanilla JS + CSS single-page app for reporters and editors (dashboard, story editor, review queue and reader tips,
live coverage, media library). It talks to the real Payload CMS (`apps/cms`, contract `apps/cms/docs/api-contracts.md`
v1.3). **There is no mock in a production build.**

The public tip form is **not** part of this app: it lives on the public site. Tips arrive in the Review Queue
(Reader Tips tab) from the staff-only `/api/submissions` collection. Set `VITE_PUBLIC_SITE_URL` to show a link to it.

## Live mode configuration (the only mode in production)

| Build-time variable | Meaning |
| --- | --- |
| `VITE_CMS_URL` | CMS base URL, no trailing slash, e.g. `https://cms.example.org`. Baked in at build time; there is no user-editable backend URL. Empty = same origin (CMS reverse-proxied under `/api`). |
| `VITE_PUBLIC_SITE_URL` | Optional public site origin, used only to link to its tip form. |

Requirements on the CMS side (see `apps/cms/docs/api-contracts.md` §5 and `docs/staging.md` §7):

- **Same site.** The session is an `HttpOnly`, `SameSite=Lax`, host-only `payload-token` cookie. The newsroom and the CMS
  must share a registrable domain (`newsroom.example.org` + `cms.example.org`) or be served from one origin behind a
  reverse proxy. A newsroom on `*.github.io` / `*.pages.dev` or another registrable domain can log in but every later
  request is anonymous.
- **Origins.** The newsroom origin must be in both `CMS_CORS_ORIGINS` and `CMS_CSRF_ORIGINS`.
- Every request uses `fetch(..., { credentials: 'include' })`. The JWT in the login response body is ignored; nothing
  credential-like is ever stored. Boot calls `GET /api/users/me` (200 `{ user: null }` means signed out); without a
  server-verified user only the sign-in screen is reachable. Logout calls `POST /api/users/logout` and clears memory and
  `ctn_*` localStorage keys (the theme preference is kept).
- Roles and sections come from the server user object. Buttons are shown by role as a convenience only; the CMS enforces
  every rule and its error messages (401 returns to sign-in, 403 "not permitted", 400/409 messages) are shown verbatim.

### Build and run

```bash
VITE_CMS_URL=https://cms.example.org npm run build:newsroom   # output: apps/newsroom/dist
npm run dev:newsroom                                          # dev server against VITE_CMS_URL (default http://localhost:3000)
```

## Development mock mode (dev server only)

```bash
npm run dev:newsroom:mock     # vite apps/newsroom --mode mock  (loads .env.mock: VITE_NEWSROOM_MOCK=1)
```

`MOCK = import.meta.env.DEV && VITE_NEWSROOM_MOCK === '1'`. The mock backend (`src/api/mock.js`, `mock-data.js`,
`mock-ui.js` and its styles in `mock-ui.css`: localStorage data, role switcher, dev accounts on the login screen) is loaded with dynamic `import()` behind
that constant, so it is removed from production bundles even if the variable is set. `newsroom-security.spec.js`
builds the app and asserts the bundle contains no demo password, mock data, role switcher or settings dialog.

## Editing model

- Body is edited as a markdown subset and stored as Lexical JSON in `content` (`src/lexical.js`): paragraphs, h2/h3,
  bold, italic, quotes, bullet and numbered lists, `http(s)`/`mailto` links, and images. Stories containing anything
  else (embeds, nested lists, underline, uploads carrying extra data, ...) open with a read-only body so nothing is lost.
- **Imported (archive) articles are mostly read-only here.** Bodies imported from WordPress usually contain YouTube embeds,
  tables, h4 headings, new-tab links or uploads with extra data. Those open with a read-only body (the notice says so) and
  the body can only be edited in the CMS admin; a title/standfirst edit sends only those fields, so the stored body is never
  rewritten (fixture test in `test/lexical.test.js`). The review inspect modal shows a warning banner for such stories
  ("body contains video/table content not shown; open in CMS admin before approving") and Approve asks for confirmation.
- **Slug of a published story is read-only.** Once a story has `publishedAt` the URL slug cannot be edited here; the CMS
  refuses a slug change on a published article (403) unless the user is editor-in-chief or admin (audit action
  `article.slug-change`). An authorised change in the CMS admin creates a 301 redirect old -> new in the `redirects`
  collection and re-points rules that targeted the old address. The archive importer is exempt.
- Images inside the body: "Insert image" (body toolbar) opens the media picker (library or upload; alt text is required)
  and puts `![alt](media:<id>)` on a line of its own at the cursor. That line is stored as a Lexical upload node
  `{ type: 'upload', relationTo: 'media', value: <numeric id>, fields: null, format: '', id, version: 3 }` and read back
  from either an id or a populated media document. The alt in the token is only a label; the media record owns the alt text.
- Live updates carry one optional photo (`image` = media id): "Add photo" in the composer, removable thumbnail,
  thumbnails on pending and published updates (URLs pass the same CMS-origin guard as every other media URL).
- Saving PATCHes only changed, allowlisted fields (`title`, `slug`, `excerpt` = standfirst, `content`, `category` id,
  `featuredImage` id, `bylineName`). Workflow actions are separate PATCHes (`status`, plus `reviewNotes` for request
  changes). Editing a published story asks for the correction note the CMS requires. Autosave only applies to
  already-saved drafts / changes-requested stories and never creates records.
- Tips become stories only through `POST /api/submissions/:id/convert { category }`. Note: the CMS credits the
  submitter's name (not email/phone) as the draft's `bylineName`; the editor shows it so an editor can change or clear it.
- Media: multipart `POST /api/media` (`file` + `_payload` JSON with `alt`, `caption`, `credit`); featured images are
  picked from `GET /api/media`. Image URLs come from the CMS response (made absolute with `VITE_CMS_URL` if relative).
- All HTML interpolation goes through one `escapeHtml` helper (`src/util.js`); record ids are validated as `/^\d+$/`
  and `encodeURIComponent`-ed before use in API paths.

## Tests

```bash
npm run test:newsroom-unit   # Lexical mapping round trips (node --test)
npm run test:newsroom-app    # Playwright: production-bundle audit + mock-mode UI (dev mock server on :5276)
```

Live-CMS tests (real login, workflow, media, tips, live coverage) run in the same command when pointed at a
`staging:up` instance (see `apps/cms/docs/staging.md`), for example:

```bash
# in apps/cms: STAGING_DIR=.staging-newsroom STAGING_PORT=3300 STAGING_PG_PORT=55434 STAGING_SKIP_BUILD=1 \
#   STAGING_NEWSROOM_ORIGIN=http://newsroom.churchtimes.localhost:5274 \
#   STAGING_PUBLIC_ORIGIN=http://www.churchtimes.localhost:5273 STAGING_AUTH_LOGIN_RATE_LIMIT=200 npm run staging:up
NEWSROOM_LIVE_CMS_URL=http://cms.churchtimes.localhost:3300 \
NEWSROOM_LIVE_CREDENTIALS=apps/cms/.staging-newsroom/credentials.json \
npm run test:newsroom-app
```

The config then builds the app with that `VITE_CMS_URL` and serves the production bundle on
`http://newsroom.churchtimes.localhost:5274` (`NEWSROOM_LIVE_PORT`); credentials are read from the file and never printed.

### Accessibility suite (`tests/newsroom-a11y.spec.js`)

Runs inside `npm run test:newsroom-app` (also `npm run test:newsroom-a11y`) against the mock-mode dev server, on the
desktop (1440px) and mobile (Pixel 7) projects, and is part of the `newsroom` CI job.

- **axe-core** (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `best-practice`) on: login (and its error state), dashboard and
  story list (including empty), story editor (new, validation error, saved, publish confirmation and result), every review
  queue tab plus the inspect modal, live events (list, new-event form, running event), media library and detail modal, the
  public-tip notice (`#submit`) and the dark theme. There is no separate staff settings or archive screen in this app
  (CMS settings and the archive review live in the CMS admin; the public submit form is on the public site).
- **Severity policy:** `serious` and `critical` findings fail the test. `minor` and `moderate` findings are attached as
  `a11y-minor` test annotations and emitted as GitHub `::warning` annotations in CI.
- **Keyboard and AT checks:** skip link is the first stop and moves focus to `<main>`; tab order reaches the primary actions;
  every focus stop shows a visible ring; modals trap Tab/Shift+Tab, close on Escape, restore focus to the trigger and make the
  page behind them `inert`; the toast container is a persistent `aria-live` region and editor errors use `role="alert"`;
  every form control has an accessible name; `prefers-reduced-motion` removes animations/transitions; no horizontal scroll
  at 320 CSS px (WCAG 1.4.10 reflow, equivalent to 400% zoom).
- **Allowlist:** unavoidable exceptions go in `A11Y_ALLOWLIST` at the top of the spec as `{ rule, selector, reason }`. It is
  currently empty; every entry needs a written reason and a link to the follow-up.
- Fix real violations in `apps/newsroom/styles/newsroom.css` or the views instead of allowlisting them. Colour tokens for the
  dark theme live in the `[data-theme="dark"]` block.

## Stable test selectors

Elements carry `data-testid` plus stable ids, for example: `login-form`, `login-email`, `login-password`, `login-submit`,
`login-error`, `logout`, `story-list`, `story-row`, `dash-new-story`, `nav-new-story`, `editor-title`, `editor-standfirst`,
`editor-body`, `editor-category`, `editor-slug`, `editor-byline`, `editor-featured-image`, `editor-choose-image`,
`editor-save-draft`, `editor-submit-review`, `editor-approve`, `editor-request-changes`, `editor-publish`,
`review-card`, `review-inspect`, `tip-list`, `tip-card`, `tip-convert`, `tip-convert-confirm`, `media-upload-input`.
