---
name: overlord-mission
description: Cursor adapter for the shared Overlord mission workflow.
---

<!-- @connector-core -->

## Cursor Adapter Notes

- Agent identifier: `cursor` for `ovld protocol create` and `ovld protocol prompt`.
- Native commands: `/attach`, `/connect`, `/load`, `/create`, `/prompt`, `/discuss-objective`, `/add-objectives`, `/record-work`.
- Follow-up capture: the installed `beforeSubmitPrompt` hook records ordinary post-delivery user messages. Do not manually publish `user_follow_up` unless the hook is unavailable.
- MCP bridge: the installed `overlord` MCP server exposes attach, update, and deliver helpers backed by `ovld protocol`.
- Authentication: use shared `ovld auth` credentials, Overlord-launched environment variables, or `Overlord_USER_TOKEN` / `OVLD_USER_TOKEN`.

## Cursor Command Mapping

- Create draft mission: `/create` or `ovld protocol create --agent cursor --objectives-json '[{"objective":"..."}]'`
- Create and execute immediately: `/prompt` or `ovld protocol prompt --agent cursor --objectives-json '[{"objective":"..."}]'`
- Load context without a session: `/load` or `ovld protocol load-context --mission-id <mission_id>`
- Submit a draft objective for discussion: `/discuss-objective` or `ovld protocol discuss-objective --mission-id <mission_id>`
- Connect this session: `/connect` or `ovld protocol connect --mission-id <mission_id>`
- Attach for execution: `/attach` or `ovld protocol attach --mission-id <mission_id>`
- Resume delivered work for follow-up execution: `ovld protocol resume-follow-up --mission-id <mission_id>`
- Add ordered follow-up objectives: `/add-objectives` or `ovld protocol add-objectives --mission-id <mission_id> --objectives-json '[{"objective":"..."}]'`
