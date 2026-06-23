Deprecated — use `/prompt` instead.

Create a new Overlord mission and attach immediately for execution.

Use the text after `/spawn` as the objective unless raw flags are present.

If raw flags are present, pass them through after:
`ovld protocol prompt --agent cursor`

Otherwise, treat the input as the objective text and run:
`ovld protocol prompt --agent cursor --objectives-json '[{"objective":"<objective>"}]'`
