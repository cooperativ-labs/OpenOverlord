# Client Checkout Bridge — Finish Sequence

**Parent plan:** [`client-checkout-bridge-unification.md`](client-checkout-bridge-unification.md)  
**Status:** Agent task sequence (implementation in progress)  
**Date:** 2026-06-28

F0–F5 feature code largely exists in the working tree but is not fully committed,
verified, or documented. Dispatch the steps below to agents **in order** unless
noted. Each step is self-contained copy-paste task text.

---

## Step 1 — Commit hygiene: stage untracked work, exclude artifacts

**Goal:** Get the full F0–F5 implementation into git as a coherent working tree.

**Do:**

- Run `git status` and stage all untracked source files for this feature:
  migrations, desktop bridge, core local-target modules, web client libs, server
  modules, tests, and the parent plan doc.
- **Do not** stage build artifacts:
  `packages/core/service/device-identity.js`, `.js.map`, `.d.ts`, `.d.ts.map`.
- Add those artifacts to `.gitignore` if they are not already ignored.
- Verify imports resolve (no broken references to previously `??` files).

**Acceptance:**

- `git status` shows no missing untracked files for this feature (except ignored
  artifacts).
- No compiled `.js` artifacts staged under `packages/core/service/`.

**Do not commit** unless the user explicitly asks.

---

## Step 2 — Update plan doc status

**Goal:** Align [`client-checkout-bridge-unification.md`](client-checkout-bridge-unification.md)
with reality.

**Do:**

- Change the header status from “Proposal (planning only)” to “Implemented — pending
  verification” (or similar).
- Add a “Remaining work” section linking to this finish sequence.

**Acceptance:**

- Parent plan status matches landed phases and points here for open work.

---

## Step 3 — Run and fix automated tests

**Goal:** Confirm the implementation passes CI-relevant tests.

**Do:**

- Run `@overlord/webapp` tests, especially:
  - `server/local-target-invoke.test.ts`
  - `server/local-target-capability.test.ts`
  - `server/branch-actions.test.ts`
  - `server/branch-selection-worktrees.test.ts`
  - `server/branch-status.test.ts`
  - `server/project-resources.test.ts`
- Run `@overlord/core` tests, especially:
  - `service/target-resource-observations.test.ts`
  - `service/local-target-mutations.test.ts`
  - `service/postgres-conformance.test.ts`
- Run `desktop/src/local-target-path-allowlist.test.ts`.
- Run `webapp/web/lib/local-target-client.test.ts`.
- Fix failures. Git-init integration tests may need running outside the sandbox.

**Acceptance:**

- All listed test files pass locally.
- No new regressions in related server branch/repository tests.

---

## Step 4 — Manual verification matrix

**Goal:** Execute parent plan §9 scenarios and record results.

**Do:**

| ID | Scenario | Expect |
| --- | --- | --- |
| V1 | Desktop + Cloud Postgres + linked resource on Mac | Repository tree, mentions, branch list, branch actions work |
| V3 | Browser + Cloud Postgres | Degraded UI; no silent wrong paths; `LocalTargetRequiredNotice` where expected |
| V4 | Browser + loopback SQLite + `OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET=true` | Dev invoke proxy works |
| V6 | Multi-target project | Operations scoped to selected execution target |
| V9 | Queue branch action for remote target → `ovld runner` | Mutation executes in-process; completion writeback |

Write a short report to `/ai/history/` with pass/fail per scenario and file bugs
as follow-up fixes if needed.

**Acceptance:**

- Report exists with explicit V1, V3, V4, V6, V9 outcomes.

---

## Step 5 — Document dev fallback for contributors

**Goal:** Satisfy F3 verification (“dev browser fallback documented”).

**Do:**

- Add a section to `docs/getting-started.md` (or `webapp/README.md`) explaining:
  - Full checkout/git features require **Overlord Desktop**.
  - Optional dev path: `OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET=true` on loopback
    SQLite for browser-only local dev.
  - `meta.capabilities.localTarget` values (`in_process_server` vs `unavailable`)
    and what they mean.

**Acceptance:**

- A contributor can find the env var and when to use it without reading source.

---

## Step 6 — Branch observation writeback (Option A)

**Goal:** Close the F2.2 gap. Today the web client observes branch git state via
the desktop bridge (`deriveBranchStatus` / `observeMissionBranchGit`) but only
merges it in React (`useObservedMissionBranch`). The server `missionBranchDto`
still returns stub values (`status: 'created'`, `dirty: false`). Persist
client-observed branch state on the control plane — same pattern as F4 resource
observations.

### 6.1 Contract & schema (do first)

**Do:**

- Read `CONTRACT.md` and
  [`database/docs/09-database-schema-contract.md`](../../database/docs/09-database-schema-contract.md).
- Add table `mission_branch_observations` (name may vary; document in schema
  contract):
  - Unique on `(execution_target_id, mission_id)`.
  - Columns: `workspace_id`, `execution_target_id`, `mission_id`, `status`
    (`created` \| `published` \| `merged_unpushed` \| `merged`), `dirty` (bool),
    `worktree_path` (nullable text), `observed_at` (timestamptz), `created_at`,
    `updated_at`.
- Add migration files for Postgres and SQLite. **Begin the filename with the
  current date-time** (e.g. `YYYYMMDDHHMMSS_mission_branch_observations.sql`).
- Add REST DTOs in `webapp/shared/contract.ts`:
  - `MissionBranchObservationInput` (`missionId`, `status`, `dirty`,
    `worktreePath`, `observedAt`).
  - `RecordMissionBranchObservationsBody { observations[] }`.
  - Reuse or mirror `RecordTargetResourceObservationsResult`.
- Bump `contractVersion` in `contract/components.yaml` and add a changelog entry
  to `CONTRACT.md` (additive; mirrors `0.64-draft` resource observations).

### 6.2 Core service

**Do:**

- Add `packages/core/service/mission-branch-observations.ts`:
  - `recordMissionBranchObservations({ ctx, executionTargetId, observations })`
    — validate missions belong to workspace; upsert by
    `(execution_target_id, mission_id)`.
  - `loadMissionBranchObservationsForMissions({ ctx, executionTargetId, missionIds })`
    — batch read for DTO assembly.
  - `mergeMissionBranchObservation({ controlPlaneBranch, observation })` — when
    a fresh observation exists, override `status`, `dirty`, `worktreePath`,
    set `observedAt`, `observationSource: 'client'`.
- Add unit tests colocated (`mission-branch-observations.test.ts`).
- Update `packages/core/types/db.ts` (kysely/codegen if applicable).

### 6.3 REST API

**Do:**

- Add `webapp/server/mission-branch-observations.ts` handler:
  - `POST /api/execution-targets/:id/mission-branch-observations`
  - Auth: acting device must match target (same rule as resource observations in
    `target-resource-observations.ts` / `client-device.ts`).
- Register route in `webapp/server/index.ts`.
- Update `missionBranchDto` in `webapp/server/repository.ts`:
  - Load latest observation for the mission’s scoped execution target.
  - Merge observation fields when `observed_at` is present (do **not** run git on
    the server).
- Add server tests for writeback + merged DTO.

### 6.4 Web client writeback

**Do:**

- Add `webapp/web/lib/mission-branch-observations.ts` (or extend
  `resource-observations.ts` with a sibling module):
  - After a successful `deriveBranchStatus` bridge call, POST observation to
    the control plane for the acting `executionTargetId`.
- Wire from:
  - `useObservedMissionBranch` / `local-target-branch.ts`, and/or
  - `ProjectRepositoryContext` / mission panel focus refresh (same interval/focus
    pattern as resource observations).
- Invalidate mission detail / branch queries after successful writeback.
- Add `api.recordMissionBranchObservations(...)` in `webapp/web/lib/api.ts`.

### 6.5 Runner (optional but recommended)

**Do:**

- When `ovld runner` claims a mission-scoped job, if branch context is available,
  observe via in-process provider (`observeMissionBranchGit`) and POST writeback
  (mirror `cli/src/resource-observations.ts`).

### 6.6 UI behavior after writeback

**Do:**

- When desktop bridge is **unavailable** but a fresh server observation exists,
  `GET` mission detail should show merged `status` / `dirty` / `worktreePath`
  (browser-on-cloud reads last client truth, not live git).
- When bridge **is** available, client may still observe live and write back;
  prefer live observation in UI, fall back to server observation when stale.

**Acceptance:**

- Desktop observes branch → POST writeback → second client/session sees merged
  `MissionBranchDto` from REST without re-running git locally.
- `missionBranchDto` never calls git/`existsSync` on linked paths.
- Postgres conformance tests still pass.
- Contract, schema doc, migrations, and tests land together.

**Reference implementations:**

- F4 resource observations:
  `packages/core/service/target-resource-observations.ts`,
  `webapp/server/target-resource-observations.ts`,
  `webapp/web/lib/resource-observations.ts`
- Branch observation body:
  `packages/core/service/local-target/branch-observe-git.ts`

---

## Step 7 — Migration & cleanup (parent plan §10)

**Goal:** Help workspaces that previously stamped the Railway/backend host as
execution target.

**Do:**

- Add `ovld doctor` check: warn when an execution target fingerprint looks like
  the hosted backend/container hostname.
- Add release-note bullets for: re-select client device in Resources, re-link
  primary resource with correct `executionTargetId`, clear stale queued
  `execution_requests`.
- Optional: admin SQL/script to fix orphaned `execution_requests.execution_target_id`.

**Acceptance:**

- `ovld doctor` surfaces the warning in a testable way.
- Release/migration guidance exists for affected workspaces.

---

## Step 8 — Resolve open questions (parent plan §12)

**Goal:** Record explicit product decisions in the parent plan.

**Do:**

- **Dev fallback:** Document whether `in_process_server` stays supported
  indefinitely (recommended: yes, opt-in only).
- **Observation retention:** Define policy for `target_resource_observations` and
  `mission_branch_observations` (recommended: latest row per key, no TTL for now).
- **Pure browser Cloud:** Document permanent degradation as accepted.
- **AI summarization:** Confirm server-side summarization with client-uploaded
  diff is the long-term design.

Update §12 in the parent plan with decisions; implement TTL/cleanup only if
explicitly chosen.

**Acceptance:**

- Parent plan §12 updated; any chosen code changes implemented or marked out of
  scope.

---

## Step 9 — Final commit / PR

**Goal:** Land the work when the user requests it.

**Do:**

- Create logical commit(s) or PR per repo conventions.
- PR summary references parent plan, contract versions, Step 4 verification
  report, and Step 6 branch writeback.
- Include test plan checklist from Steps 3–4.

**Acceptance:**

- PR is reviewable; migrations included; no build artifacts; contract + plans
  updated.

**Only run when the user explicitly asks for a commit or PR.**

---

## Optional follow-ups (not blocking)

### Step 10 — Implement `readCurrentDiff` on the bridge

`readCurrentDiff` is stubbed (`CAPABILITY_NOT_IMPLEMENTED`). Implement in core
and wire if a surface needs live diff from checkout (today file changes come from
`change_rationales` in the DB).

### Step 11 — Desktop main-process observation heartbeat

Only if renderer interval + `window.focus` (see `resource-observations.ts`)
proves insufficient for background resource/branch status updates.

---

## Suggested dispatch

| Steps | Can run together? |
| --- | --- |
| 1–3 | Yes — one agent session |
| 4 | Needs Desktop + Cloud (human or agent with environment) |
| 5, 7, 8 | After 4, can parallelize |
| 6 | After 1–3 (or in parallel with 5); contract-first |
| 9 | User-requested only |
