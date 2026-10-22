# syntax=docker/dockerfile:1
#
# Church Times CMS (Payload 3 on Next.js 16). Build from the apps/cms directory:
#   docker build -t churchtimes-cms .
#
# Targets:
#   migrator  full node_modules (incl. dev deps: tsx etc. that `payload migrate` needs). Used only for the one-off
#             migration step (compose service `migrate`, profile ops). Never run it as the long-lived server.
#   runtime   (default, last stage) production dependencies only (`npm prune --omit=dev`). The long-lived server.
#   Build both:  docker build --target migrator -t churchtimes-cms-migrator .
#                docker build --target runtime  -t churchtimes-cms .
#
# Release procedure: run database migrations BEFORE starting a new release. The container
# does not migrate on start. Production: docker compose -f docker-compose.production.yml --profile ops run --rm migrate
# Local dev: docker compose --profile app run --rm cms npm run migrate (the dev compose builds the last stage, so
# use --target migrator there if the pruned runtime image cannot migrate).
# Take a database dump before migrating. See docs/operations.md.
#
# Base image is glibc-based (bookworm-slim) so sharp's prebuilt binaries work.

# ---- deps: install the locked dependency tree --------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: compile the Next.js app -------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next build loads the Payload config, which requires PAYLOAD_SECRET (>= 32 chars).
# This placeholder is used only for this RUN step. It is not set as ENV, so it is not
# present in the runtime image. Real secrets are supplied at runtime via env_file or -e.
RUN PAYLOAD_SECRET=build-only-placeholder-not-a-secret-000000000000 npm run build

# ---- prod-deps: production dependency tree only -------------------------------------
FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev

# ---- migrator: full tree, for `payload migrate` only --------------------------------
FROM node:24-bookworm-slim AS migrator
ENV NODE_ENV=production NODE_OPTIONS=--no-deprecation NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app

# Media uploads are written here. Mount a volume or bind mount (owned by uid 1000) at this path to keep uploads across releases.
RUN mkdir -p /app/media && chown node:node /app/media

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/package.json /app/next.config.mjs /app/tsconfig.json ./
USER node
CMD ["npm", "run", "migrate"]

# ---- runtime: minimal app, non-root (LAST stage = default build target) ----------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production NODE_OPTIONS=--no-deprecation NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app

# Media uploads are written here. Mount a volume or bind mount (owned by uid 1000) at this path to keep uploads across releases.
RUN mkdir -p /app/media && chown node:node /app/media

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/package.json /app/next.config.mjs /app/tsconfig.json ./

USER node
EXPOSE 3000

# Liveness: anonymous GET /api/users/me answers 200 once Payload is initialised and the database is
# reachable. The first request also initialises Payload, hence the generous start period and timeout.
HEALTHCHECK --interval=15s --timeout=15s --start-period=40s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/users/me').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Same as `npm run start` (its cross-env only sets NODE_OPTIONS, which is an ENV above), but without the
# npm wrapper process, so SIGTERM from `docker stop` reaches Next directly.
CMD ["node", "node_modules/next/dist/bin/next", "start"]
