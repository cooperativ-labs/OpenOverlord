Create a new Overlord mission and attach immediately for execution.

Use the text after `/prompt` as the objective unless raw flags are present.

If it already contains flags such as `--title`, `--priority`, `--project-id`, `--assigned-to`, or `--for-human`, pass those flags through after:
`ovld protocol prompt --agent cursor`

Otherwise, treat the input as the objective text and run:
`ovld protocol prompt --agent cursor --objectives-json '[{"objective":"<objective>"}]'`

If no objective was provided, ask the user for one and stop.

After the command succeeds, report the new `MISSION_ID` and `SESSION_KEY`.
