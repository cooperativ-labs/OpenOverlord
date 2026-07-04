# CLI Module — Test Plan

Part of the [master test plan](../../TEST_PLAN.md). Covers three contract
components that all ship inside the `ovld` binary:

- **`cli`** — management commands, project linking, config files, output format
  ([02-cli-first-product-surface.md](02-cli-first-product-surface.md))
- **`protocol`** — agent session lifecycle ([03-agent-protocol.md](03-agent-protocol.md))
- **`runner`** — execution queue + launch ([04-runner-and-launch-execution.md](04-runner-and-launch-execution.md))

Core domain semantics come from
[06-core-domain-and-lifecycle.md](06-core-domain-and-lifecycle.md) and review
semantics from [11-review-artifacts-and-change-tracking.md](11-review-artifacts-and-change-tracking.md).

CLI, protocol, and runner all reach persistence through the **same service layer**
as REST. Most behavioral assertions therefore live at L2 (service-layer
integration via `withAdapter`); L4 adds thin real-subprocess smoke tests via
`runOvld` (`test/support/cli.ts`).

---

## A. CLI Management Layer (`cli`)

### A1. Command surface and argument shapes
- Each documented management command (`create-project`, `add-cwd`, `create`,
  `missions list`, `mission context`, …) exists with the documented arguments.
- Unknown command / missing required arg produces a non-zero exit and a
  human-readable error (not a stack trace).
- `--help` and `version` work without a database or auth.

### A2. Project linking and discovery
- Project resolves from the working directory via `.overlord/project.json`
  (contract: CLI owns "project linking and discovery from working directory").
- `discoverProject` resolves from CWD, explicit `--working-directory`, and project
  identifier; ambiguous/no-match cases produce a clear error.
- Config files (`overlord.toml`, `.overlord/project.json`) load with documented
  defaults; malformed config fails loudly.

### A3. Output format conventions
- Human-readable output matches the documented format; machine paths (`protocol`)
  emit JSON on stdout.
- Non-zero exit on every error path (contract: "non-zero exit on error").

### A4. Service-layer parity
- A management mutation (e.g. `create`) goes through the identical service
  function used by the REST and protocol surfaces — asserted by the
  [boundary conformance test](../../TEST_PLAN.md#33-interaction-surface-boundary-enforcement),
  not duplicated logic.
- All CLI mutations run in ACID transactions with optimistic concurrency
  (`revision`) — shared with the [database concurrency tests](../../database/docs/testing.md#3-optimistic-concurrency-adapter-suite-3).

---

## B. Agent Protocol (`protocol`)

The protocol surface is the highest-rigor part of the CLI suite because it is the
primary agent-facing contract. Tests are derived from
[`contract/protocol-commands.yaml`](../../contract/protocol-commands.yaml) and
shared with [Layer 3 §3.5](../../TEST_PLAN.md#35-protocol-command-surface-conformance).

### B1. Session lifecycle ordering
> Contract sequence: `attach → (update|heartbeat)* → (ask|deliver)`.

- `update`, `heartbeat`, `ask`, `deliver` all fail clearly when called **before**
  `attach` / without a valid session key (`requiresSessionKey`).
- `attach` creates an `agent_sessions` row and moves the objective to `executing`
  (declared side effects).
- After `deliver`, further implementation/`update --phase execute` is rejected
  unless explicit follow-up was begun (`--begin-follow-up-work`).
- `ask` posts exactly one `mission_events` row of type `ask` and the test asserts
  the documented "agent must stop" contract is representable (single question per
  call rejected if multiple).

### B2. `attach` response shape (`attach-response-v3`)
- Output contains every `requiredTopLevelFields`: `history`, `artifacts`,
  `attachments`, `previousObjectives`, `futureObjectives`, `session`,
  `sharedState`, `agentInstructions`.
- `session` has `sessionKey` + `state`; objective arrays each have
  `id`/`objective`/`state`/`position`.
- `agentInstructions` contains every `agentInstructionsRequiredContent` item:
  mission ID, objective ID, objective label, pointers to the structured JSON
  fields, and required protocol workflow instructions.
- Objective text, history, attachments, artifacts, and shared context remain in
  their structured fields instead of being duplicated in `agentInstructions`.

### B3. Required flags and vocab enforcement
- Each command rejects a call missing any `requiredFlags` entry.
- `update --phase` only accepts `draft|execute|review|deliver|complete|blocked|cancelled`.
- `update --event-type` only accepts `update|user_follow_up|alert|discussion_summary|decision`.
- Out-of-set phase/event-type values are rejected with a domain error.

### B4. Side-effect fidelity
- `update` appends a `mission_events` row and upserts changed files keyed by
  session+objective+path.
- **`heartbeat` creates NO `mission_events` row** — only updates session liveness
  (explicit negative assertion; contract calls this out).
- `deliver` stores a delivery record, sets objective `complete`, moves mission to
  `review`, and may trigger auto-advance of the next objective.

### B5. Delivery validation — change rationales
> "Meaningful tracked changed files require rationales."

- Delivery with tracked, meaningful changed files but **no** rationales is
  rejected.
- Each rationale requires `file_path`, `label`, `summary`, `why`, `impact`; the
  internal `filePath`/`rationale` shape is rejected (matches the skill's stated
  validation).
- Formatting-only / untracked changes do not require rationales.

### B6. Shell-special content handling
- Summaries/questions/payloads containing backticks, `$vars`, quotes are accepted
  via `--summary-file -` / `--question-file -` / `--payload-file -` stdin without
  corruption (contract: shell-special handling surface).

### B7. Idempotency
- A retried protocol write with the same `protocol.*`-scoped idempotency key
  returns the first result and does not double-apply (shared with
  [database idempotency tests](../../database/docs/testing.md#5-active-uniqueness-rules-adapter-suite-5)).

### B8. Discovery / non-session commands
- `create` → draft mission + draft objective, no session.
- `prompt` → mission created and attached/queued for execution.
- `loadContext`, `searchMissions`, `listOrganizations` are read-only (no writes).
- `discussObjective` moves a draft objective to `submitted`.
- `addObjectives` appends ordered draft objectives.
- `recordWork` creates a review-status mission + completed objective + delivery
  **without** a session (shared with [DB §8](../../database/docs/testing.md#8-record-work-without-session-adapter-suite-8)).

### B9. Objective state machine
- Drives `objectives.state` transitions per
  [Layer 3 §3.6](../../TEST_PLAN.md#36-state-machine-conformance): legal path,
  illegal-jump rejection, `pending_delivery` only post-follow-up, reopen records a
  `mission_events` row.

---

## C. Runner (`runner`)

Derived from [04-runner-and-launch-execution.md](04-runner-and-launch-execution.md)
and the Runner -> REST surface in `contract/components.yaml`.

### C1. Queue claiming atomicity
- `POST /api/runner/claim` is atomic under concurrent runners — exactly one winner
  (shared with [DB §6](../../database/docs/testing.md#6-queue-claiming-atomicity-adapter-suite-6)).
- Claim verifies the objective is launchable before claiming; appends
  `mission_events` + `entity_changes` in the same transaction, and sets claim
  device/target/expiry metadata.

### C2. Execution-request state machine
- `execution_requests.status`: `queued → claimed → launching → launched`;
  terminal `failed/cleared/cancelled/expired` are sinks
  ([Layer 3 §3.6](../../TEST_PLAN.md#36-state-machine-conformance)).
- `/api/runner/requests/:id/launched` records terminal-open success;
  protocol `attach` sets `launched_session_id` when launch context carries the
  request id. `/api/runner/requests/:id/failed` sets `failed` + last error;
  `/api/runner/clear` sets active requests to `cleared`.

### C3. Device + target resolution
- The service-layer device helper registers/returns a device idempotently.
- Working-directory resolution and execution-target selection pick the documented
  target; `ovld runner status` / `GET /api/runner/status` are read-only queue
  inspection surfaces.

### C4. Auto-advance
- A delivered objective with auto-advance enabled queues the next objective
  through the **same** execution queue (no side-channel).

### C5. Launch boundary
- `ovld launch <agent>` for the first connectors (Codex/Claude) is exercised in
  **dry-run** (no real agent process) — asserts the launch command is constructed
  per the connector's declared capabilities, deferring real-process behavior to
  the [connectors test plan](../../connectors/docs/testing.md).

---

## L4 Surface Smoke (`cli/test/e2e`)

A thin set of real-subprocess tests via `runOvld` confirming the wiring L2/L3
proved is actually reachable at the binary boundary:

- `ovld protocol attach` against a temp SQLite DB returns valid
  `attach-response-v3` JSON on stdout, exit 0.
- A full happy path: `attach → update → deliver` over subprocess leaves the
  expected rows.
- An error path (`update` without session key) exits non-zero with a clear message.
- Shell-special summary piped via `--summary-file -` round-trips.

## Test Layout

```
cli/
  test/
    management.test.ts     # A
    protocol-lifecycle.test.ts   # B1,B4,B9
    protocol-attach-shape.test.ts # B2 (shared w/ conformance)
    protocol-validation.test.ts  # B3,B5,B6,B7
    protocol-discovery.test.ts   # B8
    runner-queue.test.ts   # C1,C2,C4
    runner-device.test.ts  # C3
    launch-dryrun.test.ts  # C5
    e2e/
      ovld-protocol.e2e.test.ts  # L4
```
