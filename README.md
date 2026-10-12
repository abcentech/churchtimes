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

Assets use a relative base so the build works under `/churchtimes/` as well as a domain root. The repository includes a CI build/test workflow and a GitHub Pages deployment workflow that runs automatically on pushes to `main` and also supports manual runs.

Enable **Settings → Pages → Source → GitHub Actions**, then run **Deploy website to GitHub Pages**. Subsequent pushes to `main` automatically test, build and deploy. Pages must be enabled before deployment can succeed. Source publication and successful web deployment are separate outcomes. For a production newsroom, integrate the design with the existing WordPress CMS or a server-rendered publishing layer and individual article metadata.

## Verified checks

Clean frozen installation and production build passed. All 20 desktop/mobile browser checks passed on both the development server and the production build beneath `/churchtimes/`. Every homepage photograph loaded successfully in the production path, with no failed asset requests.

[Desktop preview](docs/previews/website-first-screen.png) · [Full homepage](docs/previews/website-desktop.png) · [Mobile preview](docs/previews/website-mobile.png)

### Blank Pages site or source-branch publishing

This is a Vite application: publishing the raw `main` branch with GitHub’s built-in Jekyll workflow does not compile the application. The deployment workflow now checks the existing Pages configuration and sets its build type to `workflow` before uploading the tested `dist` artifact. It preserves other site settings. Pages must exist and the workflow needs its declared `pages: write` permission.
