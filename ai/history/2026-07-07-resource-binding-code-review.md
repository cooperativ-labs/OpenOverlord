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
