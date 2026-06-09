---
description: Create a draft Overlord ticket from the current conversation
argument-hint: <objective or raw flags>
disable-model-invocation: true
---

Create a draft Overlord ticket from the user's request.


Use `$ARGUMENTS` as the input.
If it already contains flags such as `--title`, `--priority`, `--project-id`, `--assigned-to`, or `--for-human`, pass those flags through after `ovld protocol create --agent claude-code`.
Otherwise, treat `$ARGUMENTS` as the objective text and run:
`ovld protocol create --agent claude-code --objectives-json '[{"objective":"<objective>"}]'`

If no objective was provided, ask the user for one and stop.

After the command succeeds, report the new `TICKET_ID`.

