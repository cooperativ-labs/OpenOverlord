# Overlord Cloud — Hosted Control Plane Deployment

Operational runbook for the **Overlord Cloud** hosted edition: the always-on
backend on **Railway** backed by hosted **Postgres**, with the web app on
**Vercel**. The database side is deliberately phased: start with simple
Railway Postgres in the same Railway project, then migrate to Neon when managed
Postgres features justify the extra provider and spend. This is additive —
**Overlord Local** (Electron + loopback + SQLite) is unchanged and needs none
of this. See
`planning/feature-plans/overlord-cloud-architecture.md` for the design and
`CONTRACT.md` for the stable-surface rules.

## Region

Production runs in the **EU**:

| Component | Provider | Region |
| --- | --- | --- |
| Database, phase 1 | Railway Postgres | EU West (Amsterdam), same project as backend |
| Database, phase 2 | Neon | `aws-eu-central-1` (Frankfurt) |
| Backend  | Railway | EU West (Amsterdam) |
| Web      | Vercel | `fra1` (Frankfurt) for any DB-touching server code |

Co-locate the backend and DB so the `backend↔DB` hop stays low-latency. Phase 1
uses Railway private networking in the same region/project. Phase 2 uses the
Frankfurt (Neon) and Amsterdam (Railway) EU pairing called out in the
architecture doc. Do not split the backend and DB across continents.

## 1. Database — two-phase plan

The Cloud contract requires a hosted Postgres system of record reachable only by
the backend through `DATABASE_URL`; clients never connect to the database
directly. The initial provider is an operational choice, not a contract surface.

### Phase 1: Railway Postgres — initial low-use production

Use Railway Postgres in the same `overlord-cloud` Railway project as the
backend. This keeps the hot path simple and hot: the backend and Postgres run in
the same provider, the database is reachable over Railway private networking,
and there is no Neon scale-to-zero cold start or Neon always-on compute floor.

This is the preferred first production phase while usage is low and the team can
accept simpler database operations:

- one provider and one deployment surface;
- backend and database co-located in EU West (Amsterdam);
- backend `pg` pool can keep connections warm;
- lower operational and billing overhead than a Railway + Neon split;
- no adoption of Supabase/Auth/PostgREST/Realtime or any client-direct database
  surface.

Tradeoffs to accept explicitly:

- Railway Postgres is a Postgres service on a Railway volume, not a managed HA
  database product like Neon/Supabase/RDS.
- Plan and rehearse backups before live use; do not treat the volume alone as a
  recovery strategy.
- Restarts, upgrades, restores, or Railway service/volume issues can mean DB
  downtime.
- No Neon-style branching/PITR workflow unless replaced with an explicit backup
  and restore process.

#### Railway Postgres setup

Provision a PostgreSQL database service in the existing Railway project:

```text
Railway project: overlord-cloud
├── Service: overlord-backend
└── Service: postgres
```

Set `overlord-backend.DATABASE_URL` from the Railway Postgres private connection
string/reference variable, not a public database URL. Keep all DB credentials
server-side on the backend service.

Apply the same Postgres migrations used for Neon:

```bash
# Uses .env.prod's DATABASE_URL via with-prod-env:
yarn db:migrate:postgres
# or explicitly against Railway Postgres:
DATABASE_URL='postgresql://…@…railway.internal:5432/railway' \
  tsx scripts/migrate-postgres.ts
```

Before live use, document and test:

- backup schedule and restore procedure;
- a migration rehearsal against a disposable Railway Postgres instance or copied
  database;
- connection pool size relative to Railway Postgres connection limits;
- `statement_timeout` and any app-level retry/reconnect behavior.

### Phase 2: Neon — managed Postgres migration target

Migrate to Neon when the product needs managed Postgres features more than the
simpler one-provider Railway setup:

- managed branching for migration rehearsal and preview environments;
- managed PITR/restore workflows;
- decoupled storage/compute;
- built-in connection pooling options;
- clearer production database operations as usage grows.

The migration should not change Overlord clients. It should only change the
backend's `DATABASE_URL`, after data export/import and verification.

Cutover outline:

1. Create or reuse the Neon production project.
2. Run `database/postgres/migrations/` against a Neon branch.
3. Export Railway Postgres and import into Neon.
4. Run adapter/conformance checks against Neon.
5. Temporarily pause writes or put the backend in maintenance mode.
6. Take a final dump/restore or logical sync delta.
7. Switch `overlord-backend.DATABASE_URL` to the Neon direct connection string.
8. Restart the backend and run the verification checklist.
9. Keep the Railway Postgres service read-only/retained until rollback risk has
   passed, then remove it.

#### Neon project inventory

Project: **`Overlord Cloud (EU)`** (`little-term-34261138`), org `Cooperativ
Labs` (`org-late-union-44956267`), Postgres 18, default branch `production`,
database `neondb`. The `.neon` file pins the org + project for `neonctl` (run it
via `npx neonctl` — there is no global binary).

#### Neon connection strings

The backend owns DB credentials; **clients never connect to Neon directly**.

```bash
# Direct (use for migrations and for the always-on backend's bounded pool):
npx neonctl connection-string production --project-id little-term-34261138
# Pooled (PgBouncer; reserve for many-short-lived-connection / serverless callers):
npx neonctl connection-string production --project-id little-term-34261138 --pooled
```

Both are `…eu-central-1.aws.neon.tech/neondb?sslmode=require`. The `pg` driver
(8.x) honors `sslmode=require` from the URL. Keep `sslmode=require`.

#### Neon migrations / bootstrap

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

#### Neon autosuspend decision

For a latency-sensitive Neon production cutover, disable autosuspend so the hot
path never pays a cold start. The current Neon project is on the **Free plan
(`free_v3`)**, where `suspend_timeout_seconds` is forced to the default
5-minute autosuspend and **cannot be disabled**. Disabling it requires upgrading
to a paid plan (Launch+), then setting the compute
`suspend_timeout_seconds` to `-1` (Neon API
`PATCH /projects/{id}/endpoints/{endpoint_id}`; not exposed by `neonctl`).

For a low-use Neon deployment, autosuspend can remain enabled if the product
explicitly accepts first-request wake latency. In that mode, ensure health
checks and runner polling do not wake the database continuously.

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
  Regions, or `scale_service {"eu-west": 1}`). Co-locates with Railway Postgres
  in phase 1 and stays close to Neon Frankfurt in phase 2.
- **Connect source** `cooperativ-labs/OpenOverlord` (Settings → Source) — this
  triggers the first build/deploy. Do this only after the data-layer port.

### Service variables

| Variable | Value | Why |
| --- | --- | --- |
| `DATABASE_URL` | Phase 1: Railway Postgres private URL. Phase 2: Neon direct connection string. | Selects the Postgres adapter (data layer + Better Auth). |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` | Stable session signing across restarts. |
| `BETTER_AUTH_URL` | `https://overlord-backend-production.up.railway.app` | Cookie/redirect base for Better Auth. |
| `OVERLORD_WEB_HOST` | `0.0.0.0` | Bind all interfaces (also set in the image). |
| `NODE_ENV` | `production` | — |
| `OVERLORD_SQL_STUDIO_ENABLED` | `false` | No SQL Studio binary in the container. |
| `GEMINI_API_KEY` | optional | AI Tools automations. |

All of the above except `GEMINI_API_KEY` were previously set on
`overlord-backend` for the Neon plan. Re-check `DATABASE_URL` before deploy and
switch it to the phase-appropriate Postgres provider (verify with
`railway variables --service overlord-backend`).

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

The hosted backend is **not yet runnable against Postgres** (Railway Postgres or
Neon). The live server (`webapp/server` + `packages/core/service`) is still
synchronous
`better-sqlite3`: `webapp/server/db.ts` throws on boot when `DATABASE_URL` is a
`postgres://` URL ("the embedded webapp REST server runs on better-sqlite3
only"). Objective 3 delivered the async `DatabaseClient`, the Postgres migration
runner, async queue primitives (`packages/core/service/queue-runtime.ts`), and
Postgres conformance tests — but **the running server was not ported** (364
`db.prepare()` call sites across 25 files, ~17k LOC). Better Auth is already
Postgres-capable; the app data layer is not.

Until that port lands, a Railway container started against any Postgres
`DATABASE_URL` exits on boot.
**Do not announce a working hosted endpoint before the port + the verification
checklist below pass.**

## Verification checklist (run after the data-layer port)

- [ ] Container boots against `DATABASE_URL=<Railway Postgres>` with no better-sqlite3 throw.
- [ ] `GET https://<railway-domain>/api/health` → `{ "ok": true }` over HTTPS.
- [ ] REST: authenticate and list workspaces/projects/missions.
- [ ] Protocol: `ovld protocol attach/update/deliver` against the hosted backend.
- [ ] Runner queue: queue an objective; a runner claims it via `/api/runner/claim`
      (service-layer transaction, `FOR UPDATE SKIP LOCKED`).
- [ ] Realtime: `GET /api/stream` delivers an `entity_changes` delta after a mutation.
- [ ] Railway Postgres backup/restore procedure documented and rehearsed.
- [ ] Future Neon cutover plan reviewed before upgrading the database provider.

## Provider inventory

| Concern | Provider | Identifier |
| --- | --- | --- |
| Database phase 1 | Railway Postgres | to provision in Railway project `overlord-cloud`, EU West |
| Database phase 2 | Neon | project `little-term-34261138` (`Overlord Cloud (EU)`), `aws-eu-central-1` |
| Backend  | Railway | project `overlord-cloud` (`16825060-9441-490c-ab61-fc4e50ed9686`); service `overlord-backend` (`71f225e9-8dff-4348-95d5-f3d7f2f02e2b`); domain `overlord-backend-production.up.railway.app`; region EU West *(to set)* |
| Web      | Vercel | (to configure) |
| Source   | GitHub | `cooperativ-labs/OpenOverlord` |
