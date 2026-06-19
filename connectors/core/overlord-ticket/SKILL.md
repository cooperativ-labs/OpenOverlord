---
name: overlord-ticket
description: Shared Overlord ticket workflow protocol for connector plugins, covering both Overlord-launched tickets and chat-invoked Overlord work.
---

# Overlord Ticket

Use this core whenever an agent connector needs to work with Overlord, whether the session was launched by Overlord Desktop/CLI or the user asks from chat to engage with Overlord.

Connector adapters may add harness-specific commands, hooks, MCP tools, or launch flags, but they must not replace the lifecycle rules in this core.

## Mode 1: Launched From Overlord Desktop Or CLI

Use this mode when the prompt already contains a ticket ID or explicitly says the session was launched by Overlord.

1. Attach first with `ovld protocol attach --ticket-id <ticket_id>`.
2. The attach response prints JSON to stdout containing `session.sessionKey`. The CLI also persists this key automatically so subsequent `ovld protocol` commands in the same working directory resolve it without `--session-key`. If auto-resolution fails, pass `--session-key <sessionKey>` explicitly on every subsequent call.
3. Treat the Overlord ticket prompt as authoritative for the objective, constraints, and delivery target.
4. Post updates while working: `ovld protocol update --session-key <sessionKey> --ticket-id <ticket_id> --summary "..." --phase execute`.
   During long mechanical stretches with nothing meaningful to post, send `ovld protocol heartbeat --session-key <sessionKey> --ticket-id <ticket_id> [--phase execute] [--percent <0-100>] [--note "..."]` instead of an empty update.
5. Follow-up messages after the initial ticket are captured automatically by the installed `UserPromptSubmit` hook and stay in discussion intent while the ticket is in review. Do not post `user_follow_up` manually unless the hook is unavailable.
6. If blocked, call `ovld protocol ask --session-key <sessionKey> --ticket-id <ticket_id> --question "..."` and stop.
7. Deliver last with `ovld protocol deliver --session-key <sessionKey> --ticket-id <ticket_id> --summary "..."`, including `changeRationales` only for meaningful behavioral file changes made as part of this ticket.

For full command syntax, flags, phase values, and event types see [reference/cli.md](reference/cli.md).

## Tickets vs Objectives

**Tickets** represent whole features or goals. **Objectives** are the individual steps to implement that goal — one objective equals one agent prompt.

Example:
```
Ticket: add CLI command for editing user profile
 - Objective 1: draft plan for this command
 - Objective 2: implement phase 1 of plan
 - Objective 3: implement phase 2 of plan
 - Objective 4: update documentation
```

When to create a ticket vs an objective:
- **Create a new ticket** when the user describes a distinct feature, bug, or goal that stands on its own.
- **Add objectives to an existing ticket** when the work is a sequential step toward the same feature or goal already tracked in a ticket.

To add further objectives to an existing ticket (Mode 2):
```
ovld protocol add-objectives --ticket-id <ticket_id> --objectives-json '[{"objective":"..."},{"objective":"..."}]'
```

## Objective Submission vs Execution

Discussing or otherwise opening a ticket from within a chat should cause the draft objective to be marked **submitted** — this signals the ticket is in active discussion with an agent, but not yet being executed. Only an explicit order to execute (e.g. "execute this", "do this", "start working on it") should cause you to **attach** to the ticket and trigger execution.

- **Discussing / opening a ticket** → `ovld protocol discuss-objective --ticket-id $TICKET_ID` (draft → submitted, no session).
- **Creating a ticket** via `ovld protocol create` keeps the objective in `draft` state.
- **Explicitly ordered to execute** → `ovld protocol attach --ticket-id $TICKET_ID` (draft/submitted → executing, session begins).

Do not attach to a ticket just because it was mentioned or opened in conversation. Only attach when the user clearly asks you to execute the work.

## Mode 2: Asked From Chat To Use Overlord

Use this mode when the conversation starts normally and the user asks the agent to create, inspect, connect to, or otherwise use Overlord.

1. If the user wants to create tickets (and does not ask to start execution), run `ovld protocol create --agent <agent-identifier> --objectives-json '[{"objective":"..."}]'`.
   - When `--session-key` and `--ticket-id` are provided, it creates a follow-up draft.
   - When session flags are omitted, it resolves the project by matching current working directory (or `--working-directory`) to Overlord project resource directories, then creates a standalone draft.
   - Pass multiple items in `--objectives-json` when creating ordered steps for the same feature or goal.
   - If the user wants to **add more objectives to an existing ticket** (not create a new ticket), use `ovld protocol add-objectives --ticket-id <ticket_id> --objectives-json '[{"objective":"..."}]'` instead.
2. Default to `create` for new tickets. Only use `ovld protocol prompt --agent <agent-identifier> --objectives-json '[{"objective":"..."}]'` when the user explicitly asks to create and execute immediately.
   `prompt` creates the ticket in `execute` status and attaches immediately.
3. If the user already has a ticket ID and only wants to inspect it, run `ovld protocol load-context --ticket-id <ticket_id>`.
   When you open or discuss an existing ticket that has a draft objective, submit it with `ovld protocol discuss-objective --ticket-id <ticket_id>`.
4. If the user wants to route the current session onto an existing ticket by ID, run `ovld protocol connect --ticket-id <ticket_id>`.
5. If the user wants to establish a persistent session with a ticket by ID, run `ovld protocol attach --ticket-id <ticket_id>`.
6. If the user wants to find a ticket but does not know the ID, run `ovld protocol search-tickets --query "..." --status next-up,execute` and ask the user to confirm.
7. If you need to understand project routing before prompting, use `ovld protocol discover-project`.
8. If you need other lifecycle commands or flags, run `ovld protocol help` and use the real subcommand list instead of guessing.
9. Once you attach to a ticket, switch back to Mode 1 and follow the full ticket lifecycle.

For ticket creation examples, project discovery, and `--objectives-json` format see [reference/cli.md](reference/cli.md).

## Change Rationales

Always include `changeRationales` when delivering. Optionally include them on updates during long-running work.

Overlord captures *which* files changed for you: the CLI records a VCS baseline when you attach and, at `deliver`, automatically reports the files this run changed (current `git status` minus that baseline). You do **not** need to enumerate changed files by hand. Your job is to provide a rationale for each meaningful change you made for this ticket. Do not include other tracked worktree changes in the delivery report, payload, artifacts, or `changeRationales`, even to label them as pre-existing, concurrent, or unrelated. If `deliver` rejects with a missing-rationale error for a file you did not change for this ticket, do not add a rationale for that file; investigate attribution, send a progress update if needed, and resolve the delivery input so only this ticket's changes are reported. Record only meaningful behavioral changes; skip formatting-only noise. Do not send `file_changes` as an artifact.

If your run genuinely changed no files (investigation, discussion, or read-only work), deliver with `--no-file-changes` to declare that explicitly and skip rationale-coverage enforcement.

Each rationale entry requires these fields: `file_path`, `label`, `summary`, `why`, `impact` — all strings. Do **not** use `filePath` or `rationale`; those are a different internal shape and will cause a validation error.

Oversized inline `--*-json` arguments (including `--change-rationales-json`) are **rejected** by the CLI. For more than a handful of rationale entries, pipe JSON via `--change-rationales-file -` with a single-quoted heredoc (`<<'EOF'`) and keep the delivery `--summary` inline. The same rule applies to `--payload-json`, `--artifacts-json`, and other `--*-json` flags — use the paired `--*-file -` flag instead.

If `heartbeat` succeeds but `deliver` or `update` fails unexpectedly, the session is likely fine. Retry with rationales (or other large JSON) on stdin rather than inline JSON.

For the `record-change-rationales` command and full payload shape with optional `hunks` see [reference/cli.md](reference/cli.md).

## Rules

- Always attach first and always deliver last once you are on a ticket.
- Use `ovld protocol` commands and the connector's native commands/tools instead of ad hoc scripts.
- Do not invent protocol subcommands. Use `ovld protocol help` when unsure.
- Include at least one progress update before delivering.
- After delivery, answer ordinary questions and clarifications in discussion mode; hook capture records those user turns as `user_follow_up` activity.
- When explicit follow-up implementation starts on a delivered/review ticket and no live session exists, call `ovld protocol resume-follow-up --ticket-id <ticket_id> --summary "Beginning follow-up work."` and use the returned session key before code changes.
- When explicit follow-up implementation starts while a live delivered session still accepts updates, call `ovld protocol update --begin-follow-up-work --follow-up-intent execution --summary "Beginning follow-up work."` before code changes or `--phase execute`.
- During follow-up execution, post progress updates and record change rationales for each file modified, the same as during initial execution.
- Record important non-file decisions with `--event-type decision` or `--event-type discussion_summary`.
- The `summary` in deliver is what the PM reads first, so write it as a narrative, not a command list.
- When a summary or question contains backticks, `$vars`, or other shell-special characters, always use `--summary-file -` (or `--question-file -`) with a single-quoted heredoc (`<<'EOF'`). Never retry by stripping or escaping content — pipe stdin instead. See [reference/shell-escaping.md](reference/shell-escaping.md).
- Use `write-context` for facts a future agent session should know.
- If a protocol or MCP call fails with auth/session errors, run `ovld auth repair` yourself before asking the user to log in again or proceed without Overlord updates.
- If you must run `ovld auth login`, `--organization-id <id>` is optional — it validates/scopes that login or command but does not create a stored default organization.
- Do not add or commit changes unless the user explicitly asks you to commit.
- Delivery is the concluding step. After delivering, stop implementation work unless the user explicitly asks for follow-up execution; once follow-up execution is complete, deliver again.

## Reference

- [reference/cli.md](reference/cli.md) — Full protocol command syntax, flags, phases, ticket creation, and project discovery
- [reference/mcp.md](reference/mcp.md) — MCP tool naming, key casing, hosted vs local shim defaults
- [reference/devices.md](reference/devices.md) — Device fingerprints, project resources, and `--for-human`
- [reference/context.md](reference/context.md) — Shared state, attachments, and large artifact policy
- [reference/shell-escaping.md](reference/shell-escaping.md) — Heredoc stdin piping for special characters in summaries and payloads

<!-- version: 0.5.14 -->
