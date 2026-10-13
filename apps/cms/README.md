# Church Times CMS

Editorial backend for the Church Times Nigeria newsroom. It is a Payload CMS 3.90.2 app on Next.js 16,
backed by PostgreSQL. It provides the admin UI at `/admin`, the REST API under `/api`, article workflow
and roles, public submissions, and live-event updates.

The public website (the Vite static site in the repository root) is separate and stays separate.
It will read published content through the API in a later integration step.

**Status: MVP in progress, not production-ready.** Not yet implemented: the seed script (`npm run seed`
is a placeholder), scheduled publishing, and the in-memory submission rate limiter. See
[docs/api-contracts.md](docs/api-contracts.md) for the API contract and
[docs/operations.md](docs/operations.md) for hosting, deployment, backup and rollback.

## Prerequisites

- **Node.js 24** (the repository root `.nvmrc` is `24`). npm comes with Node.
- **One of:**
  - Nothing else. Use embedded PostgreSQL via `npm run db:local` (works on Windows, macOS and Linux), or
  - Docker with Compose, to run PostgreSQL 16 in a container.

Run all commands below from `apps/cms`.

## Quick start

Both paths start from the same setup.

1. Install dependencies:
   ```sh
   npm ci
   ```
2. Create your environment file. Never commit `.env`.
   ```sh
   cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
   ```
3. Generate secrets. Run this once for each of `PAYLOAD_SECRET`, `PREVIEW_SECRET` and `IP_HASH_SALT`,
   and paste the output into `.env`. Use a different value for each.
   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```
   `PAYLOAD_SECRET` and `PREVIEW_SECRET` must be at least 32 characters. `IP_HASH_SALT` must be at least 16.

### Path A: embedded PostgreSQL (no Docker)

1. In `.env`, keep the default `DATABASE_URL` (port `54329`).
2. Terminal 1 (leave running; Ctrl+C stops it cleanly):
   ```sh
   npm run db:local
   ```
3. Terminal 2:
   ```sh
   npm run migrate
   npm run seed        # placeholder for now; safe to skip
   npm run dev
   ```
4. Open http://localhost:3000/admin and create the first admin account (see below).

### Path B: Docker Compose

1. Start PostgreSQL 16 on `127.0.0.1:5432` (the database is not exposed beyond localhost):
   ```sh
   docker compose up -d postgres
   ```
2. In `.env`, point `DATABASE_URL` at the compose database. Use the same password as `POSTGRES_PASSWORD`
   if you set one, otherwise `churchtimes-local`:
   ```
   DATABASE_URL=postgres://churchtimes:churchtimes-local@127.0.0.1:5432/churchtimes
   ```
   Only one `DATABASE_URL` is active at a time. Use port `54329` for Path A, or `5432` for Path B.
3. Run migrations, then start the dev server:
   ```sh
   npm run migrate
   npm run seed        # placeholder for now; safe to skip
   npm run dev
   ```
4. Open http://localhost:3000/admin and create the first admin account.

To run the CMS itself in a container (optional; uses the compose database internally):

```sh
docker compose --profile app run --rm cms npm run migrate
docker compose --profile app up -d --build cms     # serves on http://127.0.0.1:3000
```

## Creating the first admin account

On an empty database, `/admin` shows Payload's create-first-user screen. Whoever reaches that screen first
becomes the first admin, so do this immediately after the first start:

- Do it on `localhost`, or over HTTPS only. Do not expose an empty instance to the internet.
- Use a strong, unique password (16+ characters, stored in a password manager). Do not reuse one from elsewhere.
- Then create every other staff account from **Admin > Users**, with the role that matches their job.
- Never share accounts. Each person logs in with their own account, so the audit log stays meaningful.
- Demo or seed users are **not implemented yet**. If they are added later, they will be created only when
  `SEED_DEMO_USERS=true` is set locally, with passwords read from environment variables. Do not use seeded
  passwords anywhere else.

## Roles

| Role (`users.role`) | Summary |
| --- | --- |
| `admin` | Everything, including user and role management. |
| `editor-in-chief` | Approve, publish, schedule, archive and correct any article; manage live events, submissions and categories; read the audit log. |
| `section-editor` | As editor-in-chief, but only for articles and live events in their assigned `sections`. |
| `trusted-publisher` | Publish or schedule their own articles directly, in their assigned sections. Cannot approve other people's work. |
| `reporter` | Write drafts and submit for review. Cannot approve, publish, schedule or archive, including their own work. |

Only `admin` can change a user's `role` or `sections`. Users cannot escalate their own privileges.
The full workflow and permission matrix is in [docs/api-contracts.md](docs/api-contracts.md) §1–2.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server on port 3000 (with Payload admin). |
| `npm run build` | Production build (`next build`). |
| `npm run start` | Run the production build (`next start`). |
| `npm run migrate` | Apply database migrations. Run before starting a new release. |
| `npm run migrate:create` | Create a new migration after a schema change. |
| `npm run generate:types` | Regenerate `src/payload-types.ts`. |
| `npm run generate:importmap` | Regenerate the admin import map. |
| `npm run seed` | Seed fixtures (placeholder; not implemented yet). |
| `npm run db:local` | Start the embedded local PostgreSQL database on port 54329 (data in `.local-postgres/`). |
| `npm run typecheck` | TypeScript check with no emit. |
| `npm test` | Run the test suite (Vitest). |

## Testing

- `npm test` runs Vitest.
- The test harness uses `TEST_DATABASE_URL` when it is set. CI sets it to a PostgreSQL service container.
  When it is not set, the harness is designed to start its own embedded PostgreSQL instead.
- Locally, you do not need `npm run db:local` running to run tests, unless your test setup says otherwise.

## Configuration

All environment variables are documented in `.env.example` and in
[docs/operations.md](docs/operations.md#environment-variables). Never commit real values.

## Documentation

- [docs/api-contracts.md](docs/api-contracts.md): roles, article workflow, data model, public and staff endpoints.
- [docs/operations.md](docs/operations.md): hosting requirements, deployment, backups, rollback, security checklist.
- [../../docs/newsroom-24h-sprint.md](../../docs/newsroom-24h-sprint.md): sprint objectives and definition of done.

## Not done yet

- No production deployment. Production deployment requires explicit approval and has not been performed.
- No WordPress migration. Legacy URL mapping fields exist, but no import has been run.
- Frontend integration (the public site reading from this API, and the editor UI) is handled by separate lanes.
