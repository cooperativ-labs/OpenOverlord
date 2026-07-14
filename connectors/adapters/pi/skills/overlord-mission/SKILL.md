---
name: overlord-mission
description: PI adapter for the shared Overlord mission workflow.
---

<!-- @connector-core -->

## PI Adapter Notes

- Agent identifier: `pi` for `ovld protocol create` and `ovld protocol prompt`.
- Model selection: pass PI provider-qualified model IDs with `--model <provider/id>` and thinking separately with `--thinking <off|minimal|low|medium|high|xhigh|max>`.
- Follow-up capture: the installed PI extension records ordinary user input as `UserPromptSubmit` after the launch-injected turn. Do not manually publish `user_follow_up` unless the extension is unavailable.
- Native resume: the PI extension reports its native session ID; Overlord review can reopen it with `pi --session <id>`.
- PI does not expose a native permission-request event. Do not claim permission activity is captured automatically.
- Authentication: use PI's provider login or API-key configuration for models, and shared `ovld auth` credentials, Overlord-launched environment variables, or `Overlord_USER_TOKEN` / `OVLD_USER_TOKEN` for protocol calls.

## PI Command Mapping

- Create draft mission: `ovld protocol create --agent pi --objectives-json '[{"objective":"..."}]'`
- Create and execute immediately: `ovld protocol prompt --agent pi --objectives-json '[{"objective":"..."}]'`
- Load context without a session: `ovld protocol load-context --mission-id <mission_id>`
- Attach for execution: `ovld protocol attach --mission-id <mission_id>`
- Resume delivered work for follow-up execution: `ovld protocol resume-follow-up --mission-id <mission_id>`
