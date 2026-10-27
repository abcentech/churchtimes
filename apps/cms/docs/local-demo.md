# Try the whole system on your own computer (local demo)

This starts a complete, throw-away copy of the Church Times system on your Windows laptop: the CMS (admin screen and API), the
newsroom app, the public website, a database, and about 300 invented stories. No Docker, no settings to edit. Nothing here touches
the real website or real data, and nobody else on the internet can reach it.

## Before you start (once)

1. Install Node.js 22 or newer (https://nodejs.org). Then open PowerShell in the project folder and run:

   ```powershell
   cd C:\Users\HP\Documents\churchtimes\churchtimes\apps\cms
   npm install
   ```

2. Close heavy programs (many browser tabs, Teams, Zoom). The demo needs about 2 GB of free memory.

## Start it

```powershell
cd C:\Users\HP\Documents\churchtimes\churchtimes\apps\cms
npm run demo
```

The first start takes 3 to 6 minutes (it builds the demo data). Later starts take about a minute. When it prints
**DEMO IS READY** it shows a table of web addresses. Open them in your browser. Leave the window open while you test.

Useful variations:

| Command | What it does |
| --- | --- |
| `npm run demo` | Start, keeping the data from last time. |
| `npm run demo -- --reset` | Wipe the demo data and start fresh. |
| `npm run demo -- --build` | Build the CMS first (several minutes once), then every page is fast. |
| `npm run demo -- --no-public` | Skip the public website. |
| `npm run demo -- --no-newsroom` | Skip the newsroom app. |

**To stop:** press `Ctrl+C` in that window. It stops the CMS, the sites and the database. If you just close the window instead, run
`npm run demo` again: it finds and stops the leftover database by itself.

## Logins

Every start creates new random passwords for five demo people, one for each role: admin, editor-in-chief, section-editor, reporter and
trusted-publisher. They are **never shown on screen**. They are saved in:

`C:\Users\HP\Documents\churchtimes\private-reports\demo-logins.txt`

Open it in Notepad and copy an email and password into the login form. The file sits outside the project folders on purpose, so it
cannot be committed or shared by accident. The emails look like `demo-admin@churchtimes.local`.

## Data and where it lives

Everything is stored in `C:\Users\HP\Documents\churchtimes\private\demo-data` (database, uploaded photos, build output), outside the
project. `npm run demo -- --reset` deletes it.

## What is in the demo

- About 300 published stories in all 15 sections, with pictures and about 40 or more reader comments (invented text).
- 3 stories with audio and video (the audio plays; the video file is a tiny placeholder that will not play).
- 5 recovered archive stories waiting for review, 2 stories in review, 1 scheduled for 2 days ahead, 1 draft, 1 with changes requested.
- Advertising campaigns, redirect rules and a live event.
- One demo account per role. Sign-up of new admins is switched off.

Stories have one section each (this version of the CMS has no "extra categories" field).

## What to try

1. Log in to the admin screen and the newsroom app as each of the five roles.
2. As the reporter, write a story in the newsroom app and send it for review. As the editor-in-chief, approve and publish it.
3. Open the review queue and approve one of the two "Demo in review" stories.
4. Open the archive review screen. As the **section editor**, approve one recovered story, then try to publish it as that same section
   editor: it is blocked (the person who approves cannot also publish). Publish it as the **admin**: allowed.
5. Search for "church" on the public site, or open the search address from the table.
6. Upload a photo to a story.
7. Schedule a story a few minutes ahead and watch it publish by itself (checked every 15 seconds).
8. Open the "Demo audio" and "Demo video" stories.

## Troubleshooting

**"Port is in use".** The demo picks the next free port by itself (CMS 3000 or higher, newsroom 5174 or higher, public site 5173 or
higher) and prints the real addresses, so use the printed table. If you see a port error anyway, close other copies of the demo.

**An old database is still running ("startup" or `postgres` processes in Task Manager).** This happens if the window was closed with the
X instead of `Ctrl+C`. Just run `npm run demo` again: it stops the leftover database that belongs to the demo folder. To do it by hand:

```powershell
Get-Process postgres -ErrorAction SilentlyContinue | Stop-Process -Force
```

(This stops every PostgreSQL on the laptop, so only use it if the demo is the only one you run.)

**It is very slow or the window says "out of memory".** Less than 2 GB of free memory. Close the browser and other programs, then run
again. The demo warns you at the start when memory is low.

**The first page takes minutes.** Without a production build the CMS runs in development mode and compiles each page when first
opened. Run `npm run demo -- --build` once to build it; after that start and pages are fast.

**Pages show "Internal Server Error" (500) right after a start.** Usually the computer ran short of memory while the CMS was compiling. Press `Ctrl+C`, close other programs, and run `npm run demo` again. The CMS messages are saved in `C:UsersHPDocumentschurchtimesprivatedemo-datacms.log` (no passwords in it).

**It stopped with an error.** Run `npm run demo -- --reset` once. If it still fails, copy the last 20 lines of the window into a message
(they contain no passwords).

**I forgot the passwords.** They are in the login file named above. Every new start makes new ones and overwrites that file.

## How it works (for developers)

- `apps/cms/scripts/demo.ts` starts embedded PostgreSQL (same package as `npm run db:local`, a free port, persistent data folder),
  runs migrations, runs the seeder `scripts/demo-seed.ts` with `payload run`, then starts the CMS and serves the Vite builds of the
  newsroom app and public site pointed at it (wiring as in `e2e/cross-app/support/stack.ts`: CORS, CSRF and submission origins,
  Cloudflare's always-pass Turnstile test keys, e-mail off, scheduler every 15 s, `ALLOW_FIRST_REGISTER=false`).
- The seeder reuses the synthetic export generator of `import:rehearse` and `perf:read` and the real importer (so comments, images and
  conversions are the real ones), then adds audio/video, workflow states, archive candidates (`import:archive-candidates` code),
  advertising and redirects.
- CMS mode: `next start` when `apps/cms/.next/BUILD_ID` exists (or `--build` is given), otherwise `next dev --webpack` (webpack, because
  Turbopack does not like linked `node_modules` folders).
- Passwords are random per run (`crypto.randomInt`), written only to the login file, whose location is checked to be outside every git
  work tree (`scripts/demo-lib.ts`, tested in `tests/unit/demo.test.ts`). `DEMO_DATA_DIR` and `DEMO_LOGINS_FILE` override the folders
  (the same location check applies). Uploads go to `<data folder>\media` through the `MEDIA_DIR` setting, which only the demo sets.
