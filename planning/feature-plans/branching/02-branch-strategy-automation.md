# Branch Strategy Automation — Implementation Plan

Status: **proposed** (planning document, ticket `1:1488`)

Some users want agents to do their work on a branch cut from a configured base
branch instead of whatever the working directory happens to have checked out.
They may want **one branch per ticket** or **one branch per objective**, a
selectable **base branch**, and a configurable **naming convention** such as
`[custom name]/title-of-ticket` (plus `/[objective-sequence-order-number]` when
branching per objective).

This plan describes how to implement that as an automation, where the
configuration lives, where the git work actually executes, and what each module
must change.

## Design Summary

| Question | Decision |
| --- | --- |
| Where is it configured? | **Project level** — `projects.settings_json.branchAutomation`, edited in project settings alongside resource directories. |
| What does the automation do? | A **pure, deterministic** built-in automation (`plan-branch-strategy`) that computes a branch plan (branch name, base branch, create-or-reuse action). No git, no DB, no provider calls. |
| Who executes git? | The **runner/launch path** (`cli`), on the device that owns the working directory, immediately after working-directory resolution and before spawning the agent. |
| Does it wrap the project or the ticket level? | Both, at different moments: configuration **wraps the project**; execution runs **per objective launch** (per execution request) and derives a **ticket-scoped or objective-scoped** branch name depending on the configured granularity. |

### Why this split

The objective asks whether the automation "should wrap the project or ticket
level". The natural seam in the current architecture is the **execution
request**: every agent run — manual run, auto-advance, web launch — flows
through `createExecutionRequest` → runner claim → `launchAgent`
(`src/service/execution-requests.ts`, `cli/src/commands.ts` `runner` case,
`cli/src/launch.ts`). Hooking there means:

- One implementation covers every launch source (CLI, REST, auto-advance).
- The git commands run on the machine that has the checkout (working-directory
  resolution has already happened), which matters once remote/SSH targets exist.
- Ticket-level branching falls out naturally: the first objective of a ticket
  creates the branch, subsequent objectives find it already exists and reuse it.

The automation itself stays pure, following the `manage-objective-lifecycle`
precedent (`automations/src/objective-manager/`): it classifies inputs and
returns a plan; the caller performs side effects. This keeps the Automations
Layer inside its contract boundary (no domain-table or filesystem access).

## Settings Model

Add a namespaced key to `projects.settings_json` (already defined as "Project
behavior settings" in the schema contract — no migration needed):

```jsonc
{
  "branchAutomation": {
    "enabled": false,            // default off; existing projects unaffected
    "baseBranch": "main",        // branch agents build from
    "granularity": "ticket",     // "ticket" | "objective"
    "prefix": "overlord",        // the "[custom name]" path segment; may contain "/"
    "namePattern": "{prefix}/{ticketTitle}" // optional advanced override
  }
}
```

Defaults when fields are missing: `enabled: false`, `baseBranch: "main"`,
`granularity: "ticket"`, `prefix: "overlord"`, and `namePattern` derived from
granularity (see below). A Zod schema validates the object on write (REST) and
tolerantly parses on read (unknown keys preserved, invalid values fall back to
defaults), matching how `readProjectColor` treats `settings_json` today
(`webapp/server/repository.ts`).

## Branch Naming Rules

Token vocabulary for `namePattern`:

| Token | Value | Example |
| --- | --- | --- |
| `{prefix}` | The configured custom name segment | `overlord` |
| `{ticketTitle}` | Slugified ticket title | `add-csv-export` |
| `{ticketSeq}` | `tickets.ticket_sequence` | `1488` |
| `{objectiveSeq}` | 1-based objective sequence (`objectives.position + 1`) | `2` |
| `{projectSlug}` | `projects.slug` | `openoverlord` |

Default patterns:

- Granularity `ticket`: `{prefix}/{ticketTitle}-{ticketSeq}`
  → `overlord/add-csv-export-1488`
- Granularity `objective`: `{prefix}/{ticketTitle}-{ticketSeq}/{objectiveSeq}`
  → `overlord/add-csv-export-1488/2`

Notes:

- `{ticketSeq}` is included in the defaults so two tickets titled identically
  cannot collide. The UI shows a live preview; users who want the bare
  `[custom name]/title-of-ticket` shape from the original request can remove
  the token in the advanced pattern field.
- When granularity is `objective`, `{objectiveSeq}` is **required** in the
  pattern (validation error otherwise) — without it every objective of a
  ticket would map to the same branch name.
- **Git ref-namespace constraint:** `a/b` (a branch) and `a/b/c` (a branch
  under directory `a/b`) cannot coexist in git. Because granularity is fixed
  per project, this only bites when a user switches granularity mid-ticket.
  The executor must surface git's ref-lock error verbatim with a hint
  ("a ticket-level branch with this prefix already exists; delete or rename it,
  or keep the previous granularity").

Slugification (`{ticketTitle}`, applied to any token output):

1. Lowercase; Unicode normalize (NFKD, strip combining marks).
2. Replace any run of non `[a-z0-9]` with `-`; trim leading/trailing `-`.
3. Truncate to 48 chars at a `-` boundary.
4. Sanitize the assembled ref: collapse `//`, strip `..`, leading `-`/`.`,
   trailing `.lock`/`.`/`/`, and validate with the same rules
   `git check-ref-format --branch` enforces. Empty result → fall back to
   `ticket-{ticketSeq}`.

## The Automation: `plan-branch-strategy`

New folder `automations/src/branch-strategy/` registered in
`automations/src/registry.ts` (id: `plan-branch-strategy`). Pure and
deterministic — registered for discoverability/reuse, callable directly as a
typed function by the runner (same dual surface as
`manageObjectiveLifecycleTool`).

```ts
export type BranchStrategyInput = {
  settings: BranchAutomationSettings;        // parsed from settings_json
  ticket: { title: string; sequence: number };
  objective: { position: number };
  project: { slug: string };
  repo: {
    currentBranch: string | null;            // null = detached/unknown
    isDirty: boolean;
    localBranches: string[];
    remoteBranches: string[];                 // "origin/..." names, optional
  };
};

export type BranchStrategyPlan =
  | { action: 'skip'; reason: 'disabled' | 'already_on_branch' }
  | { action: 'fail'; reason: 'dirty_worktree' | 'base_branch_missing'
        | 'invalid_pattern' | 'ref_conflict'; message: string }
  | {
      action: 'create' | 'reuse';
      branchName: string;                     // fully rendered + sanitized
      baseBranch: string;
      steps: BranchStep[];                    // ordered, declarative
    };

export type BranchStep =
  | { kind: 'fetch'; remote: 'origin' }       // best-effort, failure tolerated
  | { kind: 'checkout'; branch: string }
  | { kind: 'create_branch'; branch: string; from: string };
```

Decision rules:

- `enabled === false` → `skip/disabled`.
- Rendered branch already checked out → `skip/already_on_branch` (idempotent
  re-launch, second objective on a ticket branch).
- `repo.isDirty` and a checkout/create is required → `fail/dirty_worktree`.
  Never stash, reset, or discard.
- Branch exists locally (or only on the remote) → `reuse` with a `checkout`
  step (plus tracking checkout for remote-only).
- Otherwise → `create` from `baseBranch`; if the base exists neither locally
  nor remotely → `fail/base_branch_missing` with the repair hint.
- A would-be branch name that conflicts with an existing ref directory (the
  `a/b` vs `a/b/c` case) → `fail/ref_conflict`.

Unit tests colocated (`plan.test.ts`): token rendering, slug edge cases
(emoji/long/empty titles), granularity validation, every decision rule, and
ref-format sanitization.

## Execution: Runner/Launch Integration (`cli`)

New module `cli/src/branch-preparation.ts`:

1. `readRepoState(workingDirectory)` — `git rev-parse --abbrev-ref HEAD`,
   `git status --porcelain`, `git for-each-ref` for local/remote branch lists
   (reuse the `runGit` pattern from `src/repository/git-tree.ts`).
2. Load the project's `branchAutomation` settings via the service layer.
3. Call `planBranchStrategy(...)`.
4. Execute the returned `steps` with `execFileSync('git', ...)`; `fetch` is
   best-effort (offline OK), `checkout`/`create_branch` failures abort.

Call sites:

- **Runner** (`cli/src/commands.ts`, `runner` case): after
  `claimNextExecutionRequest` resolves `workingDirectory`, before
  `launchAgent`. A `fail` plan → `markExecutionFailed` with the plan's
  message (actionable, e.g. "Working tree at <path> has uncommitted changes;
  commit or stash before launching, or disable branch automation").
- **Direct launch** (`ovld launch <agent>`): same preparation, with flag
  overrides `--branch <name>` (use exactly this branch) and
  `--no-branch-automation` (skip).

Audit trail (no schema change):

- Append a `ticket_events` row, `type: 'branch_prepared'`, `phase: 'execute'`,
  payload `{ branchName, baseBranch, action: 'create' | 'reuse', executionRequestId }`.
  `ticket_events.type` is an open vocabulary in the schema contract.
- Record the resolved branch in the execution request's `launch_flags_json`
  under a namespaced key (`branchAutomation: { branchName, baseBranch, action }`)
  when marking it launched, so review surfaces can show which branch a run
  used. A dedicated `resolved_branch` column is a possible follow-up but
  requires a schema-contract version bump; not needed for MVP.

The launched agent needs no awareness of any of this — it simply starts in a
working directory already on the right branch. (Optionally, a later iteration
can append one line to the assembled prompt context noting the active branch
and that the agent should not switch branches.)

## Settings UI and REST (`webapp`)

The request is for base-branch selection "alongside the project resource in
project settings", so the controls join the **Resources** page
(`webapp/web/components/projects/project-settings/ResourcesPage.tsx`) as a
"Branching" section below the directory table (or a sibling nav page in
`ProjectSettingsModal` if the page gets crowded):

- **Enable toggle** — "Create agent branches off a base branch".
- **Base branch** — combobox populated from a new endpoint (below), with free
  text fallback when the backend cannot see the repo (same caveat the page
  already shows for directory linking).
- **Granularity** — radio: "One branch per ticket" / "One branch per
  objective".
- **Custom name (prefix)** — text input.
- **Advanced pattern** — optional input pre-filled with the granularity
  default, plus a **live preview** rendered with the automation's own
  `renderBranchName` helper against a sample ticket ("Add CSV export",
  seq 1488, objective 2). Sharing the helper guarantees preview === runtime.

REST changes (`webapp/server/index.ts`, `repository.ts`,
`shared/contract.ts`):

- `ProjectDto` gains `branchAutomation: BranchAutomationSettingsDto | null`
  (parsed from `settings_json`, same approach as `color`).
- `PATCH /api/projects/:id` accepts `branchAutomation`, validated by the Zod
  schema and merged into `settings_json` (extend the existing
  `mergeProjectSettingsJson` path).
- New `GET /api/projects/:id/branches` — resolves the primary local resource
  directory (as `/api/projects/:id/repository` does) and returns
  `{ branches: string[], currentBranch: string | null }` via
  `git for-each-ref refs/heads refs/remotes`. Errors mirror the repository
  endpoint (`not_git_repository`, `unreadable`). Implemented next to
  `readRepositoryTree` in `src/repository/` (e.g. `git-branches.ts`).

## Failure And Safety Semantics

- **Never destructive.** No stash, no reset, no forced checkout. Dirty
  worktree fails the launch with a repair message.
- **Idempotent.** Re-running an objective reuses the existing branch;
  re-launching while already on the target branch is a no-op.
- **Offline-friendly.** `fetch` failures are ignored; branch existence checks
  fall back to local refs.
- **Off by default.** No behavior change for existing projects until a user
  enables the setting.
- **Shared working directory caveat.** Two concurrent objective launches per
  branch-per-objective in the same directory would fight over HEAD. The
  runner already serializes launches per device (single claim loop), so this
  is acceptable for the local MVP; document it, and revisit with worktree
  support (e.g. `git worktree add`) as a future enhancement. The worktree
  approach and where worktrees should be stored are designed in
  [03 — Worktree Storage Layout](03-worktree-storage-layout.md).

## Contract Impact (CONTRACT.md)

Read against contract `0.5-draft`:

| Component | Change | Contract effect |
| --- | --- | --- |
| `automations` | New built-in `plan-branch-strategy` in the registry | **None.** The layer already owns "pluggable automation interface and built-in automation registry"; a pure planner mirrors `manage-objective-lifecycle`. Update `automations/docs/01-automations-overview.md` built-in table. |
| `database` | None (uses `projects.settings_json`, open `ticket_events.type` vocab, namespaced `launch_flags_json` key) | **None.** |
| `runner` | Launch pipeline gains a git branch-preparation step between working-directory resolution and spawn; new launch flags | **Reference-spec update** to `cli/docs/04-runner-and-launch-execution.md` (this step + flags + failure semantics). Runner ownership already covers launch execution; no version bump. |
| `rest` | `ProjectDto.branchAutomation`, `PATCH /api/projects/:id` body extension, new `GET /api/projects/:id/branches` | **Contract version bump required** (REST Layer owns URL paths and DTO shapes). Propose `0.6-draft`: "Adds project branch-automation settings to the project DTO/update surface and a read-only project branches endpoint." Impact on other modules: `mcp` (none — reserved), `connectors` (none), `auth` (gated by existing project-update permission), `webapp` (consumer of the new surface). |
| `connector` / `protocol` / `auth` / `extension` | — | **None.** Agents remain branch-unaware; protocol surface unchanged. |

Rule check: the automation performs no domain-table or filesystem access
(inputs injected by the caller), satisfying the Service → Automations surface.
Git execution lives in the runner, which already owns launch side effects.

## Implementation Phases

Each phase ships independently and is verifiable on its own.

**Phase 1 — Automation core (`automations/src/branch-strategy/`)**
`settings.ts` (Zod schema + defaults + tolerant parse), `slug.ts`,
`render.ts` (`renderBranchName`), `plan.ts` (`planBranchStrategy`),
`index.ts` (typed exports + `Automation` wrapper), registry entry, unit
tests. No callers yet.

**Phase 2 — Runner/launch execution (`cli`)**
`cli/src/branch-preparation.ts` (repo-state read + step executor), wire into
the runner claim path and `ovld launch`, `--branch` / `--no-branch-automation`
flags, `branch_prepared` ticket event, `markExecutionFailed` integration,
tests in `cli/test/` against a temp git repo fixture. Update
`cli/docs/04-runner-and-launch-execution.md`.

**Phase 3 — REST + settings UI (`webapp`)**
Contract bump to `0.6-draft` first (CONTRACT.md + REST boundary section of the
schema contract), then DTO/PATCH/branches endpoint, `src/repository/git-branches.ts`,
Resources-page Branching section with live preview, query hooks in
`webapp/web/lib/queries`.

**Phase 4 — Docs and polish**
Update `automations/README.md` and `01-automations-overview.md` built-ins
table, CLI help text, drift review across API/CLI/docs surfaces.

## Acceptance Criteria

- With branch automation enabled (`granularity: ticket`), launching the first
  objective of ticket seq 1488 titled "Add CSV export" from a clean checkout
  of `main` leaves the working directory on a new branch
  `overlord/add-csv-export-1488` cut from the configured base; the agent
  session starts on that branch.
- Launching the ticket's second objective reuses that branch (no new branch,
  `branch_prepared` event records `action: reuse`).
- With `granularity: objective`, the same launches produce
  `overlord/add-csv-export-1488/1` and `overlord/add-csv-export-1488/2`, each
  cut from the base branch.
- A dirty worktree fails the execution request with an actionable error and
  no git mutations.
- A missing base branch fails with a message naming the branch and directory.
- Disabled projects (default) behave exactly as today.
- Project settings UI can list branches of the primary resource, select a
  base, choose granularity, set the custom name, and shows a correct live
  preview.

## Open Questions

1. **Per-objective base.** When branching per objective, objectives currently
   branch from the configured base. Should later objectives instead stack on
   the previous objective's branch (sequential work)? Plan assumes base-branch
   for all, per the request wording; the `BranchStrategyInput` shape leaves
   room to add a `stackOnPrevious` option later.
2. **Ticket-level override.** Is a per-ticket override of granularity/prefix
   needed, or is project-level configuration sufficient for v1? Plan assumes
   project-level only.
3. **Branch cleanup.** Out of scope here; deleting/merging agent branches
   after ticket completion could become a follow-up automation.
