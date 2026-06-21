# Feature Plan: "My Tickets" Selected-Workspace View

**Ticket:** coo:41 (plan update tracked under coo:4)
**Status:** Implementation Plan
**Date:** 2026-06-19; revised 2026-06-20 (deferred cross-workspace); revised
2026-06-20 to add a dedicated aggregate-ordering persistence model; revised
2026-06-20 into an implementation-ready plan.

> **Terminology:** organization/org === workspace. Product copy may say
> "organization"; the database and webapp use `workspaces`, `workspace_id`, and
> `workspace_statuses`.

## Summary

Add a **My Tickets** board/list for the **currently selected workspace only**,
routed at `/workspace`, with a sidebar item directly below **All projects**. It
shows tickets assigned to the current operator across all projects in the active
workspace, grouped by the active workspace's `workspace_statuses`. There is no
cross-workspace status union or dedupe-by-name in v1.

My Tickets supports drag-and-drop reordering. Within-column personal reorders
must **never** write `tickets.board_position`: `board_position` is the canonical
per-project board order (indexed `(project_id, status_id, board_position)` and
shared with the project board UI), so reusing it for aggregate ordering would
silently reorder source project boards and interleave with tickets not visible
in My Tickets. Instead, aggregate ordering is persisted in a dedicated, personal
model (`my_ticket_positions`) described below. Cross-column drags are different:
they are real status changes and must follow existing ticket status-change
semantics by updating `status_id`, denormalized `status_type`, and
`board_position` for the ticket's project board while also updating the personal
position row. The database composite FK remains the integrity backstop.

## Confirmed Product Decisions

| Topic | Decision |
| --- | --- |
| Scope | Selected active workspace only. Cross-workspace behavior is deferred (but the ordering model is forward-compatible with it). |
| Route | `/workspace` for the My Tickets view; `/workspace/tickets/$ticketId` for the nested panel. |
| Ownership | Only tickets assigned to the current operator. No all-ticket mode in v1. |
| Columns | Active workspace `workspace_statuses`, grouped by `statusId`. |
| Ordering scope | **Personal** to each operator and **per status column**. Within-column order is stored in `my_ticket_positions`, not `tickets.board_position`. |
| Drag-and-drop | Enabled. Reorder within a column writes the personal model; drag to another column changes the ticket's real status and personal slot. |
| Cross-column moves | Allowed; update `status_id`, `status_type`, canonical project `board_position`, and `my_ticket_positions`. The DB composite FK rejects a status the ticket's own workspace lacks; the UI surfaces a workspace-specific alert. |
| Workspace labels | No per-card workspace label; the whole page is scoped to the selected workspace. |

## Current Architecture

- The webapp has an active-workspace singleton (`WORKSPACE`); ticket/status APIs
  are scoped to it.
- Statuses are workspace-scoped in `workspace_statuses`, keyed `(workspace_id,
  id)`. The view reuses `useWorkspaceStatuses()` and groups by `TicketDto.statusId`.
- Assignment is `tickets.assigned_workspace_user_id`. "Assigned to me" means rows
  where that equals the active actor's workspace-user id.
- Project boards own `tickets.board_position` in `(project_id, status_id)` groups
  via the `idx_tickets_project_status_board` index. This field stays owned by
  project boards.
- `tickets` carries the composite FK `FOREIGN KEY (workspace_id, status_id)
  REFERENCES workspace_statuses (workspace_id, id)`, so a status that does not
  belong to the ticket's own workspace cannot be persisted.

## Aggregate Ordering Persistence Model

Drag ordering in My Tickets is stored separately from project board order.

### New table: `my_ticket_positions`

```sql
CREATE TABLE my_ticket_positions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  workspace_user_id text NOT NULL REFERENCES workspace_users (id) ON DELETE CASCADE,
  ticket_id text NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  status_id text NOT NULL,
  position double precision NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (workspace_id, workspace_user_id, ticket_id),
  FOREIGN KEY (workspace_id, ticket_id) REFERENCES tickets (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, status_id) REFERENCES workspace_statuses (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_my_ticket_positions_user_status
  ON my_ticket_positions (workspace_id, workspace_user_id, status_id, position);
```

Design properties:

- **Personal:** keyed by `workspace_user_id`, so each operator's My Tickets order
  is independent and never affects another user or the project boards.
- **Per column:** `status_id` plus `position` order tickets within a column. A
  cross-column drag rewrites both `status_id` (here and on the ticket) and
  `position`.
- **Sparse:** a row exists only for a ticket the operator has manually dragged.
  Unpositioned tickets fall back to a deterministic default order, so the table
  stays small and no backfill is required.
- **Fractional `position`:** placing a card between neighbors averages their
  positions (`(prev + next) / 2`), giving O(1) inserts without renumbering. A
  reorder writes only the moved card. Optional lazy compaction renumbers a column
  to evenly spaced integers when fractions get too dense.
- **Hard-delete cleanup:** cascades remove stale rows on hard deletes. Tickets
  and statuses are normally soft-deleted, so reads must filter non-deleted
  tickets/statuses and ignore position rows that no longer match the ticket's
  current status.
- **Forward-compatible with cross-workspace:** because rows carry `workspace_id`,
  a later cross-workspace board can read positions across every member workspace
  and order by the personal `position` within each unioned column.

### Read-time merge

For the current actor, LEFT JOIN `tickets` to `my_ticket_positions` on
`workspace_id`, `workspace_user_id`, `ticket_id`, and
`my_ticket_positions.status_id = tickets.status_id`. The status match prevents a
position saved for an old column from applying after a ticket is moved elsewhere
through another surface. Within each status column, sort:

1. Positioned tickets first, ascending by `my_ticket_positions.position`.
2. Then unpositioned tickets by the approximate default aggregate order:
   `board_position ASC, updated_at DESC`, with a stable final tie-breaker
   (`sequence_number DESC`, else `id ASC`). `board_position` is only canonical
   within one project/status column, so ties across projects are expected.

This keeps newly assigned/never-dragged tickets visible and deterministic while
honoring any manual ordering.

### Decisions on the prior open questions

- Ordering is **personal**, not shared per workspace.
- Cross-column drags **do** change the ticket's real `status_id` (not just a view
  grouping), plus `status_type` and project-board `board_position`, subject to
  the composite FK.
- Reassigned/unassigned tickets **retain** their personal position row; if they
  return to the operator they reappear in their last manual slot. Because rows are
  sparse and cascade on hard delete, this carries negligible cost.

## Data Contract

```ts
export interface MyTicketDto extends TicketDto {
  projectName: string;
  projectColor: string | null;
  // Personal aggregate order; null when the operator has not dragged this ticket.
  myPosition: number | null;
}

export interface MyTicketsResponse {
  tickets: MyTicketDto[];
}

// Persist a personal reorder of one My Tickets status column. Mirrors
// ReorderBoardColumnBody: orderedTicketIds is every ticket the operator wants in
// `statusId`, top-to-bottom. A within-column reorder writes only the personal
// model; any listed ticket whose current status differs is a real cross-column
// status change (also updates tickets.status_id, status_type, and project-board
// board_position) and may be rejected by the (workspace_id, status_id) composite
// FK -> typed STATUS_UNAVAILABLE_FOR_WORKSPACE error.
export interface MyTicketReorderRequest {
  statusId: string;
  orderedTicketIds: string[];
}
```

Columns still come from the existing workspace status API
(`GET /api/workspace/statuses`, `useWorkspaceStatuses()`); no `MyTicketColumnDto`
is needed in v1.

**Implementation notes (resolved during execution):**

- The reorder request uses the dense `orderedTicketIds` shape (mirroring the
  project board's `ReorderBoardColumnBody`) rather than the earlier
  `before/after` fractional sketch. This was the alternative the plan review (#7)
  explicitly sanctioned: it is unambiguously correct with mixed
  positioned/unpositioned neighbours and matches the established board
  convention. Personal position rows are written densely for the moved column
  (`(index + 1) * 100`), trading the "single-row write" sparseness for
  correctness; rows remain personal, per-column, and bounded by column size.
- `assignee` was dropped from `MyTicketDto` (plan review #5): the view only
  returns tickets assigned to the operator, so the client resolves the assignee
  from `assignedWorkspaceUserId` + `useWorkspaceMembers`, exactly like the board.

## Implementation Plan

### Phase 0: contract and schema contract

1. Bump `CONTRACT.md` and `contract/components.yaml` for the additive Database
   and REST API changes.
2. Update `database/docs/09-database-schema-contract.md` with
   `my_ticket_positions` and the new REST DTO/endpoint expectations.
3. Note impact: Database gains one table/index; REST gains two workspace-scoped
   endpoints; Auth, Protocol, Runner, Connector, Automations, Extension, and
   Desktop surfaces are unchanged.

### Phase 1: database and generated types

1. Add `my_ticket_positions` to both Postgres and SQLite initial migrations.
2. Keep hard-delete cascades, but do not rely on cascades for soft-deleted tickets
   or statuses; read queries filter those out.
3. Regenerate Kysely types after migrations are updated.

### Phase 2: shared contract and repository reads

1. Add `MyTicketDto`, `MyTicketsResponse`, and `MyTicketReorderRequest` to
   `webapp/shared/contract.ts`.
2. Add `listWorkspaceMyTickets()` in `webapp/server/repository.ts`: scope to
   `WORKSPACE.id`, require `ACTOR_WORKSPACE_USER_ID`, select non-deleted tickets
   assigned to that workspace user, join non-deleted projects for name/color, and
   reuse existing `TicketDto` aggregate fields.
3. LEFT JOIN `my_ticket_positions` only when the row belongs to the actor and its
   `status_id` matches the ticket's current `status_id`; otherwise return
   `myPosition: null`.
4. Apply the read-time merge order server-side: positioned rows first by
   `myPosition`, then unpositioned rows by `board_position ASC, updated_at DESC,
   sequence_number DESC, id ASC`.
5. If the actor workspace-user id cannot be resolved, return an empty list after
   route auth succeeds; never broaden the query.

### Phase 3: reorder and cross-column mutation

1. Add `reorderWorkspaceMyTickets()` in `webapp/server/repository.ts` inside one
   transaction.
2. Validate the moved ticket belongs to the active workspace, is assigned to the
   actor, and is not deleted.
3. Validate `beforeTicketId`/`afterTicketId` are either null or visible tickets in
   the same target status column for the same actor; reject mismatched neighbors
   rather than deriving positions from unrelated rows.
4. Resolve the target `workspace_statuses` row by `statusId` and active
   `WORKSPACE.id`.
5. For within-column reorders, write only `my_ticket_positions` with a computed
   fractional `position`; do not mutate `tickets.board_position`.
6. For cross-column moves, update the ticket through canonical status-change
   semantics: `status_id = targetStatus.id`, `status_type = targetStatus.type`,
   `board_position = topBoardPosition(existing.project_id, targetStatus.id,
   ticketId)`, `updated_at`, and `revision`. Then upsert the personal position
   row for the target status.
7. Let the existing `(workspace_id, status_id)` composite FK reject invalid
   status writes. Translate the FK failure to a typed route error that the client
   can render as: "[status name] is not available for tickets in the [workspace
   name] workspace."
8. Record normal ticket change feed rows only for cross-column moves. Personal
   within-column reorders are optimistic/local and do not need a ticket-level
   realtime invalidation.

### Phase 4: REST endpoints

1. Add `GET /api/workspace/my-tickets` -> `MyTicketsResponse`, gated by
   `PERMISSIONS.TICKET_READ`.
2. Add `PATCH /api/workspace/my-tickets/order` with
   `MyTicketReorderRequest`, gated by `PERMISSIONS.TICKET_UPDATE`.
3. Return a stable typed error code for unavailable target statuses so the
   frontend does not parse database messages.

### Phase 5: client data and routes

1. Add `api.listWorkspaceMyTickets()` / `useWorkspaceMyTickets()` and
   `api.reorderWorkspaceMyTickets()` with a mutation hook.
2. Add `/workspace` and nested `/workspace/tickets/$ticketId` routes.
3. Implement `MyTicketsPage` with the board/list toggle under a dedicated storage
   key (`workspace-my-tickets`).
4. Load columns from `useWorkspaceStatuses()`, group tickets by `statusId`, and
   order each column by `myPosition` plus the same fallback order used by the
   server.
5. Cards use `projectName`, `projectColor`, optional `assignee`, and the ticket
   link; no extra workspace label. Empty state: "No tickets are assigned to you."

### Phase 6: navigation and drag-and-drop UX

1. Add the sidebar **My Tickets** item directly below **All projects**.
2. Fix sidebar active-state with pathname/location checks, not only
   `params.projectId`, so `/workspace` does not also highlight **All projects**.
3. Enable `DndContext` on the My Tickets board. On drop, send target `statusId`
   and neighbor ids, optimistically update, and roll back on error.
4. On the typed unavailable-status error, show the workspace-specific alert and
   revert the card.
5. Change `workspace-switcher.tsx` activation success navigation from `/projects`
   to `/workspace`, so switching workspaces lands on the id-free My Tickets
   surface.

## Contract And Boundary Notes

- **REST API Layer:** add `GET /api/workspace/my-tickets` and
  `PATCH /api/workspace/my-tickets/order`; add `MyTicketDto`,
  `MyTicketsResponse`, and `MyTicketReorderRequest` to `webapp/shared/contract.ts`.
- **Database Layer:** **schema change** — new `my_ticket_positions` table in both
  Postgres and SQLite migrations, plus Kysely types. No change to `tickets` or
  `workspace_statuses`. This warrants a contract version bump per the DB schema
  contract; list impact on the webapp REST layer (new endpoints) and Kysely types.
- **Auth Layer:** unchanged keys. Read gated by `TICKET_READ`, reorder by
  `TICKET_UPDATE`, scoped to the active actor's workspace-user id.
- **Realtime:** existing ticket/project/status/assignment invalidation refreshes
  cross-column moves and related ticket changes. Personal within-column reorders
  write only `my_ticket_positions`, so they rely on the mutation's optimistic
  cache update/refetch rather than global ticket invalidation.

## Test Plan

- Read returns assigned tickets from multiple projects in the selected workspace,
  and excludes unassigned tickets, tickets assigned to others, deleted tickets,
  deleted projects, and any non-active workspace.
- Returned rows include project name/color, assignee, tags, objective aggregates,
  and `myPosition`.
- Columns render from `useWorkspaceStatuses()`; tickets group by `statusId`.
- Ordering: positioned tickets sort by `myPosition`; unpositioned fall back to
  `board_position ASC, updated_at DESC` with a stable tie-breaker.
- Reorder within a column upserts `my_ticket_positions` and **never** mutates
  `tickets.board_position` (assert project board order is unchanged).
- Cross-column drag to a valid status updates `tickets.status_id` and the position
  row in one transaction, and also writes denormalized `tickets.status_type` plus
  canonical project-board `tickets.board_position`.
- Cross-column drag to a status absent from the ticket's workspace is rejected by
  the composite FK; the endpoint returns the typed error and the UI shows the
  workspace-specific alert and reverts.
- Stale-position handling: a position row whose stored `status_id` no longer
  matches the ticket's current `status_id` is ignored at read time; a row survives
  reassignment and restores the slot when the ticket returns; hard-deleting the
  ticket/user cascades the row.
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
plan is well-grounded — the composite FK `tickets (workspace_id, status_id) →
workspace_statuses (workspace_id, id)`, the `idx_tickets_project_status_board`
index, `assigned_workspace_user_id`, the `WORKSPACE`/`ACTOR_WORKSPACE_USER_ID`
singletons, and the `/projects` switcher redirect all exist as described. The
following findings drove the implementation plan above.

### High priority

1. **Cross-column move must also write `status_type` (denormalized).** Every
   existing status-change path writes `status_id` **and** `status_type`
   together (`updateTicket` repo.ts:1947-1950, `reorderBoardColumn`
   repo.ts:2182-2186, `moveTicketProjectTx` repo.ts:2008-2009). `tickets.status_type`
   is a denormalized copy of the status's `type` and gates board grouping and
   filters elsewhere. The earlier backend plan only mentioned updating
   `status_id`; the implementation must set `status_type = <new status>.type` in
   the same write or the ticket's type silently drifts.

2. **"Never write `board_position`" is too strong for cross-column moves.** A
   within-column reorder must indeed only touch `my_ticket_positions`. But a
   cross-column drag is a *real* status change, and everywhere else in the app a
   status change resets `board_position` to top-of-new-column
   (`updateTicket` repo.ts:1951-1954; `reorderBoardColumn` repo.ts:2170;
   `moveTicketProjectTx` repo.ts:2018). If the My Tickets cross-column path
   refuses to reset it, the ticket keeps a `board_position` scoped to its *old*
   column and will interleave incorrectly on the project board **and** in My
   Tickets' own unpositioned fallback (which sorts by `board_position`).
   Recommendation: scope the prohibition to within-column reorders; a
   cross-column move should set `status_id` + `status_type` +
   `board_position = topBoardPosition(project, newStatus)` (the canonical
   semantics) **and** upsert the personal position row. This does not "reorder the
   source board from an aggregate view" — the ticket genuinely changed status.

### Medium priority

3. **`ON DELETE CASCADE` "self-cleaning" is overstated.** Both `tickets` and
   `workspace_statuses` are **soft-deleted** (`deleted_at`), not hard-deleted, so
   the cascade FKs (including `(workspace_id, status_id) → workspace_statuses`)
   almost never fire in practice. Stale `my_ticket_positions` rows are harmless
   because the read query already LEFT JOINs only non-deleted tickets, but the
   "Self-cleaning … removes stale rows automatically" bullet should be softened
   to "cleaned only on **hard** delete; soft-deleted rows are filtered at read
   time." Keep the cascades (correct for hard deletes), just don't rely on them.

4. **`my_ticket_positions.status_id` can drift from the ticket's column.** The
   table stores `status_id`, duplicating `tickets.status_id`. If a ticket's
   status changes via the project board (outside My Tickets), the stored
   `status_id` goes stale. The read-time merge's join keys are unspecified — if
   it joins on `ticket_id` alone, a stale `myPosition` is applied in the *wrong*
   column. Specify the join as `(workspace_user_id, ticket_id AND
   my_ticket_positions.status_id = tickets.status_id)` so a position only applies
   when it matches the ticket's current column; otherwise `myPosition` is null and
   the ticket takes the default fallback order. This makes external status changes
   self-correcting.

### Low priority / notes

5. **`MyTicketDto.assignee` is redundant in v1.** The view only returns tickets
   assigned to the current operator, so `assignee` is always "me." Harmless and
   forward-compatible with a future all-tickets mode, but the extra join can be
   dropped for v1 if desired.

6. **Realtime claim is inaccurate for personal reorders.** A within-column
   reorder writes only `my_ticket_positions`, not `tickets`, so it emits no ticket
   change-feed row and the existing global SSE invalidation will *not* fire for it
   (acceptable — ordering is personal and updated optimistically). Cross-column
   moves do write `tickets` and will invalidate. Reword the Realtime note to scope
   the claim to ticket/status/assignment changes, not personal reorders.

7. **Two divergent reorder models now coexist.** The project board uses
   `ReorderBoardColumnBody { statusId, orderedTicketIds }` (full-column dense
   renumber); My Tickets introduces `MyTicketReorderRequest { ticketId, statusId,
   before/after }` (fractional). The fractional model gives O(1) personal inserts,
   so the divergence is justified — just flag it for maintainers, or reuse the
   `orderedTicketIds` shape against the new table to match the established
   convention.

8. **Sidebar active-state fix must key on pathname, not param presence.**
   `isProjectsActive = !params.projectId` (app-sidebar.tsx:81), so `/workspace`
   (which has no `projectId`) would also light up **All projects**. Frontend step 3
   anticipates this; specify the fix compares the router location/pathname rather
   than just param absence.

9. **Cross-project `board_position` fallback is a weak global order.**
   `board_position` is only meaningful within one `(project_id, status_id)` group,
   but a My Tickets column aggregates tickets from multiple projects. Two tickets
   from different projects can share `board_position = 100`; the
   `updated_at DESC` / `sequence_number DESC` tie-breakers then carry the order.
   This is acceptable for an un-dragged default but should be acknowledged as
   approximate, not a stable global ordering.

**Verdict:** Sound plan; the dedicated personal-ordering model correctly avoids
mutating shared `board_position` for within-column personal reorders. The
implementation plan above now incorporates the two correctness fixes
(`status_type` and cross-column `board_position`) and tightens the soft-delete and
stale-position handling.
