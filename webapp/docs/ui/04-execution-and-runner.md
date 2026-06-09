# 04 — Execution & Runner

Everything about getting an objective to run: the **Run control** (request
execution), the **execution-request queue**, the **local runner status**, and the
**auto-advance approval gate**. The web app queues work into the same durable
`execution_requests` queue the CLI uses; a local `ovld runner` actually launches
the agent. The UI must make the "queue here, launched there" split obvious.

**Routes:** the Run control is embedded on the board card and ticket detail; the
full queue/runner view is `/p/:projectId/runner`.

---

## The execution split (critical mental model)

```
   Web app / board / detail            durable queue              local machine
   ┌───────────────────────┐      ┌────────────────────┐     ┌──────────────────┐
   │ Run objective         │ ───▶ │ execution_requests │ ◀── │ ovld runner once │
   │ (request-execution)   │      │ queued→claimed→…   │     │  claims + launches│
   └───────────────────────┘      └────────────────────┘     └──────────────────┘
                                          │                          │
                                          ▼                          ▼
                                   entity_changes  ───────▶  agent attaches → session
```

The web app **requests** execution. It does **not** spawn agents. If no runner is
polling, requests sit `queued` and the UI must say so and offer the CLI fallback
(`ovld runner once` / `ovld runner start`), plus a copyable manual launch command.

---

## Run control

A compact picker, opened from a card's `▷ run`, the ticket header, or an objective
row. Prefilled from project launch defaults (doc 01) and the objective's
agent/model/effort.

```
Run objective 3 · Implement runtime
┌──────────────────────────────────────────────────────────┐
│ Agent   [ claude ▾ ]   Model [ opus ▾ ]   Effort [ high ▾]│
│ Flags   [ --append-system-prompt-file (auto) ] [+ flag]   │
│ Target  [ this-mac ▾ ]   Dir [ ~/dev/OpenOverlord ●prim ] │
│ ⚠ No runner is currently polling this target.             │  ← live runner check
│   It will queue and launch when a runner runs.            │
│      [ Copy: ovld runner once ]                            │
│ ──────────────────────────────────────────────────────── │
│                       [ Cancel ]  [ Queue run ]           │
└──────────────────────────────────────────────────────────┘
```

- **Queue run** → `POST /protocol/request-execution` with objective id, agent,
  model, effort, flags, and resolved target/working directory. The objective moves
  toward `submitted`/`launching`; an `execution_requested` event appears in the
  timeline.
- **Working-directory resolution** mirrors the runner's order (explicit → target
  resource → project primary → cwd `.overlord/project.json`). If none resolves, the
  control **blocks and shows the repair** (`ovld add-cwd` / link directory / pass
  `--working-directory`) rather than queuing a request that will fail.
- **Runner presence** is shown live: if the target has no active runner, queuing
  still works but the UI sets expectation ("will launch when a runner runs") and
  surfaces the one-line CLI fallback.
- **Manual run** allows repeat requests with distinct client request IDs; the UI
  warns if an active request already exists for the objective and lets the user
  queue another intentionally or jump to the existing one.

---

## Execution-request queue (`/p/:projectId/runner`)

The durable queue plus the local runner identity. The web equivalent of
`ovld runner status` + `ovld list-execution-requests`.

```
Runner · Open0                                   Local device: this-mac · ◍ polling (3s)
┌─ Active queue ─────────────────────────────────────────────────────────────────────┐
│ Obj / Ticket           Agent·Model  Status     Age   Source      Dir            ⋯    │
│ 1:1429 · Implement     claude·opus  launching  2s    manual_run  ~/dev/Open…    [⌫] │
│ 1:1431 · Add OAuth     codex·gpt    queued     40s    auto_advance ~/dev/bill…  [⌫] │
│ 1:1418 · Fix race      claude       failed     5m    manual_run  —  ⚠ no dir    [↻][⌫]│
└────────────────────────────────────────────────────────────────────────────────────┘
   [ Clear all ]                                       failed → shows last_error + fix
┌─ This device ──────────────────────────────────────────────────────────────────────┐
│ Fingerprint  7f2a…   Label [ this-mac ✎ ]   Targets: local → ~/dev/OpenOverlord     │
│ Runner state: polling every 3s · last claim 2s ago                                   │
│ Not running?  [ Copy: ovld runner start ]                                            │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### `ExecutionRequestRow`

| Field | Source | Notes |
| --- | --- | --- |
| Objective + ticket | `execution_requests.objective_id`/`ticket_id` | link to ticket detail |
| Agent · model · effort | request fields | |
| Status | `execution_requests.status` | `queued`, `claimed`, `launching`, `launched`, `failed`, `cleared`, `cancelled`, `expired` — colored; active = queued/claimed/launching |
| Age | timestamps | ticks live |
| Source | `manual_run` / `auto_advance` / `api` / `cli` | |
| Working dir | resolved dir | ⚠ when unresolved |
| `last_error` | on `failed` | shown with the exact repair command |
| Actions | — | **Clear** (`clear-execution-requests`), **Retry** (failed → requeue) |

### Runner status panel

- **Local device identity**: fingerprint (from `~/.ovld/device.json`), editable
  label (`update-device`), and attached project resource directories.
- **Live runner state**: polling / idle / not-detected, poll interval, last claim
  time. When no runner process is detected, prominently show
  `CopyCommand: ovld runner start` (and `ovld runner once` for a single claim) —
  the web app cannot start a runner for the user.
- **Why-not-claimable** explanations: a `queued` request that is not being claimed
  shows the reason (`objective not launchable`, `no compatible runner`, `no working
  directory`), mirroring `ovld runner status`.

---

## Auto-advance & approval gates

After a delivery, OpenOverlord inspects the next draft objective and either queues
it (`auto_advance=true`) or stops for human approval (`auto_advance=false` →
`awaiting_approval`). The UI surfaces both:

- **Auto-advanced**: the next objective shows `launching` with an
  `execution_requested` event ("auto-advanced"); no user action needed.
- **Awaiting approval**: an `awaiting_approval` banner on the ticket and a queue
  entry placeholder. The user sees `approval_reason` and an **Approve & run** button
  that queues the execution request; or **Hold** to leave it. This maps to the
  `request-approval-gate` / approval resolution surface.
- A per-objective **auto-advance toggle** (in the objective editor, doc 03) sets
  `objectives.auto_advance` so the next run will or won't gate.

Idempotency: auto-advance uses an `auto_advance:<objective_id>` key, so the UI must
not create duplicate requests — re-clicking "Approve & run" is safe and reflects
the single existing request.

---

## Data + realtime

| Region | Read | Realtime |
| --- | --- | --- |
| Active queue | `GET /execution-requests?projectId=` → `['executionRequests', projectId]` | `execution_request` insert/update → row status/age; drives topbar ⚠ for failures |
| Runner status | `GET /runner/status` (local backend) → `['runner','status']` | local poll + `execution_request` claim deltas |
| Objective state mirror | `['ticket', id]` | `objective` deltas (queued→launching→executing) |
| Approval gates | `ticket_events` `awaiting_approval` | event delta → banner |

Status transitions stream from `entity_changes`, so the queue reflects a remote
runner claiming and launching a request in real time.

---

## States

- **Empty queue:** "Nothing queued" + `ovld runner status` hint.
- **Queued but no runner:** highlight the gap; show `ovld runner start` fallback.
- **Failed launch:** red row with `last_error` and the exact repair (most common:
  no working directory → `ovld add-cwd`); **Retry** and **Clear** offered.
- **Stale claim:** a claim past its expiry shows "claim expired — retryable" and is
  reclaimable.
- **No local backend:** the runner-status panel explains the web app can queue but
  cannot observe/launch a local runner without the local process; queue operations
  still work via REST.

---

## Capability gating

- Queue operations gated by RBAC `execution_request:create` / `:claim` / clear when
  Group 1 is installed.
- Remote/SSH targets are display-only for now (per runner spec deferral); the target
  picker shows `local` targets and lists future remote targets read-only.

---

## Acceptance criteria

- A user can queue a run for an objective from the board or ticket detail, choosing
  agent/model/effort, and see it appear in the queue as `queued`.
- When a local `ovld runner` claims and launches the request, the queue row and the
  objective state update live to `launching`/`executing` with no refresh.
- A queued request with no polling runner clearly tells the user to run
  `ovld runner once`/`start`, with a copyable command.
- A failed launch shows the exact repair path (e.g. missing working directory) and
  can be retried or cleared.
- The user can identify and clear stale/active execution requests.
- Auto-advance with `auto_advance=false` produces an approval gate the user can
  approve to continue, and approving twice does not double-queue (idempotent).
</content>
