# Everhour — reference extension

Everhour is the canonical example for a **database + REST** integration in
Overlord. Copy this pattern when adding another third-party service that needs
extension-owned tables, namespaced REST routes, and first-party UI that
consumes the extension API.

## Conformance manifests

Everhour ships **paired manifests** (the current contract models database and
REST extension points separately):

| Manifest | Path | `componentType` |
| --- | --- | --- |
| Database extension | [`conformance-manifest.yaml`](./conformance-manifest.yaml) | `extension` |
| REST extension | [`../../backend/ext/everhour/conformance-manifest.yaml`](../../backend/ext/everhour/conformance-manifest.yaml) | `rest-module` |

Validate with `ovld contract check <manifest-path>` when the CLI supports it.

## Directory layout

```text
extensions/everhour/
  conformance-manifest.yaml   # database extension declaration
  README.md                   # this file

database/
  sqlite/migrations/20260706000000_ext_everhour_persistence.sql
  postgres/migrations/20260706000000_ext_everhour_persistence.sql

backend/ext/everhour/
  conformance-manifest.yaml   # REST extension declaration
  routes.ts                   # HTTP routing + permission gates only
  service.ts                  # business logic, outbound API calls, DB writes

packages/contract/src/ext/everhour.ts
  # Extension DTOs and request bodies (@overlord/contract/ext/everhour)

webapp/web/
  lib/api.ts                  # /ext/everhour client methods
  lib/queries.ts              # React Query keys + hooks
  lib/query-invalidation.ts   # entity_changes invalidation
  components/everhour/        # mission timer UI
  components/settings/IntegrationsPage.tsx
  components/projects/project-settings/IntegrationsPage.tsx
```

**Ownership rule:** extension tables and secrets live in `ext_*` tables; core
`ProjectDto` and other core contract types stay free of integration fields.
The webapp is a first-party consumer of `/ext/everhour/` — no separate UI
plugin surface is required.

## Migration conventions

1. **File name** — `YYYYMMDDHHMMSS_ext_<name>_<description>.sql` in both
   `database/sqlite/migrations/` and `database/postgres/migrations/`.
2. **Component** — record migrations with
   `schema_migrations.component = 'ext:everhour'` (pattern `ext:<name>`).
3. **Table prefix** — all extension tables use `ext_everhour_` (pattern
   `ext_<name>_`).
4. **Core schema** — do not add columns to core tables for extension data. Use
   backfill migrations to move legacy core fields into extension tables, then
   remove the core fields through a contract-first migration.
5. **Foreign keys** — reference core tables (`workspaces`, `projects`,
   `missions`) but never write to them directly from extension code except
   through sanctioned service APIs.

Everhour tables:

| Table | Purpose |
| --- | --- |
| `ext_everhour_workspace_connections` | Workspace API key and account metadata |
| `ext_everhour_project_links` | Overlord project ↔ Everhour project |
| `ext_everhour_mission_links` | Overlord mission ↔ Everhour task |

Each mutable table uses `revision` optimistic concurrency and soft-delete via
`deleted_at` with partial unique indexes for active rows.

## Route naming

All endpoints live under `/ext/everhour/` (registered in `backend/index.ts`).

| Method | Route | Permission |
| --- | --- | --- |
| `GET` | `/ext/everhour/integration` | `workspace:read` |
| `PUT` | `/ext/everhour/integration` | `workspace:update` |
| `DELETE` | `/ext/everhour/integration` | `workspace:update` |
| `GET` | `/ext/everhour/projects/:projectId/link` | `project:read` |
| `PUT` | `/ext/everhour/projects/:projectId/link` | `project:update` |
| `GET` | `/ext/everhour/missions/:missionId` | `mission:read` |
| `POST` | `/ext/everhour/missions/:missionId/timer/start` | `mission:update` |
| `POST` | `/ext/everhour/missions/:missionId/timer/stop` | `mission:update` |
| `POST` | `/ext/everhour/missions/:missionId/time` | `mission:update` |
| `PATCH` | `/ext/everhour/missions/:missionId/time/:recordId` | `mission:update` |
| `DELETE` | `/ext/everhour/missions/:missionId/time/:recordId` | `mission:update` |

`routes.ts` binds auth and permissions only; `service.ts` owns all logic.

## Auth and permissions

- Every route goes through the standard Auth Layer (`handle` wrapper with
  `requires` permission).
- Workspace-scoped operations (`integration`) require `workspace:read` or
  `workspace:update`.
- Project link operations require `project:read` or `project:update`.
- Mission timer and time-record operations require `mission:read` or
  `mission:update`.
- API keys are stored in `ext_everhour_workspace_connections.api_key_secret` and
  are never returned to clients.

## Realtime invalidation

Extension mutations append `entity_changes` rows with namespaced
`entity_type` values (declared in the database conformance manifest):

- `everhour:workspace_connection`
- `everhour:project_link`
- `everhour:mission_link`

The webapp invalidates Everhour React Query keys when these entity types appear
in the sync feed (`webapp/web/lib/query-invalidation.ts`).

## UI integration

Everhour UI remains first-party code under `webapp/web/`:

- **Settings → Integrations** — workspace API key connect/disconnect.
- **Project settings → Integrations** — link Overlord project to an Everhour
  project by name.
- **Mission panel** — timer buttons, popover, polling while a timer runs.

All data flows through `/ext/everhour/` endpoints and
`@overlord/contract/ext/everhour` types. Query keys are namespaced (`integrations/everhour`,
`project/:id/everhour-link`, `mission/:id/everhour`) so extension cache
invalidation stays isolated from core project/mission queries.

## Copying this pattern for another integration

Replace `everhour` with your extension key (`myapp`) everywhere:

1. **Design** — document tables, routes, DTOs, and permission gates before
   coding. Read `CONTRACT.md`, `contract/extension-points.yaml`, and
   `database/docs/09-database-schema-contract.md`.
2. **Database** — add `ext_myapp_*` migrations with component `ext:myapp`.
3. **Manifests** — create `extensions/myapp/conformance-manifest.yaml`
   (`componentType: extension`) and `backend/ext/myapp/conformance-manifest.yaml`
   (`componentType: rest-module`, `endpointPrefix: /ext/myapp`).
4. **Contract** — add `packages/contract/src/ext/myapp.ts` and export from the
   contract package; do not extend core DTOs.
5. **Backend** — implement `backend/ext/myapp/service.ts` (DB + outbound API)
   and `routes.ts` (thin HTTP layer); register at `/ext/myapp` in
   `backend/index.ts`.
6. **Webapp** — add API client methods, query hooks, invalidation rules, and
   optional first-party UI components that call `/ext/myapp/`.
7. **Vocabulary** — declare any new `entity_changes.entity_type` (or other
   open vocabulary) values in the database conformance manifest.
8. **Tests** — add focused migration, service, route-permission, and client
   tests (see mission objective 6).

Further design notes: [`planning/feature-plans/everhour-extension-boundary.md`](../../planning/feature-plans/everhour-extension-boundary.md).
