# Resource-Derived Workspace Scoping Implementation Plan

Status: implemented
Origin: launch-config regression — objective pre-command and flags dropped when a
mission is run from a workspace other than the caller's active one.
Owner: jake@cooperativ.io
Predecessor: `planning/feature-plans/multitenancy-access-control.md` (moved
`WORKSPACE` from a process-global to a per-request `AsyncLocalStorage` value).

Implementation note (2026-07-15): this document is the design record, so file
line references and future-tense phase instructions below describe the original
plan. The shipped shape is summarized in
`planning/feature-plans/workspace-scoping-audit.md`: explicit workspace/actor
scope is required at change and webhook writers, project/mission route guards
are shared, aggregate indexes authorize each membership once, and an AST-based
allowlist rejects new ambient workspace reads. Runtime A/B tests cover the
highest-risk shared choke points; the static gate covers the remaining call
sites without requiring one repetitive integration test per endpoint.

## 1. Problem

The multitenancy work made the active workspace **per-request** instead of
process-global. It did not change the fact that the active workspace is read
**ambiently** — service code all over the backend calls `getActiveWorkspace()` /
`getActiveWorkspaceId()` / `WORKSPACE.id` (~95 non-test sites) to answer "which
tenant is this operation for."

That is correct while a user only ever operates on the one workspace their cookie
points at. It is **wrong** now that a user can operate on resources in *other*
workspaces they belong to — My Missions aggregation, cross-workspace search, and
(the trigger for this plan) **running a mission that lives in a secondary
workspace**.

When an operation names a resource in workspace B but reads the ambient active
workspace A, it silently scopes to the wrong tenant. The fallback returns *a*
valid workspace (the caller's own), so there is **no error, no 403** — the bug
surfaces as "my setting was ignored" or "wrong data shown." This is a structural
bug generator: every ambient `WORKSPACE.id` read reachable from a foreign-workspace
resource is a latent instance.

### 1.1 The concrete symptom this plan must fix

Agent launch config (pre-command **and** flags) is stored and read from two
different workspaces:

- **Save** (webapp launch footer → `PATCH /api/launch-settings/agents/:agentKey`):
  `updateAgentLaunchConfig` persists via `ensureLocalLaunchTarget` →
  `ensureActingDeviceTarget({ ctx: serviceContext(client) })`
  (`backend/execution/launch.ts:423`). `serviceContext` builds a context for the
  **active** workspace. The route is not workspace-scoped
  (`backend/index.ts:1477`), and the webapp client sends no workspace override
  (`webapp/web/lib/api.ts:551`).
- **Read** (queue time): `launchObjective` builds its context from
  **`objective.workspace_id`** (`backend/execution/launch.ts:940-949`), resolves
  the project's execution target, and reads that workspace's per-target agent
  configs. `resolveLaunchConfig` finds nothing → falls through to
  `{ preCommand: '', flags: [] }`
  (`packages/core/service/project-execution-target.ts:536-545`) → stamps an empty
  `execution_requests.launch_flags_json`.

For a secondary-workspace mission A≠B, the save lands in A and the read looks in
B → empty config → agent launches with no pre-command and none of the flags. Both
fields vanish together because they come from the **same** resolved object.

Why it regressed "one or two commits ago": commit `cc4801b7` broadened the runner
claim scope from `callerMembershipsInActiveOrganization` to
`callerWorkspaceMemberships` (`backend/execution/runner.ts`). Before that, a
request queued in a non-active workspace could not be claimed, so it never
launched; now it launches — with the empty config.

The launch-config issue is fixed as **Phase 0** below (small, shippable), then
generalized so the whole class cannot recur.

## 2. Target model

- **Active workspace is a UI default, never a correctness input.** It answers
  "where does the UI point" and "where do new things default to" — not "which
  tenant does this operation run in."
- **Operations derive their workspace from the resource they name.** Loading an
  objective/mission/project/resource/webhook yields its `workspace_id`; that flows
  into everything downstream, including the caller's membership (`workspace_users`
  row) in *that* workspace.
- **The ambient fallback is removed from the service layer.** Omitting the
  workspace should be a type error, not a silent default to the active one.

### 2.1 The value is a pair, not an id

The ambient state is really `(activeWorkspace, actorWorkspaceUserId)` — the tenant
**and the caller's membership row within it** (`backend/db.ts:281,453`). RBAC needs
both (`rbac.ts` defaults `workspaceUserId = getActorWorkspaceUserId()` alongside
`workspaceId`). Crossing to workspace B therefore requires B's id **and** the
caller's membership in B. The primitive that produces this already exists:
`buildWebappServiceContextForWorkspace(workspaceId, db, actorWorkspaceUserId)` +
`resolveRequestActorForWorkspace` (`backend/db.ts:467-486, 541-542`). The migration
is largely "route every operation through that primitive instead of the ambient
reader."

### 2.2 What legitimately keeps reading active workspace

Only three consumers survive:

1. **Request binding at the edge** — `requireAuthenticatedSession` resolves the
   `overlord_active_workspace` cookie into `(activeWorkspace, actorWorkspaceUserId)`
   for unscoped landing reads and creation defaults (`backend/auth.ts:228`). This
   is the one place *meant* to read the cookie.
2. **Create-with-no-parent defaults** — the New Project / New Mission picker
   pre-selects the active workspace, and the request sends `body.workspaceId`
   explicitly. Server creation takes the explicit value; the `?? getActiveWorkspaceId()`
   fallback becomes the *client's* job (`backend/repository.ts:2658`).
3. **The switcher / landing view** — `isActive` in list-workspaces
   (`backend/workspaces.ts:65`) and the home view's default scope. Purely
   navigational; irrelevant wherever a view already aggregates across workspaces.

The done-signal for the migration: `getActiveWorkspaceId()` / `WORKSPACE.id` appears
**only** in (1)–(3) and never inside a function that already received a resource id.

## 3. Phase 0 — Fix launch config across workspaces (shippable immediately)

Goal: make the launch footer read/write agent configs in the **objective's**
workspace, matching where `launchObjective` reads them. Mirror the pattern commit
`3073411d` already established for the agent catalog
(`resolveCatalogWorkspaceId` + `/api/workspaces/:id/agent-catalog`).

### 3.1 Backend

- Add an optional `workspaceId` parameter to the launch-settings surface in
  `backend/execution/launch.ts`:
  - `getLaunchSettings(workspaceId?)`, `updateAgentLaunchConfig(agentKey, body,
    workspaceId?)`, and (for consistency) `updateTerminalProfile` /
    `updateWorktreeBranchAutomation`.
  - When `workspaceId` is provided, authorize it against the caller's membership
    (`requireWorkspacePermission`, the `resolveCatalogWorkspaceId` pattern —
    404/403 for non-members) and build the acting-device target in **that**
    workspace: `ensureActingDeviceTarget({ ctx:
    buildWebappServiceContextForWorkspace(workspaceId, client, <caller membership
    in that workspace>) })`. Omitted → active workspace (back-compat).
- Add workspace-scoped routes mirroring the catalog block at
  `backend/index.ts:829-846`:
  - `GET  /api/workspaces/:id/launch-settings`
  - `PATCH /api/workspaces/:id/launch-settings/agents/:agentKey`
  - (terminal-profile / worktree-automation optional in Phase 0)
  Keep the legacy unscoped routes for the active-workspace case.

### 3.2 Webapp

- `webapp/web/lib/api.ts`: add `workspaceId?` to `getLaunchSettings` and
  `updateAgentLaunchConfig`, targeting `/api/workspaces/:id/launch-settings...`
  when present (same shape as `getAgentCatalog`).
- `webapp/web/lib/queries.ts`: `useLaunchSettings(workspaceId?)` and
  `useUpdateAgentLaunchConfig(workspaceId?)` take the workspace; key the query by
  workspace so a secondary-workspace mission caches separately.
- `webapp/web/components/objectives/useObjectiveAgentSelection.ts`: pass
  `projectQ.data?.workspaceId` into `useLaunchSettings` / `commitLaunchConfig` —
  exactly as it already does for `useAgentCatalog(projectQ.data?.workspaceId)`
  (`:34`). This is the one-line source of the divergence today (`:35` uses the
  unscoped hook).

### 3.3 Verification for Phase 0

- Reproduce: mission in workspace B, active workspace A, set pre-command `agp` +
  a flag on the objective, Run, assert the queued
  `execution_requests.launch_flags_json` contains both.
- Regression: same-workspace launch still applies config.
- This is also the first case of the Phase 3 A/B harness — write it there so it is
  reusable, not inline.

## 4. Phase 1 — Audit and classify the 95 ambient reads

Produce `planning/feature-plans/workspace-scoping-audit.md`: every
`getActiveWorkspace()` / `getActiveWorkspaceId()` / `WORKSPACE.*` /
`getActiveWorkspaceIdOrNull()` site tagged as one of:

- **KEEP** — a legitimate §2.2 consumer (auth binding, create-default, switcher).
- **CONVERT** — reachable from a named resource; must derive workspace from it.
- **AGGREGATE** — a list/index read that should span the caller's memberships,
  not scope to one workspace (the My Missions precedent).

Hot spots from the initial sweep: `backend/repository.ts` (9), `backend/storage.ts`
(10, per-workspace buckets), `backend/webhooks.ts` (8), `backend/ext/everhour`
(15) and `backend/ext/github` (11), `backend/execution/launch.ts` (6).
`backend/db.ts` (21) is mostly the accessor machinery itself and stays.

Output: the CONVERT list is the actual work backlog; its size decides whether this
is days or weeks.

## 5. Phase 2 — Remove the ambient fallback from the correctness path

- **RBAC:** drop the `workspaceId = getActiveWorkspaceIdOrNull() ?? undefined`
  defaults in `loadActorRoles` / `actorIsAdmin` / `actorCan` /
  `requirePermission` (`backend/rbac.ts:22,38,67`). Make `workspaceId` required.
  This turns "forgot to scope" from a silent wrong-tenant check into a compile
  error. Expect fallout across call sites — that fallout **is** the CONVERT list
  surfacing.
- **CONVERT sites:** each takes a `workspaceId` (or a `ServiceContext` built via
  `buildWebappServiceContextForWorkspace`) from the resource it already loaded.
  Prefer threading a context object over passing a bare id, so the paired
  membership travels with it (§2.1).
- **AGGREGATE sites:** rewrite to iterate `callerWorkspaceMemberships()` (the
  runner/My-Missions precedent) instead of scoping to the active workspace.
- **Transport convention:** standardize on path-scoped routes
  (`/api/workspaces/:id/...`) or server-side resolution from the resource id, over
  the header/ambient default — the workspace in the URL cannot be forgotten by a
  handler. Retire ad-hoc reliance on `X-Overlord-Active-Workspace` for
  resource operations (keep it only for the create/landing default).

Sequence CONVERT work by blast radius: launch (Phase 0, done) → execution/runner →
repository resource ops → storage → webhooks → ext/* (each ext is self-contained).

## 6. Phase 3 — Structural test: the A/B fixture

One reusable fixture: **resource lives in workspace B while the caller's active
workspace is A**, both under one profile. Extend
`backend/mission-secondary-workspace.test.ts` (which today covers claim /
transition / protocol routing but asserts nothing about launch config).

Assert, for each workspace-scoped operation, that it resolves against the
resource's workspace, not the ambient one — starting with launch config / flags /
pre-command (Phase 0), then every operation converted in Phase 2. Make the fixture
a shared helper so each newly-converted endpoint inherits the assertion and the
bug class is caught at the door.

## 7. Risks and mitigations

- **Silent scope changes during CONVERT.** Removing the RBAC default (Phase 2)
  first, before converting call sites, makes omissions fail loudly (compile/test)
  instead of silently — do it in that order.
- **The membership pair.** A CONVERT that passes only a workspace id but keeps the
  ambient `actorWorkspaceUserId` checks permissions with the wrong membership.
  Always carry the context object, never a bare id.
- **Back-compat during rollout.** Legacy unscoped routes stay until their callers
  are migrated; new scoped routes are additive. No client/runner version break is
  required for Phase 0.
- **ext/* surfaces (everhour, github).** 26 reads combined; verify whether these
  are genuinely single-workspace integrations (KEEP, scoped by the integration's
  own workspace binding) or reachable cross-workspace (CONVERT) before touching.

## 8. Out of scope

- The tenancy/data model itself (profile ↔ workspace_users ↔ workspaces, per-
  workspace RBAC) — unchanged and correct.
- Organization-level grouping semantics beyond what
  `callerWorkspaceMemberships()` already provides.
- The `overlord_active_workspace` cookie mechanism — it stays; only its
  *authority over correctness* is removed.

## 9. Definition of done

1. Launch config (pre-command + flags) applies to a mission run from a secondary
   workspace, verified by the A/B fixture (Phase 0 + Phase 3).
2. `backend/rbac.ts` permission checks require an explicit workspace; no ambient
   default remains in the correctness path.
3. `getActiveWorkspaceId()` / `WORKSPACE.*` appears only in §2.2 consumers
   (auth binding, create-default, switcher/landing) — confirmed by the audit and a
   grep gate in CI.
4. The A/B fixture covers each distinct high-risk behavior (resource-derived
   read/write, launch, storage, webhook, extension authorization, and actor
   attribution); the AST allowlist covers all converted call sites.
