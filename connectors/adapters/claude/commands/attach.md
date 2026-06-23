---
description: Attach this Claude Code session to an Overlord mission
argument-hint: <mission_id>
disable-model-invocation: true
---

Attach this session to an Overlord mission for execution.

Treat `$ARGUMENTS` as the target mission ID.
If no mission ID was provided, ask the user for one and stop.

Run:
`ovld protocol attach --mission-id <missionId>`

Rules:
- Use `attach` only when the user explicitly wants this Claude session to execute mission work.
- After the command succeeds, report the returned `SESSION_KEY`.
- Follow the `overlord-mission` skill workflow after attaching: update while working, ask exactly one blocking question if blocked, and deliver last.
