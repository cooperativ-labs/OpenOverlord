# Cross-Repo Projects: Objective Resource Binding + Sibling Resource Context

Status: **draft / not started**
Date: 2026-07-07
Contract impact: **yes — requires CONTRACT.md +** `contract/*.yaml` **updates and a contract version bump (0 → 1) before implementation** (see §8)

## 1. Problem

A project frequently spans multiple related repositories (e.g. OpenOverlord and
OverlordMobile on the same device). Today:

- `project_resources` already supports many directories per project (one
`is_primary` per execution target), but **launch always resolves the primary**:
`resolveWorkingDirectory` in `packages/core/service/execution-requests.ts`
falls through explicit `workingDirectory` → `assertPrimaryResourceConnected`.
There is no way to point one objective at a non-primary resource.
- An agent launched into one repo has **no knowledge that sibling resources
exist**. Neither `AttachResponse` nor the assembled `agentInstructions`
(`assembleAgentInstructions` in `packages/core/service/protocol.ts`) mention
the project's other resources or their local paths.

Goal: one mission whose objectives individually target different repos, with
every agent session aware of (and able to read) the project's sibling checkouts
on the same execution target.

Non-goals (v1):

- Multi-repo *single sessions* (one agent editing two repos in one run). Each
session remains rooted in exactly one resource; siblings are readable context.
- An umbrella/monorepo resource type.
- Cross-mission linking / mission groups.
- Remote (`remote_directory`) resource semantics beyond what exists today.



## 2. Current model (facts the design builds on)


| Piece                | Where                                                                                                          | Relevant detail                                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_resources`  | `database/docs/09-database-schema-contract.md` §`project_resources`                                            | Per `(project, execution_target, path)` row; `is_primary` per target; `label`, `metadata_json`. **No cross-target identity for "the same repo".**                                                                                   |
| Objectives           | same doc §`objectives`                                                                                         | No resource column. Has `launch_config_json`, `branch`.                                                                                                                                                                             |
| `execution_requests` | same doc §`execution_requests`                                                                                 | Already has `resolved_resource_id` + `resolved_working_directory`, set at create time by `resolveWorkingDirectory`.                                                                                                                 |
| Working-dir chain    | `cli/docs/04-runner-and-launch-execution.md`                                                                   | explicit `workingDirectory` → selected target resource → **primary resource** → cwd `.overlord/project.json` match.                                                                                                                 |
| Branch planning      | `cli/src/branch-planning.ts` + `backend/branch-planning.ts`, pinned by `contract/branch-planning-vectors.json` | `canonicalMissionBranch` is per-mission (fine across repos — same name in each repo). `missionWorktreePath(worktreeRoot, projectSlug, branch)` has **no repo dimension** → two repos in one mission would collide on worktree path. |
| Branch observations  | `mission_branch_observations`                                                                                  | Unique `(execution_target_id, mission_id)` — one branch record per mission per target, no repo dimension.                                                                                                                           |
| Branch actions       | `backend/repository.ts`, `POST /api/missions/:id/branch/action`                                                | Operate on "the project's primary repo".                                                                                                                                                                                            |
| Attach context       | `packages/core/service/protocol.ts` (`AttachResponse`, `contextForObjective`, `assembleAgentInstructions`)     | `attach-response-v3` stable shape; no resource info.                                                                                                                                                                                |
| Changed files        | `changed_files.resource_id`                                                                                    | Column already exists ("FK to `project_resources` when known").                                                                                                                                                                     |
| Launch gating        | `packages/core/service/project-execution-target.ts`                                                            | `primaryResourceConnected` gates launchability per target.                                                                                                                                                                          |


Per the no-backward-compat decision for local rollouts, migrations are written
directly (Jake resets the DB); no compat shims or reversible migrations. The
`.overlord/project.json` compat rules in CONTRACT.md (legacy `resourceId` +
`resourceIdsByExecutionTarget`) still apply — this plan only adds to that file.

## 3. Design part A — logical resource identity: `resource_key`

Binding an objective to a `project_resources.id` would pin it to one execution
target, because resource rows are per-target (the same repo on two devices is
two rows, and `.overlord/project.json` is gitignored so nothing links them).
Objectives must bind to a **logical repo**, resolved to a concrete row at claim
time for whichever target launches.

Add a `resource_key` to `project_resources`:


| Column         | Type | Required | Notes                                                                                                                                                                                 |
| -------------- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource_key` | text | yes      | Stable slug identifying the logical resource within the project, shared by rows for the same repo across execution targets. Default: slugified `label`, else slugified path basename. |


- Uniqueness: unique active `(project_id, execution_target_id, resource_key)` —
a target has at most one row per logical resource.
- `ovld add-cwd` (and `POST /api/projects/:id/resources`) gain an optional
`--key <slug>` / `resourceKey` input; when omitted the default derivation
applies. When a row is created and another target already has a row whose
slug matches, they naturally share the key — no extra linking step.
- `.overlord/project.json` gains an additive `resourceKey` field (written by
`writeProjectJsonFromResource` in `cli/src/commands.ts`), so re-linking the
same checkout from another device reuses the key deterministically.
- Rename collisions on key edit are rejected (409) per the unique index.

DTO: `ProjectResourceDto` gains `resourceKey`; resource create/update bodies
accept it. Webapp project-settings resource list shows/edits it
(`webapp/web/lib/project-resources.ts`).

## 4. Design part B — objective → resource binding

Add to `objectives`:


| Column         | Type | Required | Notes                                                                                                                                        |
| -------------- | ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource_key` | text | no       | Logical resource this objective runs in. `null` = inherit the project primary for the claiming target (today's behavior, unchanged default). |


Resolution chain in `resolveWorkingDirectory` (`packages/core/service/execution-requests.ts`)
becomes:

1. Explicit `workingDirectory` from the request/flag (unchanged, wins).
2. **Objective** `resource_key`: find the active `project_resources` row with
  that key for the claiming/requested execution target (or a target-agnostic
   row). Missing/`missing`-status row → new `ServiceError`
   `objective_resource_not_connected` (mirrors
   `primary_resource_not_connected`), surfaced by the runner with a hint to run
   `ovld add-cwd --key <key>` in the right checkout.
3. Primary resource for the target (unchanged fallback when `resource_key` is null).
4. Existing cwd `.overlord/project.json` fallback (unchanged).

`createExecutionRequest` resolves at create time when a target is known and at
claim time otherwise — same two call sites that exist today (lines ~370 and
~532); both pass the objective's `resource_key` through. The resolved row id
lands in the existing `resolved_resource_id` column; **no** `execution_requests`
**schema change**.

Launch gating: `project-execution-target.ts` keeps `primaryResourceConnected`
for project-level UI, and gains a per-objective check used by the launch
button / auto-advance: an objective with a non-null `resource_key` is
launchable on a target only if that key resolves there.

Surfaces that gain the field (all additive):

- `ObjectiveDto` / `ObjectiveSummary`: `resourceKey: string | null`.
- `CreateMissionBody.objectives[]` and `firstObjective` companion: optional
`resourceKey` per entry (`packages/contract/src/index.ts`).
- Objective create/update REST bodies + `ovld objective` CLI flags
(`--resource <key>`).
- MCP tools `overlord_create_mission` / `overlord_add_objectives`: optional
`resourceKey` per objective; tool error (not silent fallback) when the key
doesn't exist on the project — consistent with the hosted-MCP explicit-
project-context rule.
- Webapp objective editor: resource picker dropdown, rendered only when the
project has >1 distinct `resource_key`; mission-create composer likewise.
- Protocol `attach`/`load-context` responses expose it via `ObjectiveSummary`.

Auto-advance needs no special handling: each queued objective resolves its own
resource, so sequential objectives can hop repos. Same-mission worktree reuse
(runner) keys on the planned worktree path, which becomes resource-scoped (§6).

## 5. Design part C — sibling resource manifest in agent context

Every session should know the project's other resources and, when resolvable,
their local paths on **its own execution target**.

### `AttachResponse` (additive field)

```ts
projectResources: Array<{
  resourceKey: string;
  label: string | null;
  isPrimary: boolean;
  /** True for the resource this session's working directory belongs to. */
  isCurrent: boolean;
  /** Absolute path on this session's execution target; null when the target is unknown or has no row for this key. */
  path: string | null;
  /** Latest target_resource_observations.state for that row, else 'unknown'. */
  state: string;
}>
```

Assembly in `contextForObjective` (`packages/core/service/protocol.ts`):
group active `project_resources` rows by `resource_key`, pick the row for the
resolving execution target to fill `path`/`state`.

Execution-target resolution for the manifest:

- `attach` with `executionRequestId` → `execution_requests.claimed_by_execution_target_id`.
- Otherwise: new optional attach/load-context input `executionTargetId`
(optional flag, non-breaking per `contract/protocol-commands.yaml` rules);
the CLI fills it from its local target fingerprint (same identity used by
`ovld setup` / runner claim).
- Unresolvable target → manifest still returned with `path: null` entries
(keys and labels are still useful context).



### `agentInstructions` section

`assembleAgentInstructions` gains, when the project has >1 logical resource:

```
## Project Resources
This project spans multiple repositories. You are working in `<currentKey>` (<path>).
Sibling resources on this machine (read for cross-repo context; do NOT report
file changes outside your own working directory):
- `overlord-mobile` — /Users/jake/Development/Cooperativ/OverlordMobile (available)
```

The "do not report changes outside your working directory" sentence guards the
existing changed-file attribution model: baseline capture and `git status` at
deliver run in the session's own working directory, so sibling edits made by an
agent would be invisible to attribution — the instructions forbid them instead.

### Other consumers

- MCP `overlord_load_mission_context`: include the manifest (metadata only —
strings; no new filesystem tools, staying inside the hosted-MCP locality rule).
- Runner launch env: export `OVERLORD_PROJECT_RESOURCES` (JSON of the same
manifest resolved for the launching target) so harness hooks / pre-commands
can use it without a protocol round-trip. Documented in
`cli/docs/04-runner-and-launch-execution.md`.
- `changed_files.resource_id`: protocol update/deliver paths populate it from
the session's execution request `resolved_resource_id` when present (today it
is mostly null), so review UIs can label which repo a change landed in.



## 6. Design part D — branch/worktree implications

`canonicalMissionBranch` is deterministic per mission, so a cross-repo mission
naturally uses the **same branch name in each repo** — keep that; it is the
easiest mental model and needs no planner change.

What must change:

1. `missionWorktreePath` **gains a resource dimension** — currently
  `join(worktreeRoot, projectSlug, branchLeaf)`; two repos' worktrees for one
   mission would collide. New shape:
   `join(worktreeRoot, projectSlug, resourceKey, branchLeaf)` (always included,
   uniform — acceptable since the DB is reset and worktrees are disposable).
   This is a **shared deterministic algorithm** duplicated in
   `cli/src/branch-planning.ts` and `backend/branch-planning.ts` and pinned by
   `contract/branch-planning-vectors.json`: update both copies, regenerate the
   fixture, **bump the contract version** (per CONTRACT.md §Shared
   Deterministic Algorithms). Both test suites
   (`cli/test/branch-planning.test.ts`, `backend/branch-planning.test.ts`)
   re-assert against the new vectors.
2. `mission_branch_observations` — add `resource_key` (text, required,
  backfill-free per DB reset); uniqueness becomes
   `(execution_target_id, mission_id, resource_key)`. Runner writeback fills it
   from the launch's resolved resource.
3. **Branch actions** (`POST /api/missions/:id/branch/action`,
  `backend/repository.ts`) — request body gains optional `resourceKey`
   (default: project primary), so commit/merge/push/publish can target either
   repo. `MissionBranchDto` prediction stays keyed to the primary in v1; the
   mission panel gains per-resource branch rows only if/when the UI needs them
   (v1 limitation, noted in the webapp section of the doc).
4. `objectives.branch` already records per-objective; no change.
5. Same-mission worktree reuse keys on the planned (now resource-scoped)
  worktree path, so two objectives in the same repo still share a worktree
   while a sibling-repo objective gets its own.



## 7. What this deliberately avoids

- **No mission-level default resource.** The fallback is objective → project
primary. A mission-level default adds a third layer for marginal ergonomics;
revisit if authoring friction shows up.
- **No FK from objectives to** `project_resources.id`**.** A text key keeps
objectives target-portable; referential integrity is enforced at the service
boundary (key must exist on the project at objective submit/launch time, not
necessarily on every target).
- **No multi-root sessions** (`--add-dir`-style write access to siblings).
Change attribution, branch prep, and delivery coverage all assume one repo
per session; the manifest gives read access on the same device, which covers
the "agents need to know the other repo" need without breaking attribution.



## 8. Contract updates (must land BEFORE implementation code)

Per CONTRACT.md maintenance rules and the component-contract skill:


| File                                           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTRACT.md`                                  | Bump contract version 0 → 1 + changelog row (worktree-path algorithm change is the version-forcing item). Update: CLI layer (`.overlord/project.json` gains `resourceKey`; `ovld add-cwd --key`), Runner layer (working-directory resolution chain step 2; `OVERLORD_PROJECT_RESOURCES` launch env), Shared Deterministic Algorithms (new `missionWorktreePath` signature + regenerated vectors), REST layer (branch action `resourceKey` param). |
| `contract/components.yaml`                     | `contractVersion: 1`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `contract/branch-planning-vectors.json`        | Regenerate with `resourceKey` in worktree-path vectors.                                                                                                                                                                                                                                                                                                                                                                                           |
| `contract/protocol-commands.yaml`              | `attach` / `load-context`: new optional `executionTargetId` input; document `attach-response-v3` additive fields `projectResources` + `objective.resourceKey` (additive optional fields — no new response-shape version needed; note them in the v3 description).                                                                                                                                                                                 |
| `database/docs/09-database-schema-contract.md` | `project_resources.resource_key` + new unique index; `objectives.resource_key`; `mission_branch_observations.resource_key` + new uniqueness; `changed_files.resource_id` population note.                                                                                                                                                                                                                                                         |
| `cli/docs/04-runner-and-launch-execution.md`   | New resolution chain, refusal error text, launch env var.                                                                                                                                                                                                                                                                                                                                                                                         |
| `cli/docs/03-agent-protocol.md`                | `projectResources` in attach context; Project Resources instructions section.                                                                                                                                                                                                                                                                                                                                                                     |




## 9. Implementation order

Each step is independently landable; contract docs land first.

1. **Contract + docs** — everything in §8. No code.
2. **Schema + core service:** `resource_key` — migrations for the three
  columns/indexes; `packages/core/service/projects.ts` resource CRUD +
   default-key derivation; `ProjectResourceDto`; `ovld add-cwd --key`;
   `.overlord/project.json` `resourceKey` write/read; webapp resource settings.
3. **Objective binding + launch resolution** — `objectives.resource_key`
  through DTOs/REST/CLI/MCP; `resolveWorkingDirectory` chain +
   `objective_resource_not_connected`; per-objective launch gating; webapp
   objective resource picker.
4. **Branch/worktree resource dimension** — both `branch-planning.ts` copies +
  vectors regen; `branch-preparation.ts` passes resource key;
   `mission_branch_observations` migration + runner writeback; branch-action
   `resourceKey` param in `backend/repository.ts`.
5. **Context manifest** — `AttachResponse.projectResources` + instructions
  section in `protocol.ts`; `executionTargetId` attach input plumbed from CLI;
   MCP `overlord_load_mission_context`; `OVERLORD_PROJECT_RESOURCES` launch
   env; `changed_files.resource_id` population.
6. **Verification pass** — end-to-end on this device: one project linking
  OpenOverlord + OverlordMobile, one mission with an objective in each, launch
   both sequentially, confirm distinct worktrees, correct working directories,
   sibling paths in both agents' context, per-repo changed-file attribution.



## 10. Impact on other modules (contract-mandated survey)


| Component             | Impact                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol              | Additive: `attach-response-v3` gains `projectResources`, `ObjectiveSummary.resourceKey`; optional `executionTargetId` input. No command renames/required-flag changes. |
| Database              | Three additive columns + two uniqueness changes (§8). Open vocab untouched; no closed-vocabulary change.                                                               |
| CLI                   | `ovld add-cwd --key`, objective `--resource` flag, `.overlord/project.json` additive field. Existing single-repo flows unchanged (null key ⇒ primary).                 |
| Runner                | Resolution chain step inserted; worktree paths move (one-time, disposable); new refusal error; launch env var.                                                         |
| REST                  | Additive DTO fields; branch action optional param; resource CRUD accepts `resourceKey`.                                                                                |
| Connector             | None — hooks unchanged; the "don't edit siblings" rule is instructions-level.                                                                                          |
| Auth / RBAC           | None — reuses existing project/resource permissions.                                                                                                                   |
| Automations           | None.                                                                                                                                                                  |
| Desktop               | None directly (renders webapp; spawned CLI picks up new behavior).                                                                                                     |
| MCP                   | Optional `resourceKey` tool inputs; manifest in load-mission-context. Locality rule respected (metadata only).                                                         |
| Extensions / webhooks | `entity_changes`/webhook payloads carry the new fields automatically via DTO serialization; no topic changes.                                                          |




## 11. Open questions

1. **Key stability on label rename** — v1: `resource_key` is independent of
  `label` after creation (rename label freely; key edits are explicit and  validated against bound objectives). OK? YES
2. **Mission branch panel UX for multi-repo missions** — v1 shows the primary
  repo's branch card only; per-resource cards are a follow-up. Acceptable  interim?  YES
3. **Should** `OVERLORD_PROJECT_RESOURCES` **include** `missing` **siblings?** Plan
  says yes with `state` so agents can report gaps rather than silently lack  context. YES

