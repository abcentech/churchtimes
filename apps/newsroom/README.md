# Church Times Nigeria — Newsroom UI

**Internal Newsroom Editorial Interface**  
*Branch:* `agent/gemini-ui-support` · *Target:* `feat/newsroom-mvp`  
*Aesthetic System:* Church Times Nigeria Brand Guide (Forest `#173B32`, Parchment `#F6F3EA`, Ink `#222A25`, Clay `#A45336`, Sage `#DFE5D8`, Muted `#61675E`)  
*Accessibility Standard:* WCAG 2.2 AA compliant with high-contrast visible focus, screen reader live regions, and semantic landmarks.

---

## 1. Overview & Architecture

The Church Times Newsroom UI is an isolated, lightweight, production-oriented single-page application built using pure Vanilla JS and Vanilla CSS. It provides church reporters, section editors, and the editor-in-chief with a streamlined workspace for writing, reviewing, fact-checking, approving, and publishing journalism, as well as managing live event coverage and public submissions.

### Project Separation of Concerns
- **Newsroom UI (`apps/newsroom/` & `tests/newsroom.spec.js`)**: Owned by Gemini. Completely decoupled from public site templates and backend database code.
- **Public Vite Website (`src/`)**: Owned by ChatGPT on `agent/chatgpt-frontend`. Preserved without modification.
- **Payload CMS & PostgreSQL (`apps/cms/`)**: Owned by Claude on `agent/payload-core`. Integrated via typed adapter contracts.

---

## 2. Key Features Implemented

### 1. Newsroom Dashboard (`#dashboard`)
- **Editorial Pipeline KPIs**: Real-time metric cards tracking Drafts, In Review, Revisions Requested, Approved Stories, Published Stories, and Reader Tips.
- **Quick Action Launchpad**: One-click navigation to Write Story, Review Submissions, Go Live, and Media Library.
- **Filterable Story Pipeline**: Search by reporter or headline keywords; filter by status and category.
- **Active Role Switcher**: Switch between Reporter (*Gbenga Osinaike*), Section Editor (*Derin Adeogun*), Editor-in-Chief (*Lanre Ogundipe*), and Public Contributor.

### 2. Story Editor (`#editor`)
- **Headline & Auto-Slug Engine**: Formats display headlines and automatically derives clean URL slugs.
- **Standfirst / Deck Summary**: Editorial italicized lead text.
- **Category Selector**: Faith & Society, Church & Ministry, People & Purpose, Business & Vocation, Culture & Ideas.
- **Body Editor**: Markdown formatting toolbar (Bold, Italic, H2, H3, Blockquotes, Bullet Lists) with dynamic word counter and reading-time estimates.
- **Featured Photograph Selection**: Attach images with verified captions, photographer credits, and accessible alt-text descriptions.
- **Autosave Engine**: Visual debounce indicator (`Saved just now` / `Autosaving...` / `Unsaved changes...`).
- **Live Reader Preview**: Desktop side-by-side split screen; mobile tabbed toggle (`✏️ Edit` / `👁️ Preview`) rendering article exactly as public readers see it.
- **Role-Governed Workflow**:
  - *Reporter*: Save Draft, Submit for Review (`draft` -> `in_review`).
  - *Section Editor*: Request Changes with feedback notes, Approve Story (`in_review` -> `approved`).
  - *Editor-in-Chief*: Publish Story immediately to public feed (`approved` -> `published`).

### 3. Review Queue (`#review`)
- **Tabbed Review Stages**: In Review, Reader Tips & Submissions, Revisions Requested, and Approved Ready.
- **Story Inspection Drawer**: Read complete text, verify fact-checking checklist (corroborated sources, subject dignity/consent, photo rights), and approve or request revisions.
- **Editorial Revision Loop**: Send feedback guidance notes back to reporters.

### 4. Public Submission Interface (`#submit`)
- **Citizen Journalism & Tip Form**: Public endpoint for anonymous or named story tips.
- **Strict Ethical Notice**: Clear disclaimer that submissions are **NEVER automatically published**.
- **Anti-Spam & Rate Limiting Protection**: Integrated honeypot and client-side validation.
- **Submission Tracking Receipt**: Generates verified tracking reference ID (e.g. `CTN-SUB-1048`) and sends tips straight to the editor's review queue.
- **One-Click Tip Conversion**: Editors can convert any verified tip into a pre-filled draft story.

### 5. Live Event Coverage Center (`#live`)
- **Event Switcher**: Manage ongoing conferences, synods, and breaking events with live viewer ticker.
- **Rapid Update Composer**: Timestamp auto-generation (WAT), breaking headline alert, and pinned highlight toggle.
- **Editorial Approval Step**: Field reporters submit updates; editors approve before timeline broadcast.
- **Live Reader Stream**: Reverse-chronological timeline with pulsing red `LIVE` badges and auto-polling simulation (8s).

### 6. Media Library (`#media`)
- **Photographic Archive**: High-resolution documentary news photos with dimensions and file sizes.
- **Rights & Accessibility Inspector**: View and edit alt text, photographer credits, and license type (*Staff Photograph*, *Editorial Archive Use*).
- **Upload Modal**: Enforces alt-text descriptions before saving assets.
- **Insert into Story**: Attach chosen photo directly into the active story draft.

---

## 3. Backend Adapter & Mock Status Transparency

Per sprint rules, mock functionality is transparently declared and never disguised as a connected backend:

- **Mode Banner**: Always visible at the top of the workspace:
  - `[LOCAL MOCK MODE]`: In-memory and `localStorage` storage mode with initial seed fixtures.
  - `[LIVE CMS CONNECTED]`: Active connection to Claude's Payload CMS.
- **Payload CMS Contract Coordinator**:
  - `GET /api/articles` (supports `where[status][equals]`, `limit`, `sort`)
  - `POST /api/articles` (create story)
  - `PATCH /api/articles/:id` (update story / change status)
  - `POST /api/public/submissions` (anonymous tip submission)
  - `GET /api/submissions` & `PATCH /api/submissions/:id` (review queue)
  - `GET /api/live-events`, `POST /api/live-updates`, `PATCH /api/live-updates/:id` (live coverage)
  - `GET /api/media` & `POST /api/media` (media library)
- **CMS Settings Dialog**: Accessible via the `⚙️ CMS Settings` button in the header. Allows testing connectivity to `http://localhost:3000` or resetting mock data to fresh fixtures.

---

## 4. Accessibility & Mobile Optimization

- **Android Phone Support**: Optimized for 390px (Pixel 7) screens with a thumb-friendly bottom navigation bar, collapsed toolbars, and responsive modal dialogues with clearance above navigation.
- **Desktop Workstation Support**: Multi-column layouts, sticky toolbars, side-by-side live reader preview.
- **Keyboard Navigation**:
  - `Alt + 1`: Go to Dashboard
  - `Alt + 2`: Go to Story Editor
  - `Alt + 3`: Go to Review Queue
  - `Alt + 4`: Go to Live Coverage
  - `Alt + 5`: Go to Media Library
  - `Alt + 6`: Go to Public Submission
  - `Ctrl + S`: Quick Save Draft
  - `Escape`: Dismiss open dialogs/modals
  - Accessible skip link: `Skip to main editorial content`
- **Dark Mode**: Toggleable night-desk mode with contrast compliant with WCAG 2.2 AA.

---

## 5. Running Locally & Testing

### Development Server
```bash
# Start standard dev server (serves public site at / and newsroom at /apps/newsroom/)
npm run dev

# Or start isolated newsroom dev server
npm run dev:newsroom
```

### Production Build
```bash
# Build newsroom application bundle
npm run build:newsroom
```

### Automated Testing (Playwright)
```bash
# Run all tests (Public website tests + Newsroom tests)
npm test

# Run newsroom UI test suite specifically
npm run test:newsroom
```
All 34 project tests pass (14 newsroom tests + 20 public site regression tests) across both Desktop Chrome and Android Pixel 7 viewports.
