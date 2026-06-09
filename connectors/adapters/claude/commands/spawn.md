---
description: (Deprecated — use /prompt instead) Create a new Overlord ticket
argument-hint: <objective or raw flags>
disable-model-invocation: true
---

This command is deprecated. Use `/overlord:prompt` instead.

Create a new Overlord ticket from the user's request.

Use `$ARGUMENTS` as the input.
If it already contains flags such as `--title`, `--priority`, `--project-id`, `--assigned-to`, or `--for-human`, pass those flags through after `ovld protocol prompt --agent claude-code`.
Otherwise, treat `$ARGUMENTS` as the objective text and run:
`ovld protocol prompt --agent claude-code --objectives-json '[{"objective":"<objective>"}]'`

If no objective was provided, ask the user for one and stop.

After the command succeeds, report the new `TICKET_ID` and `SESSION_KEY`.

