---
description: Append ordered objectives to an existing Overlord mission
argument-hint: <mission_id> <ordered objective steps>
disable-model-invocation: true
---

Append ordered objectives to an existing mission.

Use this when the prompts are sequential steps toward the same feature or goal. Create separate missions when prompts represent different features or goals.

Run:
`ovld protocol add-objectives --mission-id <mission_id> --objectives-json '[{"objective":"Step one"},{"objective":"Step two"}]'`

Index 0 is the first newly added objective to execute; later indexes queue after it.

