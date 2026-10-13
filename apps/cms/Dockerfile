# syntax=docker/dockerfile:1
#
# Church Times CMS (Payload 3 on Next.js 16). Build from the apps/cms directory:
#   docker build -t churchtimes-cms .
#
# Release procedure: run database migrations BEFORE starting a new release. The container
# does not migrate on start. Example (compose, app profile):
#   docker compose --profile app run --rm cms npm run migrate
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

# ---- runtime: minimal app, non-root ---------------------------------------------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app

# Media uploads are written here. Mount a volume at this path to keep uploads across releases.
RUN mkdir -p /app/media && chown node:node /app/media

# devDependencies are kept on purpose: `payload migrate` and `payload run` need tsx/payload CLI tooling.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/package.json /app/next.config.mjs /app/tsconfig.json ./

USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
