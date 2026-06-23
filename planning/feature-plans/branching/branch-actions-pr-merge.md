# Branch Actions — "Create PR" & "Merge with [parent]"

Status: **proposed** (planning document, ticket `coo:30`)

> Builds on [worktree-branch-automation.md](worktree-branch-automation.md) (`coo:16`),
> which introduced per-ticket branches/worktrees, `tickets.active_branch`, and the
> read-only `TicketBranchDto` branch section in the ticket panel. That plan
> deliberately scoped the branch section as **read-only status plus copy
> conveniences**. This plan proposes turning it into an **action** surface.
>
> It also assumes the merge-status correction delivered under `coo:30`
> (`deriveBranchStatus` in `webapp/server/repository.ts`, statuses
> `pending | created | published | merged`). The buttons below gate on those
> statuses, so that fix is a prerequisite, not an afterthought.

## The question being answered

> Should the branch section show **"Create PR"** and **"Merge with [parent]"**
> buttons once a branch is active, each warning the user if an objective is
> currently executing on that branch?

Verdict: **yes, with status-based gating and a real cross-component design** —
this is not a webapp-only change. The rest of this document specifies what that
costs and recommends a phased delivery.

---

## Why this isn't a small bolt-on

`TicketBranchDto` is, by contract (REST API Layer), **read-only derived metadata**
computed from `tickets.active_branch`. "Create PR" and "Merge" are *mutations* that
run git against a real checkout and (for PRs) talk to a git host. That crosses
ownership boundaries defined in `CONTRACT.md`:

| Action | Where the work actually happens | Owning component |
| --- | --- | --- |
| **Merge with parent** | local `git merge` (or `git push`-then-server-merge) against the project's primary worktree | **Runner Layer** (it already owns branch/worktree git ops via `cli/src/branch-preparation.ts`) |
| **Create PR** | push the branch to `origin` + call the git host API (GitHub/GitLab) | **new capability** — a git-host integration that does not exist today |

The webapp must not shell out to git directly (the published CLI/runner owns local
git; see the CLI → REST and Runner → REST surfaces). So both buttons become **new
REST endpoints that delegate to the Runner Layer**, plus — for PRs — a new host
integration and credential story. All of that requires a **contract update** before
implementation (new interaction/action surface, likely a new connector/host
capability, new closed-vocabulary event types if we record merge/PR events).

---

## Status gating (depends on the coo:30 fix)

The buttons should key off the corrected branch status, not a generic "active":

| `branch.status` | Merge with parent | Push parent | Create PR | Rationale |
| --- | --- | --- | --- | --- |
| `pending` | hidden | hidden | hidden | No branch exists yet. |
| `created` | shown | hidden | **hidden** (offer "Publish" first) | Local only — there's no remote ref to open a PR against. |
| `published` | shown | hidden | shown | Pushed to `origin`; a PR can target it. |
| `merged_unpushed` | hidden | **shown** | hidden | Action A done (local parent advanced); only the push remains. |
| `merged` | hidden | hidden | hidden | Already landed and pushed; offer the new-cycle hint from the automation plan instead. |

This is why the `created`/`published` split delivered under `coo:30` matters: it is
exactly the signal that decides whether "Create PR" can work at all. "Create PR" on a
`created` branch would have to push first; v1 should instead surface a distinct
**Publish** affordance (or fold push into the PR action with explicit messaging).

---

## The "objective is executing" warning

The instinct is correct and cheap to honor. We already track execution state:

- `TicketDetailDto` exposes objective lifecycle state and live `executionRequests`;
  an executing objective is detectable client-side (the same signal the board uses
  for its "executing" affordances).

Recommended behavior: a **confirm dialog, not a hard block**. Merging or PR-ing while
an agent is mid-flight in that worktree can collide with uncommitted in-progress
work, but the user may legitimately want to proceed (e.g. the agent is stuck).

> "An objective is currently executing on this branch. Merging now may conflict with
> in-progress work in its worktree. Continue anyway?"

The server endpoint should **re-check** execution state at request time (the client
signal can be stale) and return a typed, surfaceable error (e.g.
`BRANCH_BUSY_EXECUTING`) when it wants to refuse, mirroring the existing
`STATUS_UNAVAILABLE_FOR_WORKSPACE` pattern — so the warning is enforced server-side,
not just in the UI.

Additional server-side guards before a merge:
- Refuse (or warn) when the worktree is **dirty** (`isDirtyWorktree`, already used in
  `cli/src/branch-preparation.ts`) before starting Action A.
- Surface **merge conflicts** as a typed result. Per the decided flow (below),
  conflicts arise only when merging the parent *into the branch worktree*, and are
  intentionally **left in place** for the user to resolve in their IDE — not aborted
  and not resolved server-side.

---

## Related defect to fix alongside: runner merge-detection shares the old bug

The `coo:30` fix corrected merge detection **only in the webapp display path**
(`webapp/server/repository.ts`). The **Runner Layer still uses the old
`git branch --merged <base>` logic** to decide branch reuse vs. starting a new
numeric cycle:

- `cli/src/branch-preparation.ts:94` collects `git branch --merged <base>` into
  `refs.merged`.
- `cli/src/branch-planning.ts:177` treats the recorded branch as merged when
  `mergedRefs.has(recorded)`.

Because `git branch --merged <base>` lists any branch whose tip is reachable from the
base, a freshly created branch (tip identical to `main`, no commits) is reported
merged here too. The practical symptom: the **next launch on a brand-new,
never-committed branch could start an unnecessary `…-2` cycle** instead of reusing it.

This matters for the merge buttons because "Merge with parent" and the automation's
cycle logic must agree on what "merged" means. **Recommendation:** before/with this
feature, align the runner's detection with the webapp's corrected rule (require
divergence from base: different tip SHA **and** `rev-list --count <base>..<branch> ===
0`).

> Constraint: the branch-planning algorithm is a **shared deterministic algorithm**
> pinned to `contract/branch-planning-vectors.json` and duplicated across
> `cli/src/branch-planning.ts` and `webapp/server/branch-planning.ts` (see CONTRACT.md
> "Shared Deterministic Algorithms"). Note that *merge detection* currently lives
> outside the pinned planner (the runner passes `refs.merged` in; the webapp computes
> status separately in `repository.ts`). Any change that moves merge logic into the
> planner, or changes the planner's inputs/outputs, MUST update **both** copies,
> regenerate the fixture, and bump the contract version.

---

## Merge-with-parent flow (decided)

> **Decision (Q1):** worktree-first. The branch is brought up to date with its
> parent *inside its own worktree* so the human resolves any conflicts there with
> their full IDE tooling — never in a detached or server-side context. Only once the
> worktree is clean does the parent advance, and that final merge can never conflict.

The action runs as three git steps, exposed to the user as **two buttons** so a
conflict pause is a natural stopping point:

**Action A — "Update from `<parent>` & merge"** (steps 1–2):
1. **Merge parent → branch, in the branch's worktree.** Fetch, then
   `git -C <branch.worktreePath> merge <parent>` (or `origin/<parent>`). This is the
   only step that can conflict. On conflict the endpoint does **not** abort the merge;
   it leaves the conflicted merge in place in the worktree and returns a typed
   `BRANCH_MERGE_CONFLICT` result naming `branch.worktreePath` and the conflicted
   paths, so the user opens that worktree in their IDE, resolves, and commits. Action
   A can then be re-run; on a clean merge it proceeds to step 2.
2. **Advance `<parent>` to the branch (always clean).** Once the branch contains the
   parent, the branch is strictly ahead of the parent, so the parent fast-forwards to
   the branch tip — `git -C <primaryRepo> merge --ff-only <branch>` (or a ref update
   when the parent is not checked out). No conflict is possible here by construction.

**Action B — "Push `<parent>`"** (step 3):
3. **Push the parent to origin** (`git -C <primaryRepo> push origin <parent>`),
   publishing the merged result.

Splitting A from B lets the user review the locally-merged parent before publishing,
and keeps the (network, credentialed) push as a separate, explicit act.

### Design notes
- **Where conflicts are resolved:** always the branch's own worktree
  (`branch.worktreePath`), where the user already has an IDE/checkout — not the
  primary repo and not a server temp clone.
- **Guards (server-side, re-checked at request time):** refuse Action A when an
  objective is executing on the branch unless the user confirms (typed
  `BRANCH_BUSY_EXECUTING`, see above); refuse step 2/Action B if the worktree still
  has an unresolved/conflicted or dirty state.
- **Status interplay:** after a successful Action A the branch reads `merged_unpushed`
  (local parent advanced via `--no-ff`, not yet pushed); after a successful Action B it
  reads `merged` (`origin/<parent>` now contains it). Both follow from the corrected
  `deriveBranchStatus` rule — see decision 4.
- **Ownership:** all three steps are local/remote git ops → **Runner Layer**, behind
  REST endpoints (e.g. `POST /api/tickets/:id/branch/integrate` for A and
  `.../branch/push-parent` for B), gated `ticket:update`. Record each as an allowed
  `ticket_events` entry (`update`/`status_change`) — no new closed vocabulary without a
  contract bump.

## Proposed phasing

**Phase 1 — Merge with parent (worktree-first, local; no external dependency).**
- Implements Actions A and B above (steps 1–3), with conflict resolution handed off to
  the user's IDE in the branch worktree and typed conflict/busy/dirty results.
- UI: buttons gated on `created`/`published`, executing-objective confirm dialog,
  conflict surfacing that links/copies `branch.worktreePath`.

**Phase 2 — Publish (push the branch to origin).**
- Surfaces on `created` branches; pushes to `origin` and flips the branch to
  `published`. Prerequisite for "Create PR".

**Phase 3 — Create PR (git-host integration).**
- New host-integration capability (GitHub first), credential storage, and a
  `POST /api/tickets/:id/branch/pull-request` endpoint returning the PR URL.
- Largest scope: external API, auth/token handling, error mapping, host
  configurability. Deserves its own contract surface and ticket.

A pragmatic **v1** is Phase 1 plus a "Copy PR-create URL/command" convenience
(zero host integration) so users get the workflow immediately while the full PR
integration is scoped separately.

---

## Contract impact summary (must precede implementation)

- New **action endpoints** on the REST API Layer that delegate to the Runner Layer →
  new interaction surface; update `CONTRACT.md` + `contract/components.yaml`.
- Possible new **git-host capability** for Phase 3 → approved-capability list update.
- Aligning runner merge-detection with the webapp rule → if it touches the pinned
  planner, regenerate `contract/branch-planning-vectors.json` and bump the version.
- No new closed `ticket_events.type` values unless we decide merge/PR deserve
  first-class event types (that would be a closed-vocabulary change → version bump).

## Decisions (resolved with the PM)

1. **Merge-with-parent strategy → worktree-first local merge.** Bring the parent into
   the branch's own worktree (user resolves conflicts there in their IDE), then advance
   the parent to the branch, then push. Split into two buttons ("Update from `<parent>`
   & merge" / "Push `<parent>`"). See *Merge-with-parent flow* above.
   - **Refinement (during `coo:30` objective 2):** step 2 advances the parent with a
     **`--no-ff` merge commit** (`git merge --no-ff <branch>`), not a fast-forward.
     It is still conflict-free by construction (the branch already contains the
     parent after step 1), but it leaves the parent tip *diverged* from the branch
     tip. That divergence is what lets `deriveBranchStatus` distinguish a genuinely
     merged branch from a freshly-cut one (a fast-forward leaves the tips identical,
     the documented `0.39-draft` edge), enabling reliable `merged_unpushed`/`merged`.
2. **PR creation → "Copy PR URL/command" is acceptable for v1.** Full GitHub PR
   integration is deferred to Phase 3 / its own ticket.
3. **Executing-objective handling → confirm-and-proceed**, enforced server-side
   (typed `BRANCH_BUSY_EXECUTING`), not a hard block.
4. **Intermediate "merged locally but unpushed" state → yes, add it.** A new derived
   `TicketBranchStatus` value `merged_unpushed` (contract `0.40-draft`) marks the gap
   between Action A (local parent advanced) and Action B (parent pushed). Implemented
   in objective 2: `deriveBranchStatus` reports `merged` when `origin/<base>` contains
   the branch and `merged_unpushed` when only the local base does; the ticket panel
   renders it as "merged · unpushed".
5. **Parent selection → project-configured default branch.** The user sets a per-project
   **default branch** in the Resources settings page (stored in `projects.settings_json`
   under `overlord.defaultBranch`, surfaced as `ProjectDto.defaultBranch`; `null` ⇒
   `main`). It is both the branch tickets are cut from and the parent that "Merge with
   parent" advances. Implemented in objective 2 (contract `0.40-draft`): the service
   layer resolves the ticket `baseBranch` from it and the Runner Layer prefers it when
   cutting branches. (Per-merge parent override is not added; the project default is the
   single source of truth.)

## Implementation status (ticket `coo:30`)

- **Objective 1 (delivered):** `deriveBranchStatus` + `created`/`published` split
  (contract `0.39-draft`).
- **Objective 2 (this work):** decisions 4 and 5 above — `merged_unpushed` status and
  the project default branch (contract `0.40-draft`) — **plus Phase 1 itself**: the
  merge/push/publish action endpoints (contract `0.41-draft`). Done.
- **Objective 3 (delivered):** branch selection + worktree lifecycle (contract
  `0.42-draft`). Adds a ticket-panel **branch selector** that pins
  `tickets.branch_override` (consumed by the Runner Layer at the next launch via the
  existing `--branch`/override path; `--branch` flag still wins), **per-objective branch
  recording** (`objectives.branch`, written by the runner at branch-prepared time and
  shown per objective), **worktree reuse** for follow-on objectives (the planner already
  reuses the recorded branch's deterministic worktree path; preparation now prunes stale
  registrations first so a purged path can be re-added), and **Settings → Worktrees**: a
  `GET /api/worktrees` list with per-row delete (`POST /api/worktrees/remove`, refuses a
  dirty worktree without `force`) and **Purge all merged** (`POST /api/worktrees/purge-merged`).
  Purge policy is **manual + auto-on-merge**: Action B (`push_parent`) auto-removes the
  merged branch's clean worktree. Two nullable DB columns (`objectives.branch`,
  `tickets.branch_override`) on both adapters.

### Execution model (resolved with the PM)

The earlier "the webapp must not shell git" framing above is **superseded for these
actions**. Overlord's worktrees live under `~/.ovld/worktrees`, which the webapp server
(running on the host) **can** access — so it operates on them **directly**. The Runner
Layer's distinct responsibility is launching the *agent* into a worktree directory so an
AgentPod adopts the folder it is started in (pods only see the folder they are launched
in — which is why the *agent* sees the worktree but a server elsewhere might not; the
host webapp is not "elsewhere"). On-demand merge/push are therefore implemented as
**host-side git ops in the REST API/service layer** (`webapp/server/repository.ts`,
`performBranchAction`) behind `POST /api/tickets/:id/branch/action`, with typed results
(`BRANCH_MERGE_CONFLICT` / `BRANCH_BUSY_EXECUTING` / `BRANCH_DIRTY` / …). No queue table
or Runner-Layer job was needed; the action is synchronous and conflicts are left in the
branch's worktree for IDE resolution. See CONTRACT.md `0.41-draft`.
