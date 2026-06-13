# Worktree Storage Layout — Design Decision

Status: **proposed** (planning document, ticket `1:1488`, objective 2)

The [branch strategy plan](02-branch-strategy-automation.md) deferred one
problem to a "future enhancement": if two objectives of the same ticket run
with `granularity: objective`, both want their own branch checked out in the
**same** working directory, and they fight over `HEAD`
(see that doc's *Shared working directory caveat*). The fix is
`git worktree` — give each agent branch its own checkout directory.

That raises the question this objective asks: **for a user whose repository
lives in, say, `~/Development/Cooperativ/OpenOverlord`, where should the
worktrees physically go?** This document answers that and shows how it folds
into the existing plan.

## TL;DR Recommendation

Store worktrees in a **central, per-user Overlord data directory, outside the
repository and outside any synced folder**, namespaced by project and branch:

```
~/.ovld/worktrees/<project-slug>/<branch-slug>/
```

- Root defaults to `~/.ovld/worktrees` (the same `~/.ovld` home the CLI already
  uses for connector state), resolved through the existing `resolveHome` helper
  so `OVERLORD_HOME` keeps overriding it.
- Add an optional `worktreeRoot` to the project's `branchAutomation` settings
  and an `OVERLORD_WORKTREE_ROOT` env override for users who want them on a
  different disk.
- **Do not** place worktrees inside the repo or as siblings within the user's
  `Development` tree.

Example: launching `overlord/add-csv-export-1488/2` for project `openoverlord`
runs the agent in
`~/.ovld/worktrees/openoverlord/overlord-add-csv-export-1488-2/`.

## Why Not Inside / Beside The Repo

Three options were considered. The decisive constraint is that **this repo (and
typically a user's whole `Development` tree) is synced across machines via
Syncthing**, and a git worktree is intrinsically a *per-machine, non-portable*
artifact.

| Option | Path | Verdict |
| --- | --- | --- |
| **A. Inside the repo** | `OpenOverlord/.overlord/worktrees/<branch>` | ❌ Synced. Also nests checkouts inside the checkout — confuses file watchers, IDE indexers, and recursive globs. |
| **B. Sibling in `Development`** | `~/Development/Cooperativ/OpenOverlord.worktrees/<branch>` | ❌ Still inside the synced share; clutters the user's project folder. |
| **C. Central Overlord home (recommended)** | `~/.ovld/worktrees/<project>/<branch>` | ✅ Outside any synced tree; matches existing `~/.ovld` convention; per-machine by nature, like the worktree itself. |

Why "synced" is disqualifying, concretely:

1. **The worktree's git link is an absolute, machine-local path.** A worktree
   contains a `.git` *file* (not a directory) reading
   `gitdir: /Users/jake/.../OpenOverlord/.git/worktrees/<name>`, and the main
   repo's `.git/worktrees/<name>/gitdir` points back at the worktree's absolute
   path. Sync those files to another machine and both pointers are wrong. Even
   the bookkeeping is non-portable — worktrees belong with per-machine state,
   not synced project data.
2. **Sync churn and native-module breakage.** Each worktree is a full checkout
   of tracked files and, after `install`, its own `node_modules`. Syncing those
   multiplies traffic and ships platform-native binaries (e.g. `better-sqlite3`)
   across OSes — a failure mode this project has already hit. Keeping worktrees
   out of the synced tree avoids it entirely.
3. **A worktree is never standalone.** It always references the main repo's
   `.git`, so it is meaningless on a machine that doesn't have *this* clone.
   That is exactly the property of per-user local state under `~/.ovld`, and not
   the property of synced project files.

Option D — an OS-conventional dir (`~/Library/Application Support/...` /
`$XDG_DATA_HOME`) — is "more correct" by platform convention but Overlord
already standardizes on `~/.ovld`; introducing a second convention adds
cross-platform branching for no real gain. Rejected for consistency.

## Layout Details

```
~/.ovld/worktrees/
  <project-slug>/                 # one dir per project; namespaces branches
    overlord-add-csv-export-1488/        # branch-per-ticket
    overlord-add-csv-export-1488-2/      # branch-per-objective (objective 2)
```

- **Project namespace.** Key on `projects.slug` (already a planned naming
  token). Treat the directory as a *cache*: if a slug changes, the old tree is
  simply orphaned and pruned — nothing depends on its stability. Where two
  projects could collide on slug, disambiguate with a short project-id suffix.
- **Branch leaf.** Reuse the sanitized name from the plan's `renderBranchName`,
  then **flatten `/` → `-`** for the directory leaf
  (`overlord/add-csv-export-1488/2` → `overlord-add-csv-export-1488-2`). This
  keeps a flat directory per project and sidesteps replicating git's
  `a/b` vs `a/b/c` ref/dir collision in the filesystem.
- **Configurable root.** `branchAutomation.worktreeRoot` (optional, defaults to
  `<home>/.ovld/worktrees` via `resolveHome`), plus `OVERLORD_WORKTREE_ROOT` for
  CI/power users. `~` expands the same way connector install paths already do.

## How It Folds Into The Branch-Strategy Plan

Small, additive changes to the [existing plan](02-branch-strategy-automation.md):

1. **Automation stays pure.** `BranchStrategyInput` gains `worktreeRoot` (the
   resolved absolute root, injected by the runner — the pure automation never
   touches the filesystem). The plan output gains a computed `worktreePath` and
   worktree-aware step kinds:
   ```ts
   | { kind: 'add_worktree'; path: string; branch: string; from: string }
   | { kind: 'reuse_worktree'; path: string }
   ```
   When worktrees are enabled, these replace the in-place `checkout` /
   `create_branch` steps.
2. **Runner executes and relocates the cwd.** In
   `cli/src/branch-preparation.ts`, instead of `git checkout` in the resource
   directory, run `git worktree add <worktreePath> -b <branch> <base>` (create)
   or reuse an existing worktree, then **launch the agent with
   `cwd = worktreePath`** instead of the resolved resource path. The primary
   `project_resource` checkout stays the untouched "control" clone that owns
   `.git`; every agent branch is isolated.
3. **The HEAD-contention caveat dissolves.** Git forbids checking out one branch
   in two worktrees, and branch-per-objective produces distinct branches → each
   gets its own worktree → concurrent launches no longer fight over `HEAD`.
   Branch-per-ticket shares one branch → one worktree → naturally serialized,
   which matches today's behavior.
4. **Safety semantics carry over.** Never destructive: a pre-existing worktree
   that is dirty or locked fails the launch with a repair hint rather than being
   clobbered. The main checkout is never modified, so the plan's
   `dirty_worktree` failure now only concerns the worktree being prepared.
5. **Lifecycle / cleanup.** `git worktree remove` on ticket completion and
   `git worktree prune` for orphans — this is the natural home for the existing
   plan's *Open Question 3 (branch cleanup)*, since worktrees, unlike branches,
   consume real disk and should be reclaimed.

## Consequences & Notes

- **Disk usage** moves out of the synced tree into one pruneable place — a
  feature given the native-module/sync concerns above, not a regression.
- **`node_modules`** are not shared between worktrees; an agent may need to
  install dependencies in a fresh worktree. A shared package store or symlink is
  a possible optimization but is out of scope here.
- **The main clone must exist locally** for `git worktree add` — already
  guaranteed, since it is the resolved working directory the runner starts from.
- **Human discoverability.** Agents are launched with an explicit cwd, so the
  central location is transparent to the automated flow; surface the resolved
  `worktreePath` in the `branch_prepared` ticket event and the settings UI so a
  human can find it.

## Contract Impact

No new impact beyond the existing plan's REST bump. `worktreeRoot` rides inside
the already-proposed `branchAutomation` settings object (no schema change), and
worktree execution lives in the runner, which already owns launch side effects.
