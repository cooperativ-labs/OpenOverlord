# Overlord Cloud — Hosted Control Plane Deployment

Operational runbook for the **Overlord Cloud** hosted edition: the always-on
backend on **Railway** backed by **Neon Postgres**, with the web app on
**Vercel**. This is additive — **Overlord Local** (Electron + loopback +
SQLite) is unchanged and needs none of this. See
`planning/feature-plans/overlord-cloud-architecture.md` for the design and
`CONTRACT.md` for the stable-surface rules.

## Region

Production runs in the **EU**:

| Component | Provider | Region |
| --- | --- | --- |
| Database | Neon | `aws-eu-central-1` (Frankfurt) |
| Backend  | Railway | EU West (Amsterdam) |
| Web      | Vercel | `fra1` (Frankfurt) for any DB-touching server code |

Co-locate the backend and DB so the `backend↔DB` hop stays in the single-digit
millisecond range. Frankfurt (Neon) and Amsterdam (Railway) are the EU pairing
called out in the architecture doc. Do not split the backend and DB across
continents.

## 1. Neon — system of record

Project: **`Overlord Cloud (EU)`** (`little-term-34261138`), org `Cooperativ
Labs` (`org-late-union-44956267`), Postgres 18, default branch `production`,
database `neondb`. The `.neon` file pins the org + project for `neonctl` (run it
via `npx neonctl` — there is no global binary).

### Connection strings

The backend owns DB credentials; **clients never connect to Neon directly**.

```bash
# Direct (use for migrations and for the always-on backend's bounded pool):
npx neonctl connection-string production --project-id little-term-34261138
# Pooled (PgBouncer; reserve for many-short-lived-connection / serverless callers):
npx neonctl connection-string production --project-id little-term-34261138 --pooled
```

Both are `…eu-central-1.aws.neon.tech/neondb?sslmode=require`. The `pg` driver
(8.x) honors `sslmode=require` from the URL. Keep `sslmode=require`.

### Migrations / bootstrap

The Postgres migrations ship inside `@overlord/database`
(`database/postgres/migrations/`, 1:1 with the SQLite set). Apply them with the
adapter-aware runner — it refuses to run unless `DATABASE_URL` resolves to
Postgres and is idempotent (checksum-guarded `schema_migrations`):

```bash
# Uses .env.prod's DATABASE_URL via with-prod-env:
yarn db:migrate:postgres
# or explicitly:
DATABASE_URL='postgresql://…@…eu-central-1.aws.neon.tech/neondb?sslmode=require' \
  tsx scripts/migrate-postgres.ts
```

The production branch is already bootstrapped: **41 tables, 12 migrations,
seeded `local` workspace**. Re-running is a no-op.

> **Migration rehearsal:** create a Neon branch from `production`, run
> migrations against it, verify, then drop it. (Hardening — objective 15.)

### Autosuspend caveat (action required)

The architecture requires **autosuspend (scale-to-zero) disabled** on the prod
DB so the hot path never pays a cold start. The project is currently on Neon's
**Free plan (`free_v3`)**, where `suspend_timeout_seconds` is forced to the
default 5-minute autosuspend and **cannot be disabled**. Disabling it requires
upgrading to a paid plan (Launch+), then setting the compute
`suspend_timeout_seconds` to `-1` (Neon API
`PATCH /projects/{id}/endpoints/{endpoint_id}`; not exposed by `neonctl`). This
is a billing decision and is **not yet done**.

## 2. Railway — always-on backend

Project: **`overlord-cloud`** (`16825060-9441-490c-ab61-fc4e50ed9686`),
environment `production` (`156c6901-3134-4ecf-ba24-b10fe0d256f3`).

Service: **`overlord-backend`** (`71f225e9-8dff-4348-95d5-f3d7f2f02e2b`),
created empty (no source connected yet — see the cutover prerequisite below).
Public domain: **`https://overlord-backend-production.up.railway.app`**
(target port 8080).

The backend is the bundled server (`webapp/dist-server/index.cjs`) serving REST
+ protocol + runner queue + `/api/stream` realtime. Deploy from the repo
`Dockerfile` (committed at repo root) via the GitHub repo
`cooperativ-labs/OpenOverlord`. `railway.json` sets the Dockerfile builder, the
`/api/health` health check, and an on-failure restart policy, so those apply
automatically once the source is connected.

**Still to set (could not be done via CLI this session — do in the Railway
dashboard or via the re-authed MCP `scale_service`):**

- **Region → EU West (Amsterdam)** for the service instance (Settings →
  Regions, or `scale_service {"eu-west": 1}`). Co-locates with Neon Frankfurt.
- **Connect source** `cooperativ-labs/OpenOverlord` (Settings → Source) — this
  triggers the first build/deploy. Do this only after the data-layer port.

### Service variables

| Variable | Value | Why |
| --- | --- | --- |
| `DATABASE_URL` | Neon **direct** connection string | Selects the Postgres adapter (data layer + Better Auth). |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` | Stable session signing across restarts. |
| `BETTER_AUTH_URL` | `https://overlord-backend-production.up.railway.app` | Cookie/redirect base for Better Auth. |
| `OVERLORD_WEB_HOST` | `0.0.0.0` | Bind all interfaces (also set in the image). |
| `NODE_ENV` | `production` | — |
| `OVERLORD_SQL_STUDIO_ENABLED` | `false` | No SQL Studio binary in the container. |
| `GEMINI_API_KEY` | optional | AI Tools automations. |

All of the above except `GEMINI_API_KEY` are **already set** on
`overlord-backend` (verify with `railway variables --service overlord-backend`).

Railway injects `PORT`; the image's `CMD` binds `OVERLORD_WEB_PORT=$PORT`
explicitly, so no port variable is required. Production-profile env resolution
honors real (Railway-injected) env vars because they are present in the
boot-time runtime-env snapshot (`cli/src/env.ts`).

### Deploy

```bash
railway link            # select project overlord-cloud, EU West
railway up              # or connect the GitHub repo for push-to-deploy
railway domain          # generate the HTTPS *.up.railway.app domain
```

Set the service **region to EU West (Amsterdam)** and the health check to
`/api/health` (the one unauthenticated route; returns `{ "ok": true }`).

## 3. Vercel — web frontend

Serve `webapp/web` from Vercel (`fra1`). The browser holds its realtime
connection **directly to the Railway backend**, not proxied through Vercel.
Keep the backend off Vercel functions (no persistent SSE / long-poll / workers
there). Full web wiring (runtime-injected API base URL, env vars) is a later
objective; this runbook covers the backend control plane.

## ⚠️ Prerequisite before a live cutover: the data-layer Postgres port

The hosted backend is **not yet runnable against Neon.** The live server
(`webapp/server` + `packages/core/service`) is still synchronous
`better-sqlite3`: `webapp/server/db.ts` throws on boot when `DATABASE_URL` is a
`postgres://` URL ("the embedded webapp REST server runs on better-sqlite3
only"). Objective 3 delivered the async `DatabaseClient`, the Postgres migration
runner, async queue primitives (`packages/core/service/queue-runtime.ts`), and
Postgres conformance tests — but **the running server was not ported** (364
`db.prepare()` call sites across 25 files, ~17k LOC). Better Auth is already
Postgres-capable; the app data layer is not.

Until that port lands, a Railway container started against Neon exits on boot.
**Do not announce a working hosted endpoint before the port + the verification
checklist below pass.**

## Verification checklist (run after the data-layer port)

- [ ] Container boots against `DATABASE_URL=<Neon>` with no better-sqlite3 throw.
- [ ] `GET https://<railway-domain>/api/health` → `{ "ok": true }` over HTTPS.
- [ ] REST: authenticate and list workspaces/projects/missions.
- [ ] Protocol: `ovld protocol attach/update/deliver` against the hosted backend.
- [ ] Runner queue: queue an objective; a runner claims it via `/api/runner/claim`
      (service-layer transaction, `FOR UPDATE SKIP LOCKED`).
- [ ] Realtime: `GET /api/stream` delivers an `entity_changes` delta after a mutation.
- [ ] Neon autosuspend disabled (paid plan) so the hot path has no cold start.

## Provider inventory

| Concern | Provider | Identifier |
| --- | --- | --- |
| Database | Neon | project `little-term-34261138` (`Overlord Cloud (EU)`), `aws-eu-central-1` |
| Backend  | Railway | project `overlord-cloud` (`16825060-9441-490c-ab61-fc4e50ed9686`); service `overlord-backend` (`71f225e9-8dff-4348-95d5-f3d7f2f02e2b`); domain `overlord-backend-production.up.railway.app`; region EU West *(to set)* |
| Web      | Vercel | (to configure) |
| Source   | GitHub | `cooperativ-labs/OpenOverlord` |
