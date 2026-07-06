# Everhour Extension Boundary

## Objective

Refactor Everhour from a core time-tracking feature into the reference Overlord extension for database-backed integrations. The extension must use sanctioned extension points only:

- Database extension tables named `ext_everhour_*`.
- Migration component `ext:everhour`.
- REST extension endpoints under `/ext/everhour/`.
- Extension-local DTOs instead of core `ProjectDto` or core contract fields.
- First-party web UI that consumes the extension API without creating an unsanctioned third-party UI plugin surface.

## Current Contract Assessment

The current contract can represent the required database and REST boundaries:

- `database-extension` allows `ext_<name>_` tables and `schema_migrations.component = 'ext:<name>'`.
- `rest-extension` allows endpoint prefixes under `/ext/<name>/`.
- Open vocabularies allow namespaced `entity_changes.entity_type` and `entity_changes.source` values for extension invalidation.
- Core `metadata_json` / `settings_json` can temporarily carry namespaced compatibility metadata, but Everhour's durable data should move to first-class extension tables.

No webapp UI extension point is required for this refactor. Everhour should remain a first-party optional UI consumer of the extension API. A general plugin UI surface would be a new contract surface and is intentionally out of scope.

One manifest modeling gap should be resolved before the final conformance manifest lands: `contract/conformance-manifest.schema.yaml` supports `componentType: extension` with `extension.usesExtensionPoints`, and it separately supports `componentType: rest-module` with `restModule.endpointPrefix`, but it does not cleanly model one shipped extension that declares both database and REST extension usage in a single manifest. Two compatible options exist:

1. Current-contract option: ship paired manifests:
   - `extensions/everhour/conformance-manifest.yaml` with `componentType: extension`, `extension.tablePrefix: ext_everhour_`, `extension.migrationComponent: ext:everhour`, and `extension.usesExtensionPoints: [database-extension, open-vocabulary-value]`.
   - `webapp/server/ext/everhour/conformance-manifest.yaml` with `componentType: rest-module`, `restModule.endpointPrefix: /ext/everhour`, and `restModule.usesServiceLayer: true`.
2. Contract-clarification option: allow `componentType: extension` manifests to declare `rest-extension` in `extension.usesExtensionPoints` and include `restModule.endpointPrefix` when the extension ships REST routes.

Recommended path: use the current-contract paired manifest model unless the project wants Everhour to be the precedent for unified extension manifests. If the unified model is chosen, update `CONTRACT.md`, `contract/extension-points.yaml`, and `contract/conformance-manifest.schema.yaml` before implementation. Impact: database and backend implementation stay the same; webapp gains no new UI plugin surface; tests add manifest validation for the unified shape; future extensions get one canonical manifest instead of paired manifests.

## Module Layout

Target layout:

```text
extensions/
  everhour/
    conformance-manifest.yaml
    README.md
    contract.ts
    service.ts
    repository.ts
    everhour-client.ts
    migrations/
      sqlite/
        20260706000000_ext_everhour_initial.sql
      postgres/
        20260706000000_ext_everhour_initial.sql
    tests/
      repository.test.ts
      service.test.ts
backend/
  ext/
    everhour/
      routes.ts
      conformance-manifest.yaml
webapp/
  web/
    components/everhour/
    lib/everhour.ts
```

Ownership:

- `extensions/everhour/contract.ts` owns Everhour DTOs and request bodies.
- `extensions/everhour/everhour-client.ts` owns outbound Everhour API calls and upstream response normalization.
- `extensions/everhour/repository.ts` owns direct reads/writes to `ext_everhour_*` tables through `DatabaseClient`.
- `extensions/everhour/service.ts` owns workspace/project/mission authorization-adjacent business operations and calls core service helpers for core reads.
- `backend/ext/everhour/routes.ts` owns HTTP routing and auth/permission binding only.
- `webapp/web/components/everhour/*` remains first-party UI, but all data access goes through `/ext/everhour/` and extension DTO types.

## REST Boundary

All routes move from core `/api/.../everhour` paths to `/ext/everhour/`:

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/ext/everhour/integration` | `workspace:read` | Read workspace connection state without returning the API key. |
| `PUT` | `/ext/everhour/integration` | `workspace:update` | Validate and store or replace the workspace API key. |
| `DELETE` | `/ext/everhour/integration` | `workspace:update` | Soft-delete or clear the workspace connection. |
| `PUT` | `/ext/everhour/projects/:projectId/link` | `project:update` | Link or unlink an Overlord project to an Everhour project. |
| `GET` | `/ext/everhour/missions/:missionId` | `mission:read` | Read mission Everhour state, records, total, and running timer. |
| `POST` | `/ext/everhour/missions/:missionId/timer/start` | `mission:update` | Ensure a task link and start the Everhour timer. |
| `POST` | `/ext/everhour/missions/:missionId/timer/stop` | `mission:update` | Stop the current timer and return refreshed mission state. |
| `POST` | `/ext/everhour/missions/:missionId/time` | `mission:update` | Add manual time to the linked task. |
| `PATCH` | `/ext/everhour/missions/:missionId/time/:recordId` | `mission:update` | Update a time record. |
| `DELETE` | `/ext/everhour/missions/:missionId/time/:recordId` | `mission:update` | Delete a time record. |

The project link route should return an extension DTO, not core `ProjectDto`. Suggested response: `EverhourProjectLinkDto { projectId, linked, everhourProjectId, everhourProjectName, everhourSectionId, updatedAt, revision }`. The webapp can invalidate and refetch the core project separately when needed.

## Extension Tables

### `ext_everhour_workspace_connections`

Workspace-scoped connection and secret storage.

Columns:

- `id` Id primary key.
- `workspace_id` Id, FK to `workspaces`.
- `api_key_secret` text, required for active rows. Everhour requires the retrievable key for outbound API calls, matching the current raw storage posture and the webhook signing-secret precedent. The service must never return this value to clients, must redact it from change feeds/logs, and should migrate the column to encrypted storage if a general secret-storage facility lands.
- `account_id` text, nullable.
- `account_name` text, nullable.
- `created_at`, `updated_at`, `deleted_at`, `revision`.

Indexes:

- Unique active `(workspace_id)`.
- `(workspace_id, deleted_at)`.

### `ext_everhour_project_links`

Project-scoped Everhour project binding.

Columns:

- `id` Id primary key.
- `workspace_id` Id, FK to `workspaces`.
- `project_id` Id, FK to `projects`.
- `everhour_project_id` text, required for active rows.
- `everhour_project_name` text, required for active rows.
- `everhour_section_id` text, nullable.
- `created_at`, `updated_at`, `deleted_at`, `revision`.

Indexes:

- Unique active `(workspace_id, project_id)`.
- `(workspace_id, everhour_project_id)`.
- `(project_id, deleted_at)`.

### `ext_everhour_mission_links`

Mission-scoped Everhour task binding.

Columns:

- `id` Id primary key.
- `workspace_id` Id, FK to `workspaces`.
- `project_id` Id, FK to `projects`.
- `mission_id` Id, FK to `missions`.
- `everhour_task_id` text, required for active rows.
- `created_at`, `updated_at`, `deleted_at`, `revision`.

Indexes:

- Unique active `(workspace_id, mission_id)`.
- `(workspace_id, everhour_task_id)`.
- `(project_id, deleted_at)`.
- `(mission_id, deleted_at)`.

All mutable writes use optimistic concurrency where the caller updates an existing extension row. First-link creation can be insert-or-active-conflict with a retry/read path.

## Migration And Backfill Plan

1. Add SQLite and Postgres extension migrations with component `ext:everhour`.
2. Create the three extension tables and indexes above.
3. Backfill active workspace connections from `workspaces.settings_json.everhourApiKey`.
4. Backfill active project links from these legacy project settings keys:
   - `overlord.everhourProjectId`
   - `overlord.everhourProjectName`
   - `overlord.everhourSectionId`
5. Backfill active mission links from `missions.everhour_task_id`.
6. During the transition, service reads should prefer extension tables and fall back to legacy core fields only when no extension row exists.
7. After extension reads/writes ship, remove legacy writes.
8. Remove `missions.everhour_task_id` from the schema contract, generated DB types, and core migrations only through a contract-first migration plan appropriate for existing installations.
9. Remove Everhour keys from core serializers and shared core DTOs.

Backfill must be idempotent: rerunning should not create duplicate active rows. Use deterministic row IDs only if the migration framework already has a project standard for generated IDs in data migrations; otherwise use adapter-supported generated UUID/ULID helpers in migration code or a service-level backfill step.

## Realtime And Invalidations

Extension data changes should write `entity_changes` rows when web clients need to invalidate cached extension state:

- `entity_type = 'everhour:workspace_connection'`
- `entity_type = 'everhour:project_link'`
- `entity_type = 'everhour:mission_link'`
- `source = 'everhour:extension'`

These are open vocabulary values and must be declared in the conformance manifest. Changed fields should use extension DTO field names, not raw secret fields. The webapp should invalidate Everhour query keys on these extension entity types and continue avoiding broad Everhour refetches for unrelated core changes.

## DTO Boundary

Move these types out of `packages/contract/src/index.ts` into `extensions/everhour/contract.ts`:

- `EverhourIntegrationDto`
- `UpdateEverhourIntegrationBody`
- `LinkProjectEverhourBody`
- `EverhourProjectLinkDto`
- `EverhourTimeRecordDto`
- `EverhourTimerDto`
- `MissionEverhourStateDto`
- `CreateEverhourTimeBody`
- `UpdateEverhourTimeBody`

Remove these fields from core `ProjectDto`:

- `everhourProjectName`
- `everhourProjectId`

Core project reads should no longer parse Everhour settings. Project settings UI should request `EverhourProjectLinkDto` separately.

## Implementation Sequence

1. Add extension manifests and docs.
2. Add extension migrations and backfill.
3. Add extension repository/service/client modules.
4. Register `/ext/everhour/` routes with the same permission gates as today.
5. Update webapp API client, queries, and components to extension routes and DTOs.
6. Remove core Everhour DTO fields and parsing helpers after compatibility reads are in place.
7. Add focused migration, service, route permission, and UI query tests.
