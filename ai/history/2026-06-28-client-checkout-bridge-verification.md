# Client Checkout Bridge — Manual Verification Report

**Date:** 2026-06-28  
**Plan:** [`client-checkout-bridge-unification.md`](../../planning/feature-plans/client-checkout-bridge-unification.md) §9  
**Finish sequence:** Step 4  
**Environment:** macOS agent session; loopback SQLite; no packaged Desktop or hosted Postgres

## Summary

| ID | Scenario | Result | Notes |
| --- | --- | --- | --- |
| **V1** | Desktop + Cloud Postgres + linked resource on Mac | **Not run** | Requires Overlord Desktop + hosted Postgres + linked checkout on this Mac. Blocked in agent environment. |
| **V3** | Browser + Cloud Postgres | **Pass (static + unit)** | Postgres always reports `capabilities.localTarget: unavailable`. Browser without Desktop gets `LOCAL_TARGET_REQUIRED` from `invokeLocalTarget`. `LocalTargetRequiredNotice` wired in branch control, worktrees settings, and settings nav hides Worktrees when unavailable. |
| **V4** | Browser + loopback SQLite + dev proxy | **Pass (automated)** | `local-target-capability.test.ts` and `local-target-invoke.test.ts` pass with `OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET=true` (list branches/worktrees, branch action integrate flow). |
| **V6** | Multi-target project | **Pass (automated)** | `project-execution-target.test.ts` (8 tests) and `project-resources.test.ts` confirm primaries and launch selection scoped per `executionTargetId`. |
| **V9** | Queue branch action → `ovld runner` on remote target | **Partial pass** | Queue path verified via integration smoke: branch action on non-acting target creates `execution_requests` row with `requested_source: local_target_mutation`, correct `execution_target_id`, and mutation metadata. Claim+in-process execute+writeback on the **remote** device requires Postgres (client device headers on claim) plus `ovld runner once` on that machine — not exercised end-to-end here. CLI path reviewed: `cli/src/commands.ts` parses mutation metadata and calls `executeLocalTargetMutation` → `POST .../completed`. |

## V3 detail (browser + Cloud Postgres)

- `resolveLocalTargetServerCapability({ dialect: 'postgres' })` → `unavailable` even when dev flag is set (`local-target-capability.test.ts`).
- `invokeLocalTarget` without Desktop or dev proxy → `code: LOCAL_TARGET_REQUIRED` (`local-target-client.test.ts`).
- UI surfaces explicit degradation instead of empty/wrong paths:
  - `MissionBranchControl.tsx` — notice when branch list empty and for branch actions.
  - `WorktreesPage.tsx` — notice replaces worktree list.
  - `SettingsModal.tsx` — hides Worktrees nav item when unavailable.

## V4 detail (dev browser fallback)

Automated git integration tests under `webapp/server/local-target-invoke.test.ts`:

- Rejects invoke when flag unset.
- Lists branches and worktrees when flag set.
- Runs `performBranchAction` integrate + push_parent against real temp repos.

Contributor documentation added in `docs/getting-started.md` (Step 5).

## V6 detail (multi-target)

- `project-resources.test.ts` — primary resource mutations stay scoped per execution target; global vs per-target primaries do not clobber each other.
- `project-execution-target.test.ts` — eligible target listing, preference persistence, launch resolution, and rejection of unreachable targets.

## V9 detail (remote runner queue)

Integration smoke (loopback SQLite, 2026-06-28):

1. Seed remote VM execution target (`fp-vm`) distinct from acting local device.
2. Select VM target for project; queue `integrate` branch action.
3. Assert queued row: `requested_source = local_target_mutation`, `execution_target_id` = VM target, metadata contains `performBranchAction` input.

**Limitation:** On co-located SQLite, `claimNextExecutionRequest` resolves the claiming device via server host fingerprint (`ensureActingDeviceTarget`), not the HTTP client device body — so full claim→execute→writeback for a *different* machine is only representative on **hosted Postgres** where `ctx.clientDevice` is honored.

## Follow-up (not blocking Step 4)

1. **V1 manual pass** — Human QA: Desktop + Cloud Postgres; exercise repository tree, `@` mentions, branch list, branch actions.
2. **V9 E2E on Postgres** — Queue from browser/desktop on target A; run `ovld runner once` on target B with matching device fingerprint; confirm `launched` status and branch activity writeback.
3. **Optional:** Add a committed integration test for V9 queue+claim on Postgres test DB (mirrors smoke above).
