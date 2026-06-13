# Railway + PostgreSQL Deployment — Recommendation

Ticket: `1:1495` — *Deploy OpenOverlord with PostgreSQL on Railway*

## TL;DR

1. **Railway Postgres is the default, primary deployment target.** It is the
   recommended way to run Overlord for any shared/hosted/multi-runner use. Use
   Railway's native PostgreSQL plugin, **not** the Railway "Supabase" template —
   Overlord consumes none of Supabase's services, so the template is pure overhead.
2. **Local dev mirrors that default with a Docker Postgres container.** A
   `docker-compose` Postgres (same major version as Railway) gives developers a
   production-parity database locally, so "works on my machine" matches "works on
   Railway."
3. **SQLite stays as a first-class *local* option.** Users who just want to run
   Overlord on their own machine, single-writer, with zero infra can keep using
   SQLite. It is no longer the *recommended deployment* path, but it remains
   supported and selected automatically when `DATABASE_URL` is unset.
4. **Any other Postgres stack still works.** Railway is the default, not a lock-in.
   Point `DATABASE_URL` at Supabase-hosted Postgres, RDS, Neon, a self-managed
   cluster, etc., and Overlord uses it — the only requirement is a Postgres-protocol
   database. This is the documented escape hatch.
5. **Keep auth on Better Auth — it is already fully wired for PostgreSQL.** You never
   need Supabase Auth/GoTrue. The modularity preference is already satisfied by the code.
6. **The real blocker is not infrastructure, it is finishing the PostgreSQL core
   adapter.** Auth, adapter selection, and the Postgres DDL exist; the core service
   layer (`webapp/server`) and the direct-DB CLI paths are still synchronous
   SQLite-only. That porting work gates the Postgres-default rollout (Railway, Docker
   dev, and bring-your-own-Postgres alike).

The highest-performance, lowest-overhead hosted path is **native Railway Postgres +
Better Auth, single service to start, on Railway's private network** — with a local
Docker Postgres for dev parity and SQLite retained for local-only use.

### Database selection at a glance

| Mode | When | How it's selected | Status |
| --- | --- | --- | --- |
| **Railway Postgres** (default deploy) | Shared / hosted / multi-runner | `DATABASE_URL` → Railway internal Postgres host | Needs Phase A core port |
| **Docker Postgres** (default dev) | Local development, prod parity | `DATABASE_URL` → `postgres://…@localhost` from `docker-compose` | Needs Phase A core port |
| **Bring-your-own Postgres** | Existing Postgres infra (Supabase/RDS/Neon/self-host) | `DATABASE_URL` → that host | Needs Phase A core port |
| **SQLite** (local-only option) | Single-machine, zero-infra local use | `DATABASE_URL` unset → local `.sqlite` file | Works today |

---

## What the code actually does today

| Concern | State | Evidence |
| --- | --- | --- |
| Adapter selection | **Done.** `DATABASE_URL` with a `postgres(ql)://` URL selects Postgres; otherwise local SQLite. Optional `OVERLORD_PG_SCHEMA` for schema isolation. | `database/src/adapter.ts` |
| Better Auth on Postgres | **Done.** Uses `pg` `Pool` + Kysely `PostgresDialect`, with `search_path` schema support and a bearer-token plugin. | `auth/src/auth/config.ts`, `auth/src/auth/database.ts` |
| Postgres DDL | **Done.** Migrations exist: `001_better_auth`, `002_initial_core`, `003_rbac`, `004_storage`, plus storage-path and ticket-search migrations. | `database/postgres/migrations/` |
| Core service layer on Postgres | **Not done.** `webapp/server/db.ts` hardcodes `new Database()` (better-sqlite3), throws if no `.sqlite` file exists, and uses the SQLite-only `data_version` pragma for realtime polling. `repository.ts` (~2.4k lines) and siblings use ~137 synchronous `prepare/get/all/run` call sites. | `webapp/server/db.ts`, `repository.ts`, `realtime.ts` |
| CLI data access | **Mixed.** `ovld protocol …` already talks to a service over HTTP (`OVERLORD_URL`), but the direct CLI runtime opens SQLite locally via `openDatabase()`. | `cli/src/runtime.ts`, `cli/src/management.ts` |
| Deploy config | **None.** No Dockerfile / `railway.json` / nixpacks config in the repo. | — |

This aligns with the existing analysis in
`database/docs/12-private-network-postgresql-deployment-plan.md`, which already
chose Postgres as the authoritative database for a multi-client topology and listed
the implementation priorities — most of which remain to be done for the core layer.

---

## Recommendation 1 — Native Railway Postgres, not the Supabase template

The Railway Supabase template provisions the full Supabase stack: GoTrue (auth),
PostgREST, Realtime, Storage, the Kong gateway, `postgres-meta`, and Studio — a
multi-container deployment around Postgres.

Overlord uses **none** of those:

- Auth → its own **Better Auth** module.
- API → its own protocol/REST service layer (`webapp/server`).
- Realtime → its own `entity_changes` feed + SSE poller.
- Storage → its own storage layer (`webapp/server/storage.ts`, local-storage paths).

So every Supabase sidecar is dead weight: more RAM/CPU, more cost, more attack
surface, more failure modes, zero functional benefit. It also contradicts your two
stated preferences (modular; Better Auth not Supabase Auth).

**Native Railway Postgres** gives you a single managed database that owns the whole
box's resources (better cache/`shared_buffers` headroom), one fewer hop, and a
clean modular boundary. If you ever want a Supabase-hosted Postgres specifically,
you can still point `DATABASE_URL` at it *without* adopting its auth — but on
Railway, the native plugin is the leaner, faster choice.

## Recommendation 2 — Stay on Better Auth (no action needed)

`createAuth()` already runs Better Auth on a `pg` `Pool` against the same
`DATABASE_URL`, with optional per-schema isolation. Set `DATABASE_URL` and auth is
on Postgres. Supabase Auth/GoTrue is never required.

## Recommendation 3 — Finish the Postgres core adapter first (the gating work)

Deploying today with `DATABASE_URL=postgres://…` would put **auth** on Postgres but
the **core** service would still try to open a local SQLite file and throw on a
fresh Railway container (ephemeral filesystem, no `.sqlite`). Even with an attached
volume, a single SQLite file defeats the multi-writer / distributed-runner goal and
will not share state across scaled instances. So the prerequisite is real code work,
not a deploy config.

## Recommendation 4 — Local dev: Docker Postgres for production parity

Because Railway Postgres is now the default deployment, local development should run
the **same engine** so behavior matches. Ship a `docker-compose.yml` that stands up a
single Postgres container pinned to the same major version Railway provisions:

```yaml
# docker-compose.yml (dev infra)
services:
  postgres:
    image: postgres:16            # match Railway's Postgres major version
    container_name: overlord-postgres
    environment:
      POSTGRES_USER: overlord
      POSTGRES_PASSWORD: overlord
      POSTGRES_DB: overlord
    ports:
      - "5432:5432"
    volumes:
      - overlord-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U overlord -d overlord"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  overlord-pgdata:
```

Developer workflow:

```bash
docker compose up -d postgres
export DATABASE_URL="postgres://overlord:overlord@localhost:5432/overlord"
export OVERLORD_PG_SCHEMA=overlord   # optional, mirrors Railway
# boot applies database/postgres/migrations, then starts the webapp
yarn start:webapp
```

Notes:

- **Same migration path as Railway.** The Postgres `openDatabase`/`migrate` work in
  Phase A applies `database/postgres/migrations` identically against the Docker
  container and Railway, so the dev DB is schema-identical to production.
- **Pin the major version** to whatever Railway provisions (16 at time of writing) so
  you catch version-specific behavior in dev, not in prod.
- **SQLite is still one command away** for contributors who don't want Docker: just
  leave `DATABASE_URL` unset. Keep this documented side-by-side so newcomers aren't
  forced into Docker for a quick local run.
- Add convenience scripts (e.g. `yarn db:up` / `yarn db:down` wrapping
  `docker compose`) and a `.env.example` showing the Docker `DATABASE_URL` as the
  default and the unset-for-SQLite alternative.

## Recommendation 5 — Bring-your-own Postgres (Railway is default, not lock-in)

Railway is the recommended default, but the architecture is just "a Postgres reachable
via `DATABASE_URL`." Any Postgres-protocol database works unchanged:

- **Supabase-hosted Postgres** — point `DATABASE_URL` at the Supabase connection
  string. You get Supabase's managed Postgres *without* adopting GoTrue/PostgREST;
  Better Auth still owns auth. (This is the only sane way to use Supabase here.)
- **AWS RDS / Aurora, GCP Cloud SQL, Neon, Crunchy, self-managed** — same deal.
- **Requirements to document for an alternate stack:** a reachable `DATABASE_URL`,
  network/TLS access from the Overlord service, the ability to run the
  `database/postgres/migrations`, and (if you scale runners) enough connections or a
  PgBouncer in front. `OVERLORD_PG_SCHEMA` is available for schema isolation on shared
  clusters.

This keeps the modularity goal intact: the default is opinionated (Railway), but the
boundary is a standard Postgres URL, so no user is locked in.

---

## Recommended Railway topology

```text
Railway project (one region)
├── Service: postgres            ← native Postgres plugin, private networking, daily backups
└── Service: overlord-web        ← Express server in webapp/server
        DATABASE_URL = ${{ Postgres.DATABASE_URL }}   (reference variable, *.railway.internal host)
        OVERLORD_PG_SCHEMA = overlord   (optional schema isolation)
        boot: apply database/postgres/migrations → yarn start:webapp
```

- **Private network only.** Connect via Railway's internal `*.railway.internal`
  host; never expose Postgres publicly. Use TLS for any external service access.
- **Pooling.** Start with one service instance and a per-process `pg` `Pool`. Add
  **PgBouncer (transaction mode)** only when instance/runner connection count
  approaches Railway Postgres's limit. Verify Kysely/`pg` prepared-statement
  behavior under transaction pooling before relying on it.
- **Queue claiming.** Use `FOR UPDATE SKIP LOCKED` for `execution_requests` claims
  (already specified in the deployment plan) so distributed runners don't double-claim.
- **Performance levers.** Co-locate DB and service in the same region; size `Pool`
  `max` to the Postgres connection limit; set `statement_timeout`; rely on the
  durable `entity_changes` feed with a commit-safe high-water cursor.

### Performance verdict

Native Postgres + Better Auth on a shared private network, single service to start,
is the highest-performance, lowest-overhead option. The Supabase template adds
latency and resource contention for no functional gain to Overlord.

---

## Sequenced plan (what to actually build)

### Phase A — Core PostgreSQL adapter (gates deployment)

1. **Promote an async query executor** into `@overlord/database`. The existing
   `auth/src/auth/database.ts` (`queryOne`/`queryAll`/`execute` with `?`→`$n`
   rewriting over a `PostgresQueryExecutor`) is the template — generalize it so both
   SQLite and Postgres implement one interface.
2. **Add Postgres `openDatabase`/`migrate`** that applies
   `database/postgres/migrations` in order and tracks them in `schema_migrations`
   with `adapter = 'postgres'`, mirroring the SQLite tracking in `connection.ts`.
3. **Port the core service layer** (`webapp/server/db.ts`, `repository.ts`,
   `launch.ts`, `workspaces.ts`, `storage.ts`, `index.ts`, `title-automation.ts`)
   from synchronous better-sqlite3 onto the async executor; make handlers `await`.
4. **Replace SQLite realtime polling.** Swap the `data_version` pragma for a
   Postgres-safe change-feed cursor over `entity_changes.seq`, optionally with
   `LISTEN`/`NOTIFY` wakeups (commit-safe high-water mark per the deployment plan).
5. **Route or port the CLI direct-DB paths** (`runtime.ts`, `management.ts`) — either
   onto the adapter or through the HTTP service for remote deployments.
6. **Adapter conformance tests** — run the same suite against SQLite and a throwaway
   Postgres so behavior stays adapter-neutral.

### Phase B — Local Docker Postgres (default dev parity)

7. Add `docker-compose.yml` with a single Postgres service pinned to Railway's major
   version (see Recommendation 4), plus `yarn db:up` / `yarn db:down` helper scripts.
8. Add `.env.example` documenting the Docker `DATABASE_URL` as the default dev value
   and the "leave unset for SQLite" alternative. Make the local Postgres path the
   one shown first in the README quick-start, with SQLite as the lightweight option.
9. Verify the Phase A migration path applies cleanly against the Docker container and
   that the full dev flow (signup → ticket → protocol) runs on local Postgres.

### Phase C — Railway deploy (default hosted target)

10. Add a `Dockerfile` (or nixpacks config) + `railway.json`; boot step runs Postgres
    migrations then `yarn start:webapp`.
11. Provision Railway Postgres; wire `DATABASE_URL` via a reference variable; set
    `OVERLORD_PG_SCHEMA` if you want schema isolation.
12. Smoke test end-to-end: Better Auth signup on Postgres → create ticket → `ovld
    protocol attach/update/deliver` against the Railway service URL.

### Phase D — Documentation of the new default

13. Update deployment/README docs so **Railway Postgres is presented as the default**,
    Docker Postgres is the default local-dev path, SQLite is the documented local-only
    option, and "bring-your-own Postgres" (Supabase/RDS/Neon/self-host via
    `DATABASE_URL`) is the documented escape hatch (see Recommendation 5).

## Contract impact

None. This preserves the current contract boundaries (clients/runners use
protocol/REST surfaces; services own domain transitions; the adapter provides ACID
transactions, revision compare-and-set, queue claiming, and commit-safe change-feed
behavior). Making Postgres the default is a positioning/configuration change, not a
contract change: **SQLite remains a valid, supported local option** (selected when
`DATABASE_URL` is unset), and any Postgres-protocol database satisfies the adapter
contract. This matches the "Contract Impact" section of the existing private-network
Postgres deployment plan.
