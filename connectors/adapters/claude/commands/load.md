---
description: Load Overlord ticket context without creating a new session
argument-hint: <ticket_id>
disable-model-invocation: true
---

Load Overlord ticket context without attaching to the ticket.


Treat `$ARGUMENTS` as the target ticket ID.
If no ticket ID was provided, ask the user for one and stop.


Run:
`ovld protocol load-context --ticket-id <ticketId>`

Rules:
- Use `load-context`, not `attach`.
- Do not create or switch sessions.
- Summarize the returned ticket details, history, artifacts, and shared context for the user.


