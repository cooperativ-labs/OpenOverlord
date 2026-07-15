# Workspace Scoping Audit — the 95 Ambient Reads

Status: complete (Phases 1–3 of `resource-derived-workspace-scoping.md`)
Date: 2026-07-15
Mission: coo:331
Original Phase 1 method: `grep -rn -E 'getActiveWorkspace\(|getActiveWorkspaceId\(|getActiveWorkspaceIdOrNull\(|\bWORKSPACE\.' backend packages`
excluding `*.test.*` and `test/` — 95 sites. Completion is now enforced by the
TypeScript-AST checker in `scripts/check-workspace-scoping.mjs`, not by brittle
substring/line-number matching.

## Completion update

The inventory below is the original Phase 1 snapshot. All CONVERT and
AGGREGATE clusters are now complete. Remaining ambient reads are limited to
request binding/boot, active-workspace UI defaults and legacy unparented
creation/configuration routes; resource-id, project-id, mission-id,
objective-id, execution-request-id, execution-target-id, storage-key, and
webhook-subscription-id operations resolve their owning workspace before RBAC
or persistence. `scripts/check-workspace-scoping.mjs` inventories ambient reads
by enclosing function and rejects anything outside the reviewed edge/default
allowlist.

## Tags

- **KEEP** — legitimate §2.2 consumer: auth/request binding at the edge,
  create-with-no-parent default, switcher/landing/display, boot.
- **CONVERT** — reachable from a named resource; must derive the workspace from
  that resource (the work backlog).
- **AGGREGATE** — a list/index read that should span the caller's workspace
  memberships (the My Missions precedent).
- **INFRA** — the accessor machinery itself in `backend/db.ts` (defines the
  ambient mechanism; stays until the end state removes consumers).
- **COMMENT** — the grep match is prose in a doc comment, not a runtime read.

## Totals

| Tag | Count |
|---|---|
| CONVERT | 41 |
| KEEP | 31 |
| COMMENT | 12 |
| INFRA | 9 |
| AGGREGATE | 2 |
| **Total** | **95** |

The headline: **41 CONVERT sites, but they collapse into ~10 shared choke
points** (see §Backlog). Most sites are reached through a handful of helpers
(`resolveBucket`, `resolveObjectiveScope`, `loadSubscriptionForUpdate`,
`assertProject`/`readProjectLink`/`getMissionRow` in each ext service, the
launch-settings surface, and the three `rbac.ts` defaults). Fixing the choke
points converts the majority mechanically. This is a **days-to-~2-weeks**
effort, not multi-week: roughly one day per cluster plus the Phase 3 fixture.

## Phase 2 progress

| Cluster | Status | Notes |
|---|---|---|
| 1 — Phase 0 launch-settings surface | **DONE** | Optional `workspaceId` threaded through `getLaunchSettings`/`updateAgentLaunchConfig`/`updateTerminalProfile`/`updateWorktreeBranchAutomation`; new `resolveLaunchSettingsScope` authorizes via `requireWorkspacePermission` and builds the acting-device ctx with `buildWebappServiceContextForWorkspace`. Added `GET/PATCH /api/workspaces/:id/launch-settings*` routes. Webapp `api.ts`/`queries.ts` gained the optional `workspaceId`; `useObjectiveAgentSelection` passes `projectQ.data?.workspaceId`. launch.ts sites 114/131/141/152/189 all removed — only 172 (`resolveCatalogWorkspaceId` KEEP) remains. |
| 2 — Latent defaults (free) | **DONE** | `readStoredCatalog`/`persistCatalog` (launch.ts 141/152) and `readSqlStudioEnabled` (workspace-settings.ts 65) defaults deleted; all callers already pass ids. |
| 3 — RBAC defaults | **DONE** | `loadActorRoles`, `actorIsAdmin`, `actorCan`, and `requirePermission` require an explicit `(workspaceId, workspaceUserId)` scope. Resource-aware route handlers no longer run a generic active-workspace guard first. |
| 4 — Change-feed / webhook-event enablers | **DONE** | Change writers require an explicit workspace and derive or validate the actor membership in that same workspace; webhook events receive the authorized workspace/actor pair. |
| 5 — Objective attachments | **DONE** | Objective lookup resolves and authorizes its workspace before selecting its bucket, listing, uploading, deleting, or serving metadata. |
| 6 — Bucket resolution | **DONE** | Stored-object lookup derives its workspace from persisted object metadata before resolving a bucket. |
| 7 — Webhook subscription operations | **DONE** | Subscription-id operations, deliveries, redelivery, and project-bound creation resolve the subscription/project workspace before authorization and persistence. |
| 8 — GitHub ext | **DONE** | Project/mission operations use shared resource route guards plus their parent workspace for links, installation credentials, pull requests, and change records. An asymmetric-role route test proves ADMIN in active A cannot authorize a project in B. |
| 9 — Everhour ext | **DONE** | Project/mission operations use their parent resource workspace for links, API credentials, timers, and change records. |
| 10 — AGGREGATE rewrites | **DONE** | Runner and My Missions iterate the caller's workspace memberships; resource filters first resolve their owning workspace. |

The backend typecheck, AST scoping check, and focused A/B regression suites are
clean. Full-suite verification is recorded with the implementation handoff.

### Phase 3 A/B fixture (structural regression harness)

`backend/secondary-workspace-fixture.ts` is the shared harness the plan's Phase 3
calls for. `setupSecondaryWorkspaceFixture()` puts a project/mission/objective in
workspace **B** while the active workspace stays **A** (both under one ADMIN
profile); `assertScopedToResourceWorkspace()` encodes the invariant — a value
written scoped to B is visible read-scoped-to-B and **absent** read-scoped-to-A
(valid only for genuinely per-workspace state). Cases live in
`backend/mission-secondary-workspace.test.ts` under the describe *"workspace-scoped
operations resolve against the resource workspace, not the active one"*.

Seeded with the Phase 0 launch surface: `worktreeBranchAutomationEnabled` (the
genuinely per-workspace launch setting — `workspaces.settings_json`, launch.ts
114/131/189) gets the full A/B invariant; per-agent pre-command/flags are a
per-**device** preference shared across a profile's workspaces (not per-workspace),
so they get an end-to-end check that `launchObjective` resolves them from the
objective's own workspace context instead. The suite also exercises project
target resolution, stored attachments, project webhook creation, Everhour link
lookup, and B-workspace change attribution while A remains active. GitHub's
route-level cross-workspace authorization has a separate asymmetric-role test;
the AST allowlist supplies exhaustive call-site coverage without duplicating
the same A/B scenario for every endpoint.

## Resolved cross-cutting architecture finding

`handle(..., { requires })` remains appropriate only for active-workspace
landing/default routes. Every resource-aware handler delegates authorization to
the service that resolves its target workspace (or explicitly builds a target
workspace service context). This preserves token-scope checks while avoiding a
pre-handler active-workspace denial for resources in workspace B.

---

## backend/db.ts (21) — machinery; stays

| Line | Site | Tag | Notes |
|---|---|---|---|
| 128, 260, 277, 278, 393, 410, 413, 569, 634 | doc comments | COMMENT | Prose referencing the accessors; not runtime reads. |
| 376, 386, 387, 399 | `getActiveWorkspace` / `getActiveWorkspaceId` / `getActiveWorkspaceIdOrNull` definitions | INFRA | The accessors that define the ambient mechanism. |
| 417, 420, 423, 426 | `WORKSPACE` proxy getters (`id`/`slug`/`name`/`kind`) | INFRA | Proxy machinery. |
| 449 | `buildWebappServiceContext(client)` | INFRA | The ambient-default `ServiceContext` factory — legitimate at the request edge. Its resource-derived counterpart `buildWebappServiceContextForWorkspace` (db.ts:467) already exists; any resource-scoped caller reaching the ambient variant is a CONVERT at the *caller*, not here. |
| 640 | `reloadActiveWorkspace()` | KEEP | Re-reads the active workspace after an in-place rename; the operation is about the active workspace itself. |
| 706 | `recordChange`: `input.workspaceId ?? getActiveWorkspaceId()` | **CONVERT** (enabler) | Change-feed rows must be attributed to the changed entity's workspace. `input` already carries `missionId`/`projectId`/`objectiveId`; well-behaved callers (reorderProjects:1751, status writers) already pass it. Fix: make `workspaceId` required, derive at each caller. |
| 746 | `enqueueWebhookEventRest`: `input.workspaceId ?? getActiveWorkspaceId()` | **CONVERT** (enabler) | Webhook dispatch must match subscriptions in the resource's workspace. A REST mutation on a foreign-workspace mission that omits `workspaceId` enqueues against the caller's active workspace. Same fix: require the id. |

## backend/rbac.ts (3) — the Phase 2 targets

| Line | Site | Tag | Notes |
|---|---|---|---|
| 22 | `loadActorRoles({workspaceId = getActiveWorkspaceIdOrNull() ?? undefined})` | **CONVERT** (Phase 2 enabler) | One external caller omits the id (`repository.ts:5761`); also the engine under `actorIsAdmin`/`actorCan`. |
| 38 | `actorIsAdmin({workspaceId = ...})` | **CONVERT** (Phase 2 enabler) | `workspaces.ts:172` passes an explicit id; only `requireAdmin()` still relies on the ambient default. |
| 67 | `actorCan(action, {workspaceId = ...})` | **CONVERT** (Phase 2 enabler, highest fan-out) | Ambient-relying callers: 5 direct `actorCan` sites (`branching/target-resource-observations.ts:15,16`, `branching/mission-branch-observations.ts:15,16`, `execution/execution-target-migration.ts:9`) + all 9 `requirePermission()` route-guard sites + `requireAdmin`. Already-derived exemplars: `rbac.ts:117` (`requireWorkspacePermission`), `launch.ts:886,1119`, `webhook-dispatcher.ts:222`. Dropping these three defaults is what surfaces the CONVERT fallout as compile errors. |

## backend/execution/launch.ts (6) — Phase 0 surface

| Line | Site | Tag | Notes |
|---|---|---|---|
| 114 | `readWorkspaceSettings(client, workspaceId = WORKSPACE.id)` | **CONVERT** | Genuinely ambient via `updateWorktreeBranchAutomation` (:506) → `PATCH /api/launch-settings/worktree-branch-automation`. No `/api/workspaces/:id/launch-settings` route exists yet — that scoped route is the missing Phase 0 piece. Derive from the route's `:id` workspace. |
| 131 | `writeWorkspaceSettings(settings, client, workspaceId = WORKSPACE.id)` | **CONVERT** | Same path as :114. |
| 141 | `readStoredCatalog(client, workspaceId = WORKSPACE.id)` | **CONVERT** (latent) | Every runtime caller already passes an explicit `targetWorkspaceId` from `resolveCatalogWorkspaceId`; the default is dead. Mechanical: delete the default. |
| 152 | `persistCatalog(catalog, client, workspaceId = WORKSPACE.id)` | **CONVERT** (latent) | Same as :141 — dead default, delete. |
| 171 | `resolveCatalogWorkspaceId`: `if (!workspaceId) return WORKSPACE.id` | KEEP | The legacy no-`:id` catalog routes' documented active-workspace default (route-level permission already ran on the active workspace). Dies when the legacy routes are retired. |
| 189 | `readWorktreeBranchAutomationEnabled(client, workspaceId = WORKSPACE.id)` | **CONVERT** | `repository.ts:829` already passes the mission's workspace explicitly; only the unscoped `GET /api/launch-settings` path (`launchSettingsDto` :211) still hits the ambient default. |

## backend/repository.ts (9)

| Line | Site | Tag | Notes |
|---|---|---|---|
| 1608 | `listProjects()` | **AGGREGATE** | Top-level `GET /api/projects` index. `listProjectsForWorkspace(workspaceId)` already exists for explicit scoping (multi-workspace sidebar, index.ts:775); the unqualified list should union across the caller's memberships. |
| 1764 | `listWorkspaceStatuses()` | KEEP | Active workspace's own board/settings config (`GET /api/workspace/statuses`). Resource-derived reads already use `selectWorkspaceStatusesForWorkspace(row.workspace_id)`. |
| 1805 | `resolveStatusWorkspaceId(db, workspaceId?)` | KEEP | Documented dual-mode defaulter: scoped `/api/workspaces/:id/statuses` routes pass the id; legacy routes get the active workspace. Update/delete could be refined to derive from the status row, but the follow-up scoped lookup 404s foreign rows — safe. |
| 2658 | `createProject`: `body.workspaceId?.trim() \|\| getActiveWorkspaceId()` | KEEP | §2.2(2) create-with-no-parent default; `requireWorkspacePermission` re-authorizes explicit values. (Plan end-state: move the fallback to the client.) |
| 2952 | `searchMissions` — project-less branch | **AGGREGATE** | With `projectId` the workspace is already derived from the project (coo:135). The global-search branch should span all memberships, not the active workspace. |
| 3177 | `requireMissionPermission` — `display_id` fallback | KEEP | Auth binding: display ids are unique only per workspace, so the fallback *must* scope to the active one; UUID path already derives from the mission row. |
| 5920 | `loadOperatorIdentity` | KEEP | Actor-attribution membership lookup for personal user tokens (owned by `profile_id`); auth binding, not resource scoping. |
| 6016 | `createUserToken` — token row `workspace_id` | KEEP | Create-with-no-parent default at token creation. |
| 6038 | `createUserToken` — scope-grant rows | KEEP | Same transaction; inherits the create-time workspace. |

## backend/storage.ts (10)

| Line | Site | Tag | Notes |
|---|---|---|---|
| 85 | `resolveBucket(bucketKey)` | **CONVERT** (choke point) | Mixed helper. Fine for `user-images`/`workspace-images` uploads (no parent), wrong for `uploadObjectiveAttachment` (objective already yields `scope.workspace_id`) and `resolveStoredObject` (object has an owning workspace). Add an explicit `workspaceId` param. |
| 236 | `uploadUserImage` | KEEP | Create-with-no-parent (`POST /api/uploads/user-images`). |
| 277 | doc comment | COMMENT | — |
| 284 | `uploadWorkspaceImage` — object key | KEEP | Workspace logo upload for the workspace being administered. |
| 302 | `uploadWorkspaceImage` — row insert | KEEP | Same create default as :284. |
| 404 | `resolveObjectiveScope(objectiveId)` | **CONVERT** (choke point) | Entry point for all attachment ops; filters the objective by active workspace, producing spurious 404s for foreign-workspace objectives. Look up by id, use `row.workspace_id`, RBAC-check in that workspace. |
| 564 | `listObjectiveAttachments` | **CONVERT** | Redundant active-workspace filter; derive from the objective's resolved `workspace_id`. |
| 597 | `deleteObjectiveAttachment` — lookup | **CONVERT** | Derive from the objective (`resolveObjectiveScope` result, same tx). |
| 627 | `deleteObjectiveAttachment` — remaining-list | **CONVERT** | Same as :564. |
| 747 | doc comment | COMMENT | — |

## backend/webhooks.ts (8)

| Line | Site | Tag | Notes |
|---|---|---|---|
| 121 | `assertProjectInWorkspace(db, projectId)` | **CONVERT** | On create, active workspace is a fine default; on update the project must belong to the *subscription's* workspace (couples to :133). |
| 133 | `loadSubscriptionForUpdate(db, id)` | **CONVERT** (choke point) | Every by-id op (update/delete/rotate/test/deliveries/redeliver) filters by the cookie workspace — an admin of B active in A gets 404s. Load by id, then check membership/permission in the row's workspace. Fixing this carries :121/:381/:403/:429/:492. |
| 145 | `listWebhookSubscriptions()` | KEEP | Per-workspace admin settings surface; the active workspace is the settings context being viewed. |
| 183 | `createWebhookSubscription` | KEEP | Create-with-no-parent default. |
| 381 | `testWebhookSubscription` — `X-Overlord-Workspace` header | **CONVERT** | Should advertise the subscription's workspace, not the caller's cookie. |
| 403 | `testWebhookSubscription` — attempt row | **CONVERT** | Attempt belongs to the subscription's workspace. |
| 429 | `ensurePingOutboxRow` | **CONVERT** | Ping outbox row should inherit the subscription's workspace. |
| 492 | `redeliverWebhookDelivery` — tenancy guard | **CONVERT** | Assert the outbox row matches the *subscription's* workspace, not the active one. |

## backend/ext/github/service.ts (11)

| Line | Site | Tag | Notes |
|---|---|---|---|
| 159 | `readInstallation` | **CONVERT** (caveat) | Fine for the settings endpoints; wrong when reached via `requireInstallationToken` from `listGitHubRepos` / `linkProjectGitHub` / `createMissionGitHubPullRequest`, where the token must belong to the resource's workspace. Thread a derived `workspaceId` in. |
| 184 | `assertProject` | **CONVERT** | Derive from `projects.workspace_id` for the passed `projectId`. |
| 198 | `readProjectLink` | **CONVERT** | Link row is a child of the project; derive from the project. |
| 224 | `beginGitHubInstall` | KEEP | Connect-integration flow for the active workspace; no parent resource. |
| 235 | `completeGitHubInstall` — state verify | KEEP | OAuth callback binds to the workspace that began the flow. |
| 281 | `completeGitHubInstall` — insert | KEEP | Create-with-no-parent: new installation belongs to the installing workspace. |
| 317 | `disconnectGitHub` | KEEP | Workspace-level disconnect of the active workspace's own integration. |
| 426 | `linkProjectGitHub` — insert | **CONVERT** | New link belongs to the project's workspace. |
| 459 | `readPullRequest` | **CONVERT** | Derive from `missions.workspace_id`. |
| 494 | `createMissionGitHubPullRequest` — mission select | **CONVERT** | The natural derive point: load the mission by id, use its `workspace_id` downstream. |
| 526 | `createMissionGitHubPullRequest` — PR insert | **CONVERT** | Derive from the mission just loaded. |

## backend/ext/everhour/service.ts (15)

| Line | Site | Tag | Notes |
|---|---|---|---|
| 196 | `readEverhourConnection` | **CONVERT** (caveat) | Fine for the settings endpoints; wrong when it supplies the API key (via `requireApiKey`) for project/mission timer and time ops that may target another workspace. Thread a derived `workspaceId` in. |
| 229 | `writeEverhourConnection` — update | KEEP | Manage the active workspace's own integration. |
| 251 | `writeEverhourConnection` — insert | KEEP | Create-with-no-parent connection. |
| 276 | `clearEverhourConnection` | KEEP | Workspace-level disconnect. |
| 334 | `readProjectLink` | **CONVERT** | Derive from `projects.workspace_id`. |
| 345 | `assertProjectExists` | **CONVERT** | Derive from `projects.workspace_id`. |
| 361 | `clearProjectLink` | **CONVERT** | Derive from the project. |
| 416 | `writeProjectLink` — update | **CONVERT** | Derive from the project. |
| 444 | `writeProjectLink` — insert | **CONVERT** | Derive from the project. |
| 483 | `writeProjectGeneralTaskId` | **CONVERT** | Derive from the project owning the link. |
| 600 | `getMissionRow` | **CONVERT** (choke point) | The natural derive point for all mission ops: load by id, use `missions.workspace_id` (+ `project_id`) downstream. |
| 633 | `listProjectEverhourTaskIds` | **CONVERT** | Derive from the project. |
| 650 | `readMissionLink` | **CONVERT** | Derive from the mission. |
| 665 | `writeMissionTaskId` — update | **CONVERT** | Derive from the loaded mission. |
| 687 | `writeMissionTaskId` — insert | **CONVERT** | Derive from the loaded mission. |

## backend/workspaces.ts (4)

| Line | Site | Tag | Notes |
|---|---|---|---|
| 65 | `toWorkspaceDto` — `isActive` flag | KEEP | §2.2(3) switcher display flag. |
| 666 | `updateWorkspace` — SQL-studio sync guard | KEEP | Compares the target `id` to active for a side-effect; the operation itself derives from `id`. |
| 695 | `updateWorkspace` — `reloadActiveWorkspace` guard | KEEP | Active-binding maintenance after rename. |
| 741 | `deleteWorkspace` — re-point guard | KEEP | Re-points the active workspace after deleting it; navigational. |

## Singleton files (7)

| Site | Tag | Notes |
|---|---|---|
| `backend/index.ts:1727` (`bootWorkspaceId`) | KEEP | Boot-time seed for SQL-studio sync; no request context exists at boot. |
| `backend/index.ts:1753` (boot log line) | KEEP | Logging only. |
| `backend/auth.ts:281` | KEEP | §2.2(1) auth binding: default workspace for loopback-trusted local CLI operator. |
| `backend/http/meta.ts:26` | KEEP | `GET /api/meta` active-workspace marker; switcher/landing display. |
| `backend/protocol.ts:69` | KEEP | Protocol `ServiceContext` edge binding; per-resource protocol ops already resolve via `protocolWorkspaceId()` from the resource id. |
| `backend/organizations.ts:113` | KEEP | Derives active org from active workspace; navigation/display. |
| `backend/account-deletion.ts:25` | COMMENT | Prose explaining why deletion spans all workspaces. |
| `backend/workspace-settings.ts:65` (`readSqlStudioEnabled`) | **CONVERT** (latent) | All 3 runtime callers pass explicit ids; the `= WORKSPACE.id` default is dead. Delete it. |

---

## The CONVERT backlog (41 sites → ~10 work items)

Sequenced by blast radius per plan §5. "Latent" items are dead defaults —
mechanical deletion with zero behavior change.

| # | Cluster | Sites | Shape of the fix |
|---|---|---|---|
| 1 | **Phase 0: launch-settings surface** | launch.ts 114, 131, 189 | Add `GET/PATCH /api/workspaces/:id/launch-settings*` routes (mirror the catalog block at index.ts:829-846); thread `workspaceId` through `getLaunchSettings`/`updateAgentLaunchConfig`/`updateWorktreeBranchAutomation`; webapp passes `projectQ.data?.workspaceId`. |
| 2 | Latent defaults (free) | launch.ts 141, 152; workspace-settings.ts 65 | Delete the `= WORKSPACE.id` default params; all callers already pass ids. |
| 3 | **RBAC defaults** (Phase 2 opener) | rbac.ts 22, 38, 67 | Make `workspaceId` required. Fallout to fix: 5 direct `actorCan` sites, 9 `requirePermission` route guards, `requireAdmin`, `repository.ts:5761`. Use `requireWorkspacePermission`/`requireProjectPermission` pattern. |
| 4 | Change-feed / webhook-event enablers | db.ts 706, 746 | Make `input.workspaceId` required in `recordChange` and `enqueueWebhookEventRest`; derive at each caller from the mutated entity. |
| 5 | Objective attachments | storage.ts 404, 564, 597, 627 | `resolveObjectiveScope` loads by id and yields `workspace_id`; RBAC-check in that workspace; downstream queries use it. |
| 6 | Bucket resolution | storage.ts 85 | Add explicit `workspaceId` param to `resolveBucket`; attachment path passes the objective's workspace, serve path the object's owner, image uploads keep active. |
| 7 | Webhook subscription by-id ops | webhooks.ts 121, 133, 381, 403, 429, 492 | `loadSubscriptionForUpdate` loads by id, checks membership/permission in the row's workspace; the other five sites inherit the subscription's `workspace_id`. |
| 8 | GitHub ext | github 159, 184, 198, 426, 459, 494, 526 | Load project/mission by id first, derive `workspace_id`, thread into `readInstallation`/`readProjectLink`/token minting. Self-contained. |
| 9 | Everhour ext | everhour 196, 334, 345, 361, 416, 444, 483, 600, 633, 650, 665, 687 | Same pattern: `getMissionRow`/`assertProjectExists` become derive points; `readEverhourConnection` takes the derived workspace. Self-contained. |
| 10 | AGGREGATE rewrites | repository.ts 1608 (`listProjects`), 2952 (global `searchMissions`) | Iterate `callerWorkspaceMemberships()` (runner/My-Missions precedent) instead of scoping to the active workspace. |

### Effort estimate

Clusters 2 is free; 1 is the already-specified Phase 0; 3–7 are each roughly a
half-day to a day including tests; 8–9 are the largest (26 sites combined) but
mechanical once the per-service derive point is in place — a day each; 10 is a
day. **Total: on the order of 1.5–2 weeks including the Phase 3 A/B fixture**
— "days, not weeks" per cluster, with the ext services as the long pole.

### CI AST gate (Definition of done §9.3)

`scripts/check-workspace-scoping.mjs` parses backend/package source files and
fails on an ambient accessor outside its reviewed file/function allowlist. The
following grep remains useful for human inventory, but is not the CI decision:

```
grep -rn -E 'getActiveWorkspace\(|getActiveWorkspaceId\(|getActiveWorkspaceIdOrNull\(|\bWORKSPACE\.' backend packages \
  | grep -v '\.test\.' | grep -v 'test/'
```

Expected survivors: db.ts machinery, rbac callers via `requireWorkspacePermission`
only, auth.ts:281, http/meta.ts:26, protocol.ts:69, organizations.ts:113,
workspaces.ts (4 switcher/maintenance guards), index.ts boot lines,
repository.ts create-defaults (1805, 2658, 6016, 6038) and auth bindings
(3177, 5920), storage image-upload defaults (236, 284, 302), webhooks
list/create (145, 183), ext connect/disconnect settings flows (github 224,
235, 281, 317; everhour 229, 251, 276), launch.ts:171 until the legacy catalog
routes are retired.
