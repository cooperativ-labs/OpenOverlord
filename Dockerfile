# Overlord Cloud backend image (Railway).
#
# Builds the bundled web/REST/protocol/runner/realtime server
# (`backend/dist-server/index.cjs`, produced by `backend/scripts/build-server.mjs
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
FROM node:24-bookworm-slim AS builder

WORKDIR /app
ENV YARN_ENABLE_SCRIPTS=1

# Yarn 4 via committed yarnPath (.yarnrc.yml), not Corepack.

# Install against the full workspace manifest set so workspace resolution works.
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases .yarn/releases
COPY auth/package.json auth/
COPY automations/package.json automations/
COPY backend/package.json backend/tsconfig.json backend/
COPY database/package.json database/
COPY cli/package.json cli/
COPY webapp/package.json webapp/
COPY desktop/package.json desktop/
COPY packages/core/package.json packages/core/
COPY packages/contract/package.json packages/contract/
# Source is copied after install; skip workspace builds until COPY . . below.
RUN printf '%s\n' \
  '#!/bin/sh' \
  'set -e' \
  'YARN="$(sed -n "s/^yarnPath: //p" /app/.yarnrc.yml)"' \
  'exec node "$YARN" "$@"' \
  > /usr/local/bin/repo-yarn \
  && chmod +x /usr/local/bin/repo-yarn
RUN repo-yarn install --immutable --mode=skip-build

# Build workspace packages that resolve to dist/ (database, auth, automations,
# contract, core), then bundle the Postgres-only server. esbuild still follows
# relative imports into packages/core/service/*.ts for the server graph.
COPY . .
RUN repo-yarn db:build:prod \
  && repo-yarn auth:build:prod \
  && repo-yarn automations:build:prod \
  && repo-yarn contract:build:prod \
  && repo-yarn core:build:prod \
  && repo-yarn workspace @overlord/backend build:server:cloud \
  && repo-yarn workspaces focus --production @overlord/automations

# ---- Runtime -------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    OVERLORD_WEB_HOST=0.0.0.0 \
    OVERLORD_SQL_STUDIO_ENABLED=false \
    OVERLORD_SERVE_SPA=false \
    OVERLORD_IN_POD=1

# The bundle plus external runtime deps and the staged Postgres migrations the
# bundle resolves relative to its own location (backend/postgres/migrations).
# This is a Postgres-only control plane (DATABASE_URL is always a postgres URL),
# so the SQLite migration tree (backend/sqlite/migrations) is intentionally not
# copied: the Postgres runtime path never calls the sqlite migrator. See
# backend/db.ts — migrateDatabase/openDatabase run only for the sqlite
# adapter; Postgres goes through migratePostgres.
COPY --from=builder /app/backend/dist-server ./backend/dist-server
COPY --from=builder /app/backend/postgres ./backend/postgres
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Railway injects $PORT; bind it explicitly so the value is honored regardless of
# how OVERLORD_WEB_PORT is set in the service. /api/health is the unauthenticated
# health-check endpoint.
EXPOSE 8080
CMD ["sh", "-c", "OVERLORD_WEB_PORT=${PORT:-8080} node backend/dist-server/index.cjs"]
