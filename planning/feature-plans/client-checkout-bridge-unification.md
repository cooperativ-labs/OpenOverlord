# Client Checkout Bridge — Unification & Cloud Parity Plan

**Status:** Implemented — pending verification
**Date:** 2026-06-28
**Contract baseline:** `0.59-draft`
**Layers:** Desktop Shell (`desktop`), REST API Layer (`rest`), Core Service (`core`), Web SPA (`webapp/web`)
**Builds on:**
[`local-execution-target-capabilities.md`](local-execution-target-capabilities.md),
[`local-execution-target-rollout.md`](local-execution-target-rollout.md),
[`overlord-cloud-architecture.md`](overlord-cloud-architecture.md),
[`desktop-app-module.md`](desktop-app-module.md)
**Follows audit:** cloud-vs-client boundary review (2026-06-28 conversation)

---

## 1. Executive summary

WS-A–E routed checkout-local work through `LocalTargetCapabilities` and stopped
the hosted backend from being an execution target, but the product still has
**two parallel paths** for the same operations:

1. **Co-located SQLite path** — `webapp/server` uses `InProcessProvider` when
   `DATABASE_DIALECT === 'sqlite'`, running git/fs directly in the server
   process.
2. **Hosted path** — capabilities return `LOCAL_TARGET_REQUIRED`; the UI must
   call ad-hoc desktop IPC (today: `@` mentions only) or fail.

That split is the root of recurring bugs: features work in Local edition and
break on Cloud, or work in Desktop-on-Cloud but not in browser-on-Cloud, or pass
`executionTargetId: null` and hit the wrong resource.

**Recommendation:** treat the **desktop local-target bridge** as the canonical
transport for all **web-initiated** checkout-local work, for **both** SQLite and
Postgres backends. The REST server becomes a pure control plane for those
operations in every edition. Shared capability bodies live once in
`@overlord/core/service/local-target/`; desktop IPC and `InProcessProvider` are
thin wrappers around the same functions.

CLI and runner processes keep **in-process** providers — they already run on the
execution target and do not need IPC.

---

## 2. Problem statement

### 2.1 Architectural violation (still present)

From [`local-execution-target-capabilities.md`](local-execution-target-capabilities.md) §2:

> All checkout-local work must run on an execution target, never on the backend.

WS-D routed mutations through providers but **`resolveBackendResourceProvider`**
still keys off `isCoLocatedBackend(DATABASE_DIALECT)`:

```ts
// webapp/server/repository.ts — pattern repeated ~10×
resolveBackendResourceProvider(BACKEND_CO_LOCATED_WITH_CHECKOUT, target)
```

When dialect is `sqlite`, the **backend process** is treated as the execution
target. That was expedient for the original loopback topology but violates R1/R2
and duplicates logic the desktop bridge must also implement.

### 2.2 Audit findings (severity-ordered)

| ID | Area | Symptom on Cloud | Root cause |
| --- | --- | --- | --- |
| **A1** | `LiveFileChanges`, `ProjectSettingsSection` | Editor links missing `rootPath` | `useProjectRepository(projectId, null)` ignores selected target |
| **A2** | `GET /api/projects/:id/repository` | Empty tree / `unsupported_resource` | Server provider always unavailable on Postgres |
| **A3** | `ovld protocol discover-project` | Walks Railway filesystem or wrong cwd | Protocol handler runs `discoverProject()` server-side |
| **A4** | `primaryResource()` / `primaryResourcePath()` | Wrong resource on multi-target projects | No `executionTargetId` filter |
| **A5** | `loadBranchActionContext` | Fails with `BRANCH_NO_PRIMARY` before capability layer | `existsSync` on server for client paths |
| **A6** | `missionBranchDto` | `status: created`, `dirty: false`, wrong `worktreePath` | Git/fs enrichment gated on co-location |
| **A7** | `listMissionBranches` | Only current branch name | `listBranches` unavailable server-side |
| **A8** | Settings → Worktrees | Empty list | `collectWorktreeEntries` + `existsSync` on server |
| **A9** | Resource list UI | Shows `active` when path missing on client | No client observation writeback |
| **A10** | `@` mentions | **Fixed** (desktop IPC) | One-off bridge, not generalized |
| **A11** | Device identity / claim | **Fixed** (client device headers) | Backend host was stamped as target |
| **A12** | `localMutationProvider()` | Never reaches runner queue | Uses `backendTargetMetadata(null)`, not full registry |

### 2.3 What is correctly backend-owned (out of scope)

These should **not** move client-side:

- Mission/objective/execution-request CRUD and state machine
- Runner claim/launch/fail writebacks
- Realtime SSE, auth, workspace setup
- Attachment/object storage on server disk
- AI commit-message **summarization** after diff is gathered (diff gathering is client-side)
- Branch **metadata** persistence (`active_branch`, paths reported by runner via `branch-prepared`)

---

## 3. Architectural decision: unified bridge vs dual path

### 3.1 Options considered

| Option | Description | Pros | Cons |
| --- | --- | --- | --- |
| **A. Status quo** | SQLite → in-process server; Postgres → unavailable + ad-hoc IPC | Local browser-only dev works without Electron | Two code paths; Cloud parity is manual; subtle target bugs |
| **B. Unified desktop bridge (recommended)** | Web UI always uses `window.overlord` local-target IPC when available, regardless of dialect | One product behavior; server deletes co-location git/fs; shared core bodies | Browser-only + local SQLite loses repo features unless fallback kept |
| **C. Server-side remote proxy** | Webapp server forwards capability calls to desktop over WebSocket | Centralized API surface | Requires inbound connection to client (violates R3); complex auth |
| **D. Runner queue for all sync UI** | Every tree read is a polled job | Works for CLI-only VMs | Poor latency for branch picker, mentions, editor links |

### 3.2 Recommendation: Option B with a narrow dev fallback

**Unify Local and Cloud web UI on the desktop bridge.**

```text
┌─────────────────────────────────────────────────────────────────┐
│ Web SPA (Electron renderer or browser)                          │
│                                                                 │
│  useLocalTargetCapability('readRepositoryTree', input)          │
│       │                                                         │
│       ├─ window.overlord.localTarget.*  ──► Desktop main (IPC)  │
│       │         │                                               │
│       │         └─► @overlord/core local-target git/fs bodies   │
│       │                                                         │
│       └─ (dev only) REST fallback when loopback sqlite + no     │
│           desktop bridge AND meta.capabilities.localTarget =    │
│           'in_process_server'                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ HTTPS (control plane only)
┌─────────────────────────────────────────────────────────────────┐
│ Backend (SQLite or Postgres)                                    │
│  - persist resources, missions, queue                           │
│  - NEVER read linked checkout paths for UI                       │
│  - accept observation writebacks from clients                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ CLI / ovld runner (on execution target)                         │
│  InProcessProvider ──► same @overlord/core bodies               │
└─────────────────────────────────────────────────────────────────┘
```

**Why this is the right default**

1. **Eliminates duplication** — `readRepositoryTree`, `listBranches`,
   `deriveBranchPublicationStatus`, worktree enumeration, etc. are implemented
   once in core; desktop IPC and `InProcessProvider` delegate to the same
   functions (mentions already do this for a subset).
2. **Local edition parity** — Desktop-on-Local and Desktop-on-Cloud run
   identical renderer code; dialect only changes where the DB lives.
3. **Honest boundary** — The SQLite webapp server is no longer a hidden
   execution target; device identity always comes from the client.
4. **Incremental** — WS-A–E seams stay; we change transport selection and delete
   `BACKEND_CO_LOCATED_WITH_CHECKOUT` from UI-serving paths.

**Narrow dev fallback (optional, Phase 0)**

For contributors who open `http://127.0.0.1:4310` in a plain browser against a
local SQLite server: keep a **deprecated** REST in-process path gated by
`meta.capabilities.localTarget === 'in_process_server'`. Document that full
product features require the desktop shell. Do not invest in new features on the
fallback path.

**What stays in-process on the server**

- Nothing that touches a **linked checkout path** for UI or mutations.
- Server may still use fs for **backend-owned** paths: SQLite file, attachment
  storage roots, static SPA bundle, sql-studio binary resolution.

---

## 4. Target transport matrix

After this plan ships, capability resolution for **web-initiated** work:

| Caller context | Transport | Provider location |
| --- | --- | --- |
| Desktop SPA (any backend dialect) | `desktop_bridge` | `desktop/src/local-target/` → core bodies |
| Browser SPA + remote Postgres | unavailable (degrade UI) | — |
| Browser SPA + loopback SQLite (dev) | `in_process_server` (optional fallback) | `webapp/server` thin wrapper → core bodies |
| CLI `ovld` / `ovld runner` | `in_process` | `packages/core/service/local-target/` |
| Web queues work for another device | `runner_queue` | existing stub → future async jobs |

**Target selection** (unchanged from WS-C): UI reads
`ProjectRepositoryContext.selectedExecutionTargetId`; server stamps queue items
from stored preference; claim uses runner device identity.

---

## 5. Capability surface for the desktop bridge

Generalize the mentions IPC into one audited preload API.

### 5.1 Preload contract (additive)

Extend `window.overlord` with a single dispatch surface:

```ts
type LocalTargetBridgeCall =
  | { capability: 'readRepositoryTree'; input: ReadRepositoryTreeInput }
  | { capability: 'listBranches'; input: ListBranchesInput }
  | { capability: 'observeResource'; input: ObserveResourceInput }
  | { capability: 'readCurrentDiff'; input: ReadCurrentDiffInput }
  | { capability: 'listWorktrees'; input: ListWorktreesInput }
  | { capability: 'deriveBranchStatus'; input: BranchStatusInput }
  | { capability: 'performBranchAction'; input: PerformBranchActionInput }
  | { capability: 'generateCommitMessageFromLocalDiff'; input: GenerateCommitMessageInput }
  | { capability: 'writeProjectMetadata'; input: WriteProjectMetadataInput }
  // existing: chooseDirectory, getDeviceIdentity, readRepositoryMentionPaths (deprecated → readRepositoryTree)

interface OverlordDesktopBridge {
  invokeLocalTarget(call: LocalTargetBridgeCall): Promise<CapabilityResult<unknown>>;
}
```

Each handler in `desktop/src/ipc.ts` validates paths (no arbitrary shell), calls
the shared core implementation, returns `CapabilityResult` JSON.

**Security:** IPC handlers must reject paths outside the user's linked resources
(allowlist from last-fetched resource list, or resolve under known `repoPath`).

### 5.2 Web client helper

`webapp/web/lib/local-target-client.ts`:

```ts
export async function invokeLocalTarget<T>(call: LocalTargetBridgeCall): Promise<CapabilityResult<T>> {
  if (window.overlord?.invokeLocalTarget) {
    return window.overlord.invokeLocalTarget(call);
  }
  if (meta.capabilities.localTarget === 'in_process_server') {
    return api.invokeLocalTarget(call); // thin REST proxy for dev fallback only
  }
  return fail('LOCAL_TARGET_REQUIRED', '…');
}
```

Most UI hooks call this instead of REST for checkout-local reads.

### 5.3 REST endpoints — control plane only

| Endpoint | Today | Target |
| --- | --- | --- |
| `GET …/repository` | Server reads tree when sqlite | Returns DB metadata only; tree from client bridge |
| `GET …/missions/:id/branches` | Server lists git refs | Client bridge; server stores override pin |
| `POST …/branch/action` | Server runs git | Client bridge (sync) or queue job (remote target) |
| `GET /api/worktrees` | Server enumerates | Client bridge |
| `POST /api/projects/:id/resources` | Server may write metadata | DB insert + client `writeProjectMetadata` (already partial) |
| `GET …/resources` | Lifecycle + server observe | Lifecycle + **cached client observations** |

Optional dev-only: `POST /api/local-target/invoke` proxies to in-process core on
loopback SQLite — **not** deployed to cloud image.

---

## 6. Phased implementation

Legend: **R1** interchangeable backends · **R2** one mechanism · **R3** queue-here/run-there · **R4** slim cloud image

### Phase F0 — Quick fixes (1–2 days) ✅ landed 2026-06-28

**Goal:** Stop known footguns without waiting for full bridge.

| Task | Files | Acceptance |
| --- | --- | --- |
| F0.1 Use selected execution target in UI | `LiveFileChanges.tsx`, `ProjectSettingsSection.tsx` | Use `useProjectRepositoryContext()` or pass `selectedExecutionTargetId` |
| F0.2 Scope `primaryResource` by target | `webapp/server/repository.ts` | `primaryResource(projectId, executionTargetId?)`; callers pass mission/project target |
| F0.3 Client-side `discover-project` | `cli/src/commands.ts` | When `backend_url` is remote and no `--project-id`, resolve via local `.overlord/project.json` walk **before** POST; server handler requires `--project-id` or `--directory` only for co-located dev |
| F0.4 Remove server `existsSync` pre-checks on hosted | `loadBranchActionContext`, `collectWorktreeEntries` | Hosted paths skip fs; return typed errors via capability layer |
| F0.5 Meta capability flag | `webapp/server/index.ts`, `contract` | `capabilities.localTarget: 'desktop_bridge' \| 'in_process_server' \| 'unavailable'` |

**Contract:** additive `meta.capabilities.localTarget`; optional protocol note that
`discover-project --directory` is client-local when backend is remote.

---

### Phase F1 — Desktop bridge core (3–5 days) ✅ landed 2026-06-28

**Goal:** One IPC surface; replace mentions special-case. **(R2)**

| Task | Files | Acceptance |
| --- | --- | --- |
| F1.1 Extract shared invoke router | `desktop/src/local-target-bridge.ts` | Dispatches to core `*-git.ts` / `InProcessProvider` bodies |
| F1.2 `invokeLocalTarget` IPC + preload | `desktop/src/ipc.ts`, `preload.ts`, `overlord-desktop.d.ts` | Returns `CapabilityResult`; path allowlist enforced |
| F1.3 Web `local-target-client.ts` | `webapp/web/lib/local-target-client.ts` | Feature-detects bridge; unit tests with fake `window.overlord` |
| F1.4 Migrate mentions | `useRepositoryMentionOptions.ts` | Uses `readRepositoryTree` via bridge; delete `readRepositoryMentionPaths` IPC |
| F1.5 Migrate repository context | `ProjectRepositoryContext.tsx`, queries | Tree/git fields from bridge; REST returns resource metadata only |
| F1.6 Migrate editor `rootPath` | `LiveFileChanges`, `ProjectSettingsSection` | `repository.rootPath` from bridge or context |

**Tests:** desktop unit tests for IPC allowlist; web hook tests with fake bridge.

---

### Phase F2 — Branch & worktree UI (3–5 days) ✅ landed 2026-06-28

**Goal:** Mission panel and settings work on Cloud desktop. **(R1, R2)**

| Task | Files | Acceptance |
| --- | --- | --- |
| F2.1 Branch list via bridge | `MissionBranchControl`, `local-target-client` | Branch picker populated on Cloud desktop |
| F2.2 Branch status observation | bridge `deriveBranchStatus`, mission DTO | `dirty`, `status`, `worktreePath` reflect **client** git state; server DTO stores last observation timestamp |
| F2.3 Branch actions via bridge | `MissionBranchControl` mutations | commit/integrate/publish run locally; server records activity via existing REST after success |
| F2.4 Commit message draft | bridge `generateCommitMessageFromLocalDiff` + server AI | Diff local; summarization still server |
| F2.5 Worktrees settings page | `WorktreesPage.tsx` | Lists client worktrees via bridge; hide when `localTarget === 'unavailable'` |
| F2.6 Gate UI when no bridge | branch controls, worktrees nav | Clear copy: "Open in Overlord Desktop" |

**Contract:** optional `MissionBranchDto.observedAt` + `observationSource: 'client'`.

---

### Phase F3 — Server slimming (2–4 days) ✅ landed 2026-06-28

**Goal:** Delete co-location git/fs from webapp server. **(R1, R4)**

| Task | Files | Acceptance |
| --- | --- | --- |
| F3.1 Strip tree/branch/worktree from server handlers | `webapp/server/repository.ts` | Endpoints return metadata or 409 `LOCAL_TARGET_REQUIRED`; no `existsSync` on linked paths |
| F3.2 Delete `BACKEND_CO_LOCATED_WITH_CHECKOUT` from repository | same | Single code path |
| F3.3 Optional dev proxy route | `webapp/server/local-target-proxy.ts` | Only when `dialect === 'sqlite'` && `OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET=true` |
| F3.4 Update `0.58-draft` ownership wording | `CONTRACT.md` | Hosted rule applies to **all** REST checkout operations; local sqlite server same |

**Verification:** Postgres conformance tests pass; local desktop e2e passes; dev
browser fallback documented.

---

### Phase F4 — Observations & multi-target (3–5 days) ✅ landed 2026-06-28

**Goal:** Resource `missing` reflects client reality. **(R3)**

| Task | Files | Acceptance |
| --- | --- | --- |
| F4.1 Observation writeback API | `POST /api/execution-targets/:id/observations` | Client reports `observeResource` results |
| F4.2 Cache in DB or ephemeral store | `target_resource_observations` table (new) | `GET resources` merges lifecycle + latest observation |
| F4.3 Desktop periodic observe | desktop heartbeat or on-focus | Resources page shows accurate status on Cloud |
| F4.4 Runner observe on claim | `cli/src/runner` | CLI-only targets report without desktop |

**Contract:** new table + DTO fields → `CONTRACT_VERSION` bump.

---

### Phase F5 — Remote target async mutations (future) ✅ landed 2026-06-28

When selected target is **not** this desktop device, sync IPC is wrong — use
`RunnerQueueProvider` (already stubbed):

- Branch action → execution request kind `branch_action`
- Worktree purge → `worktree_purge`
- UI shows pending → completed via SSE

Out of scope for F0–F4 except API design hooks.

**Landed:** `execution_requests` with `requested_source: local_target_mutation` and
`metadata_json.overlord.localTargetMutation` queue branch actions and worktree
purges for the selected remote target. `ovld runner` executes mutations
in-process and reports `POST /api/runner/requests/:id/completed`. Web UI detects
remote target selection and queues via REST instead of the desktop bridge; mission
panel shows pending mutation state from active execution requests.

---

## 7. Code organization (DRY)

```
packages/core/service/local-target/
  git-run.ts, worktree-git.ts, branch-actions-git.ts, …   # single implementation
  in-process-provider.ts                                   # wraps bodies for CLI/runner
  desktop-bridge-provider.ts                               # NEW: typed call envelope (shared types only)
  registry.ts, default-registry.ts

desktop/src/
  local-target-bridge.ts                                   # IPC → core bodies
  ipc.ts                                                   # allowlist + invokeLocalTarget

webapp/web/lib/
  local-target-client.ts                                   # renderer transport selection

webapp/server/
  repository.ts                                            # control plane only (F3)
  local-target-proxy.ts                                    # optional dev fallback
```

**Rule:** No new `existsSync`/`git` calls in `webapp/server` against linked
checkout paths. Code review checklist item.

---

## 8. Contract changes

| Phase | Change | Version impact |
| --- | --- | --- |
| F0 | `meta.capabilities.localTarget`; protocol `discover-project` client-local rule | Additive changelog entry |
| F0 | Client device headers (if not yet in contract text) | Document in Desktop + REST surfaces |
| F2 | `MissionBranchDto` observation metadata | Additive fields |
| F3 | Revise `0.58-draft` wording: sqlite server also MUST NOT serve checkout fs via REST | Clarification entry |
| F4 | `target_resource_observations` table + REST writeback | **Bump** `CONTRACT_VERSION` |
| F1 | `window.overlord.invokeLocalTarget` | Desktop shell extension (like `writeProjectMetadata`) |

Read `CONTRACT.md` and update `contract/components.yaml` in the same PR as each
stable surface change.

---

## 9. Verification matrix

Every phase must pass:

| # | Scenario | Expect |
| --- | --- | --- |
| V1 | Desktop + Cloud Postgres + linked resource on Mac | Repository tree, mentions, branch list, branch actions work |
| V2 | Desktop + Local SQLite | Same behavior as V1 (parity) |
| V3 | Browser + Cloud Postgres | Degraded UI; no silent wrong paths |
| V4 | Browser + Local SQLite (dev) | Fallback works if enabled; documented |
| V5 | `ovld runner once` claims job stamped for client target | Unchanged from WS-B fix |
| V6 | Multi-target project | Operations scoped to selected target |
| V7 | `ovld protocol discover-project` on remote backend | Resolves from client cwd / project.json |
| V8 | Postgres unit tests | No server-side linked-path fs |
| V9 | R3: queue from desktop, run on CLI VM | Claim on VM; desktop bridge not involved for execution |

---

## 10. Migration & data cleanup

For workspaces that previously stamped the **Railway host** as execution target:

1. Exclude backend-host fingerprint from eligible targets (shipped).
2. User re-selects client device in Resources → execution target selector.
3. Re-link primary resource with `executionTargetId` = client target.
4. Clear or re-queue stale `execution_requests` with wrong `execution_target_id`.
5. Optional one-time admin script: `UPDATE execution_requests SET execution_target_id = NULL WHERE …` for orphaned server-target rows.

Document in release notes / `ovld doctor` warning when container hostname detected.

---

## 11. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| IPC latency for large trees | Cache in renderer (React Query `staleTime`); paginate tree reads |
| Path traversal via IPC | Strict allowlist against linked resources |
| Browser-only local dev regression | Explicit opt-in fallback; desktop is primary product surface |
| Branch action failures desync DB vs git | Client reports success then server records activity; on failure no server mutation |
| Remote target (not this machine) | F5 runner queue; until then disable actions with clear message |
| Contract drift | Contract-first checklist per §8 |

---

## Remaining work

F0–F5 implementation is in the working tree. Open items (verification, branch
observation writeback, migration guidance, and final PR) are tracked in
[`client-checkout-bridge-finish-sequence.md`](client-checkout-bridge-finish-sequence.md)
(Steps 4–9).

---

## 12. Open questions

1. **F3 dev fallback** — Keep `in_process_server` REST proxy indefinitely, or
   require Electron for all contributor workflows?
2. **Observation retention** — Ephemeral cache vs durable `target_resource_observations`?
3. **Pure browser Cloud** — Accept permanent degradation, or stable browser
   fingerprint + service worker (probably not worth it)?
4. **AI summarization** — Keep on server (needs diff upload) or move to desktop
   when API keys are local?

---

## 13. Suggested PR order

```
F0 (quick fixes) → F1 (bridge core) → F2 (branch/worktree UI) → F3 (server slimming) → F4 (observations)
```

F3 can overlap F2 once bridge covers branch reads. Do **not** delete server
in-process paths until F1 bridge passes V1 and V2.

---

## 14. Opinion summary: local SQLite parity via the same bridge

**Yes — unify on the desktop bridge for all web-initiated checkout work.**

Keeping SQLite in-process on the server was a migration stepping stone (WS-D), not
the end state. It causes:

- duplicated transports (server in-process vs desktop IPC vs mentions one-off);
- false confidence that Cloud parity is "done" when Local still masks missing bridge work;
- device identity confusion when the server process and the user's machine are the same host but logically distinct components.

The bridge approach does **not** mean duplicating git logic in Electron — it means
**not** duplicating it: one implementation in core, two thin entry points (IPC and
CLI). The server drops checkout logic entirely.

**Exception:** CLI/runner should remain in-process. **Optional exception:** a
flagged dev REST proxy for browser + loopback SQLite only.

This is the fastest path to "Local and Cloud are the same product, different DB
location" — which is the original R1 goal.
