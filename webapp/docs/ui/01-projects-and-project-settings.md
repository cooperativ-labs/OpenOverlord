# 01 — Projects & Project Settings

Covers the project switcher, the projects list, and the per-project settings
screen. Projects are the top-level container that maps to a git repository and one
or more local resource directories ([core domain spec](../../../cli/docs/01-core-domain-and-lifecycle.md#project)).

---

## Project switcher (topbar)

**Purpose:** make the active project always visible and switchable in one click,
since every operational route is project-scoped (`/p/:projectId/...`).

```
[ Open0 ▾ ]
 ┌─────────────────────────────┐
 │ ⌕ filter projects…          │
 │ ● Open0          12 active  │  ← current; count = tickets in execute/review
 │ ○ Billing-svc     3 active  │
 │ ○ Infra            —        │
 │ ─────────────────────────── │
 │ + New project               │
 │ ⚙ Manage projects…          │  → /settings? or projects list view
 └─────────────────────────────┘
```

- Switching rewrites the current route to the equivalent route in the target
  project when one exists (board↔board), otherwise lands on that project's board.
- Each row shows the project name and a live count of `execute`+`review` tickets
  (from the board query), plus a ⚠ marker if the project has a missing primary
  working directory.
- `+ New project` opens the **Create Project** dialog (below).

**Data:** `GET /projects` → `['projects']`. Realtime: `entity_changes` with
`entityType=project` invalidates `['projects']`; ticket count badges update from
each project's board query / change deltas.

---

## Projects list (full screen)

Reached from "Manage projects…". A denser management view of all projects.

```
Projects                                              [ + New project ]
┌────────────────────────────────────────────────────────────────────┐
│ Name        Repo / primary dir            Tickets   Default agent    │
│ Open0       ~/dev/OpenOverlord  ●primary   12 / 40   claude · opus    │
│ Billing-svc ~/dev/billing       ●primary    3 / 9    codex · gpt-…    │
│ Infra       ⚠ no linked directory           0 / 2    claude           │  ← warning row
└────────────────────────────────────────────────────────────────────┘
Each row → open project → project board; ⋯ menu → Settings, Archive.
```

- Rows surface the **primary resource directory** and a **missing-directory
  warning** (the runner cannot launch without one — links to the repair).
- `Tickets` shows open / total. `Default agent/model` previews the project launch
  defaults used by the board's quick-run.

---

## Create / edit project dialog

```
New project
┌───────────────────────────────────────────────┐
│ Name*           [ ______________________ ]     │
│ Description     [ ______________________ ]     │
│ Link directory  (•) This directory  ( ) None   │
│                 /Users/jake/dev/OpenOverlord   │  ← detected cwd of local backend
│                 [x] Mark primary               │
│ Default agent   [ claude ▾ ]  Model [ opus ▾ ] │
│ Default effort  [ high ▾ ]                      │
│ ────────────────────────────────────────────── │
│                         [ Cancel ] [ Create ]  │
└───────────────────────────────────────────────┘
```

- Maps to `POST /protocol/create-project` (+ `add-project-resource` when a
  directory is linked). Linking writes `.overlord/project.json` into the directory
  via the local backend — the UI does not write files itself.
- Directory linking is only offered when a **local backend** is present (a
  browser-only deployment cannot see the filesystem); otherwise show the directory
  section as "link from the CLI: `ovld add-cwd`".
- "Default agent/model/effort" persist to project launch defaults consumed by
  quick-run and the runner.

---

## Project Settings

**Route:** `/p/:projectId/settings`. Project-scoped configuration. Distinct from
**Instance Settings** (doc 08) which is workspace-wide.

```
Project: Open0                                           [ Archive project ]
┌─ General ───────────────────────────────────────────────────────────────┐
│ Name        [ Open0 ]            Description [ … ]                         │
│ Project ID  0571aa36-…  (read-only, copy)                                  │
└──────────────────────────────────────────────────────────────────────────┘
┌─ Resource directories ───────────────────────────────────────────────────┐
│ Path                          Target/device      Primary   State          │
│ ~/dev/OpenOverlord            this-mac           ●          ✓ linked       │
│ ~/work/OpenOverlord (mirror)  this-mac           ○ [set]    ✓ linked       │
│ ⚠ /old/path                   this-mac           ○          ✗ missing      │
│                                                  [ + Link a directory ]    │
└──────────────────────────────────────────────────────────────────────────┘
┌─ Launch defaults ────────────────────────────────────────────────────────┐
│ Default agent [ claude ▾ ]  Model [ opus ▾ ]  Effort [ high ▾ ]           │
│ These prefill the Run control and auto-advance for this project.          │
└──────────────────────────────────────────────────────────────────────────┘
┌─ Workflow / statuses ────────────────────────────────────────────────────┐
│ Status name   Type      Default   Order                                    │
│ next-up       draft     ●default  ▲▼                                       │
│ execute       execute   (exclusive)                                        │
│ review        review    (exclusive)                                        │
│ complete      complete                                                     │
│ blocked       blocked                                                      │
│ cancelled     cancelled                                                    │
│   Rename allowed; type semantics are fixed. One default, one execute,      │
│   one review per project (enforced by the contract).                       │
└──────────────────────────────────────────────────────────────────────────┘
```

### Sections

1. **General** — name, description, read-only stable project ID (copyable).
   `PATCH /projects/:id` (service-layer, returns new revision).
2. **Resource directories** — list `project_resources` for this project: path,
   execution target/device, primary flag, and **linked vs missing** state.
   Actions: link a directory (local backend, mirrors `ovld add-cwd`), set primary,
   unlink. A missing primary is highlighted because the runner refuses to launch
   without one (links to the same repair surfaced on the board and runner page).
3. **Launch defaults** — default agent / model / reasoning effort for this
   project; consumed by the Run control (doc 04) and auto-advance.
4. **Workflow / statuses** — render `project_statuses` rows. Names are renamable
   and reorderable; **status types are fixed vocabulary** and the UI enforces the
   contract invariants (exactly one default, one `execute`, one `review`). Note in
   the schema contract that statuses are kept **by workspace** — if a deployment
   scopes them per-project the UI reads them per-project but the rule set is the
   same.
5. **Danger zone** — Archive/delete project with typed confirmation. Soft-delete
   (`deleted_at`); the UI calls the service-layer archive, never a hard table
   delete. Disabled (with denial reason) for non-admins when Group 1 is installed.

---

## Realtime & data summary

| UI region | Read | Realtime trigger |
| --- | --- | --- |
| Switcher / list | `GET /projects` | `entityType=project` → invalidate `['projects']` |
| Per-project ticket counts | board query | `ticket` / `objective` deltas for that `projectId` |
| Resource directories | `GET /projects/:id` resources | `project_resource` deltas |
| Workflow statuses | project statuses | `project_status` deltas |

---

## Capability gating

- **Archive / delete** and any settings write are gated by RBAC `project:update` /
  `project:delete` when Group 1 is installed; in core-only mode the implicit user
  has full trust.
- Directory linking UI requires a local backend with filesystem access; otherwise
  show the equivalent `ovld` command.

---

## Acceptance criteria

- A user can create a project and link the current directory from the web app,
  then see it in the switcher with a primary directory set.
- A project missing a primary working directory shows a warning in the switcher,
  the projects list, and project settings, each linking to the same repair.
- Renaming a status updates the board column header live without losing objective
  ordering or ticket history.
- The contract status invariants (one default / one execute / one review) cannot
  be violated from the UI.
- Archiving a project requires explicit confirmation and performs a soft-delete via
  the service layer, never a direct table delete.
</content>
