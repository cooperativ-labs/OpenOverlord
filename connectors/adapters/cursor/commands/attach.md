Attach this Cursor session to an Overlord ticket for execution.

Use the text after `/attach` as the ticket ID.
If no ticket ID was provided, ask the user for one and stop.

Run:
`ovld protocol attach --ticket-id <ticketId>`

Rules:
- Use attach only when the user explicitly wants this session to execute ticket work.
- After the command succeeds, report the returned `SESSION_KEY`.
- Follow the `overlord-ticket` skill workflow after attaching: update while working, ask exactly one blocking question if blocked, and deliver last.
