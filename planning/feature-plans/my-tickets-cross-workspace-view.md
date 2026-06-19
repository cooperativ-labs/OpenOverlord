# Feature Plan: "My Tickets" — cross-workspace assigned-ticket view

**Ticket:** coo:41
**Status:** Plan
**Author:** Claude (opus-4-8)
**Date:** 2026-06-19

## Summary

Add a **"My Tickets"** view that aggregates, into a single board/list, every ticket
**assigned to the current operator** across **all projects in all workspaces** they
belong to. It lives as a top-level destination in the sidebar, directly **below the
"All projects" button**, and reuses the existing board/list presentation with a
canonical-status grouping (since columns can no longer be a single project's
`project_statuses`).

### Scope decisions (confirmed with product)


| Question  | Decision                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope     | **All workspaces (literal)** — every workspace the operator is an active member of, not just the active one.                               |
| Ownership | **Assigned to me** — only tickets where the assignee resolves to the operator's identity. A `mine`-only view; no "all tickets" mode in v1. |


These two decisions are the defining constraints: the active webapp backend currently
hard-scopes every ticket/project query to a single `WORKSPACE` singleton, so the
"all workspaces" requirement is the primary engineering lift here.

---

## Current architecture — what we're working against

### 1. The backend is single-active-workspace

`webapp/server/repository.ts` resolves a process-wide `WORKSPACE` singleton (the
active workspace, reloaded on switch via `reloadActiveWorkspace()`), and every read
is bound to it:

- `listProjects()` → `WHERE workspace_id = WORKSPACE.id` (`repository.ts:588`)
- `listTickets(projectId)` → `... AND t.project_id = @project_id` with
`workspace_id = WORKSPACE.id` (`repository.ts:1394`)
- `searchTickets({ query, projectId })` → also bound to `WORKSPACE.id`
(`repository.ts:1427`)
- REST: `GET /api/projects/:id/tickets` (`index.ts:567`) and
`GET /api/tickets/search` (`index.ts:580`) are the only ticket-list surfaces; both
return active-workspace rows only.

There is **no existing read path that spans workspaces.** `listWorkspaces()`
(`workspaces.ts:199`) already returns every workspace the operator is an active
member of, so the membership data exists — but ticket/project reads never use it.

### 2. "Assignee" is a per-workspace identity

`tickets.assigned_workspace_user_id` references `workspace_users.id`, which is a
**per-workspace membership** keyed by `profile_id`. The same operator (one
`profiles.id`) has a *different* `workspace_users.id` in each workspace. So
"assigned to me across all workspaces" means:

> tickets whose `assigned_workspace_user_id` is in the **set of the operator's
> `workspace_users.id` rows across all their workspaces** (all the memberships that
> share the operator's `profile_id`).

`resolveAssignedWorkspaceUserId()` (`repository.ts`) and the actor identity
(`ACTOR_WORKSPACE_USER_ID`, `getCurrentActorIdentity()` → `repository.ts:2965`
returns `{ userId, workspaceUserId }`) currently only know the active workspace's
membership. We need the operator's `profile_id` and the full set of their
membership ids.

### 3. The operator's identity is not exposed cross-workspace to the client

`/api/meta` (`index.ts:201`) returns the active `WORKSPACE` and `needsSetup`, but
**not** the current workspace-user id or profile id. `/api/profile` returns the
profile. The client currently has no way to compute "is this ticket mine."

### 4. Board columns are per-project `project_statuses`

`BoardPage`/`TicketListView` group tickets by `statusId` into columns derived from a
single project's `useProjectStatuses(projectId)`. Different projects have different
status rows (different ids, even different sets), so **a cross-project board cannot
use `statusId` columns.** It must group by the canonical closed vocabulary
`StatusType` (`draft | execute | review | complete | blocked | cancelled`), which
`TicketDto.statusType` already carries. `STATUS_CONFIG[status.type]` (in `ui.tsx`)
already provides per-type styling/labels and is used by `TicketListView`.

### 5. Drag-to-reorder is project+status scoped

`useReorderBoardColumn` / `reorderBoardColumn` reorder within one
`(projectId, statusId)` column and renumber `board_position`. There is **no
meaningful cross-project/cross-workspace ordering**, so the My Tickets view is
**read-only with respect to ordering** (no DnD). Sort within each status group by a
fixed key (recommend `priority` then `updatedAt DESC`).

### 6. Cards are routing-coupled to a project

`TicketListCard` / `SortableTicketCard` / `TicketCard` take `projectId`,
`projectName`, `projectColor`, an `assignee`, and link to
`/projects/$projectId/tickets/$ticketId`. In the aggregate view each ticket carries
its **own** project (and workspace) — these must be supplied per-card from the
ticket's row, not from a single ambient project context.

### 7. Realtime works in our favor

`realtime.ts` streams `entity_changes` over a **global cursor with no workspace
filter**, and the client invalidates queries globally (`invalidateAll`). So a My
Tickets query will refresh on mutations in *any* workspace with no extra wiring.

---

## Design

### Data contract — a self-contained `MyTicketDto`

Because the view spans workspaces, it must not depend on the workspace-scoped
`useProjects()` / `useWorkspaceMembers()` caches (those only cover the active
workspace). Instead the new endpoint returns rows that embed everything the card
needs.

Add to `webapp/shared/contract.ts`:

```ts
export interface MyTicketDto extends TicketDto {
  /** Project the ticket belongs to (its own project, not the active one). */
  projectName: string;
  projectColor: string | null;
  /** Workspace the ticket belongs to, for grouping/labeling. */
  workspaceName: string;
  workspaceSlug: string;
  /** Resolved assignee display for the card (always the operator in v1). */
  assignee: WorkspaceMemberDto | null;
}
```

`TicketDto` already includes `workspaceId`, `projectId`, `statusType`,
`displayId`, `priority`, the objective-count aggregates, and `tags`, so the card has
its identity and badges. `displayId` already encodes the workspace slug
(`<slug>:<sequence>`), which doubles as the workspace label if we prefer not to add
`workspaceName`.

### Backend — a cross-workspace read

1. **Resolve the operator's membership set.** Add a repository helper, e.g.
  `getOperatorMembershipIds(): { profileId: string; workspaceUserIds: string[] }`,
   that takes the current actor's `profile_id` (from `getCurrentActorIdentity()` /
   the seeded actor) and selects **all** `workspace_users.id` rows for that
   `profile_id` where `status = 'active' AND deleted_at IS NULL`, joined to active
   workspaces the operator is a member of.
2. **Add `listMyTickets()`** in `repository.ts` — a query **not** bound to
  `WORKSPACE.id`. It selects tickets where
   `assigned_workspace_user_id IN (<operator membership ids>)` and the ticket is not
   soft-deleted, joins `projects` (name, color) and `workspaces` (name, slug),
   orders by `workspace`, then `priority`, then `updated_at DESC`, and maps to
   `MyTicketDto[]`. Reuse the existing `selectTicketsSql` aggregate sub-selects
   (objective counts, `has_executing_objective`, etc.) so badges match the project
   board exactly. Empty membership set → empty list (no leakage).
   **Security note:** the `IN (membership ids)` filter is inherently the operator's
   own memberships, so it cannot return tickets from workspaces the operator does
   not belong to. Keep the `TICKET_READ` permission gate on the route; the RBAC
   actor resolution is unchanged.
3. **REST endpoint.** Add `GET /api/my-tickets` →
  `handle(() => ({ tickets: listMyTickets() }), { requires: PERMISSIONS.TICKET_READ })`
   in `index.ts`. (Naming: a dedicated path rather than overloading
   `/api/tickets/search`, which is workspace-scoped and FTS-oriented.)
4. **Expose operator identity for the client** (needed so the client can label
  "mine" and future-proof a toggle). Either:
  - extend `/api/meta` with `actorProfileId` / `actorWorkspaceUserId`, or
  - rely entirely on the server-side filter (the endpoint already returns only
  mine) and skip client-side identity.
   **Recommendation:** rely on the server filter for v1 (no meta change needed);
   the endpoint *is* the "mine" definition. Revisit only if we later add an
   "all tickets" mode with a client-side mine toggle.

### Frontend

1. **API + query.**
  - `api.ts`: `listMyTickets: () => request<{ tickets: MyTicketDto[] }>('GET', '/api/my-tickets').then(r => r.tickets)`.
  - `queries.ts`: add `keys.myTickets = ['my-tickets']` and
  `useMyTickets()`. It refreshes on the global SSE feed like every other query.
2. **Route.** In `router.tsx`, add a top-level route sibling to `/projects`:
  - `myTicketsRoute` at `path: '/my-tickets'` → `MyTicketsPage`.
  - For ticket detail, add a nested `path: 'tickets/$ticketId'` under
  `myTicketsRoute` rendering the **existing** `TicketPanelRoute`
  (`pages/TicketPage.tsx`), so opening a ticket keeps the My Tickets context
  instead of jumping to the project board. `TicketPanelRoute` already loads by
  ticket id, so it is route-parent agnostic; verify it doesn't read
  `from: '/projects/$projectId'` params (if it does, make the param read
  `strict: false`).
3. **Sidebar entry.** In `app-sidebar.tsx`, add a `SidebarMenuItem` in the
  "Workspace" group **immediately after** the "All projects" item:
   `isMyTicketsActive` from `useRouterState`/pathname. Update `isProjectsActive`
   so the two don't both highlight.
4. `**MyTicketsPage`.** New page in `webapp/web/pages/`:
  - `const tickets = useMyTickets()`.
  - Build `ticketById` and group by `statusType` into the six canonical
  `StatusType` buckets (fixed order). Construct synthetic "status" objects
  `{ id: statusType, type: statusType, name: STATUS_CONFIG[type].label }` so the
  existing `TicketListStatusGroup` / `BoardColumn` presentational components can
  be reused.
  - **Board/list toggle** reusing `TicketsViewToggle` + `readStoredBoardView`/
  `storeBoardView` with a dedicated key (e.g. `'my-tickets'`).
  - **Read-only:** render columns/groups without `DndContext` (or pass
  `draggable={false}`); there is no cross-project reorder. This means a thin
  refactor or a pair of presentational wrappers — see "Reuse strategy" below.
  - Each card gets its own `projectName`/`projectColor`/`assignee` from the
  `MyTicketDto` row, and a small **workspace/project label** (e.g. `displayId`
  prefix or a project chip) so the operator can tell projects apart.
  - Empty state: "No tickets are assigned to you" with a hint.

### Reuse strategy for the presentational layer

The existing `BoardPage`/`TicketListView` bundle DnD + reorder mutations with
rendering. To avoid duplicating card markup, factor the **read-only rendering** out:

- **Preferred:** add a `draggable`/read-only path to the existing components.
`TicketListView` already accepts `draggable` and `noSensors`; extend it (or its
status-group/card children) to accept a `projectByTicket` resolver and a synthetic
status list, then drive it from both `BoardPage` (per-project) and `MyTicketsPage`
(aggregate). `BoardColumn` / `TicketListStatusGroup` / `TicketListCard` already
take `projectId/projectName/projectColor/assignee` props per render, so the main
change is sourcing those per-ticket instead of from one ambient project.
- **Fallback:** a dedicated lightweight `MyTicketsBoard` / `MyTicketsList` that
imports only the card components (`TicketListCard`, `TicketCard`) and lays out
static columns. Lower coupling risk, slight duplication.

Recommendation: start with the **fallback** (static, read-only layout reusing the
card components) to ship without destabilizing the heavily-stateful `BoardPage`, and
only generalize the shared components if a second consumer justifies it.

---

## Contract / boundary review

- **REST API Layer:** adds `GET /api/my-tickets` and the additive `MyTicketDto`
(derived from existing schema columns). Per `CONTRACT.md` maintenance table, a new
REST endpoint + additive DTO does **not** require a contract-version bump. **But**
this is the first **cross-workspace read** in the webapp backend, which deviates
from the documented single-active-workspace scoping pattern. **Action:** add a
short note to the REST API Boundary section of
`database/docs/09-database-schema-contract.md` describing the cross-workspace
"assigned to operator" read so the deviation is intentional and documented. No
closed-vocabulary, schema, or migration change.
- **Database Layer:** no schema change. `statusType` grouping uses the existing
closed `project_statuses.type` vocabulary; no new values.
- **Auth Layer:** unchanged. `TICKET_READ` gate retained; the membership-set filter
enforces that only the operator's own workspaces are visible.
- **Realtime:** no change (global feed already covers all workspaces).

Run the `component-contract` skill before implementing the REST + DTO change to
confirm no boundary violation, and update the schema-contract doc **before** landing
code per the contract's "implementation must not land before the contract update"
rule.

---

## Implementation steps (ordered)

1. **Contract doc:** add the cross-workspace read note to
  `database/docs/09-database-schema-contract.md` (REST API Boundary section).
2. **Backend repo:** `getOperatorMembershipIds()` + `listMyTickets()` in
  `repository.ts`; `MyTicketDto` in `contract.ts`.
3. **Backend route:** `GET /api/my-tickets` in `index.ts` with `TICKET_READ`.
4. **Backend tests:** node:test coverage — assigned-to-me across ≥2 workspaces,
  excludes others' tickets, excludes soft-deleted, empty membership → empty,
   correct project/workspace enrichment. (Use the existing
   `test-helpers.ts`/bsq-redirect harness.)
5. **Client api + query:** `api.listMyTickets`, `useMyTickets`, `keys.myTickets`.
6. **Route + sidebar:** `/my-tickets` (+ nested ticket panel) and the sidebar entry
  below "All projects".
7. `**MyTicketsPage`:** status-type grouping, board/list toggle, read-only layout,
  per-card project/workspace context, empty state.
8. **Verify** (jsdom + memory-history router per sandbox constraints): sidebar nav,
  grouping, card links open the ticket panel, empty state.

## Open questions / follow-ups (non-blocking)

- **Ticket panel route parenting:** confirm `TicketPanelRoute` reads its ticket id wyarn `ct: false` param reads if needed. (Tracked as a sub-task of step 6.)
- **Workspace labeling on cards:** decide between a project color chip, the
`displayId` slug prefix, or an explicit workspace name line. Recommend the
`displayId` prefix + project color dot (already rendered) for minimal surface.
- **Future "all tickets" mode / mine toggle:** out of scope for v1 (ownership =
assigned-to-me), but the endpoint/DTO shape leaves room to add an unfiltered
variant + client-side mine filter later, which would then need the operator
identity exposed via `/api/meta`.
- **Sort order within a status group:** proposed `priority` then `updatedAt DESC`;
confirm with product if a different default is wanted.

