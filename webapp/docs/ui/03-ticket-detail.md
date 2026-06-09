# 03 — Ticket Detail

The core screen of the application. A ticket is the durable goal and review
record; this page is where humans plan objectives, watch agents execute them live,
and read the accumulating shared context and history. It is the web equivalent of
`ovld ticket context`, `ovld attach`, and the activity timeline combined.

**Route:** `/p/:projectId/tickets/:ticketId` with `?tab=activity|objectives|context|artifacts|changes`.
Opens as a full route (deep-linkable, reload-safe), never a modal.

---

## Layout

A persistent header, a left objective rail, and a tabbed main panel.

```
┌─ 1:1429  Build Realtime React Web Interface ───────────────  [status: execute ●] ⋯ ┐
│ Project Open0 · priority high · target this-mac · created by jake · updated 6s ago   │
│ [ ▷ Run objective ]  [ + Add objective ]  [ Ask shown ]  [ Review → ] (when ready)   │
├──────────────────────────┬───────────────────────────────────────────────────────────┤
│ OBJECTIVES               │ [ Activity ] Objectives  Context  Artifacts  Changes        │
│                          │                                                             │
│ 1 ✓ Plan IA      complete│  ┌─ AgentSessionStrip ─────────────────────────────────┐    │
│ 2 ● Write docs  executing│  │ 🤖 claude · opus · phase execute · ◷ updated 6s ago  │    │
│   └ 🤖 live              │  │ session a1b2… · started 4m ago · [ Heartbeat fresh ] │    │
│ 3 ◷ Implement     draft   │  └──────────────────────────────────────────────────────┘  │
│ 4 ◷ Tests         future  │                                                             │
│                          │  ActivityTimeline (newest first, appends live)              │
│ [ + Add objective ]      │   6s   update     "Wrote structure + 3 page docs…"          │
│                          │   2m   decision   "Use TanStack Router for tabs"            │
│ ── shared context ──     │   4m   update     "Surveyed all surfaces"                    │
│ repo.testing  vitest     │   4m   status     objective 2 → executing                   │
│ deploy.target local      │   5m   user       "focus on realtime first"                 │
│ [ + context entry ]      │   …                                                         │
└──────────────────────────┴───────────────────────────────────────────────────────────┘
```

---

## Header

| Element | Source | Notes |
| --- | --- | --- |
| `display_id` + title | `tickets.display_id`, `title` | title inline-editable (RBAC `ticket:update`) |
| Status badge | `tickets.status_type` | click → status menu (same transitions as board) |
| Meta line | project, `priority`, `execution_target_intent_json`, creator, `updated_at` | priority editable inline |
| Primary actions | — | **Run objective** (doc 04), **Add objective**, **Review →** (appears when status is `review` / a delivery exists), and contextual **Ask shown** / **Resume follow-up** |
| ⋯ menu | — | edit constraints/acceptance/tools/output, change priority, change assignee (G1), archive |

The header also hosts **attention banners** (full-width, dismiss-to-act): a
pending `ask` ("Agent is blocked: …  [Answer]"), a `permission_request`
("Agent requests tool X  [Approve]/[Deny]" — gated G4), or a failed launch
("Launch failed: no working directory  [Fix]"). These mirror the topbar counter.

---

## Objective rail (left)

Ordered list of the ticket's objectives — the heart of the planning model
(one objective = one agent pass).

```
1 ✓ Plan IA            complete      ◷ done 3m ago
2 ● Write docs         executing  🤖 claude·opus   ▓▓▓░ live
3 ◷ Implement runtime  draft       ▷ run   ⋮ reorder
4 ◷ Add tests          future      (hidden chain)
   [ + Add objective ]
```

Per `ObjectiveRow`:

- **State pill** with the objective vocabulary (`future`, `draft`, `submitted`,
  `launching`, `executing`, `pending_delivery`, `complete`) — visually distinct
  from ticket status (doc 00 §6.2).
- **Assigned agent/model/effort** (`assigned_agent`, `model`, `reasoning_effort`).
- **Live indicator** when an `agent_session` is attached (`executing`).
- **Per-objective actions:** Run (doc 04), Edit, Reorder (drag, draft/future
  only), Attach file, Approval-gate toggle (`auto_advance`).
- Selecting an objective focuses the main panel's session/activity on that
  objective and scopes the Changes tab.

### Objective editor

Inline/expanding editor for the selected objective (mirrors objective fields):

```
Objective 3 · Implement runtime                         state: draft  [ Save ]
┌──────────────────────────────────────────────────────────────────────┐
│ Title         [ Implement runtime ]                                    │
│ Instruction*  [ multi-line agent-facing instruction_text …          ] │
│ Agent [ claude ▾ ]  Model [ opus ▾ ]  Effort [ high ▾ ]  Flags [+]     │
│ Auto-advance [x]    Attachments: design.png ⌫  [ + attach ]            │
└──────────────────────────────────────────────────────────────────────┘
[ Save draft ]  [ Submit for execution ]  [ Run now ]
```

- Editing is allowed for `draft`/`future`; `executing`/`complete` objectives are
  read-only with their history. `submitted` can be unsubmitted back to `draft`.
- **Submit** → `POST /protocol/discuss-objective` (draft → submitted).
- **Add objective** → `POST /protocol/add-objectives` (appends ordered objective;
  used when work is a sequential step toward the same goal).
- **Attachments are objective-scoped** (not ticket-scoped): upload via
  `attachment-prepare-upload`/`finalize-upload`; the active objective's
  attachments are what an attached agent sees.
- **Reorder** persists `objectives.position` for draft/future objectives only.

---

## Tabs (main panel)

### Activity (default)
- `AgentSessionStrip` at top for the active/most-recent session: agent, model,
  `phase`, `delivery_state`, started time, and a **ticking heartbeat age**
  (`last_heartbeat_at`) that goes stale (amber) past threshold and offers the
  failure/clear path.
- `ActivityTimeline` renders `ticket_events` newest-first, append-only, with one
  `EventItem` renderer per type:

  | `ticket_events.type` | Rendering |
  | --- | --- |
  | `update` | progress narrative; expandable; shows linked changed-files when present |
  | `user_follow_up` | human message, verbatim, visually attributed to the user |
  | `alert` | non-blocking warning style |
  | `discussion_summary` | pinned-style conclusion |
  | `decision` | decision callout |
  | `ask` | blocking question; inline **Answer** box (posts `user_follow_up`/`decision`) |
  | `permission_request` | tool request; **Approve/Deny** (gated G4) |
  | `delivery` | delivery summary card + link to Review tab |
  | `execution_requested` | "queued for runner" with request id |
  | `awaiting_approval` | auto-advance paused; **Approve to continue** |
  | `status_change` | compact ticket/objective transition chip |

- New events **slide in** at the top with a highlight; existing events never
  reorder. A "filter events" control hides `status_change`/heartbeat noise.

### Objectives
- Full-width version of the rail with all objective fields, history per objective,
  and the completion timeline (which session delivered which objective).

### Context
- `shared_context_entries` for the ticket: key, value (string/JSON, syntax-aware),
  tags. This is the durable memory that later objectives inherit. Add/edit via
  `write-context` (`POST /protocol/write-context`); filter by key substring/tag.
  Read-only display warns against pasting secrets (per security boundaries).

### Artifacts
- Delivery artifacts grouped by `artifacts.type` (`test_results`, `next_steps`,
  `note`, `url`, `decision`, `migration`). See doc 05 for the full review surface;
  this tab is the quick inline view. Large files are objective attachments, not
  inline artifacts.

### Changes
- Embedded view of doc 06 scoped to this ticket (and selected objective): changed
  files, read-only diffs, and rationale coverage.

---

## Data + realtime

| Region | Read | Realtime delta → effect |
| --- | --- | --- |
| Header / status | `GET /tickets/:id` → `['ticket', id]` | `ticket` update → patch header |
| Objective rail | objectives in ticket payload | `objective` update → state pill / live dot |
| Session strip | active `agent_sessions` | `agent_session` update + heartbeat → strip + age |
| Activity | `GET /tickets/:id/events` → `['ticket', id, 'events']` | `ticket_event` insert → prepend `EventItem` |
| Context | `GET /tickets/:id/context` | `shared_context_entry` deltas |
| Artifacts | `GET /tickets/:id/deliveries` | `delivery`/`artifact` deltas |
| Changes | `GET /tickets/:id/changes` | `changed_files`/`change_rationale` deltas |

One realtime subscription scoped to `ticket:<id>` (a `stream_key` the change feed
supports) drives all of the above. Heartbeats update the session strip age but do
**not** create timeline rows (per the contract).

---

## Actions → protocol/REST map

| UI action | Endpoint (mirrors `ovld protocol`) |
| --- | --- |
| Edit title/priority/fields | `PATCH /tickets/:id` |
| Add objective | `POST /protocol/add-objectives` |
| Edit/reorder objective | `PATCH …/objectives/:id` |
| Submit objective | `POST /protocol/discuss-objective` |
| Run objective | `POST /protocol/request-execution` (doc 04) |
| Answer an ask | `POST /protocol/update --event-type user_follow_up`/`decision` |
| Approve/deny permission (G4) | `POST /protocol/permission-request` resolution |
| Approve auto-advance gate | resolve `awaiting_approval` → queue next (doc 04) |
| Write context | `POST /protocol/write-context` |
| Attach file to objective | `attachment-prepare-upload` → upload → `attachment-finalize-upload` |
| Move ticket status | `PATCH /tickets/:id` status |

The UI **never** advances an objective state itself; it requests the transition
and reflects the authoritative result from the change feed.

---

## States

- **Loading:** header first, then rail, then activity skeleton.
- **No objectives:** rail shows "Add the first objective" + `ovld protocol add-objectives` hint.
- **Idle (no active session):** session strip shows "No agent attached" with **Run**.
- **Blocked (ask):** header banner + the ask pinned in the timeline with an answer box.
- **Pending delivery:** objective shows `pending_delivery`; header offers **Finish
  follow-up** path; explains a follow-up delivery is needed.
- **Conflict (409):** an edit collided with a newer revision → refetch + "changed
  elsewhere, re-apply?".

---

## Capability gating

- Assignee field & actor attribution on events: Group 1 (else "you"/agent only).
- Permission-request approve/deny: Group 4 (else permission requests appear as
  read-only `alert`-style notes if surfaced at all).
- Tag editing: Group 5.
- Edits/actions gated by RBAC capabilities (`ticket:update`, `objective:submit`,
  `session:attach`, `event:create`) when Group 1 is installed.

---

## Acceptance criteria

- Opening a ticket shows its objectives in order, the active objective's live
  session, and the full activity timeline — without reading the original agent chat.
- A user can watch an executing objective update in place: new progress updates
  appear at the top of the timeline and the session heartbeat age ticks, with no
  refresh.
- A user can add, edit, reorder (draft/future), submit, and attach files to
  objectives, and each action maps to the corresponding protocol command.
- A blocking `ask` is unmistakable (header banner + pinned event) and answerable
  inline; answering records a follow-up without forcing redelivery.
- Shared context written by an earlier objective is visible and editable here and
  inherited by later objectives.
- The page never performs an objective/ticket state transition locally; it always
  reflects the change feed's authoritative result.
</content>
