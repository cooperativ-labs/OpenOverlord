# Worktree & Branch Automation — Implementation Plan

Status: **proposed** (planning document, ticket `coo:16`)

> This document replaces the two earlier branching plans
> (`02-branch-strategy-automation.md` and `03-worktree-storage-layout.md`).
> Those explored a configurable matrix — branch-per-ticket *or* per-objective,
> tunable prefixes, name patterns, in-place checkout *or* worktrees. This plan
> collapses all of that into **one default behavior** that needs no
> configuration to be useful.

## The Goal, In One Sentence

Every ticket gets its **own git branch checked out in its own git worktree**
under `~/.ovld/worktrees/`; the **first** objective launched on a ticket creates
them, **every later** objective on that ticket runs in the same worktree on the
same branch, and if that branch has **already been merged**, the next launch
starts a **fresh branch with a numeric suffix** (`-2`, `-3`, …).

```
Ticket coo:16 "Automate worktree branching"
  objective 1 launches → create branch  overlord/automate-worktree-branching-16
                         create worktree ~/.ovld/worktrees/<project>/overlord-automate-worktree-branching-16
                         agent runs there
  objective 2 launches → reuse that branch + worktree
  objective 3 launches → reuse that branch + worktree
  …branch gets merged & the ticket is re-opened for follow-up…
  objective 4 launches → branch is merged → create overlord/automate-worktree-branching-16-2
                         in a new worktree, agent runs there
```

The launched agent stays branch-unaware: it simply starts in a working
directory that is already on the right branch. The ticket panel shows the user
which branch/worktree the ticket is on.

## Why Worktrees (Not In-Place Checkout)

A single working directory can only have one branch checked out at a time, so
two tickets — or a ticket and the user's own work — would fight over `HEAD`.
`git worktree` gives each ticket branch its own physical checkout that all
share the main clone's `.git`. The runner already serializes launches per
device, but worktrees also let a human keep working in the main clone while an
agent runs, and make concurrent tickets safe.

## Where Worktrees Live

```
~/.ovld/worktrees/<project-slug>/<branch-leaf>/
```

- **Root:** `~/.ovld/worktrees`, resolved through the CLI's existing home
  helper (`resolveHome` in `cli/src/connectors.ts`, the same `~/.ovld` home used
  for connector state). `OVERLORD_HOME` keeps overriding the home; add
  `OVERLORD_WORKTREE_ROOT` for users who want worktrees on another disk.
- **Outside any synced/shared tree.** A worktree's `.git` is a *file* holding an
  absolute, machine-local `gitdir:` path back into the main clone — it is
  intrinsically per-machine and non-portable. It must never live inside the
  repo or a synced `Development` folder (sync would corrupt the pointers and
  ship platform-native `node_modules` across OSes — a failure mode this project
  has already hit). `~/.ovld` is per-user local state, which is exactly what a
  worktree is.
- **Project namespace:** `projects.slug`. Treat the directory as a *cache* —
  if a slug changes the old tree is orphaned and pruned; nothing depends on its
  stability. Disambiguate slug collisions with a short project-id suffix.
- **Branch leaf:** the sanitized branch name with `/` flattened to `-`
  (`overlord/automate-worktree-branching-16` →
  `overlord-automate-worktree-branching-16`). This keeps one flat directory per
  project and sidesteps git's `a/b` vs `a/b/c` ref/dir collision in the
  filesystem.

## Branch Naming

One pattern, no per-project configuration required:

```
overlord/<ticket-title-slug>-<ticketSeq>
```

- `overlord` — fixed prefix (a constant; a project-level override is a possible
  later add, not part of v1).
- `<ticket-title-slug>` — the ticket title, slugified.
- `<ticketSeq>` — `tickets.ticket_sequence` (the number in the `coo:16`
  display id). Included so two tickets with identical titles never collide.

Slugification of the title:

1. Lowercase; Unicode-normalize (NFKD, strip combining marks).
2. Replace any run of non-`[a-z0-9]` with `-`; trim leading/trailing `-`.
3. Truncate to 48 chars at a `-` boundary.
4. Sanitize the assembled ref: collapse `//`, strip `..`, leading `-`/`.`,
   trailing `.lock`/`.`/`/`; it must satisfy `git check-ref-format --branch`.
   An empty result falls back to `ticket-<ticketSeq>`.

**Merged → numeric suffix.** When a ticket's branch has already been merged, the
next launch must not keep adding commits to merged history; it starts a clean
cycle. The branch name gains the lowest free suffix:

```
overlord/automate-worktree-branching-16      (cycle 1)
overlord/automate-worktree-branching-16-2    (cycle 2, after cycle 1 merged)
overlord/automate-worktree-branching-16-3    (cycle 3, …)
```

The suffix is chosen by scanning existing local/remote refs for the base name
and incrementing past the highest one present, skipping any candidate that is
itself merged or currently checked out.

## How "Already Merged" Is Detected

Each launch needs to answer: *does this ticket already have a live branch I
should reuse, or do I need a fresh one?* The decision uses the ticket's own
recorded branch plus git state — no guessing from the working directory alone.

1. **Look up the ticket's current branch.** The runner reads the
   `tickets.active_branch` column (see *Branch persistence*). That is the branch
   the ticket has been operating on.
2. **`active_branch` is null** → first launch → create the canonical name →
   write it to `active_branch`. (Worktree created.)
3. **`active_branch` exists and is *not* merged** → reuse it (its worktree is
   reused / re-added if pruned). This is the "subsequent objectives continue on
   that branch" path.
4. **`active_branch` is merged** → the previous cycle shipped; pick the next
   free numeric suffix, create that branch + worktree, overwrite `active_branch`
   with the new name.

A branch counts as **merged** when either:

- it still exists and `git branch --merged <base>` (and/or
  `git branch -r --merged origin/<base>`) lists it, **or**
- it no longer exists locally or on the remote *and* `tickets.active_branch`
  still names it — i.e. it was merged and the PR-merge deleted it. (A null
  `active_branch` is the first-launch case, not a merge.)

`<base>` is the repository's default branch (`main`), discovered from
`origin/HEAD` with a `main`/`master` fallback. Merge detection is best-effort
and offline-tolerant: if the remote is unreachable, local refs decide, and the
worst case is reusing an unmerged branch (the safe default) rather than
destroying anything.

## Launch / Runner Execution

The work happens in the **runner/launch path** — on the device that owns the
checkout, after working-directory resolution and before the agent spawns — so
one implementation covers every launch source (CLI run, auto-advance, web
launch), all of which flow through `createExecutionRequest` → runner claim →
`launchAgent`.

New module `cli/src/branch-preparation.ts`:

1. `readRepoState(mainClonePath)` — current branch, dirty flag, local + remote
   branch lists, base branch, and per-ticket merge state (reuse the `runGit`
   pattern from `src/repository/git-tree.ts`).
2. Resolve the ticket's recorded branch and run the **planner** (below) to get a
   decision: `reuse`, `create`, `new_cycle` (suffixed create), or `fail`.
3. Execute with `git`:
   - create / new-cycle → `git worktree add <worktreePath> -b <branch> <base>`
   - reuse → ensure the worktree exists (`git worktree add <worktreePath> <branch>`
     if it was pruned), else use it as-is
4. Launch the agent with **`cwd = worktreePath`** instead of the main resource
   directory. The main clone stays the untouched "control" checkout that owns
   `.git`.

Call sites:

- **Runner** (`cli/src/commands.ts`, `runner` case): after
  `claimNextExecutionRequest` resolves the working directory, before
  `launchAgent`.
- **Direct launch** (`ovld launch <agent>`): same preparation, with escape
  hatches `--branch <name>` (use exactly this branch) and `--no-worktree` (run
  in place, today's behavior).

### Safety semantics (never destructive)

- No stash, reset, or forced checkout — ever. The main clone is never modified.
- A pre-existing target worktree that is **dirty or locked** fails the launch
  with a repair hint instead of being clobbered.
- A missing base branch fails with a message naming the branch and directory.
- Idempotent: re-launching an objective that is already on its branch/worktree
  is a no-op.
- Offline-friendly: `fetch` and remote checks are best-effort.

### Branch persistence (source of truth) + audit trail

**Source of truth — `tickets.active_branch` column.** A new nullable
`tickets.active_branch TEXT` column holds the branch the ticket is currently
operating on. The runner writes it whenever it creates or starts a new cycle of
a branch; reuse leaves it unchanged. This is the single queryable answer to
"which branch is this ticket on", read by both the merge-detection above and the
REST/ticket-panel surfaces below — no event scanning, no JSON probing.

> **Why a column, not a `branch_prepared` event.** `ticket_events.type` is *not*
> an open vocabulary: both engines enforce a **closed** `CHECK (type IN (...))`
> constraint (`database/{sqlite,postgres}/migrations/002_initial_core.sql`), and
> `contract/extension-points.yaml` lists the same fixed 11 values. Inserting a
> `branch_prepared` row would violate that constraint unless the enum (and the
> contract vocabulary) were also changed. A dedicated column is the smaller,
> simpler, directly-queryable choice and avoids touching the event vocabulary.

This is an **additive migration** (nullable column, default null → existing rows
unaffected) and must be applied to **both** `database/sqlite/migrations/` and
`database/postgres/migrations/`, regenerate kysely types (`database/src/types/db.ts`),
and be threaded through **both** data layers that read tickets — the REST
`webapp/server/repository.ts` and the protocol/CLI `src/service/*` — plus the
contract DTOs.

**Audit trail.** For the human-readable activity feed, record branch preparation
as an ordinary allowed-type event (`type: 'update'` or `'status_change'`) with a
summary like "Prepared branch `<name>` in worktree `<path>`" and the structured
detail in `payload_json` — no new event type required. Also stamp the resolved
branch into the execution request's `launch_flags_json` under
`branchAutomation: { branchName, worktreePath, action }` when marking it
launched, so review surfaces can show which branch a run used.

## The Planner (pure, testable)

A small pure helper — following the `automations/src/objective-manager/`
precedent (classify inputs, return a plan; caller does the side effects) — keeps
naming, slugification, suffix selection, and the create/reuse/new-cycle decision
deterministic and unit-tested, and lets the UI render the same branch-name
preview the runtime will use.

```ts
type BranchDecisionInput = {
  ticket: { title: string; sequence: number };
  project: { slug: string };
  recordedBranch: string | null;        // from tickets.active_branch
  base: string;                          // e.g. "main"
  refs: { local: string[]; remote: string[]; merged: string[] };
  worktreeRoot: string;                  // resolved absolute path, injected
};

type BranchDecision =
  | { action: 'reuse';      branch: string; worktreePath: string }
  | { action: 'create';     branch: string; worktreePath: string; from: string }
  | { action: 'new_cycle';  branch: string; worktreePath: string; from: string; cycle: number }
  | { action: 'fail';       reason: 'dirty_worktree' | 'base_missing' | 'ref_conflict'; message: string };
```

The helper performs **no** filesystem, git, or DB access — the runner injects
`refs`, `worktreeRoot`, and `recordedBranch`. Colocated tests cover slug edge
cases (emoji / very long / empty titles), suffix selection (gaps, highest-wins),
merged-vs-unmerged reuse, and ref-format sanitization. It can be registered in
`automations/src/registry.ts` for discoverability, or live as a plain exported
function the runner imports; either keeps it inside the Automations contract
boundary.

## Ticket Panel — Branch Section

Add a compact **Branch** section to `webapp/web/components/TicketPanel.tsx`,
placed in the supporting-context column alongside *Activity* / *Artifacts* /
*File Changes* (same `text-xs uppercase` section heading pattern already used
there). It is read-only status plus a couple of convenience controls — clean and
unobtrusive:

```
┌─ Branch ───────────────────────────────────┐
│  overlord/automate-worktree-branching-16  [⧉]│  ← branch name + copy
│  ● active · cut from main                    │  ← status pill + base
│  ~/.ovld/worktrees/coo/overlord-…-16      [⧉]│  ← worktree path + copy
└──────────────────────────────────────────────┘
```

- **Branch name** with a copy-to-clipboard button.
- **Status pill:** `active` (current, unmerged), `merged` (shipped — hints the
  next launch starts a new cycle), or `not created yet` (no objective has
  launched). Plus the base branch it was cut from.
- **Worktree path** with copy (so a human can `cd` there), shown truncated.
- Useful, low-risk controls to include: **copy `cd` command**, and a small
  **"copy branch"** affordance already above. Destructive controls (remove
  worktree, delete branch) are intentionally **out of scope** for v1 — surface
  the info, don't let the panel mutate git.

Data source: the section reads the ticket's current branch from the REST DTO,
which surfaces the `tickets.active_branch` column. When `active_branch` is null,
render the *predicted* name from the pure helper with a "not created yet" pill,
so the user sees what the branch will be before the first launch.

## REST / Contract

- `TicketDetailDto` gains an optional `branch` object:
  `{ name, baseBranch, worktreePath, status: 'active' | 'merged' | 'pending' }`,
  assembled in `webapp/server/repository.ts` from the `tickets.active_branch`
  column (`name`; `status: 'pending'` when null), with `baseBranch` and
  `worktreePath` derived from the name + project slug + worktree root. A precise
  `merged` badge can be computed lazily when the repo is reachable; otherwise the
  default is `active`.
- This is a **REST contract version bump** (the REST layer owns DTO shapes):
  propose the next draft version with the note "Adds derived branch/worktree
  info to the ticket detail DTO." Runner, automations, auth, connectors, MCP are
  unaffected (agents stay branch-unaware; the change is additive and read-only).
- **`contract/components.yaml`** currently lists, under the REST layer's `owns`,
  "read-only derived ticket branch metadata from branch_prepared events". With
  Option B that wording must change to "…derived from the `tickets.active_branch`
  column", to keep the contract consistent with the column-based source of truth.

## Contract Impact Summary

| Component | Change | Contract effect |
| --- | --- | --- |
| `runner` (`cli`) | Branch + worktree preparation between working-dir resolution and spawn; `--branch` / `--no-worktree` flags; writes `tickets.active_branch`; audit via allowed-type event + `launch_flags_json` | Reference-spec update to `cli/docs/04-runner-and-launch-execution.md`; runner already owns launch side effects — no version bump. |
| `automations` | Optional pure branch-decision helper (registry entry) | None — mirrors `manage-objective-lifecycle`; no domain-table or filesystem access. |
| `database` | **Additive `tickets.active_branch TEXT` column** (nullable, default null) on both SQLite + Postgres; regenerate kysely types | **Schema-contract update** (the schema contract owns table columns); additive/nullable, no data backfill. Thread through both data layers (`webapp/server/repository.ts` + `src/service/*`). |
| `rest` (`webapp`) | `TicketDetailDto.branch` (derived from the column, read-only) | **Version bump** (additive DTO field). |
| `webapp` UI | Branch section in `TicketPanel` | Consumer of the new field. |
| `connector` / `protocol` / `auth` / `mcp` | — | None. |

## Implementation Phases

Each phase ships and verifies independently.

1. **Planner core** — slug + branch-name rendering, suffix selection, the
   create/reuse/new-cycle/fail decision, colocated unit tests. No callers yet.
2. **Persistence + runner execution** — `tickets.active_branch` migration
   (SQLite + Postgres) and kysely regen; `cli/src/branch-preparation.ts`
   (repo-state read + worktree step executor) that reads/writes `active_branch`;
   wire into the runner claim path and `ovld launch`, `--branch` /
   `--no-worktree` flags, audit event, dirty/missing-base failure handling,
   tests against a temp git-repo fixture. Update
   `cli/docs/04-runner-and-launch-execution.md`.
3. **REST + ticket panel** — contract bump, `TicketDetailDto.branch` derived from
   `active_branch`, `contract/components.yaml` wording fix, the `TicketPanel`
   Branch section with copy controls and the predicted-name fallback, query-hook
   wiring.
4. **Docs & polish** — automations built-ins table, CLI help text, drift review
   across API/CLI/docs surfaces, worktree-cleanup follow-up note.

## Acceptance Criteria

- Launching the **first** objective of a ticket (e.g. coo:16
  "Automate worktree branching") from a clean main clone creates branch
  `overlord/automate-worktree-branching-16` in worktree
  `~/.ovld/worktrees/<project>/overlord-automate-worktree-branching-16`, and the
  agent session starts in that worktree on that branch.
- Launching the ticket's **second/third** objectives reuses that branch and
  worktree (`tickets.active_branch` is unchanged; audit event records
  `action: reuse`).
- After that branch is **merged** and the ticket is re-launched, a new branch
  `overlord/automate-worktree-branching-16-2` is created in its own worktree.
- A **dirty or locked** target worktree fails the launch with an actionable
  message and **no** git mutation; the main clone is never touched.
- A **missing base branch** fails with a message naming the branch and directory.
- The **ticket panel** shows the current branch name, its status (active /
  merged / not created yet), the base branch, and the worktree path, with copy
  controls.

## Out Of Scope / Follow-ups

- **Worktree cleanup.** `git worktree remove` on ticket completion and
  `git worktree prune` for orphans — worktrees consume real disk, so reclamation
  is the natural next feature, but it is not required for this goal.
- **Destructive panel controls** (remove worktree / delete branch from the UI).
- **Per-project overrides** of prefix or base branch — deferred; the single
  default behavior above is the v1 goal. (The `tickets.active_branch` column is
  **in** v1 — see *Branch persistence*.)
- **Shared dependency store** across worktrees (each worktree has its own
  `node_modules`; an agent may need to install in a fresh worktree).
