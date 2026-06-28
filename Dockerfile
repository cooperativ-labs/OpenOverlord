# Overlord Cloud backend image (Railway).
#
# Builds the bundled web/REST/protocol/runner/realtime server
# (`webapp/dist-server/index.cjs`, produced by `webapp/scripts/build-server.mjs
# --cloud`) and runs it on plain Node. This is the always-on control-plane
# service from `planning/feature-plans/overlord-cloud-architecture.md`: it owns
# auth, the execution-request queue, protocol writeback, and the realtime feed,
# and it reaches Neon Postgres over the injected `DATABASE_URL`.
#
# The cloud server bundle keeps `@google/genai` external (see build-server.mjs).
# `better-sqlite3` is lazy-loaded only on the Local SQLite path and is not
# installed in this image. The SPA is served from Vercel, not this container
# (`OVERLORD_SERVE_SPA=false`). `nodeLinker: node-modules` (see .yarnrc.yml)
# makes the externals available at runtime.
#
# See private-docs/deployment-overlord-cloud.md for the operator runbook.

# ---- Builder -------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app
ENV YARN_ENABLE_SCRIPTS=1

# Yarn 4 via Corepack, pinned by package.json "packageManager".
RUN corepack enable

# Install against the full workspace manifest set so workspace resolution works.
COPY package.json yarn.lock .yarnrc.yml ./
COPY auth/package.json auth/
COPY automations/package.json automations/
COPY database/package.json database/
COPY cli/package.json cli/
COPY webapp/package.json webapp/
COPY desktop/package.json desktop/
COPY packages/core/package.json packages/core/
# Source is copied after install; skip workspace builds until COPY . . below.
RUN yarn install --immutable --mode=skip-build

# Build the workspace packages that resolve to dist/ (database, auth,
# automations), then bundle the Postgres-only server. @overlord/core resolves
# to source and is bundled directly by esbuild.
COPY . .
RUN yarn db:build:prod \
  && yarn auth:build:prod \
  && yarn automations:build:prod \
  && yarn workspace @overlord/webapp build:server -- --cloud \
  && rm -rf node_modules/better-sqlite3

# ---- Runtime -------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    OVERLORD_WEB_HOST=0.0.0.0 \
    OVERLORD_SQL_STUDIO_ENABLED=false \
    OVERLORD_SERVE_SPA=false \
    OVERLORD_IN_POD=1

# The bundle plus external runtime deps and the staged Postgres migrations the
# bundle resolves relative to its own location (webapp/postgres/migrations).
# This is a Postgres-only control plane (DATABASE_URL is always a postgres URL),
# so the SQLite migration tree (webapp/sqlite/migrations) is intentionally not
# copied: the Postgres runtime path never calls the sqlite migrator. See
# webapp/server/db.ts — migrateDatabase/openDatabase run only for the sqlite
# adapter; Postgres goes through migratePostgres.
COPY --from=builder /app/webapp/dist-server ./webapp/dist-server
COPY --from=builder /app/webapp/postgres ./webapp/postgres
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Railway injects $PORT; bind it explicitly so the value is honored regardless of
# how OVERLORD_WEB_PORT is set in the service. /api/health is the unauthenticated
# health-check endpoint.
EXPOSE 8080
CMD ["sh", "-c", "OVERLORD_WEB_PORT=${PORT:-8080} node webapp/dist-server/index.cjs"]
