---
description: Mark an Overlord draft objective as submitted for discussion
argument-hint: <ticket_id>
disable-model-invocation: true
---

Submit a draft objective for active discussion without attaching an execution session.

Treat `$ARGUMENTS` as the target ticket ID.
If no ticket ID was provided, ask the user for one and stop.

Run:
`ovld protocol discuss-objective --ticket-id <ticketId>`

Rules:
- Use `discuss-objective`, not `attach`, when the user is opening or discussing a ticket but has not asked Claude to execute it.
- Do not create or switch sessions.
- Summarize the returned objective state for the user.
