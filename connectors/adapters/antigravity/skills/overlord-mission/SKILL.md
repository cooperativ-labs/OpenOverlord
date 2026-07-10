---
name: overlord-mission
description: Antigravity adapter for the shared Overlord mission workflow.
---

<!-- @connector-core -->

## Antigravity Adapter Notes

- Agent identifier: `antigravity` for `ovld protocol create` and `ovld protocol prompt`.
- Follow-up capture: the installed `PreInvocation` hook (Antigravity's closest analog to the canonical `UserPromptSubmit` hook) records ordinary post-delivery user turns. Do not manually publish `user_follow_up` unless the hook is unavailable.
- Permission capture: the installed `PreToolUse` hook (Antigravity's closest analog to the canonical `PermissionRequest` hook) publishes permission activity through `ovld protocol` and always allows the underlying tool call — it only records, it never gates.
- Model selection: do not pass `--model` or an effort/thinking flag. Antigravity manages model selection internally; the launch prompt only carries mission/objective context.
- MCP bridge: the installed `overlord` MCP server exposes the hosted-compatible `overlord_*` mission tool catalog backed by `ovld protocol`.
- Slash commands: each file under `skills/` (this skill plus `attach`, `connect`, `load`, `create`, `prompt`, `discuss-objective`, `add-objectives`, `record-work`, `spawn`) is auto-registered by Antigravity as a `/<name>` command.
- Authentication: use shared `ovld auth` credentials, Overlord-launched environment variables, or `Overlord_USER_TOKEN` / `OVLD_USER_TOKEN`.
- Do not create or rely on a repository-local `AGENTS.md` for Overlord itself.

## Antigravity Command Mapping

- Create draft mission: `/create` or `ovld protocol create --agent antigravity --objectives-json '[{"objective":"..."}]'`
- Create and execute immediately: `/prompt` or `ovld protocol prompt --agent antigravity --objectives-json '[{"objective":"..."}]'`
- Load context without a session: `/load` or `ovld protocol load-context --mission-id <mission_id>`
- Submit a draft objective for discussion: `/discuss-objective` or `ovld protocol discuss-objective --mission-id <mission_id>`
- Connect this session: `/connect` or `ovld protocol connect --mission-id <mission_id>`
- Attach for execution: `/attach` or `ovld protocol attach --mission-id <mission_id>`
- Resume delivered work for follow-up execution: `ovld protocol resume-follow-up --mission-id <mission_id>`
- Add ordered follow-up objectives: `/add-objectives` or `ovld protocol add-objectives --mission-id <mission_id> --objectives-json '[{"objective":"..."}]'`
- Record completed work as a follow-up mission: `/record-work` or `ovld protocol record-work --agent antigravity --objectives-json '[{"objective":"..."}]'`
