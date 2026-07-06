# Web App Module

The web control center and the REST/realtime API that backs it. Overlord is
CLI-first; the web app is a **Vite-powered React SPA** over a small Express
REST + realtime layer that reads and writes the local SQLite database directly
through `better-sqlite3`.

A first slice has landed: a realtime console for **projects, missions, and
objectives** — list/create/edit each, with the UI reflecting database changes
(including writes made by the CLI) live over Server-Sent Events. The settings
surface now covers per-user local execution-target launch defaults (terminal
profile plus per-agent flags/pre-commands); launching objectives still follows
the existing mission/objective controls.

## Table of Contents

- [For Users](#for-users)
  - [Using the web app](#using-the-web-app)
  - [AI title summarization](#ai-title-summarization)
- [For Developers](#for-developers)
  - [Running the web app](#running-the-web-app)
  - [Module Layout](#module-layout)
  - [REST surface (as built)](#rest-surface-as-built)
  - [Contract Component](#contract-component)
  - [Documentation](#documentation)
  - [Status](#status)
  - [Code & Tests](#code--tests)

## For Users

### Using the web app

The web app runs as part of a backend process at the configured host/port. In
packaged local mode, Desktop supervises that backend. The current local default
is `http://127.0.0.1:4310`, which is also the CLI's default `backend_url`.

Open that URL in your browser to manage projects, missions, and objectives on a
realtime Kanban board. Changes made through the CLI appear live without a
manual refresh. The settings surface lets you configure per-user local
execution-target launch defaults (terminal profile plus per-agent flags and
pre-commands).

### AI title summarization

Mission and objective titles are derived from instruction text via the
[`automations`](../automations/README.md) module (`serviceToAutomations`):

- On create (and when an objective's instruction changes without an explicit
  title edit), the server sets an immediate local title, then asynchronously
  refines it with Gemini when `GEMINI_API_KEY` is set in the active env file.
- Title updates are written through the same `entity_changes` feed, so the
  board and mission panel refresh live.

## For Developers

### Running the web app

The module is a self-contained Yarn sub-project (its own `package.json`):

```bash
cd webapp
yarn install           # first time only
yarn dev               # server (:4310) + Vite dev server (:5173) together
# open http://localhost:5173
```

`yarn dev` runs the top-level backend (`../backend/index.ts`) and the Vite dev
server (which proxies `/api` to it). For a production-style run:

```bash
yarn build && yarn start   # builds the SPA, serves it + the API on :4310
```

The source server and Vite read repo-root `.env.local` only. Packaged/bundled
production reads `.env.prod` only. Copy `.env.local.example` for development ports
and `OVLD_HOME`. This lets a packaged production instance keep using
`OVERLORD_WEB_PORT=4310` while development runs on a different API port and
data directory.

The server opens the global SQLite database under `OVLD_HOME` by default
(override with `OVERLORD_SQLITE_PATH` or `overlord.toml` `database_path`).
Initialise that database first with `yarn start:local` from the repo root.

### Module Layout

```
webapp/
  web/        ← the React SPA (pure consumer of the REST surface)
  shared/     ← the typed API contract (camelCase DTOs) shared by server + web
  docs/       ← design + planning specs (below)

backend/
  *.ts        ← the `rest` contract component: Express REST routes + SSE realtime,
              ← opening the SQLite DB via better-sqlite3 (db.ts, repository.ts,
              ← realtime.ts, index.ts)
```

Realtime works off the `entity_changes` feed: every mutation appends a row in
the same transaction, and the server polls that feed (with a `PRAGMA
data_version` safety net for external table writes) and streams compact deltas
to the browser over `GET /realtime` (with `GET /api/stream` kept as a
compatibility alias), including `changedFields` parsed from
`changed_fields_json`, which the SPA maps to targeted TanStack Query
invalidations. Reconnects replay `GET /sync/changes?after=<seq>` and fall back
to full-cache invalidation if catch-up is unavailable.

### REST surface (as built)

All under an `/api` prefix so the SPA can own the root path-space. DTO fields are
camelCase per the [REST API Boundary](../database/docs/09-database-schema-contract.md#rest-api-boundary).

| Method & path | Purpose |
| --- | --- |
| `GET /api/meta` | Active organization, organizations list, accessible workspaces in that organization, nullable default workspace, and capability flags |
| `POST /api/onboarding` | Zero-membership onboarding: creates an organization, first workspace, membership, and admin role in one transaction |
| `GET/PATCH /api/organizations/:id` | Organization identity and settings, including name and logo |
| `GET/POST/DELETE /api/organizations/:id/admins` | Derived organization admin management (`ADMIN` in every constituent workspace) |
| `GET /realtime` | Canonical SSE realtime feed of `entity_changes` deltas |
| `GET /api/stream` | Compatibility alias for the SSE realtime feed |
| `GET /sync/changes?after=<seq>` | Reconnect catch-up read backed by `entity_changes` |
| `GET /api/agent-catalog`, `PUT /api/agent-catalog`, `POST /api/agent-catalog/refresh` | Workspace agent catalog for launch/settings surfaces |
| `GET /api/launch-settings` | The acting user's local execution-target launch defaults |
| `PATCH /api/launch-settings/agents/:agentKey` | Persist per-agent pre-command / flags to `user_execution_target_preferences.agent_configs_json` |
| `PATCH /api/launch-settings/terminal-profile` | Persist the local terminal launcher profile to `user_execution_target_preferences.terminal_profile_json` |
| `GET/POST /api/projects`, `GET/PATCH /api/projects/:id` | Projects (PATCH covers rename / describe / archive) |
| `GET /api/workspace/statuses` | Workspace card statuses (board columns, shared across projects) |
| `POST /api/workspace/statuses` | Add a workspace status |
| `PATCH /api/workspace/statuses/:statusId` | Rename a status or set the default |
| `PATCH /api/workspace/statuses/reorder` | Reorder workspace statuses |
| `DELETE /api/workspace/statuses/:statusId` | Soft-delete a workspace status |
| `GET /api/projects/:id/resources` | Linked project resources, including execution-target-specific working directories |
| `POST /api/projects/:id/resources` | Add a linked project resource for an execution target |
| `PATCH /api/projects/:id/resources/:resourceId` | Set a project resource as primary |
| `DELETE /api/projects/:id/resources/:resourceId` | Remove a linked project resource |
| `GET /api/projects/:id/repository?executionTargetId=...` | Git repository metadata and file tree for the selected linked resource |
| `GET /api/projects/:id/missions` | Missions in a project |
| `POST /api/missions`, `GET/PATCH/DELETE /api/missions/:id` | Missions (DELETE soft-deletes mission + objectives) |
| `GET /api/missions/:id/objectives` | Objectives of a mission |
| `POST /api/objectives`, `PATCH/DELETE /api/objectives/:id` | Objectives |

**Deviations from the recommended boundary, to ratify:** `/api/meta` and
`/api/workspace/statuses` are new reads the board needs. As a local single-user
console it does **not** yet do per-request auth/authorization or use idempotency
keys — both are required before any multi-user/hosted deployment and before the
shared service layer lands.

### Contract Component

Maps to the **REST API Layer** (`rest`) in [`CONTRACT.md`](../CONTRACT.md), which owns:

- URL paths and HTTP method contracts
- Request/response DTO shapes (derived from the logical schema's camelCase field names)
- REST auth integration points (via the [Auth module](../auth/README.md))
- The SSE/WebSocket realtime endpoint

It does **not** own the database schema (→ [Database module](../database/README.md))
or the protocol CLI surface (→ [CLI module](../cli/README.md)).

### Documentation

- [Web App Requirements](docs/web-app.md): deferred UI / control-center requirements, kept separate from the CLI-first implementation.
- [Framework Recommendation](docs/framework-recommendation.md): why the first implementation should prefer Vite + React + TanStack Router/Query + Serwist over Next.js.
- [UI Design Documents](docs/ui/README.md): the detailed design specification for the realtime React interface — a structure/information-architecture document followed by one detailed spec per page (projects, board, mission detail, execution/runner, review, changes, connectors, settings, users/tokens, search).
- [Implementation Plan](docs/implementation-plan.md): the dependency-ordered build plan that turns the framework recommendation and UI design docs into phased milestones (contract-first API, realtime spine first, vertical slice, then breadth, then gated surfaces).
- REST API Boundary: see the "REST API Boundary" section of [09 — Database Schema Contract](../database/docs/09-database-schema-contract.md) (owned by the [Database module](../database/README.md)).
- [Test Plan](docs/testing.md): REST API conformance (routing, camelCase DTO shape, auth/authorization, idempotency, realtime/sync) plus the framework-agnostic web-UI test plan. Part of the root [TEST_PLAN.md](../TEST_PLAN.md).

### Status

A first realtime slice has landed (projects / missions / objectives CRUD +
live updates). The remaining surfaces described in the [UI design
docs](docs/ui/README.md) and [implementation plan](docs/implementation-plan.md)
— execution & runner, review & delivery, current changes, connectors, settings,
users/roles/tokens — are still deferred and remain CLI-only.

> **Scope note for this slice:** some server paths still read and write the
> SQLite database directly through `better-sqlite3` rather than calling the
> shared service layer in `packages/core/service/`. Move those REST handlers
> onto the service layer as the areas are touched per `AGENTS.md`, so business
> logic is not duplicated.

### Code & Tests

- `server/` — Express REST + SSE realtime over `better-sqlite3` (`db.ts`,
  `repository.ts`, `realtime.ts`, `index.ts`).
- `web/` — the React SPA (`main.tsx`, `router.tsx`, `lib/`, `components/`, `pages/`).
- `shared/contract.ts` — the typed DTO contract.

`yarn typecheck` and `yarn build:prod` both pass. The realtime path is verified
end-to-end (a write from a separate process is reflected in the UI without a
reload).
