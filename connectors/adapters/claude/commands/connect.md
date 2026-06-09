---
description: Connect this session to another Overlord ticket by ticket ID
argument-hint: <ticket_id>
disable-model-invocation: true
---

Connect this session to another Overlord ticket.

Treat `$ARGUMENTS` as the target ticket ID.
If no ticket ID was provided, ask the user for one and stop.


Run:
`ovld protocol connect --ticket-id <ticketId>`

Rules:
- Use `connect`, not `attach`.
- Do not load extra ticket context unless the user explicitly asks for it.
- After the command succeeds, report the returned `SESSION_KEY` and confirm that future updates should use that ticket.


