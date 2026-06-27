---
name: overlord-mission
description: Claude Code adapter for the shared Overlord mission workflow.
---

<!-- @connector-core -->

## Claude Adapter Notes

- Agent identifier: `claude-code` for `ovld protocol create` and `ovld protocol prompt`.
- Native commands: `/overlord:attach`, `/overlord:connect`, `/overlord:load`, `/overlord:create`, `/overlord:prompt`, `/overlord:discuss-objective`, `/overlord:add-objectives`, `/overlord:record-work`.
- Follow-up capture: the installed `UserPromptSubmit` hook records ordinary post-delivery user messages. Do not manually publish `user_follow_up` unless the hook is unavailable.
- Permission capture: the installed `PermissionRequest` hook publishes permission activity through `ovld protocol`.
- Stop hook: the installed `Stop` hook may print pending-delivery guidance but does not deliver for you.
- Authentication: the plugin `user_token` config is passed to child `ovld protocol` calls as `Overlord_USER_TOKEN`, after preserving existing `Overlord_USER_TOKEN` / `OVLD_USER_TOKEN` environment fallback behavior.

## Claude Command Mapping

- Create draft mission: `/overlord:create` or `ovld protocol create --agent claude-code --objectives-json '[{"objective":"..."}]'`
- Create and execute immediately: `/overlord:prompt` or `ovld protocol prompt --agent claude-code --objectives-json '[{"objective":"..."}]'`
- Load context without a session: `/overlord:load` or `ovld protocol load-context --mission-id <mission_id>`
- Submit a draft objective for discussion: `/overlord:discuss-objective` or `ovld protocol discuss-objective --mission-id <mission_id>`
- Connect this session: `/overlord:connect` or `ovld protocol connect --mission-id <mission_id>`
- Attach for execution: `/overlord:attach` or `ovld protocol attach --mission-id <mission_id>`
- Resume delivered work for follow-up execution: `ovld protocol resume-follow-up --mission-id <mission_id>`
- Add ordered follow-up objectives: `/overlord:add-objectives` or `ovld protocol add-objectives --mission-id <mission_id> --objectives-json '[{"objective":"..."}]'`
