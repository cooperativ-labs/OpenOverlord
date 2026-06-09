---
description: Attach this Claude Code session to an Overlord ticket
argument-hint: <ticket_id>
disable-model-invocation: true
---

Attach this session to an Overlord ticket for execution.

Treat `$ARGUMENTS` as the target ticket ID.
If no ticket ID was provided, ask the user for one and stop.

Run:
`ovld protocol attach --ticket-id <ticketId>`

Rules:
- Use `attach` only when the user explicitly wants this Claude session to execute ticket work.
- After the command succeeds, report the returned `SESSION_KEY`.
- Follow the `overlord-ticket` skill workflow after attaching: update while working, ask exactly one blocking question if blocked, and deliver last.
