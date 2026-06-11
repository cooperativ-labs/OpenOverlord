Append ordered objectives to an existing ticket.

Use this when the prompts are sequential steps toward the same feature or goal. Create separate tickets when prompts represent different features or goals.

Run:
`ovld protocol add-objectives --ticket-id <ticket_id> --objectives-json '[{"objective":"Step one"},{"objective":"Step two"}]'`

Index 0 is the first newly added objective to execute; later indexes queue after it.
