# Feature Plan: "My Missions" Selected-Workspace View

**Mission:** coo:41 (plan update tracked under coo:4)
**Status:** Implementation Plan
**Date:** 2026-06-19; revised 2026-06-20 (deferred cross-workspace); revised
2026-06-20 to add a dedicated aggregate-ordering persistence model; revised
2026-06-20 into an implementation-ready plan.

> **Terminology:** organization/org === workspace. Product copy may say
> "organization"; the database and webapp use `workspaces`, `workspace_id`, and
> `workspace_statuses`.

## Summary

Add a **My Missions** board/list for the **currently selected workspace only**,
routed at `/workspace`, with a sidebar item directly below **All projects**. It
shows missions assigned to the current operator across all projects in the active
workspace, grouped by the active workspace's `workspace_statuses`. There is no
cross-workspace status union or dedupe-by-name in v1.

My Missions supports drag-and-drop reordering. Within-column personal reorders
must **never** write `missions.board_position`: `board_position` is the canonical
per-project board order (indexed `(project_id, status_id, board_position)` and
shared with the project board UI), so reusing it for aggregate ordering would
silently reorder source project boards and interleave with missions not visible
in My Missions. Instead, aggregate ordering is persisted in a dedicated, personal
model (`my_mission_positions`) described below. Cross-column drags are different:
they are real status changes and must follow existing mission status-change
semantics by updating `status_id`, denormalized `status_type`, and
`board_position` for the mission's project board while also updating the personal
position row. The database composite FK remains the integrity backstop.

## Confirmed Product Decisions

| Topic | Decision |
| --- | --- |
| Scope | Selected active workspace only. Cross-workspace behavior is deferred (but the ordering model is forward-compatible with it). |
| Route | `/workspace` for the My Missions view; `/workspace/missions/$missionId` for the nested panel. |
| Ownership | Only missions assigned to the current operator. No all-mission mode in v1. |
| Columns | Active workspace `workspace_statuses`, grouped by `statusId`. |
| Ordering scope | **Personal** to each operator and **per status column**. Within-column order is stored in `my_mission_positions`, not `missions.board_position`. |
| Drag-and-drop | Enabled. Reorder within a column writes the personal model; drag to another column changes the mission's real status and personal slot. |
| Cross-column moves | Allowed; update `status_id`, `status_type`, canonical project `board_position`, and `my_mission_positions`. The DB composite FK rejects a status the mission's own workspace lacks; the UI surfaces a workspace-specific alert. |
| Workspace labels | No per-card workspace label; the whole page is scoped to the selected workspace. |

## Current Architecture

- The webapp has an active-workspace singleton (`WORKSPACE`); mission/status APIs
  are scoped to it.
- Statuses are workspace-scoped in `workspace_statuses`, keyed `(workspace_id,
  id)`. The view reuses `useWorkspaceStatuses()` and groups by `MissionDto.statusId`.
- Assignment is `missions.assigned_workspace_user_id`. "Assigned to me" means rows
  where that equals the active actor's workspace-user id.
- Project boards own `missions.board_position` in `(project_id, status_id)` groups
  via the `idx_missions_project_status_board` index. This field stays owned by
  project boards.
- `missions` carries the composite FK `FOREIGN KEY (workspace_id, status_id)
  REFERENCES workspace_statuses (workspace_id, id)`, so a status that does not
  belong to the mission's own workspace cannot be persisted.

## Aggregate Ordering Persistence Model

Drag ordering in My Missions is stored separately from project board order.

### New table: `my_mission_positions`

```sql
CREATE TABLE my_mission_positions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  workspace_user_id text NOT NULL REFERENCES workspace_users (id) ON DELETE CASCADE,
  mission_id text NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  status_id text NOT NULL,
  position double precision NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (workspace_id, workspace_user_id, mission_id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES missions (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, status_id) REFERENCES workspace_statuses (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_my_mission_positions_user_status
  ON my_mission_positions (workspace_id, workspace_user_id, status_id, position);
```

Design properties:

- **Personal:** keyed by `workspace_user_id`, so each operator's My Missions order
  is independent and never affects another user or the project boards.
- **Per column:** `status_id` plus `position` order missions within a column. A
  cross-column drag rewrites both `status_id` (here and on the mission) and
  `position`.
- **Sparse:** a row exists only for a mission the operator has manually dragged.
  Unpositioned missions fall back to a deterministic default order, so the table
  stays small and no backfill is required.
- **Fractional `position`:** placing a card between neighbors averages their
  positions (`(prev + next) / 2`), giving O(1) inserts without renumbering. A
  reorder writes only the moved card. Optional lazy compaction renumbers a column
  to evenly spaced integers when fractions get too dense.
- **Hard-delete cleanup:** cascades remove stale rows on hard deletes. Missions
  and statuses are normally soft-deleted, so reads must filter non-deleted
  missions/statuses and ignore position rows that no longer match the mission's
  current status.
- **Forward-compatible with cross-workspace:** because rows carry `workspace_id`,
  a later cross-workspace board can read positions across every member workspace
  and order by the personal `position` within each unioned column.

### Read-time merge

For the current actor, LEFT JOIN `missions` to `my_mission_positions` on
`workspace_id`, `workspace_user_id`, `mission_id`, and
`my_mission_positions.status_id = missions.status_id`. The status match prevents a
position saved for an old column from applying after a mission is moved elsewhere
through another surface. Within each status column, sort:

1. Positioned missions first, ascending by `my_mission_positions.position`.
2. Then unpositioned missions by the approximate default aggregate order:
   `board_position ASC, updated_at DESC`, with a stable final tie-breaker
   (`sequence_number DESC`, else `id ASC`). `board_position` is only canonical
   within one project/status column, so ties across projects are expected.

This keeps newly assigned/never-dragged missions visible and deterministic while
honoring any manual ordering.

### Decisions on the prior open questions

- Ordering is **personal**, not shared per workspace.
- Cross-column drags **do** change the mission's real `status_id` (not just a view
  grouping), plus `status_type` and project-board `board_position`, subject to
  the composite FK.
- Reassigned/unassigned missions **retain** their personal position row; if they
  return to the operator they reappear in their last manual slot. Because rows are
  sparse and cascade on hard delete, this carries negligible cost.

## Data Contract

```ts
export interface MyMissionDto extends MissionDto {
  projectName: string;
  projectColor: string | null;
  // Personal aggregate order; null when the operator has not dragged this mission.
  myPosition: number | null;
}

export interface MyMissionsResponse {
  missions: MyMissionDto[];
}

// Persist a personal reorder of one My Missions status column. Mirrors
// ReorderBoardColumnBody: orderedMissionIds is every mission the operator wants in
// `statusId`, top-to-bottom. A within-column reorder writes only the personal
// model; any listed mission whose current status differs is a real cross-column
// status change (also updates missions.status_id, status_type, and project-board
// board_position) and may be rejected by the (workspace_id, status_id) composite
// FK -> typed STATUS_UNAVAILABLE_FOR_WORKSPACE error.
export interface MyMissionReorderRequest {
  statusId: string;
  orderedMissionIds: string[];
}
```

Columns still come from the existing workspace status API
(`GET /api/workspace/statuses`, `useWorkspaceStatuses()`); no `MyMissionColumnDto`
is needed in v1.

**Implementation notes (resolved during execution):**

- The reorder request uses the dense `orderedMissionIds` shape (mirroring the
  project board's `ReorderBoardColumnBody`) rather than the earlier
  `before/after` fractional sketch. This was the alternative the plan review (#7)
  explicitly sanctioned: it is unambiguously correct with mixed
  positioned/unpositioned neighbours and matches the established board
  convention. Personal position rows are written densely for the moved column
  (`(index + 1) * 100`), trading the "single-row write" sparseness for
  correctness; rows remain personal, per-column, and bounded by column size.
- `assignee` was dropped from `MyMissionDto` (plan review #5): the view only
  returns missions assigned to the operator, so the client resolves the assignee
  from `assignedWorkspaceUserId` + `useWorkspaceMembers`, exactly like the board.

## Implementation Plan

### Phase 0: contract and schema contract

1. Bump `CONTRACT.md` and `contract/components.yaml` for the additive Database
   and REST API changes.
2. Update `database/docs/09-database-schema-contract.md` with
   `my_mission_positions` and the new REST DTO/endpoint expectations.
3. Note impact: Database gains one table/index; REST gains two workspace-scoped
   endpoints; Auth, Protocol, Runner, Connector, Automations, Extension, and
   Desktop surfaces are unchanged.

### Phase 1: database and generated types

1. Add `my_mission_positions` to both Postgres and SQLite initial migrations.
2. Keep hard-delete cascades, but do not rely on cascades for soft-deleted missions
   or statuses; read queries filter those out.
3. Regenerate Kysely types after migrations are updated.

### Phase 2: shared contract and repository reads

1. Add `MyMissionDto`, `MyMissionsResponse`, and `MyMissionReorderRequest` to
   `webapp/shared/contract.ts`.
2. Add `listWorkspaceMyMissions()` in `webapp/server/repository.ts`: scope to
   `WORKSPACE.id`, require `ACTOR_WORKSPACE_USER_ID`, select non-deleted missions
   assigned to that workspace user, join non-deleted projects for name/color, and
   reuse existing `MissionDto` aggregate fields.
3. LEFT JOIN `my_mission_positions` only when the row belongs to the actor and its
   `status_id` matches the mission's current `status_id`; otherwise return
   `myPosition: null`.
4. Apply the read-time merge order server-side: positioned rows first by
   `myPosition`, then unpositioned rows by `board_position ASC, updated_at DESC,
   sequence_number DESC, id ASC`.
5. If the actor workspace-user id cannot be resolved, return an empty list after
   route auth succeeds; never broaden the query.

### Phase 3: reorder and cross-column mutation

1. Add `reorderWorkspaceMyMissions()` in `webapp/server/repository.ts` inside one
   transaction.
2. Validate the moved mission belongs to the active workspace, is assigned to the
   actor, and is not deleted.
3. Validate `beforeMissionId`/`afterMissionId` are either null or visible missions in
   the same target status column for the same actor; reject mismatched neighbors
   rather than deriving positions from unrelated rows.
4. Resolve the target `workspace_statuses` row by `statusId` and active
   `WORKSPACE.id`.
5. For within-column reorders, write only `my_mission_positions` with a computed
   fractional `position`; do not mutate `missions.board_position`.
6. For cross-column moves, update the mission through canonical status-change
   semantics: `status_id = targetStatus.id`, `status_type = targetStatus.type`,
   `board_position = topBoardPosition(existing.project_id, targetStatus.id,
   missionId)`, `updated_at`, and `revision`. Then upsert the personal position
   row for the target status.
7. Let the existing `(workspace_id, status_id)` composite FK reject invalid
   status writes. Translate the FK failure to a typed route error that the client
   can render as: "[status name] is not available for missions in the [workspace
   name] workspace."
8. Record normal mission change feed rows only for cross-column moves. Personal
   within-column reorders are optimistic/local and do not need a mission-level
   realtime invalidation.

### Phase 4: REST endpoints

1. Add `GET /api/workspace/my-missions` -> `MyMissionsResponse`, gated by
   `PERMISSIONS.MISSION_READ`.
2. Add `PATCH /api/workspace/my-missions/order` with
   `MyMissionReorderRequest`, gated by `PERMISSIONS.MISSION_UPDATE`.
3. Return a stable typed error code for unavailable target statuses so the
   frontend does not parse database messages.

### Phase 5: client data and routes

1. Add `api.listWorkspaceMyMissions()` / `useWorkspaceMyMissions()` and
   `api.reorderWorkspaceMyMissions()` with a mutation hook.
2. Add `/workspace` and nested `/workspace/missions/$missionId` routes.
3. Implement `MyMissionsPage` with the board/list toggle under a dedicated storage
   key (`workspace-my-missions`).
4. Load columns from `useWorkspaceStatuses()`, group missions by `statusId`, and
   order each column by `myPosition` plus the same fallback order used by the
   server.
5. Cards use `projectName`, `projectColor`, optional `assignee`, and the mission
   link; no extra workspace label. Empty state: "No missions are assigned to you."

### Phase 6: navigation and drag-and-drop UX

1. Add the sidebar **My Missions** item directly below **All projects**.
2. Fix sidebar active-state with pathname/location checks, not only
   `params.projectId`, so `/workspace` does not also highlight **All projects**.
3. Enable `DndContext` on the My Missions board. On drop, send target `statusId`
   and neighbor ids, optimistically update, and roll back on error.
4. On the typed unavailable-status error, show the workspace-specific alert and
   revert the card.
5. Change `workspace-switcher.tsx` activation success navigation from `/projects`
   to `/workspace`, so switching workspaces lands on the id-free My Missions
   surface.

## Contract And Boundary Notes

- **REST API Layer:** add `GET /api/workspace/my-missions` and
  `PATCH /api/workspace/my-missions/order`; add `MyMissionDto`,
  `MyMissionsResponse`, and `MyMissionReorderRequest` to `webapp/shared/contract.ts`.
- **Database Layer:** **schema change** — new `my_mission_positions` table in both
  Postgres and SQLite migrations, plus Kysely types. No change to `missions` or
  `workspace_statuses`. This warrants a contract version bump per the DB schema
  contract; list impact on the webapp REST layer (new endpoints) and Kysely types.
- **Auth Layer:** unchanged keys. Read gated by `MISSION_READ`, reorder by
  `MISSION_UPDATE`, scoped to the active actor's workspace-user id.
- **Realtime:** existing mission/project/status/assignment invalidation refreshes
  cross-column moves and related mission changes. Personal within-column reorders
  write only `my_mission_positions`, so they rely on the mutation's optimistic
  cache update/refetch rather than global mission invalidation.

## Test Plan

- Read returns assigned missions from multiple projects in the selected workspace,
  and excludes unassigned missions, missions assigned to others, deleted missions,
  deleted projects, and any non-active workspace.
- Returned rows include project name/color, assignee, tags, objective aggregates,
  and `myPosition`.
- Columns render from `useWorkspaceStatuses()`; missions group by `statusId`.
- Ordering: positioned missions sort by `myPosition`; unpositioned fall back to
  `board_position ASC, updated_at DESC` with a stable tie-breaker.
- Reorder within a column upserts `my_mission_positions` and **never** mutates
  `missions.board_position` (assert project board order is unchanged).
- Cross-column drag to a valid status updates `missions.status_id` and the position
  row in one transaction, and also writes denormalized `missions.status_type` plus
  canonical project-board `missions.board_position`.
- Cross-column drag to a status absent from the mission's workspace is rejected by
  the composite FK; the endpoint returns the typed error and the UI shows the
  workspace-specific alert and reverts.
- Stale-position handling: a position row whose stored `status_id` no longer
  matches the mission's current `status_id` is ignored at read time; a row survives
  reassignment and restores the slot when the mission returns; hard-deleting the
  mission/user cascades the row.
- Sidebar nav, routes, panel, board/list toggle, and empty state pass under the
  existing web test harness.
- The workspace switcher redirects to `/workspace` (not `/projects`) after
  activating a different workspace, from any starting route.

## Execution Checklist

1. Contract/schema-contract updates.
2. Database migrations and generated DB types.
3. Shared DTOs and backend read path with tests.
4. Reorder/cross-column mutation and REST endpoints with tests.
5. Client API, query, mutation, route, sidebar, and switcher updates.
6. DnD board/list UI and unavailable-status alert behavior.
7. Targeted backend/frontend checks, plus contract/schema review.

## Plan Review (2026-06-20)

Reviewed against the live schema (`database/postgres/migrations/002_initial_core.sql`),
`webapp/server/repository.ts`, `webapp/shared/contract.ts`, and the frontend
(`workspace-switcher.tsx`, `app-sidebar.tsx`, `router.tsx`, `BoardPage.tsx`). The
plan is well-grounded — the composite FK `missions (workspace_id, status_id) →
workspace_statuses (workspace_id, id)`, the `idx_missions_project_status_board`
index, `assigned_workspace_user_id`, the `WORKSPACE`/`ACTOR_WORKSPACE_USER_ID`
singletons, and the `/projects` switcher redirect all exist as described. The
following findings drove the implementation plan above.

### High priority

1. **Cross-column move must also write `status_type` (denormalized).** Every
   existing status-change path writes `status_id` **and** `status_type`
   together (`updateMission` repo.ts:1947-1950, `reorderBoardColumn`
   repo.ts:2182-2186, `moveMissionProjectTx` repo.ts:2008-2009). `missions.status_type`
   is a denormalized copy of the status's `type` and gates board grouping and
   filters elsewhere. The earlier backend plan only mentioned updating
   `status_id`; the implementation must set `status_type = <new status>.type` in
   the same write or the mission's type silently drifts.

2. **"Never write `board_position`" is too strong for cross-column moves.** A
   within-column reorder must indeed only touch `my_mission_positions`. But a
   cross-column drag is a *real* status change, and everywhere else in the app a
   status change resets `board_position` to top-of-new-column
   (`updateMission` repo.ts:1951-1954; `reorderBoardColumn` repo.ts:2170;
   `moveMissionProjectTx` repo.ts:2018). If the My Missions cross-column path
   refuses to reset it, the mission keeps a `board_position` scoped to its *old*
   column and will interleave incorrectly on the project board **and** in My
   Missions' own unpositioned fallback (which sorts by `board_position`).
   Recommendation: scope the prohibition to within-column reorders; a
   cross-column move should set `status_id` + `status_type` +
   `board_position = topBoardPosition(project, newStatus)` (the canonical
   semantics) **and** upsert the personal position row. This does not "reorder the
   source board from an aggregate view" — the mission genuinely changed status.

### Medium priority

3. **`ON DELETE CASCADE` "self-cleaning" is overstated.** Both `missions` and
   `workspace_statuses` are **soft-deleted** (`deleted_at`), not hard-deleted, so
   the cascade FKs (including `(workspace_id, status_id) → workspace_statuses`)
   almost never fire in practice. Stale `my_mission_positions` rows are harmless
   because the read query already LEFT JOINs only non-deleted missions, but the
   "Self-cleaning … removes stale rows automatically" bullet should be softened
   to "cleaned only on **hard** delete; soft-deleted rows are filtered at read
   time." Keep the cascades (correct for hard deletes), just don't rely on them.

4. **`my_mission_positions.status_id` can drift from the mission's column.** The
   table stores `status_id`, duplicating `missions.status_id`. If a mission's
   status changes via the project board (outside My Missions), the stored
   `status_id` goes stale. The read-time merge's join keys are unspecified — if
   it joins on `mission_id` alone, a stale `myPosition` is applied in the *wrong*
   column. Specify the join as `(workspace_user_id, mission_id AND
   my_mission_positions.status_id = missions.status_id)` so a position only applies
   when it matches the mission's current column; otherwise `myPosition` is null and
   the mission takes the default fallback order. This makes external status changes
   self-correcting.

### Low priority / notes

5. **`MyMissionDto.assignee` is redundant in v1.** The view only returns missions
   assigned to the current operator, so `assignee` is always "me." Harmless and
   forward-compatible with a future all-missions mode, but the extra join can be
   dropped for v1 if desired.

6. **Realtime claim is inaccurate for personal reorders.** A within-column
   reorder writes only `my_mission_positions`, not `missions`, so it emits no mission
   change-feed row and the existing global SSE invalidation will *not* fire for it
   (acceptable — ordering is personal and updated optimistically). Cross-column
   moves do write `missions` and will invalidate. Reword the Realtime note to scope
   the claim to mission/status/assignment changes, not personal reorders.

7. **Two divergent reorder models now coexist.** The project board uses
   `ReorderBoardColumnBody { statusId, orderedMissionIds }` (full-column dense
   renumber); My Missions introduces `MyMissionReorderRequest { missionId, statusId,
   before/after }` (fractional). The fractional model gives O(1) personal inserts,
   so the divergence is justified — just flag it for maintainers, or reuse the
   `orderedMissionIds` shape against the new table to match the established
   convention.

8. **Sidebar active-state fix must key on pathname, not param presence.**
   `isProjectsActive = !params.projectId` (app-sidebar.tsx:81), so `/workspace`
   (which has no `projectId`) would also light up **All projects**. Frontend step 3
   anticipates this; specify the fix compares the router location/pathname rather
   than just param absence.

9. **Cross-project `board_position` fallback is a weak global order.**
   `board_position` is only meaningful within one `(project_id, status_id)` group,
   but a My Missions column aggregates missions from multiple projects. Two missions
   from different projects can share `board_position = 100`; the
   `updated_at DESC` / `sequence_number DESC` tie-breakers then carry the order.
   This is acceptable for an un-dragged default but should be acknowledged as
   approximate, not a stable global ordering.

**Verdict:** Sound plan; the dedicated personal-ordering model correctly avoids
mutating shared `board_position` for within-column personal reorders. The
implementation plan above now incorporates the two correctness fixes
(`status_type` and cross-column `board_position`) and tightens the soft-delete and
stale-position handling.
