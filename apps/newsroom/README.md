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
`mock-ui.js`: localStorage data, role switcher, dev accounts on the login screen) is loaded with dynamic `import()` behind
that constant, so it is removed from production bundles even if the variable is set. `newsroom-security.spec.js`
builds the app and asserts the bundle contains no demo password, mock data, role switcher or settings dialog.

## Editing model

- Body is edited as a markdown subset and stored as Lexical JSON in `content` (`src/lexical.js`): paragraphs, h2/h3,
  bold, italic, quotes, bullet and numbered lists, `http(s)`/`mailto` links. Stories containing anything else (images,
  nested lists, underline, ...) open with a read-only body so nothing is lost.
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

## Stable test selectors

Elements carry `data-testid` plus stable ids, for example: `login-form`, `login-email`, `login-password`, `login-submit`,
`login-error`, `logout`, `story-list`, `story-row`, `dash-new-story`, `nav-new-story`, `editor-title`, `editor-standfirst`,
`editor-body`, `editor-category`, `editor-slug`, `editor-byline`, `editor-featured-image`, `editor-choose-image`,
`editor-save-draft`, `editor-submit-review`, `editor-approve`, `editor-request-changes`, `editor-publish`,
`review-card`, `review-inspect`, `tip-list`, `tip-card`, `tip-convert`, `tip-convert-confirm`, `media-upload-input`.
