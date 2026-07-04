---
description: Create a new Overlord mission from the current conversation and execute it immediately
---

Create a new Overlord mission from the user's request.

Use the command argument as the input.
If it already contains flags such as `--title`, `--priority`, `--project-id`, `--assigned-to`, or `--for-human`, pass those flags through after `ovld protocol prompt --agent antigravity`.
Otherwise, treat the argument as the objective text and run:
`ovld protocol prompt --agent antigravity --objectives-json '[{"objective":"<objective>"}]'`

If no objective was provided, ask the user for one and stop.

After the command succeeds, report the new `MISSION_ID` and `SESSION_KEY`.
