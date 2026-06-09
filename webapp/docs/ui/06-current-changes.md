# 06 — Current Changes

A **read-only** view of the linked project's local VCS state, scoped around
Overlord review units (ticket, objective, delivery) and linked to recorded change
rationales. This is the web equivalent of `ovld changes status|diff|rationales`.

**Route:** `/p/:projectId/changes?ticketId=&objectiveId=&path=` — also embedded as
the **Changes** tab on ticket detail (doc 03) scoped to that ticket/objective.

> **Hard constraint:** VCS access is strictly read-only. This screen never creates
> commits, refs, branches, stashes, checkpoints, tags, resets, checkouts, patches,
> or any other mutation, and it never uploads repository contents to the backend.
> It requires a **local backend** with a linked directory; without one it shows an
> unavailable state.

---

## Layout

A file list on the left, a diff viewer on the right, scoped by a context selector.

```
Changes · Open0      Scope: [ Ticket 1:1429 ▾ ][ Objective: Write docs ▾ ]   ⌕ path…
┌─ Changed files ──────────────┐ ┌─ Diff: webapp/docs/ui/03-ticket-detail.md ──────────┐
│ ▸ rationale-covered (4)      │ │ @@ -0,0 +1,210 @@   ✦ "Add ticket detail spec"       │
│   M src/auth/token.ts    ✓   │ │ + # 03 — Ticket Detail                               │
│   A …/ui/03-…detail.md   ✓   │ │ + The core screen of the application…               │
│   M src/auth/index.ts    ✓   │ │ …                                                   │
│ ▸ needs rationale (1)        │ │  (read-only; line numbers; hunk headers; rationale   │
│   M src/rbac/types.ts    ⚠   │ │   labels annotated inline where recorded)            │
│ ▸ unassigned / workspace (2) │ │                                                      │
│   M README.md            –   │ │                                                      │
│   ?? scratch.txt         –   │ │                                                      │
└──────────────────────────────┘ └──────────────────────────────────────────────────────┘
   Coverage: 4/5 meaningful files have rationales · [ open in Review → ]
```

---

## Scope selector

Change views are organized around Overlord review units first, the repo second:

- **Ticket** scope: all changed files associated with the ticket's sessions/objectives.
- **Objective** scope: narrow to one objective's `changed_files`.
- **Unassigned / current workspace**: local diff hunks that can't be associated with
  a specific objective are shown explicitly as workspace changes — never silently
  attached to the wrong objective.

The scope is in the URL so a deep link reproduces the exact view.

---

## File list groups

`ChangedFileRow`s grouped by review meaning, not just by directory:

| Group | Meaning | Marker |
| --- | --- | --- |
| Rationale-covered | meaningful tracked change with a `change_rationale` | ✓ + rationale label |
| Needs rationale | meaningful tracked change, no rationale yet | ⚠ (the gap delivery validates) |
| Observed earlier / no current diff | recorded earlier, gone from the working tree | "no current diff" |
| Unassigned / workspace | local change not tied to an objective | – |

Each row shows the normalized path, VCS status (`M`/`A`/`D`/`R`/`??`), the owning
objective when known, and rationale presence. Status comes from `changed_files`
(metadata only — path + status + session/objective, never file contents) joined
with live local VCS status read by the backend.

---

## Diff viewer

- `DiffView` renders the **read-only** unified diff for the selected file. Hunk
  headers are shown and, where a `change_rationale.hunks[].header` matches, the
  rationale `label` is annotated inline so the reviewer sees *why* a hunk exists.
- Diffs are read on demand from the local backend's VCS read (status/diff only).
  Full diffs and file contents are **not persisted** to the database — they're read
  live and shown, consistent with the change-tracking security boundary.
- A "open in Review" jump links the file to the Review screen's rationale coverage
  (doc 05) and vice-versa.

---

## Data + realtime

| Region | Read | Realtime |
| --- | --- | --- |
| File list + coverage | `GET /tickets/:id/changes` (`changed_files` + `change_rationales`) → `['ticket', id, 'changes']` | `changed_files`/`change_rationale` deltas update rows/coverage live during an active session |
| Diff body | local backend VCS read (status/diff), on demand | refetched when the file's `changed_files` revision changes |
| Workspace/unassigned diff | local backend VCS status | local poll; not from the change feed (it's live VCS, not a domain entity) |

While an agent is working, the persisted `changed_files` set updates through the
change feed, so the file list reflects what's changing in near-real-time; the diff
bodies are pulled from the live working tree on selection.

---

## States

- **No linked directory / no local backend:** unavailable state — "Current changes
  need a linked local directory and the local backend." Offer `ovld add-cwd` and
  explain a browser-only deployment can't read local diffs.
- **Clean working tree:** "No local changes" + the recorded `changed_files` history
  for the scope (so a delivered ticket still shows what changed).
- **Loading diff:** skeleton in the diff pane; file list loads first.
- **Large diff:** collapse-by-default with "expand"; very large files offer
  "view in editor" rather than rendering inline.
- **Coverage gap:** the "needs rationale" group is highlighted and counted; links to
  Review so a human can push back before completing.

---

## Capability gating

- Entirely depends on a **local backend** with filesystem/VCS read access; this is
  a deployment capability, not a table group. Hosted/browser-only deployments hide
  the diff panes and show the recorded `changed_files` metadata read-only.
- Read access gated by RBAC `ticket:read` when Group 1 is installed.

---

## Acceptance criteria

- The view shows changed files for a ticket/objective grouped by rationale coverage,
  with unassigned workspace changes shown separately and never misattributed.
- Diffs are read-only and annotated with recorded rationale labels and hunk headers;
  no control on this screen can mutate the repository.
- No repository contents are uploaded to the backend; diffs are read locally and
  shown, and only metadata is persisted.
- When no local directory/backend is available, the screen shows a clear unavailable
  state with the repair command instead of erroring.
- Coverage gaps (meaningful changes lacking rationales) are visible and link to the
  Review screen.
</content>
