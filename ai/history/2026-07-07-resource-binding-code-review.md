# Resource Binding Code Review Report

**Date:** 2026-07-07  
**Mission:** coo:169 — Refactor and Improve Code Quality  
**Scope:** Phases 2–6 cross-repo resource binding implementation

## Summary

Reviewed resource binding across core protocol, projects service, CLI launch/run paths, manifest assembly, and execution requests. **0 Critical, 2 High (fixed), 4 Medium (1 fixed, 3 deferred), several Low/deferred.**

Intentional duplication left in place: `cli/src/branch-planning.ts` ↔ `backend/branch-planning.ts` (contract-pinned), CLI VCS preflight vs server deliver, hosted vs local project discovery.

## Fixes Applied This Objective

| Issue | Fix |
| --- | --- |
| `changed_files.resource_id` null on direct attach | `resolveSessionResourceId` now falls back: execution request → objective `resource_key` → primary resource; workspace-scoped query |
| Manual `ovld run`/`launch` wrong worktree resourceKey | Pass `objectiveId` into `prepareMissionBranch` via new `launchableObjectiveId()` helper |
| Manual launch missing sibling manifest | Pass `executionTargetId` into `launchAgent` for all local launch commands |
| Dead ternary in manifest state | Simplified to `observationState ?? 'unknown'` |
| Broken async tests | `await` on `createMissionWithObjectives` / `attachSession` in manifest tests |
| Claim audit trail | Include `resolved_resource_id` in `changedFields` when runner claim sets it |

## High — Deferred (documented)

### Shared target-scoped resource query helper

`pickResourceForTarget` (manifest), `findProjectResourceByKey` / `findPrimaryProjectResource` (core), and `primaryResource` / `resourceByKey` (backend repository) overlap. Consolidating into `packages/core/service/project-resource-queries.ts` would reduce drift but touches many call sites — follow-up if repository layer is refactored.

### MCP deliver without CLI VCS preflight

Hosted MCP `overlord_deliver_session` does not run `applySessionChangedFiles` or attribution classification. Acceptable for file-less MCP runs; document in MCP tool description if MCP agents begin editing files.

## Medium — Deferred

- **`discoverProject({ projectId })` without execution target** — primary pick ignores target scoping when project id is explicit; low traffic path.
- **Redundant `findPrimaryProjectResource` in manifest builder** — extra DB round-trip when `currentResourceKey` omitted; callers usually pass objective key.
- **Duplicate `isTruthyFlag` helpers** — cosmetic; consolidate in `util.ts` when touching those files next.

## Positive Observations

- `resource-binding-e2e.test.ts` exercises the full binding pipeline well.
- `resolveObjectiveWorkingDirectory` fallback chain is clear and tested.
- Protocol attach auto-fills `executionTargetId` from launch settings consistently.
- Branch-planning conformance vectors guard the resource-scoped worktree dimension.

## Verification

- Linter clean on touched files.
- `cli/test/branch-planning.test.ts` and `backend/branch-planning.test.ts` pass (5/5 each).
- SQLite-backed tests require local `@overlord/database` build (blocked in cloud pod).

---

# On-Device Re-Review Addendum

**Date:** 2026-07-08
**Context:** PR #16 (the review above) never merged; main moved past it. This pass re-applied its still-valid fixes onto main, then re-reviewed with SQLite-backed tests runnable on-device for the first time.

## New Bugs Found and Fixed

| Issue | Fix |
| --- | --- |
| **Backend typecheck broken on main**: phase 4 uses `body.resourceKey` in `performBranchAction` but the body type never declared it | Added `resourceKey?: unknown` to the body type (`backend/repository.ts`) |
| **Webapp typecheck broken on main**: `reportMissionBranchObservation` referenced an undefined `resource` variable — the file never compiled | Added a `resourceKey` parameter; caller passes `resource.resourceKey` (`webapp/web/lib/mission-branch-observations.ts`, `local-target-branch.ts`) |
| **Wrong changed-file attribution**: bound objective key missing on the resolved target fell straight back to the primary resource (wrong repo) | `resolveSessionResourceId` retries the key lookup target-agnostically before the primary fallback (`protocol.ts`) |
| **Mission test suites never executed**: the four resource-binding core test files fail `no_workspace` — `openInMemoryDatabase()` stopped seeding `local-workspace` after the org migration | Root-caused into `seedServiceOperator`: it now seeds the full org → workspace → sequence → statuses → buckets chain; added `createSeededServiceContext` convenience; rewired the mission test files (plus `projects.test.ts`, `missions.my-mission-position.test.ts`) to it |
| Internally inconsistent test: `objective_resource_not_connected` case bound an objective to a key that key-validation (phase 3) rejects at creation | Test now links `mobile` on a second execution target so creation passes and target-scoped launch resolution fails as intended |
| `projects.test.ts` used `path` without importing it (latent — file never ran) | Added the import |
| `resolveCwdProjectResource` accepted `executionTargetId` but ignored it | Caller's launch target now wins when picking among multi-target project.json links |
| **Destructive test side effect**: tests linked `process.cwd()` as a project resource, and `addProjectResource` writes `.overlord/project.json` into the linked directory — running the suite clobbered the real checkout's project link | Tests use `mkdtemp` directories instead (`protocol-context-manifest.test.ts`, `projects.test.ts`); the overwritten `.overlord/project.json` was restored from HEAD. Consider guarding the metadata write against non-existent/temp contexts if this bites again |

## Deferred Items From the Original Review — Now Done

- **Shared target-scoped resource query helper**: `findProjectResourceRow` (core `projects.ts`) now backs `findPrimaryProjectResource` + `findProjectResourceByKey`; `activeResourceRow` (backend `repository.ts`) backs `primaryResource` + `resourceByKey`. `listProjectResources`/`findPrimaryProjectResource` reuse `rowToProjectResourceSummary`.
- **Redundant `findPrimaryProjectResource` in manifest builder**: removed — `buildProjectResourceManifestEntries` already falls back to the target-scoped primary key. Also deduplicated the primary-pick computation, simplified observation selection, and dropped the unused `status` field from `ResourceLike`.

## Still Deferred

- MCP deliver without CLI VCS preflight (unchanged from above).
- `discoverProject({ projectId })` without execution-target scoping (low-traffic).
- Duplicate `isTruthyFlag` helpers (cosmetic).
- `cli/test/runner-and-changes.test.ts` (564 lines) is stale from before the async DatabaseClient cutover — sync calls into async service APIs; every test fails. Needs a mechanical async rewrite (pre-existing, unrelated to resource binding).
- ~30 other core service tests still fail `no_workspace`/FK-seed for the same dropped-implicit-seed reason (`missions.board-position`, `missions.search`, `postgres-conformance`, `protocol.test.ts`, …) — same fix pattern as above (`createSeededServiceContext`) applies file by file.
- `project_resources.status` allows `archived` per the schema contract, but no runtime path writes it; webapp filters defensively while service-layer finders and the agent manifest would include such rows. Harmonize if archiving ever ships.

## Verification (on-device)

- Full monorepo typecheck passes (it did not on main before this pass).
- 31/31 core service tests across the ten suites touching resource binding + seed helper users (manifest, objective binding, branch observations, e2e, projects, my-mission-position, storage, project-execution-target, profiles, launch-default) — first full execution of the mission's SQLite-backed tests.
- 22/22 CLI/backend tests (branch-planning conformance, branch-preparation, launch).
- 6/6 webapp `project-resources`/`local-target-client` tests.
- ESLint: 0 errors on touched files (remaining warnings are pre-existing `no-console` in the CLI).
