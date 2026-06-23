---
description: Connect this session to another Overlord mission by mission ID
argument-hint: <mission_id>
disable-model-invocation: true
---

Connect this session to another Overlord mission.

Treat `$ARGUMENTS` as the target mission ID.
If no mission ID was provided, ask the user for one and stop.


Run:
`ovld protocol connect --mission-id <missionId>`

Rules:
- Use `connect`, not `attach`.
- Do not load extra mission context unless the user explicitly asks for it.
- After the command succeeds, report the returned `SESSION_KEY` and confirm that future updates should use that mission.


