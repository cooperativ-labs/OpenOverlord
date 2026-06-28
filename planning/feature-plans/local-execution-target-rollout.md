# Local Execution Target — Rollout & Legacy Removal Plan

**Status:** In progress (WS-E complete; WS-A registry routing fixed; WS-B/C behavioral gaps; R3 UI missing; WS-A provider bodies remain partial)
**Date:** 2026-06-28
**Contract baseline:** `0.59-draft`
**Design doc:** [`local-execution-target-capabilities.md`](local-execution-target-capabilities.md)
**Related plans:**
[`overlord-cloud-architecture.md`](overlord-cloud-architecture.md),
[`runner-background-daemon.md`](runner-background-daemon.md)

---

## 0. Progress

Legend: ✅ done · 🔲 not started · 🔄 partial.

| Step | Scope | Status | Notes |
| --- | --- | --- | --- |
| **WS-E1** | Stop committing generated migration trees | ✅ | `webapp/.gitignore` ignores `postgres/` like `sqlite/`; staged copies `git rm --cached`. Merged (PR #8). |
| **WS-E2** | Don't ship SQLite migrations to the Postgres image | ✅ | Dropped `COPY webapp/sqlite` from the Dockerfile runtime stage (the Postgres path never runs the sqlite migrator). Merged (PR #8). |
| **WS-A** | Capability interface + provider registry + fake | ✅ | `packages/core/service/local-target/` (interface, `CapabilityResult`, error codes incl. `LOCAL_TARGET_REQUIRED`, §5 observation states, registry + `UnavailableProvider`, fake). Merged (PR #8). |
| WS-A | `InProcessProvider` bodies | 🔄 | Class exists; bodies land per-capability with each WS-D step (see below) rather than as a throwaway verbatim wrapper. |
| WS-A | `DesktopBridgeProvider`, `RunnerQueueProvider` | 🔄 | `RunnerQueueProvider` stub + default registry landed in WS-C; desktop bridge deferred to WS-D remote UI paths. |
| WS-A | `createDefaultLocalTargetRegistry` co-location routing | ✅ | In-process only when `target.executionTargetId === callerExecutionTargetId`; co-located backend + different target id → `RunnerQueueProvider`. |
| **WS-B** | Split target identity (claim vs. create) | 🔄 | `ensureCallerDeviceTarget` + claim path landed (PR #8), but **`launch.ts:820` still falls back** to `localTarget.executionTargetId` when `resolveProjectExecutionTargetForLaunch` returns `null` (ambiguous multi-target). Violates contract `0.59-draft` (`NULL` required). |
| WS-B | Launch must not override null selector | 🔲 | Remove `?? localTarget.executionTargetId` in `launchObjective`; stamp `execution_target_id = NULL` and resolve agent configs without the caller-device target. Centralize into one service helper `{ executionTargetId, agentConfigs }` so launch cannot reintroduce backend-device stamping. |
| **WS-D(1)** | `observeResource` + resource status | ✅ | All three status-derivation sites routed through the capability; hosted backend never infers `missing` from its own fs; fixed the old `repository.ts` status type error. Branch `local-execution-target-wsd1`. |
| **WS-D(2)** | `writeProjectMetadata` | ✅ | `writeProjectJson` moved into the local-target module; core/webapp resource creation writes via `provider.writeProjectMetadata` (co-located writes, hosted no-ops). Branch `local-execution-target-wsd1`. |
| **WS-D(3)** | `readRepositoryTree`, `listBranches`, `readCurrentDiff` | ✅ | `getProjectRepository` and `listMissionBranches` now route through `LocalTargetCapabilities`; dead service-layer `readCurrentDiff` export removed (provider capability remains for future callers). |
| **WS-C** | Execution-target selector | 🔄 | REST + preference + `ProjectRepositoryContext` plumbing landed; `RunnerQueueProvider` + default registry stub. **R3 UI not wired** (`setSelectedExecutionTargetId` unused; `ResourcesPage` still says selection surface needed). |
| WS-C | Selector listing must not provision backend target | 🔲 | `listEligibleProjectExecutionTargets` calls `ensureCallerDeviceTarget` — a Cloud `GET /api/projects/:id/execution-target` can create/mark-reachable a Railway host target. List/read paths must not side-effect provision the service caller's device. |
| WS-C | Visible target selector UI (R3 acceptance) | 🔲 | Wire `eligibleTargets` + `setSelectedExecutionTargetId` into project settings (replace `ResourcesPage` placeholder copy). Desktop/CLI should read/write the same preference. Exit: select CLI-only VM, Run from Desktop → agent runs on VM. |
| **WS-D(4)** | `prepareBranch`, `listWorktrees`, `removeWorktree`, `purgeMergedWorktrees`, branch actions | ✅ | Git mutations in `repository.ts` route through `LocalTargetCapabilities` via shared `git-run.ts`, `worktree-git.ts`, and `branch-actions-git.ts`; `prepareBranch` remains CLI-owned (`CAPABILITY_NOT_IMPLEMENTED` in `InProcessProvider`). macOS `/tmp` ↔ `/private/tmp` normalized with `resolveRealPath`. Branch `local-execution-target-wsd1`. |
| **WS-D(5)** | `generateCommitMessageFromLocalDiff` | ✅ | Local diff gathering moved to `commit-message-diff-git.ts` + `InProcessProvider`; backend still calls `generateCommitMessageFromDiff` (Gemini). Branch `local-execution-target-wsd1`. |
| **WS-D(6)** | `launchAgent` + `doctor` | ✅ | `doctor` runs portable git/node checks via `doctor-checks.ts`; `launchAgent` remains CLI-owned (`CAPABILITY_NOT_IMPLEMENTED`). Branch `local-execution-target-wsd1`. |
| **WS-D (final)** | Delete `serverCanAccessLinkedFilesystem()` | ✅ | Removed from `repository.ts`; co-location now flows through `BACKEND_CO_LOCATED_WITH_CHECKOUT` + `resolveBackendResourceProvider`. Mutation guards rely on `assertCapabilitySuccess`. |
| **WS-E3** | Drop `better-sqlite3` from the cloud image | ✅ | Lazy-load `better-sqlite3` in `@overlord/database` + auth; `build:server --cloud` stages Postgres migrations only; Dockerfile drops native toolchain + prunes the addon from runtime `node_modules`. |
| **WS-E4** | Decide SPA serving (Open Q#7) | ✅ | **Decision:** Vercel serves the Cloud SPA (contract `0.55-draft`). `resolveServeSpa` gates `express.static` to SQLite/Local; Dockerfile sets `OVERLORD_SERVE_SPA=false` and never ships `webapp/dist`. |
| **WS-E5** | Remove the stale root `src/` | ✅ | Stale untracked root `src/` removed; only ignored `.DS_Store` remained locally. |
| **WS-E6** | Untrack generated `.overlord/project.json` | 🔲 | Contract `0.31-draft`: per-instance, not committed. `.gitignore` covers the path but `cli/.overlord/project.json` and `packages/core/.overlord/project.json` remain tracked — `git rm --cached` both. |
| WS-D (cleanup) | Local-only git/status helpers behind providers | 🔲 | Remaining local-only helpers in `changes.ts` and `repository.ts` should move behind provider methods or small shared provider helpers (consolidation; not blocking R3). |

**Architecture note for WS-D(3)+:** keep the in-process provider DB-free —
make git-capability inputs path-based (resolved `repoPath`/`workingDirectory`).
The backend resolves id→path (DB), calls the provider, then maps the native
payload → DTO. The `git` bodies can live in `@overlord/core` (it already runs
`execFileSync('git', …)` in `changes.ts`), so one core provider serves every
transport without pulling webapp deps into core.

**Pre-existing issues (not introduced by this work, surfaced while executing):**
`webapp/web/components/ui/dialog.tsx:60` fails `typecheck:webapp` (Radix
`asChild`); `cli/test/runner-and-changes.test.ts` and
`cli/test/protocol-lifecycle.test.ts` are red on `main` (they use the old
synchronous `ctx.db` API, never migrated to the async `DatabaseClient`).

---

## 1. Purpose

The design doc says *what* the boundary should be. This doc says *how to get
there without breaking the Local edition*, and *exactly which legacy code is
deleted at the end of each step*.

The governing rule is **parallel-change (strangler) sequencing**: for every
piece of legacy behavior we

1. add the new seam (capability interface / provider / selector) **alongside**
   the old code,
2. migrate callers to the seam,
3. flip the default so the seam is the only live path,
4. **then** delete the legacy code — never before step 3 is verified.

Local edition must stay green at every step. A change is not "done" until both
the in-process Local provider and a fake/cloud provider pass the §9 matrix in
the design doc.

## 2. Current state (what already exists)

Phase 0 of the design doc is partly landed (see `git status`: modified
`projects.ts`, `changes.ts`, `execution-requests.ts`, `repository.ts`,
`ipc.ts`, `ProjectCreatorModal.tsx`, `ResourcesPage.tsx`, new
`project-metadata.ts`). Concretely today:

- `webapp/server/repository.ts` already gates host-side git/fs behind
  `serverCanAccessLinkedFilesystem()` (~10 call sites: resource status, branch
  status, worktree listing, dirty checks, branch actions) and throws
  `LOCAL_FILESYSTEM_UNAVAILABLE` when the hosted backend cannot serve.
- `packages/core/service/execution-targets.ts` exposes
  `ensureLocalExecutionTarget`, used by **both** request creation
  (`webapp/server/launch.ts`) and claiming (`claimNextExecutionRequest` in
  `packages/core/service/execution-requests.ts`) — the §3.2 conflation.
- The claim filter is already `execution_target_id IS NULL OR = ?`, so the
  claim side is ready for a real target id; the creation side is not.

So this is a *refactor-and-extract* effort on a working system, not a green-field
build. The guard pattern (`serverCanAccessLinkedFilesystem()`) is the seam we
generalize into a provider, and is itself deleted once providers exist.

## 3. Workstreams

Five workstreams, mapped to the design requirements. They are mostly
independent and can land as separate PR chains; the dependency edges are called
out in §5.

| WS | Title | Requirement | Design phases |
| --- | --- | --- | --- |
| **A** | Capability interface + provider transports | R2 | 4, 1 |
| **B** | Split target identity (claim vs. create) | R1, R3 | 3.2 |
| **C** | Execution-target selector ("current target") | R3 | 6.1, 5 |
| **D** | Route reads & mutations through providers | R1, R2 | 2, 3, 4 |
| **E** | Slim the cloud image + build hygiene | R4 | 6 |

WS-E is independent of A–D and can be done first or in parallel (it is the
lowest-risk, highest-visibility cleanup). WS-A is the spine for D.

---

## 4. Execution steps

Each step lists **Add**, **Migrate**, **Flip**, then **Delete** (the legacy
removed once the step is verified).

### WS-A — Capability interface + providers (R2)

**Add**
- `LocalTargetCapabilities` interface (the §4 table) as a typed contract:
  `ok`-discriminated results, stable error codes, target metadata.
- Provider registry resolving a *target* → transport:
  - `InProcessProvider` (Local backend co-located with checkout; local runner on
    its own machine) — wraps the existing helpers verbatim at first.
  - `DesktopBridgeProvider` over `window.overlord` ([desktop/src/ipc.ts](desktop/src/ipc.ts)).
  - `RunnerQueueProvider` (outbound-poll request/response; see WS-C).
- A fake provider for tests.

**Migrate** — nothing yet; this step only introduces the seam and the
in-process provider that calls today's code.

**Flip / Delete** — none in this step. The interface must ship before any caller
moves.

> Exit: a no-op refactor where `InProcessProvider` produces byte-identical
> behavior to today; fake provider swappable in tests.

### WS-B — Split target identity (R1, R3)

**Add**
- `ensureCallerDeviceTarget(ctx)` — the *claiming* identity, derived from the
  polling runner/CLI process's device (today's `ensureLocalExecutionTarget`
  body, renamed for honesty).
- Leave `ensureLocalExecutionTarget` as a thin alias temporarily.

**Migrate**
- `claimNextExecutionRequest` ([execution-requests.ts:487](packages/core/service/execution-requests.ts))
  → `ensureCallerDeviceTarget`.
- Request creation in [launch.ts](webapp/server/launch.ts) stops calling the
  device-derived target for the `execution_target_id` it stamps; it consumes the
  selector from WS-C instead (until WS-C lands, it stamps `NULL` = "any eligible
  target", which is already claimable).

**Flip** — request creation no longer depends on the backend host's device.

**Delete**
- The `ensureLocalExecutionTarget` alias once both callers are migrated.
- Any backend code path that assumed "the creating process is the running
  process."

### WS-C — Execution-target selector (R3)

**Add**
- Durable preference: current execution target per `(workspace_user, project)`,
  with workspace/user fallback. Reuse `workspace_user_execution_targets` +
  observations from §5; persist the selection (new column or settings-blob key —
  decide in the contract note, additive/nullable).
- REST: `GET/PUT /api/projects/:id/execution-target` returning the selected
  target + eligible targets (joined with §5 observations for reachability).
- `RunnerQueueProvider` request/response jobs for the capabilities the web/remote
  Desktop need (browse, branch list, diff, branch actions, launch).

**Migrate**
- Web, Desktop, CLI all read/write the same selector.
- Request creation stamps the **selected** target id.

**Flip** — clicking Run on surface X queues a request targeted at selected device
Y; Y's runner claims it via WS-B identity; X may go offline.

**Delete**
- Any client-side assumption that "launch runs where the button was clicked."

> Exit (the R3 acceptance case): select a CLI-only VM as a project's current
> target, click Run in Desktop on a laptop → agent runs on the VM.

### WS-D — Route reads & mutations through providers (R1, R2)

Done capability-by-capability, lowest-risk first, each its own PR:

1. `observeResource` + resource status (replaces `existsSync` resource checks in
   [projects.ts](packages/core/service/projects.ts) and the §5 `missing`
   derivation).
2. `writeProjectMetadata` (already partly via `project-metadata.ts` / desktop
   bridge — finish routing it through the provider).
3. `readRepositoryTree`, `listBranches`, `readCurrentDiff` (read paths in
   [repository.ts](webapp/server/repository.ts) and
   [changes.ts](packages/core/service/changes.ts)).
4. `prepareBranch`, `listWorktrees`, `removeWorktree`, `purgeMergedWorktrees`,
   branch actions (the `runGit`/`execFileSync` mutations in
   [repository.ts](webapp/server/repository.ts)).
5. `generateCommitMessageFromLocalDiff` (local gathers diff; backend may still
   call the AI summarizer).
6. `launchAgent` + `doctor`.

**Per-capability pattern:** move the host-side helper body into
`InProcessProvider`; replace the caller with `provider.<capability>()`; the
`serverCanAccessLinkedFilesystem()` guard collapses into "is there a provider for
this target?" (in-process for Local, queue for remote, `LOCAL_TARGET_REQUIRED`
if none).

**Delete (after each capability is verified through a provider):**
- the corresponding direct `existsSync` / `execFileSync('git', …)` /
  `runGit` / `worktreeIsDirty` / `worktreePathForBranch` call site in
  `repository.ts` / `projects.ts` / `changes.ts`;
- the working-directory `existsSync` validation in
  `execution-requests.ts` (replaced by claim-time provider observation);
- **finally**, once *every* capability is routed, delete
  `serverCanAccessLinkedFilesystem()` itself — it is dead once the only host-side
  git lives inside `InProcessProvider`.

### WS-E — Slim cloud image + build hygiene (R4)

Independent; can ship first. Each is a discrete, verifiable cut.

1. **Stop committing generated migration trees.** `.gitignore`
   `webapp/sqlite/` and `webapp/postgres/` (they are staged copies produced by
   [build-server.mjs](webapp/scripts/build-server.mjs)); `git rm --cached`
   them. `database/{sqlite,postgres}/migrations` stays the source of truth.
   *Verify:* `git status` is clean after `yarn workspace @overlord/webapp
   build:server`.
2. **Don't ship SQLite migrations to the Postgres image.** Gate the
   sqlite-migrations staging/`COPY` on the configured DB adapter (or two build
   targets). *Verify:* the runtime image has no `webapp/sqlite/`.
3. **Drop `better-sqlite3` from the cloud image.** Finish the contract
   `0.55-draft` adapter selection so the production path never imports
   `better-sqlite3`; then remove it (and `python3/make/g++`) from the runtime
   stage of the [Dockerfile](Dockerfile). Decide one-image-lazy-load vs.
   two-images (Open Q#8). *Verify:* image builds with no native toolchain;
   Postgres conformance suite green.
4. **Decide SPA serving (Open Q#7).** If Vercel serves the SPA (per
   `0.55-draft`), drop the `webapp/web`/`dist` build and the
   `express.static(distDir)` mount [index.ts:1046](webapp/server/index.ts) from
   the cloud path; keep static-serving for Local/desktop only.
5. **Remove the stale root `src/`.** Untracked duplicate of `packages/core`
   (contract `0.53-draft`); delete locally.

**Delete:** committed `webapp/{sqlite,postgres}`; SQLite migration COPY in the
cloud image; `better-sqlite3` + build toolchain from the runtime stage;
(conditionally) SPA static serving on the cloud path; stale `src/`.

---

## 5. Sequencing & dependencies

```
WS-E  ──────────────────────────────►  (independent, do first / in parallel)

WS-A ──► WS-D
   └──► WS-B ──► WS-C ──► (R3 acceptance)
```

- **WS-A before WS-D** (need the interface before moving callers).
- **WS-B before WS-C** (selector is meaningless until create/claim identities
  are split).
- **WS-C's `RunnerQueueProvider`** is the same transport WS-D's remote path
  uses, so land the queue provider once (in WS-C) and WS-D consumes it.
- **Legacy deletion is always the last commit of its step**, gated on the §9
  matrix passing for both a real Local provider and a fake/cloud provider.

Suggested PR order: E1–E2 → A → B → D(1–3) → C → D(4–6) → E3–E4.

## 6. Contract touchpoints

- **WS-C** adds REST (`GET/PUT /api/projects/:id/execution-target`), a DTO, and
  a persisted selection field → additive contract entry (no `CONTRACT_VERSION`
  constant bump if no migration; bump if a column is added).
- **WS-B/D** change *internal* service wiring and error codes
  (`LOCAL_TARGET_REQUIRED`) — covered by the existing `0.58-draft` ownership
  rule; confirm error-code vocabulary is documented.
- **WS-E** aligns the cloud image with `0.55-draft` (Vercel SPA, no direct
  `better-sqlite3`) → **no** contract change, but document the build split.
- Follow `CLAUDE.md`: read `CONTRACT.md` before each cross-module PR; if a change
  extends the contract, update `CONTRACT.md` in the same PR and list module
  impact.

## 7. Verification

Reuse the design doc §9 matrix as the gate for every legacy deletion:

1. Local SQLite backend + in-process provider.
2. Hosted/Postgres backend with **no** filesystem access.
3. Fake runner target reporting observations/results.
4. Real CLI path: `ovld add-cwd`, branch preparation, changed-file delivery,
   and the R3 queue-here/run-there flow.

Invariants that must hold before deleting any guard:
- backend location never determines whether local file work can happen;
- hosted backend never marks a resource `missing` from its own fs, never reads
  source files;
- a request targeted at device Y is never claimed by device Z;
- DB state stays correct when a target operation fails halfway.

## 8. Risks & rollback

- **Risk:** deleting `serverCanAccessLinkedFilesystem()` too early strands the
  Local edition. *Mitigation:* it is the **last** deletion in WS-D, after all
  capabilities route through a provider.
- **Risk:** WS-E step 3 breaks Local (which legitimately needs `better-sqlite3`).
  *Mitigation:* the addon is removed only from the **cloud runtime stage**; Local
  desktop/CLI builds keep it.
- **Risk:** target-selection regressions silently route work to the wrong
  device. *Mitigation:* §7 invariant test "targeted request never claimed by
  another device" is a required check.
- **Rollback:** each step is a self-contained PR; because legacy is deleted only
  after the seam is verified, reverting a deletion PR restores the old path
  without touching the new seam.

## 9. Out of scope

- Provisioning new managed/cloud runners (covered by
  `overlord-cloud-architecture.md`).
- Browsers reading local files directly; exposing source to the hosted backend;
  inbound ports to targets; runner→Postgres direct connections (all design-doc
  non-goals).
