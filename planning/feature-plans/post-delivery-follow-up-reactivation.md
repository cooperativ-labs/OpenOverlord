# Post-Delivery Follow-Up Reactivation

**Status:** Proposal
**Problem observed:** A user sent a follow-up message after an objective had
already been delivered. The previous session key had expired, `attach` failed
with `No active objective found on ticket`, and the agent still made a local file
change that could not be recorded against the completed objective.

## 1. Goal

Support the normal human workflow:

1. An agent delivers an objective.
2. The user keeps chatting in the same agent session.
3. Ordinary user messages are recorded to the ticket activity feed.
4. If the follow-up is discussion only, the objective stays complete.
5. If the follow-up asks for more implementation, the same completed objective
   is explicitly reopened for follow-up execution, accepts progress events and
   changed files, then requires a new delivery.

The mechanism should work even when:

- the original `agent_sessions` row is ended by delivery;
- the old `SESSION_KEY` is invalid or unavailable;
- the connector hook fires before the agent has decided whether the message is
  discussion or execution;
- the ticket has no non-complete objective.

## 2. Current Behavior And Gap

The repo already has several intended pieces:

- Connector manifests declare `followUpHook`.
- Claude, Codex, and Cursor connector scripts call
  `ovld protocol hook-event --hook-type UserPromptSubmit`.
- `ticket_events.type = user_follow_up` is a closed vocabulary value.
- `objectives.state = pending_delivery` exists and is documented as the state
  for follow-up work after a prior delivery.
- `agent_sessions.delivery_state = pending_redelivery` exists.
- `update --begin-follow-up-work --follow-up-intent execution` exists in the
  protocol docs and service shape.

The practical gaps are:

- `ovld protocol hook-event` is referenced by connector scripts and docs, but
  the current CLI command switch does not implement it.
- `update` requires a live session key; `deliver` sets `agent_sessions.ended_at`,
  so `getSessionByKey()` rejects the old key after delivery.
- `attach` resolves a non-complete objective. Once all objectives are complete,
  it fails instead of offering an explicit follow-up-resume path.
- Follow-up capture and follow-up execution are coupled too tightly to an
  active session. User messages should be recordable without reopening work.

## 3. Recommended Model

Use two separate operations:

1. **Record follow-up message**: always append a `user_follow_up` ticket event.
   This is discussion by default and does not change objective state.
2. **Begin follow-up execution**: explicitly create or resume a working session
   on a delivered objective, transition that objective from `complete` to
   `pending_delivery`, and allow normal `update` / changed-file / `deliver`
   flow.

Do not add a new `objectives.state` value named `reactivated` or `updating`.
`pending_delivery` already models "this delivered objective has follow-up work
that needs another delivery." Adding a new state would be a closed vocabulary
change with broad UI, schema, test, and contract impact for little additional
semantic value.

Use "reactivated" as an event/session concept, not an objective state.

## 4. Activity Capture: Implement `hook-event`

Add the missing protocol service and CLI command:

```bash
ovld protocol hook-event \
  --hook-type UserPromptSubmit \
  --ticket-id coo:5 \
  --prompt-file - \
  --turn-index 12 \
  --external-session-id <native-session-id> \
  --session-key <optional-session-key>
```

Behavior for `UserPromptSubmit`:

- Resolve the ticket by `--ticket-id`.
- Resolve an objective in this order:
  1. active objective: `executing`, `pending_delivery`, `launching`,
     `submitted`, `draft`;
  2. objective attached to a matching session key, even if the session is ended;
  3. objective attached to a matching `external_session_id`;
  4. most recently completed objective on the ticket;
  5. null objective only if the ticket truly has no objectives.
- Resolve `session_id` if possible, but do not require a live session.
- Insert `ticket_events.type = user_follow_up`.
- Use phase `review` when the ticket is delivered/reviewing and no active
  execution is underway; use `execute` only when an active execution session is
  already present.
- Store hook metadata in `payload_json`, including `hookType`, `turnIndex`,
  `externalSessionId`, and a hash of the prompt for dedupe.
- Do not change objective state.
- Do not require `--session-key`.
- If `--session-key` is provided and expired, use it only as attribution
  evidence; do not reject the event solely because the session has ended.

Idempotency:

- Create an idempotency key such as
  `hook.UserPromptSubmit:<ticketId>:<externalSessionId|sessionId|unknown>:<turnIndex>:<promptHash>`.
- If the hook fires more than once for the same turn, return the existing event.

Connector requirements:

- Keep using `UserPromptSubmit` where the harness supports it.
- Prefer `--prompt-file -` over inline `--prompt` so large or shell-sensitive
  user messages are preserved exactly.
- Pass `--external-session-id` whenever the harness exposes one.
- Pass `--session-key` only when available; it must be optional.
- Preserve existing skip logic that avoids recording Overlord's initial injected
  prompt as a user follow-up.

This gives the activity feed a faithful record of post-delivery user turns even
when no work is reopened.

## 5. Execution Reactivation: Add A Resume Path

Add an explicit protocol path for execution follow-up on a completed objective.
Two compatible API shapes are possible.

### Preferred Shape: `resume-follow-up`

```bash
ovld protocol resume-follow-up \
  --ticket-id coo:5 \
  --objective-id <optional-objective-id> \
  --agent codex \
  --external-session-id <native-session-id> \
  --summary-file -
```

Returns the same shape as `attach`, including a new `sessionKey`.

Behavior:

1. Resolve the ticket.
2. Pick the objective:
   - explicit `--objective-id`, or
   - the objective associated with the latest `user_follow_up` from this
     external session, or
   - the most recently completed objective.
3. Reject if another objective on the ticket is already `executing` or
   `pending_delivery`, unless this command is idempotently resuming that same
   objective.
4. Create a new `agent_sessions` row with:
   - `phase = execute`;
   - `delivery_state = pending_redelivery`;
   - `ended_at = null`;
   - `external_session_id` set when provided.
5. Transition the objective:
   - `complete -> pending_delivery`;
   - clear `completed_at`;
   - increment `revision`.
6. Move the ticket to an execute-type status.
7. Insert a `ticket_events.type = update` event with payload:
   `{ "followUpIntent": "execution", "reactivated": true }`.
8. Return attach context so the agent can continue with normal workflow.

After this point, regular commands work:

```bash
ovld protocol update --session-key <new> --ticket-id coo:5 --summary "..." --phase execute
ovld protocol deliver --session-key <new> --ticket-id coo:5 --summary "..."
```

### Alternative Shape: Extend `attach`

```bash
ovld protocol attach --ticket-id coo:5 --begin-follow-up-work
```

This is smaller for agents, but it makes `attach` more ambiguous. Today `attach`
means "start active work on the current active objective." Adding a follow-up
flag is acceptable, but it should be explicit. Do not make a bare `attach`
implicitly reopen a completed objective; that would turn accidental post-review
activity into implementation.

Recommended compromise:

- `attach` without flags continues to fail when all objectives are complete.
- `attach --begin-follow-up-work` delegates to the same service logic as
  `resume-follow-up`.
- `resume-follow-up` remains as the more readable command and can be used by UI,
  MCP, and connectors.

## 6. State Semantics

Use these state meanings:

- `complete`: no active implementation is expected; discussion events may still
  be recorded.
- `pending_delivery`: the previously completed objective has new follow-up work
  and must be delivered again.

Do not transition `complete -> executing` directly. `pending_delivery` is more
accurate because it preserves the fact that the objective had a prior delivery
and now needs redelivery.

Session semantics:

- A delivered session remains ended and immutable.
- A follow-up execution creates a new live session for the same objective.
- The new session starts with `delivery_state = pending_redelivery`.
- `deliver` on the new session writes a new delivery row, sets the objective
  back to `complete`, and ends only the new session.

This keeps the delivery history auditable instead of mutating the old session
back to life.

## 7. File Change Handling

Changed-file tracking should only happen after execution reactivation. A pure
`UserPromptSubmit` event does not create `changed_files` rows.

When follow-up execution starts:

- The new session id becomes the `changed_files.session_id`.
- The objective id remains the original completed objective id.
- Delivery validation checks changed files for the new session.
- Prior delivery rationales remain attached to prior delivery/session history.

This makes the review story clear: "delivery 1 changed A; follow-up delivery 2
changed B."

## 8. UI And Agent Workflow

Agent instructions:

1. After delivery, keep answering ordinary questions in discussion mode.
2. The connector hook records every user follow-up to activity.
3. If the user asks for implementation or file edits, call:

```bash
ovld protocol resume-follow-up --ticket-id <id> --summary "Beginning follow-up work."
```

4. Use the returned `sessionKey` for updates and delivery.
5. Deliver again when the follow-up work is complete.

UI:

- Show post-delivery `user_follow_up` events in review activity.
- Add a "Resume follow-up" action on delivered objectives.
- When an objective is `pending_delivery`, show a clear "Follow-up needs
  delivery" state and route the primary action to deliver/review.
- Do not hide discussion events simply because the objective is complete.

## 9. Contract Impact

This is a contract-touching change.

Required contract/doc updates:

- `CONTRACT.md`: clarify that `UserPromptSubmit` may record activity without a
  live session, and that explicit follow-up execution reopens `complete` as
  `pending_delivery`.
- `contract/protocol-commands.yaml`: add `hookEvent` if missing from the
  machine-readable command list; add `resumeFollowUp` or the explicit
  `attach --begin-follow-up-work` flag.
- `cli/docs/03-agent-protocol.md`: document post-delivery discussion vs
  follow-up execution.
- `connectors/docs/05-connectors-and-agent-plugins.md`: require supported
  connectors to implement `UserPromptSubmit` capture with optional session key.
- `automations/src/objective-manager/objective-lifecycle.md`: align the
  implementation-specific lifecycle note with the chosen command names.
- Connector skill/reference files: update instructions so agents recover from
  ended sessions by `resume-follow-up`, not by retrying bare `attach`.

No database migration is required if existing values are reused:

- `ticket_events.type = user_follow_up`
- `objectives.state = pending_delivery`
- `agent_sessions.delivery_state = pending_redelivery`

A migration is required only if implementation needs new persisted columns for
hook dedupe or native turn IDs. Prefer using existing `idempotency_keys` and
`ticket_events.payload_json` first.

## 10. Implementation Steps

1. Implement protocol service `recordHookEvent()` for `UserPromptSubmit`.
2. Add CLI parsing for `ovld protocol hook-event`.
3. Make hook-event accept optional/expired session attribution.
4. Add tests proving post-delivery `UserPromptSubmit` creates a
   `user_follow_up` event against the completed objective.
5. Implement service `resumeFollowUp()` using the state transition
   `complete -> pending_delivery` and creating a new live session.
6. Add CLI command `resume-follow-up` and/or
   `attach --begin-follow-up-work`.
7. Add tests proving:
   - bare `attach` still fails when all objectives are complete;
   - explicit resume succeeds;
   - update with the new session accepts changed files;
   - delivery after follow-up returns the objective to `complete`;
   - discussion-only follow-ups do not reopen the objective.
8. Update connector docs and installed skills.
9. Update web UI affordances for activity and pending delivery.

## 11. Acceptance Criteria

Reproduce the original failure as a passing flow:

1. Complete a ticket objective.
2. Send a follow-up user message in the same agent harness.
3. Confirm the activity feed shows a `user_follow_up` event.
4. Confirm the objective is still `complete`.
5. Ask the agent to make a file edit.
6. Agent calls `resume-follow-up` and receives a new session key.
7. Objective moves to `pending_delivery`.
8. Agent posts updates and changed-file rationales with the new key.
9. Agent delivers again.
10. Objective returns to `complete`, with both deliveries preserved.

Failure-mode acceptance:

- Expired old session key does not prevent `UserPromptSubmit` capture.
- Bare `attach` does not silently reopen completed work.
- Duplicate hook events for the same turn do not duplicate activity feed rows.
- A second follow-up execution cannot start while another objective on the same
  ticket is already `executing` or `pending_delivery`.

