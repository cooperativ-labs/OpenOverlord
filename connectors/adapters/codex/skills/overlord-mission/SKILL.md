---
name: overlord-mission
description: Codex adapter for the shared Overlord mission workflow.
---

<!-- @connector-core -->

## Codex Adapter Notes

- Agent identifier: `codex` for `ovld protocol create` and `ovld protocol prompt`.
- Follow-up capture: the installed `UserPromptSubmit` hook records ordinary post-delivery user messages. Do not manually publish `user_follow_up` unless the hook is unavailable.
- Permission capture: the installed `PermissionRequest` hook publishes permission activity through `ovld protocol`.
- Native resume: the follow-up hook reports Codex thread/session IDs from `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, or rollout files under `~/.codex/sessions`.
- MCP bridge: the installed `overlord` MCP server exposes attach, update, and deliver helpers backed by `ovld protocol`.
- Authentication: use shared `ovld auth` credentials, Overlord-launched environment variables, or `Overlord_USER_TOKEN` / `OVLD_USER_TOKEN`.
- Do not create or rely on a repository-local `AGENTS.md` for Overlord itself.

## Codex Command Mapping

- Create draft mission: `ovld protocol create --agent codex --objectives-json '[{"objective":"..."}]'`
- Create and execute immediately: `ovld protocol prompt --agent codex --objectives-json '[{"objective":"..."}]'`
- Load context without a session: `ovld protocol load-context --mission-id <mission_id>`
- Submit a draft objective for discussion: `ovld protocol discuss-objective --mission-id <mission_id>`
- Connect this session: `ovld protocol connect --mission-id <mission_id>`
- Attach for execution: `ovld protocol attach --mission-id <mission_id>`
- Resume delivered work for follow-up execution: `ovld protocol resume-follow-up --mission-id <mission_id>`
- Add ordered follow-up objectives: `ovld protocol add-objectives --mission-id <mission_id> --objectives-json '[{"objective":"..."}]'`
