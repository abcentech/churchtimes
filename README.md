# Church Times Nigeria

A premium editorial website rebuilt around the current publication at [churchtimesnigeria.net](https://churchtimesnigeria.net/).

The site uses 21 current-source stories, their original photographs, dates and bylines; newly written briefings link to each full report. It includes seven editorial sections, search, a browser-local reading list, about, contact and advertising pages. All photos and fonts are served locally. No sample news is presented as published journalism.

## Development

Node 24, as pinned in `.nvmrc`.

```bash
npm ci
npm run dev -- --port 5173 --strictPort
```

In the cloud workspace, use `npm --cache /tmp/churchtimes-npm-cache ci` if the default home cache is not writable.

```bash
npm run build
npm run preview -- --port 4173 --strictPort
npm test -- --workers=2
```

Playwright uses system Chromium when available; set `CHROMIUM_PATH` to choose another system Chromium. Otherwise run `npx playwright install chromium`. Tests run against the development server by default. Set `TEST_BASE_URL` to test an already-running deployment, including a repository subpath.

## Public newsroom development

The public newsroom feed and article pages are opt-in through
`VITE_PUBLIC_CMS_URL`. The current edition remains available without a CMS.
See [the integration contract and validation commands](docs/public-newsroom-integration.md).

```bash
npm run test:unit
npm run test:newsroom -- --workers=2
```

The newsroom suite uses API fixtures. `npm run test:cms` additionally exercises real
Payload REST handlers and PostgreSQL; its external Turnstile transport is stubbed.

## Public submissions and contact forms

The public site includes `#submit` and a contact form on `#contact`. All public
submissions require editorial review and are never automatically published.
Online sending requires a public Turnstile site key and anonymous API
endpoints; otherwise the site offers email contact.

See [public forms configuration and the CMS v1.2 backend contract](docs/public-forms.md).
Use `.env.example` as a guide for public build-time values; never include secret keys.

```bash
npm run test:forms -- --workers=2
```

The forms tests mock both Turnstile and API responses. They do not send to the real newsroom.

## Source and scope

- [Current content and media manifest](docs/current-content-manifest.json)
- [Rebuild, source boundaries and publication notes](docs/content-and-publication.md)
- [Research audit](docs/research-and-discovery.md)
- [Earlier brand strategy](docs/brand-guide.md)
- [Financial operating plan](docs/financial-plan.md)
- [Financial workbook](public/downloads/churchtimes-operating-system.xlsx)

Content was retrieved on 5 October 2026. This is a reviewed static selection, not an automatic CMS migration or a live feed. Preserve attribution, image rights and original source links when updating. The website displays briefings; original full articles remain on the publication's existing site.

Contact links open email/phone apps. Requests for updates are not automatic subscriptions. Reading lists are local to the browser; no analytics, payments or account backend is included. Original production WordPress and DNS were not modified.

## GitHub Pages

The currently enabled Pages source is the `main` branch root. It publishes the **compiled** `index.html` and `site/` export, with `.nojekyll` to prevent source processing. No Pages API settings change or extra credential is needed.

Edit the application in `src/` and `public/`. The editable HTML template is `src/index.template.html`; the root `index.html` is generated. Vite uses that template for development and builds.

Before committing website changes:

```bash
npm run export:pages
npm run check:pages
```

Commit the resulting `index.html`, `site/` and `.nojekyll` with the source changes. GitHub’s existing branch-based Pages deployment publishes the compiled website automatically on push. The verification workflow checks that the export matches the current source, runs browser tests and retains the build artifact.

`npm run build` produces a complete deployable `dist/` directory. Both the committed branch export and `dist/` work under `/churchtimes/`. The GitHub workflow token is not asked to alter repository settings; that operation previously failed with “Resource not accessible by integration.”

## Verified checks

The real-content website has 20 desktop/mobile browser checks. The branch export must pass them on a plain static server under `/churchtimes/` before publication.

[Desktop preview](docs/previews/website-first-screen.png) · [Full homepage](docs/previews/website-desktop.png) · [Mobile preview](docs/previews/website-mobile.png)
