# Resource Binding — Phase 6 End-to-End Verification Report

**Date:** 2026-07-07  
**Mission:** coo:169 — Update contract and docs for resource binding  
**Plan:** [`cross-repo-projects-objective-resource-binding.md`](../../planning/feature-plans/cross-repo-projects-objective-resource-binding.md) §9 step 6  
**Environment:** Cursor cloud agent pod (Linux); OpenOverlord workspace only; no OverlordMobile checkout; no `ovld` CLI; no local runner

## Summary

| Check | Result | Notes |
| --- | --- | --- |
| **Branch-planning vectors (CLI)** | **Pass** | `cli/test/branch-planning.test.ts` — 5/5 including distinct `overlord` vs `mobile` worktree paths |
| **Branch-planning vectors (backend)** | **Pass** | `backend/branch-planning.test.ts` — 5/5 |
| **Simulated cross-repo mission (core)** | **Blocked here** | `packages/core/service/resource-binding-e2e.test.ts` added; requires `@overlord/database` build + better-sqlite3 (unavailable in cloud pod) |
| **Existing objective binding tests** | **Blocked here** | `objective-resource-binding.test.ts`, `protocol-context-manifest.test.ts` — same SQLite blocker |
| **Real device: OpenOverlord + OverlordMobile linked project** | **Not run** | Requires human Mac with both repos, `ovld add-cwd --key`, runner, and agent launches |
| **Sequential runner launches with git worktrees** | **Not run** | Requires local VCS + `ovld runner once` on device |
| **OVERLORD_PROJECT_RESOURCES in launched agent env** | **Not run** | Requires runner launch on device (PR #14) |
| **MCP load-context projectResources on hosted backend** | **Not run** | Phase 5 code not deployed to hosted backend during this session |

## Automated coverage added (Phase 6)

New integration test `packages/core/service/resource-binding-e2e.test.ts` simulates the plan’s cross-repo scenario in memory:

1. One project with `overlord` (primary) and `mobile` resources on the same execution target.
2. One mission with one objective per resource key.
3. For each objective sequentially:
   - `resolveObjectiveWorkingDirectory` → distinct checkout paths.
   - `previewMissionBranch` → distinct worktree paths under `<root>/<slug>/<resourceKey>/<branch>`.
   - `createExecutionRequest` → `resolved_resource_id` + working directory.
   - `recordMissionBranchObservations` with per-resource `resourceKey`.
   - `loadMissionContext` / `buildProjectResourceManifest` → sibling `projectResources` + `## Project Resources` instructions.
   - `attachSession` + `updateSession` → `changed_files.resource_id` matches resolved resource.
   - `deliverSession` → objective completes before the next iteration.

Run locally after `yarn install` and database build:

```bash
cd packages/core && yarn test service/resource-binding-e2e.test.ts
```

## Contract vector confirmation (distinct worktrees)

From `contract/branch-planning-vectors.json` for mission sequence 16:

| Resource key | Worktree path |
| --- | --- |
| `overlord` | `/tmp/ovld-worktrees/coo/overlord/automate-worktree-branching-16` |
| `mobile` | `/tmp/ovld-worktrees/coo/mobile/automate-worktree-branching-16-5` (cycle scenario) or `/tmp/ovld-worktrees/coo/mobile/feature-other` (override scenario) |

Same branch leaf, different resource segment — no collision between repos.

## Gaps requiring local device verification

### G1 — Linked OpenOverlord + OverlordMobile project

**Steps:**

1. On Mac, link OpenOverlord: `ovld add-cwd --key overlord` from OpenOverlord checkout.
2. Link OverlordMobile: `ovld add-cwd --project-id <id> --key mobile` from OverlordMobile checkout.
3. Create mission with two objectives (`--resource overlord` then `--resource mobile`).
4. Launch objective 1 via runner; confirm worktree under `.../overlord/...` and cwd = OpenOverlord path.
5. Deliver; launch objective 2; confirm worktree under `.../mobile/...` and cwd = OverlordMobile path.
6. Attach each run; confirm `projectResources` lists sibling path + state; confirm `OVERLORD_PROJECT_RESOURCES` env on launch.

### G2 — Per-repo changed-file attribution in review UI

After G1, change one file in each repo during its objective; deliver with rationales; confirm `changed_files.resource_id` in API/UI labels each change to the correct resource.

### G3 — Hosted MCP manifest after Phase 5 deploy

After merging PR #14, call `overlord_load_mission_context` with `executionTargetId` on a multi-resource project and confirm `projectResources` in the response.

## Recommendation

Treat Phase 6 as **partially complete in CI/cloud** (branch-planning conformance + new simulated E2E test) and **complete on device** after G1–G2 manual pass. No code defects found in automated slices; remaining work is environment-dependent QA.
