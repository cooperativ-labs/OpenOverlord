Attach this Cursor session to an Overlord mission for execution.

Use the text after `/attach` as the mission ID.
If no mission ID was provided, ask the user for one and stop.

Run:
`ovld protocol attach --mission-id <missionId>`

Rules:
- Use attach only when the user explicitly wants this session to execute mission work.
- After the command succeeds, report the returned `SESSION_KEY`.
- Follow the `overlord-mission` skill workflow after attaching: update while working, ask exactly one blocking question if blocked, and deliver last.
