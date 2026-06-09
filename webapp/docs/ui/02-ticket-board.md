# 02 — Ticket Board

The default landing screen and the primary way to see and move work. A
Kanban-style board grouped by ticket status, with a dense list alternative, live
filters, search, ticket creation, and a quick-run affordance.

**Route:** `/p/:projectId/board` (kanban) · `?view=list` (list) · all filter and
search state lives in search params so the view is deep-linkable.

---

## Kanban view

Columns are the project's `project_statuses`, ordered by their configured order and
colored by `status_type` (doc 00 §6.2). One card per ticket.

```
Board · Open0          [Kanban|List]  ⌕ filter…  [Status▾][Priority▾][Agent▾][Tag▾]  [+ New ticket]
┌─ next-up ────┐ ┌─ execute ───────┐ ┌─ review ─────────┐ ┌─ complete ──┐ ┌─ blocked ─┐
│ 1:1431       │ │ 1:1429 ●live     │ │ 1:1421           │ │ 1:1402      │ │ 1:1418 ⛔ │
│ Add OAuth…   │ │ Build React UI   │ │ Token rotation   │ │ Seed schema │ │ Fix race  │
│ ◷ 2 obj      │ │ 🤖 claude·opus   │ │ ✦ delivery ready │ │ ✓ 3/3 obj   │ │ ❓ ask     │
│ ▷ run        │ │ ▓▓▓░ exec 2/4    │ │ ⌫ 4 files        │ │             │ │           │
│ #backend     │ │ ◷ 6s ago         │ │ 2 artifacts      │ │             │ │           │
└──────────────┘ └──────────────────┘ └──────────────────┘ └─────────────┘ └───────────┘
        + new        (drag to move)        review →
```

### TicketCard contents

| Element | Source | Notes |
| --- | --- | --- |
| `display_id` (`1:1429`, mono) | `tickets.display_id` | copyable; click → ticket detail |
| Title | `tickets.title` | truncated, 2 lines |
| Objective progress | objectives states | "exec 2/4", "✓ 3/3", "◷ 2 obj" |
| Live agent strip | active `agent_sessions` | `🤖 agent·model` + pulsing live dot + heartbeat age while `executing` |
| Attention markers | events / requests | `❓ ask`, `⛔ failed launch`, `✦ delivery ready`, `▷ run` (quick-run) |
| Changed files | `changed_files` count | "⌫ N files" when tracked |
| Priority | `tickets.priority` | left border / `PriorityTag` (`low/normal/high/urgent`) |
| Tags (gated G5) | `ticket_tag_assignments` | `TagChip`s |

### Movement

- **Drag/drop** a card between columns issues a status change through the
  service layer (`PATCH /tickets/:id` status → mirrors a `status_change` event).
  The card moves optimistically and reconciles against the returned revision; a
  rejected move (e.g. invalid transition / RBAC denial) snaps back with the reason.
- An **explicit status menu** on each card (⋯) is the keyboard/non-drag path and
  the accessible default.
- Moving a ticket **does not** reorder its objectives or destroy session history
  (contract invariant) — the board only changes `tickets.status_id`.

---

## List view

Denser, sortable, better for review and scanning many tickets.

```
Board · Open0 · List                       [filters as above]      [+ New ticket]
ID       Title                 Status    Pri    Objectives  Agent       Updated   Files
1:1429   Build React UI        execute●  high   exec 2/4    claude·opus  6s ago    —
1:1421   Token rotation        review    normal ✓ 4/4       —            12m       4
1:1431   Add OAuth provider    next-up   high   2 draft     —            1h        —
1:1418   Fix scheduler race    blocked   urgent ❓ ask       codex        3h        2
```

- Sort by updated/created/priority/status. Columns mirror the card fields.
- Live row updates from the same change feed; the `execute●` dot pulses for active
  work and "Updated" ticks.

---

## Filters & search

A single filter bar shared by both views, all reflected in URL search params:

- **Status** (multi-select over `project_statuses`)
- **Priority** (`low/normal/high/urgent`)
- **Agent/model** (assigned/active agent)
- **Assignee** (gated G1; hidden in single-user mode)
- **Tag** (gated G5)
- **Updated** range
- **Text filter** — quick client-side filter over loaded cards; the full
  cross-workspace ranked search is the `⌘K`/`/search` surface (doc 10). When
  Group 8 (search) is absent, text filter is client-side only + exact `display_id`.

---

## Create ticket

A modal (board stays behind, deep-linkable as `?new=1`). Mirrors `ovld create` /
`POST /protocol/create`.

```
New ticket · Open0
┌──────────────────────────────────────────────────────────────┐
│ Title            [ _______________________________________ ]   │
│ First objective* [ multi-line objective / prompt text …    ]   │
│                  [                                          ]   │
│ Priority [ normal ▾ ]   Status [ next-up ▾ ]   Tags [+]        │
│ ▸ Advanced (constraints, acceptance criteria, tools, output)   │
│ ▸ Objectives (add more ordered objectives now)                 │
│ Agent [ claude ▾ ] Model [ opus ▾ ] Effort [ high ▾ ]          │
│ Auto-advance [x]                                               │
│ ────────────────────────────────────────────────────────────  │
│           [ Cancel ]  [ Create draft ]  [ Create & run ▾ ]     │
└──────────────────────────────────────────────────────────────┘
```

- **Create draft** → ticket with `draft`/`next-up` status, objective in `draft`
  (`POST /protocol/create`).
- **Create & run** → create then queue execution for the first objective
  (`POST /protocol/prompt` or create + `request-execution`); requires a runnable
  working directory or it surfaces the repair before queuing.
- **Advanced** exposes the ticket fields agents consume: `constraints_text`,
  `acceptance_criteria_text`, `available_tools_json`, `output_format_text`.
- **Objectives** lets the user add multiple ordered objectives up front (one ticket,
  several agent passes) — the canonical "ticket = goal, objective = step" model.

---

## Data + realtime

| Region | Read | Realtime |
| --- | --- | --- |
| Columns/rows | `GET /tickets?projectId=&status=&…` → `['tickets', projectId, filtersHash]` | `ticket` insert/update/delete deltas → patch the affected card/row and move between columns on status change |
| Card progress / live strip | objectives + active `agent_sessions` (embedded or `['ticket', id]`) | `objective`, `agent_session`, `ticket_event` deltas |
| Attention markers | `ask`/`permission_request`/failed `execution_request`/`delivery` events | corresponding deltas; also feed the topbar ⚠ counter |
| Quick-run | `POST /protocol/request-execution` | `execution_request` + `objective` deltas reflect queued→launching→executing |

The board holds one realtime subscription scoped to the project; every delta maps
to a single card/row mutation so the board reflects agent activity with no refresh.

---

## States

- **Empty (no tickets):** `EmptyState` — "No tickets yet. Create your first
  ticket" + `CopyCommand: ovld create "<objective>"`.
- **Empty column:** subtle "Nothing in {status}".
- **Loading:** column/row skeletons matching final density.
- **Filtered-empty:** "No tickets match these filters" + clear-filters.
- **Quick-run blocked:** if no primary working directory, the `▷ run` affordance
  shows the repair (`ovld add-cwd` / link directory) instead of silently failing.

---

## Capability gating

- Assignee filter & avatars: Group 1 (else hidden).
- Tag chips & tag filter: Group 5 (else hidden).
- Ranked text search: Group 8 (else client-side filter + `display_id` lookup).
- Drag-to-move and create are gated by RBAC `ticket:update` / `ticket:create` when
  Group 1 is installed.

---

## Acceptance criteria

- The board is the post-launch landing screen and shows all of a project's tickets
  grouped by status.
- An objective transitioning `submitted → launching → executing → complete` moves
  and updates its card live, including the agent strip and heartbeat age, with no
  manual refresh.
- A ticket with a pending `ask` or a failed launch is visually flagged on its card
  and counted in the topbar attention cluster.
- Filters and the chosen view (kanban/list) survive reload via URL state.
- A user can create a ticket with one or several ordered objectives, optionally
  queue the first for execution, and the quick-run path surfaces a repair when no
  working directory is linked.
- Running the board with only core groups hides assignee, tag, and ranked-search
  affordances with no broken controls.
</content>
