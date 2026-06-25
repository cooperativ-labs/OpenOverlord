# Objective Launch and Execution Flow Review

Mission: `coo:23`
Date: 2026-06-24

## Executive Summary

The objective launch flow has a workable vertical slice:

1. The web objective run button calls `POST /api/objectives/:id/launch`.
2. The server snapshots agent/model/launch config into `execution_requests`.
3. `ovld runner once|start` claims a request through `/api/runner/*`.
4. The CLI prepares the mission branch/worktree when enabled.
5. The CLI opens the agent command in the configured terminal.
6. The launched agent attaches with `ovld protocol attach`, posts updates, and delivers.
7. Protocol delivery writes `deliveries`, `mission_events`, `agent_sessions`, objective state, file changes, artifacts, and auto-advance queue effects.

The biggest refinement opportunity is to make one service-layer state machine own execution requests. Today the live web runner endpoints, local launch queueing, and `src/service/execution-requests.ts` duplicate overlapping SQL and drift in important details. The second major issue is a contract/documentation split: the contract still lists runner queue operations as protocol commands, while the implemented CLI help and live code intentionally route runner queue work through management REST endpoints.

No behavior changes are included in this report.

## Current Flow

### 1. Queue From Mission UI

- `AgentLaunchButton` validates that a primary resource is connected, then calls `useLaunchObjective()` with the selected agent/model/reasoning values (`webapp/web/components/objectives/AgentLaunchButton.tsx:69`, `webapp/web/components/objectives/AgentLaunchButton.tsx:89`).
- The client mutation calls `api.launchObjective`, which posts to `/api/objectives/:id/launch` (`webapp/web/lib/queries.ts:768`, `webapp/web/lib/api.ts:248`).
- The server route is gated by `execution_request:create` and dispatches to `launchObjective` (`webapp/server/index.ts:720`).
- `launchObjective` persists the selected agent/model/reasoning to the objective, optionally stores a per-objective launch override, moves `draft` to `launching`, resolves launch config precedence, inserts `execution_requests`, appends an `execution_requested` event, and records a change feed entry (`webapp/server/launch.ts:725`, `webapp/server/launch.ts:793`, `webapp/server/launch.ts:816`, `webapp/server/launch.ts:843`, `webapp/server/launch.ts:860`).

This part fits the architecture doc: objective-specific selection stays on the objective, reusable launch mechanics stay under target/user config, and the queued request gets a resolved snapshot.

### 2. Runner Claim And Local Launch

- The CLI runner claims through `POST /api/runner/claim`, marks the request `launching`, prepares branch/worktree, records branch preparation, calls `launchAgent`, then marks the request `launched` or `failed` (`cli/src/commands.ts:790`, `cli/src/commands.ts:799`, `cli/src/commands.ts:817`, `cli/src/commands.ts:828`, `cli/src/commands.ts:834`, `cli/src/commands.ts:864`).
- Branch preparation is well isolated: the CLI computes and creates/reuses the branch/worktree, while the backend records the result via `POST /api/missions/:id/branch-prepared` (`cli/src/branch-preparation.ts:378`, `webapp/server/runner.ts:329`). The backend correctly records branch state under allowed event vocabulary rather than inventing a closed `mission_events.type` (`webapp/server/runner.ts:440`).
- `launchAgent` creates a `.overlord/tmp` context file, resolves the agent command, sets `TMPDIR`/`TMP`/`TEMP`/`OVERLORD_TMPDIR`, and spawns either inline or through a terminal launcher (`cli/src/launch.ts:144`, `cli/src/launch.ts:151`, `cli/src/launch.ts:187`, `cli/src/launch.ts:199`).

### 3. Agent Protocol Writeback

- The launched agent must attach. `attachSession` moves the active objective to `executing`, creates `agent_sessions`, moves the mission to execute, promotes or creates the next draft objective, and returns full context (`src/service/protocol.ts:362`, `src/service/protocol.ts:423`, `src/service/protocol.ts:484`, `src/service/protocol.ts:533`).
- The CLI records a local VCS baseline after attach/resume and injects changed files at update/deliver time (`cli/src/commands.ts:423`, `cli/src/vcs.ts:291`, `cli/src/vcs.ts:510`).
- `deliverSession` validates summary/rationales, records changed files and rationales, inserts delivery/artifact/event rows, marks objective complete, ends the session, moves the mission to review, and queues auto-advance if configured (`src/service/protocol.ts:1254`, `src/service/protocol.ts:1450`, `src/service/protocol.ts:1546`).

This protocol path is the cleanest part of the flow. The writeback contract is centralized, and delivery state is durable.

## Findings And Refinements

### 1. Contract Drift: Runner Protocol Commands Are Specified But Not Implemented

`contract/protocol-commands.yaml` still declares runner protocol operations such as `getDevice`, `requestExecution`, `claimExecution`, `completeExecutionLaunch`, and `failExecutionLaunch` (`contract/protocol-commands.yaml:260`). The protocol design doc also lists these as required protocol commands (`cli/docs/03-agent-protocol.md:74`). But `webapp/server/protocol.ts` has no handlers for them, and `cli/src/protocol-help.ts` explicitly lists runner queue work as management commands, not protocol commands (`cli/src/protocol-help.ts:1`, `cli/src/protocol-help.ts:70`). The E2E smoke test asserts protocol help does not mention `claim-execution`.

There is also stale skill reference text telling agents to run `ovld protocol get-device` and `ovld protocol list-project-resources` (`connectors/core/overlord-mission/reference/devices.md:3`), even though the current protocol help does not support those commands.

Recommended direction: update the contract to make runner queue operations a CLI -> REST management surface, not an Agent -> Protocol surface. This matches the implemented CLI and keeps agent protocol focused on mission lifecycle. Contract impact:

- Remove or reclassify `runnerProtocol` entries in `contract/protocol-commands.yaml`.
- Update `cli/docs/03-agent-protocol.md`, `cli/docs/testing.md`, and connector skill references copied under `connectors/*/skills/overlord-mission/reference/devices.md`.
- Ensure `CONTRACT.md` and `contract/components.yaml` explicitly document `/api/runner/*` as the sanctioned runner queue surface if they are the stable interface.
- Downstream impact: agents and connector docs should stop advertising runner/device commands under `ovld protocol`; runner clients continue to use `ovld runner` and `/api/runner/*`.

Alternative: implement the missing protocol subcommands. That expands the stable protocol surface and requires fixing the service helpers below first so the protocol implementation satisfies the claim/event/change-feed contract.

### 2. Execution Request State Is Split Across Duplicate Implementations

There are at least three overlapping authorities:

- `webapp/server/launch.ts` queues web runs directly with SQL (`webapp/server/launch.ts:816`).
- `webapp/server/runner.ts` claims and mutates runner request status directly with SQL (`webapp/server/runner.ts:164`, `webapp/server/runner.ts:257`).
- `src/service/execution-requests.ts` has service helpers for create/claim/mark/clear (`src/service/execution-requests.ts:147`, `src/service/execution-requests.ts:347`, `src/service/execution-requests.ts:430`), but live `/api/runner/*` does not use them.

This creates drift:

- The schema/contract says claims should set `claimed_by_device_id`, `claimed_by_execution_target_id` where applicable, and `claim_expires_at` (`database/docs/09-database-schema-contract.md:1160`, `database/docs/09-database-schema-contract.md:1184`). The live web runner claim sets neither device nor expiry (`webapp/server/runner.ts:207`).
- The live runner claim appends `mission_events` and `entity_changes` (`webapp/server/runner.ts:224`, `webapp/server/runner.ts:234`), but the service `claimNextExecutionRequest` updates status without those event/change-feed writes (`src/service/execution-requests.ts:413`).
- The service helper has claim TTL support, but the live runner path does not use it (`src/service/execution-requests.ts:350`, `webapp/server/runner.ts:164`).

Recommended direction: introduce one execution-request state machine in the service layer and make web routes thin adapters. The service should own queue, claim, mark launching, mark terminal-opened/launched, link attached session, fail, clear, and expire. Then both `/api/objectives/:id/launch`, `/api/runner/*`, protocol auto-advance, and any future protocol runner commands call the same implementation.

### 3. `launched` Means Terminal Spawn Succeeded, Not Agent Attached

The documented pipeline lists "launched agent attaches" before "runner marks the launch successful or failed" (`cli/docs/04-runner-and-launch-execution.md:13`). The implementation marks the request `launched` after the local spawn command returns success (`cli/src/commands.ts:834`, `cli/src/commands.ts:864`). For terminal launches, that often only means `osascript` or a terminal prefix accepted the command, not that the agent actually started, attached, or can deliver (`cli/src/launch.ts:204`).

The schema has `execution_requests.launched_session_id` for correlation (`database/docs/09-database-schema-contract.md:1166`), but no code currently writes it. `attachSession` creates the `agent_sessions` row, but does not link it back to the execution request (`src/service/protocol.ts:484`).

Risk: terminal opens successfully, agent binary fails immediately, user closes the window, or the agent never calls `attach`. The request becomes `launched`, the objective can remain `launching`, and there is no durable acknowledgement tying the queued request to a real session.

Recommended direction:

- Pass `executionRequestId` into the launched agent context/environment.
- On `attachSession`, link the newest matching launched/launching request to the session via `launched_session_id` and move the request to a clearer attached state or add attachment metadata without changing the closed status vocabulary.
- Add a sweeper or runner status check for requests marked `launched` whose objective has not reached `executing` within a timeout.
- Consider renaming the internal transition in code comments to "terminal opened" unless and until it is attach-confirmed.

### 4. Nonzero Launch Exit Records Failure Twice

In `runRunnerCommand`, a nonzero `launchAgent` result posts `/failed`, then throws, and the enclosing `catch` posts `/failed` again (`cli/src/commands.ts:857`, `cli/src/commands.ts:871`). That can double-increment revisions and produce duplicate change-feed updates for one failure.

Recommended direction: post failure in one place. The simplest fix is to throw first with a typed error and let the catch perform the single failed write, or return after the explicit failed write.

### 5. Runner Status Transitions Are Too Permissive

`updateRunnerRequestStatus` can set any request to `launching`, `launched`, or `failed` regardless of current state (`webapp/server/runner.ts:257`). The service helper at least guards `launching` with `WHERE status = 'claimed'` (`src/service/execution-requests.ts:438`), though `launched` and `failed` are also permissive there.

Recommended direction: enforce allowed transitions centrally:

- `queued -> claimed`
- `claimed -> launching`
- `launching -> launched|failed`
- `queued|claimed|launching -> cleared`
- terminal statuses are sinks unless an explicit retry/requeue operation creates a new request.

Tests should cover illegal transition rejection for the REST runner endpoints, not only the service helper.

### 6. Stale Claim And Stale Launch Recovery Is Incomplete

The runner design requires stale claims to expire and become retryable or failed with a clear event (`cli/docs/04-runner-and-launch-execution.md:30`). The live web runner claim path does not set `claim_expires_at`, and there is no visible expiration sweep in the live runner path (`webapp/server/runner.ts:207`). Because `launched` is not considered an active queue status, a terminal-opened-but-never-attached request can also fall out of the active queue while the objective remains launchable/launching.

Recommended direction:

- Set claim expiry and claimed device/target in the live claim path.
- Add an expiration pass before each claim and in `runner status`.
- Split timeout handling for "claimed but runner died" and "terminal opened but no attach".
- Surface repair actions in `ovld runner status`.

### 7. Changed-File Explicit Payload Behavior Does Not Match The Comment

`applySessionChangedFiles` says delivery merges explicit changed-file payloads with the VCS delta, but when an explicit payload is present it uses only the explicit payload (`cli/src/commands.ts:91`, `cli/src/commands.ts:127`). This is an edge case because most agents rely on automatic delivery injection, but it means a partial explicit `--changed-files-json` can suppress mechanically observed files.

Recommended direction: either actually merge explicit payloads with the delta at deliver time, or update the comment/contract to say explicit changed-file payloads intentionally replace the automatic delta.

## Redundant Or Legacy Code Candidates

- `claimNextExecutionRequest`, `markExecutionLaunching`, `markExecutionLaunched`, and `markExecutionFailed` in `src/service/execution-requests.ts` appear to be used by tests and service-level paths, while live runner endpoints use `webapp/server/runner.ts` direct SQL. Consolidate rather than keeping both.
- `runnerProtocol` in `contract/protocol-commands.yaml` looks legacy relative to `cli/src/protocol-help.ts` and `/api/runner/*`.
- `launched_session_id` is schema-supported but unused. Keep it only if the attach correlation work is planned; otherwise document why it remains reserved.
- Connector `reference/devices.md` files advertise unsupported protocol commands and should be updated or removed from the mission skill references.

## Suggested Implementation Sequence

1. Decide the contract direction for runner queue commands. Prefer making `/api/runner/*` the stable runner surface and pruning runner commands from protocol docs/contracts.
2. Move live runner endpoint logic onto a single service-layer state machine. Preserve current REST shapes while centralizing SQL, event writes, change-feed writes, claim metadata, and transition guards.
3. Add request-to-session correlation. Pass `executionRequestId` into launch context and link it in `attachSession`.
4. Add stale claim/stale launch expiration. Include status output that explains exactly why a request is stuck and how to repair it.
5. Fix the double-failure write in `cli/src/commands.ts`.
6. Align changed-file explicit payload behavior with its comment and tests.
7. Clean connector/protocol docs and copied skill references.

## Test Additions

- Web runner endpoint tests for claim metadata: `claimed_by_device_id`, `claimed_by_execution_target_id`, `claim_expires_at`, mission event, and entity change.
- Web runner endpoint tests for illegal status transitions.
- CLI runner test proving one failed launch creates one failed status transition/change event.
- End-to-end test where a launched agent attaches and `execution_requests.launched_session_id` is set.
- Stale claim and launched-without-attach recovery tests.
- Protocol/docs smoke test ensuring supported protocol command lists, `contract/protocol-commands.yaml`, and connector skill references agree.
- Changed-file delivery test covering explicit payload plus automatic VCS delta.

## Contract Notes

This report does not require a contract version bump because it changes no runtime behavior. The implementation currently has a contract mismatch around runner protocol commands. If the project accepts the recommended direction, the contract should be updated before behavior cleanup:

- Treat runner queue claiming/status as REST/CLI management, not `ovld protocol`.
- Keep Agent -> Protocol focused on attach/update/heartbeat/ask/deliver and mission lifecycle commands.
- Document `/api/runner/*` in the REST/Runner surfaces as the stable interface.

If instead the project chooses to implement the runner protocol commands, that should be a contract-preserving implementation task with extra service-layer work first, because the current service helpers do not yet satisfy the full claim metadata/event/change-feed requirements.
