---
description: Load Overlord mission context without creating a new session
---

Load Overlord mission context without attaching to the mission.

Treat the command argument as the target mission ID.
If no mission ID was provided, ask the user for one and stop.

Run:
`ovld protocol load-context --mission-id <missionId>`

Rules:
- Use `load-context`, not `attach`.
- Do not create or switch sessions.
- Summarize the returned mission details, history, artifacts, and shared context for the user.
