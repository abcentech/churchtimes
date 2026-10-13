# Church Times Nigeria — 24-hour newsroom sprint

## Objective
Deliver a **working, locally runnable** newsroom MVP without disrupting the current Vite static website or production WordPress. Preserve the existing main branch. Do not claim production readiness without tests.

## Existing state
- Repository: abcentech/churchtimes
- Public site: Vite static export with source in src/, tests in Playwright, GitHub Pages publishing.
- No Payload CMS or PostgreSQL integration in the current package.json.
- Development integration branch: feat/newsroom-mvp.
- Keep current public site running. Do not rewrite the frontend into Next.js during this sprint. Implement Payload as a separate app in apps/cms and integrate published content through a safe API adapter in a later integration step.

## Non-negotiable product requirements
1. Public submissions can be made without editor credentials, but are NEVER published automatically.
2. Trusted publishers may publish directly; reporters submit for review; section editors and editors-in-chief approve.
3. Article states: draft -> in_review -> changes_requested -> approved -> published; allow scheduling and correction revisions. Server-side access checks must enforce all transitions.
4. Live events: reporters submit timestamped updates, editors approve, public sees only approved updates. Polling is sufficient for MVP.
5. Mobile-friendly editor for Android and desktop; simple title, category, body, media, preview, submit/publish.
6. Secure upload validation, rate limits for anonymous submissions, sanitization, CSRF considerations, audit trail, and no secrets in repository.
7. PostgreSQL + Payload CMS on a small VPS; local Docker Compose for development; database migrations and seed fixtures.
8. Maintain existing original article URLs or map redirects during future WordPress migration. No production migration in sprint.

## Parallel agent lanes (one branch each; PRs into feat/newsroom-mvp)
- **Claude Sonnet / backend**: branch agent/payload-core; implement apps/cms, Payload config, collections Users, Articles, Categories, Media, Submissions, LiveEvents, LiveUpdates, audit logging, roles and server-side access control; Docker Compose and environment example. No changes to existing Vite src/.
- **Gemini / frontend**: branch agent/editor-ui; build accessible mobile-first newsroom UI and public /submit flow, integrate through typed API contracts or mocks; do not edit backend collections.
- **Jules / QA**: branch agent/qa; add tests for role restrictions, anonymous submissions, publication lifecycle, live updates, responsive UI, and existing public site regressions. Avoid modifying implementation except isolated test fixes.
- **Claude Opus / review**: inspect PRs for privilege escalation, XSS, upload vulnerabilities, data model and API consistency. Provide review comments and focused fixes in own branch if needed.
- **ChatGPT / integration**: reconcile API contracts, review PRs, preserve GitHub Pages deployment, run builds/tests and merge only passing changes.

## API contract v0
- POST /api/public/submissions : anonymous creates pending submission; validates inputs and rate limits.
- GET /api/articles?status=published : public published articles only.
- GET /api/live-events/:slug/updates : public approved updates only, sorted by event sequence.
- Authenticated CMS CRUD endpoints via Payload; permission checks on server.
- Public website should not expose draft previews without a signed, expiring token.

## Definition of done
- Fresh clone can start PostgreSQL and CMS from documented commands.
- Admin account creation documented securely.
- Public submission appears in editor review queue but never public feed until approved.
- Reporter cannot self-approve; trusted publisher can publish within assigned scope.
- Public article and live-event pages render approved content.
- Mobile (390px) and desktop (1280px) editor flows tested.
- npm build and Playwright tests pass; no secrets committed.
- README includes hosting requirements, deployment, backup and rollback notes.

## First 24 hours
0–2h: inspect repository, agree data/API contracts, branch allocation.
2–10h: backend and frontend development in parallel.
10–16h: integrate and add live event flow.
16–21h: tests, security fixes, responsive QA.
21–24h: demo and deployment documentation; only deploy after explicit approval and verified hosting.

## Cost controls
Use existing paid AI plans and current infrastructure. No paid SaaS dependencies required for MVP. Keep database local to VPS, use PostgreSQL search initially, polling for live updates, and self-hosted media with explicit backup plan. Costs for server, domain, backup storage and maintenance are not automatically zero.
