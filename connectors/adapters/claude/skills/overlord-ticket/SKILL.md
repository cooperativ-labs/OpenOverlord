---
name: overlord-ticket
description: Claude Code adapter overlay for the shared Overlord ticket workflow.
---

# Claude Overlord Ticket

This Claude Code skill is the adapter-specific entrypoint for the shared Connector Core at `connectors/core/overlord-ticket/SKILL.md`.

When working inside an Overlord source checkout, read and follow that core before using the Claude-specific notes below. When this plugin is packaged for installation, the setup/build step must materialize the same core files into the installed plugin so the Claude skill remains self-contained.

## Claude Adapter Notes

- Agent identifier: `claude-code` for `ovld protocol create` and `ovld protocol prompt`.
- Native commands: `/overlord:attach`, `/overlord:connect`, `/overlord:load`, `/overlord:create`, `/overlord:prompt`, `/overlord:discuss-objective`, `/overlord:add-objectives`, `/overlord:record-work`.
- Follow-up capture: the installed `UserPromptSubmit` hook records ordinary post-delivery user messages. Do not manually publish `user_follow_up` unless the hook is unavailable.
- Permission capture: the installed `PermissionRequest` hook publishes permission activity through `ovld protocol`.
- Stop hook: the installed `Stop` hook may print pending-delivery guidance but does not deliver for you.
- Authentication: the plugin `user_token` config is passed to child `ovld protocol` calls as `Overlord_USER_TOKEN`, after preserving existing `Overlord_USER_TOKEN` / `OVLD_USER_TOKEN` environment fallback behavior.

## Claude Command Mapping

- Create draft ticket: `/overlord:create` or `ovld protocol create --agent claude-code --objectives-json '[{"objective":"..."}]'`
- Create and execute immediately: `/overlord:prompt` or `ovld protocol prompt --agent claude-code --objectives-json '[{"objective":"..."}]'`
- Load context without a session: `/overlord:load` or `ovld protocol load-context --ticket-id <ticket_id>`
- Submit a draft objective for discussion: `/overlord:discuss-objective` or `ovld protocol discuss-objective --ticket-id <ticket_id>`
- Connect this session: `/overlord:connect` or `ovld protocol connect --ticket-id <ticket_id>`
- Attach for execution: `/overlord:attach` or `ovld protocol attach --ticket-id <ticket_id>`
- Resume delivered work for follow-up execution: `ovld protocol resume-follow-up --ticket-id <ticket_id>`
- Add ordered follow-up objectives: `/overlord:add-objectives` or `ovld protocol add-objectives --ticket-id <ticket_id> --objectives-json '[{"objective":"..."}]'`

## References

- Shared source: `connectors/core/overlord-ticket/SKILL.md`
- Shared command reference: `connectors/core/overlord-ticket/reference/cli.md`
- Shared context and artifact reference: `connectors/core/overlord-ticket/reference/context.md`
- Shared device reference: `connectors/core/overlord-ticket/reference/devices.md`
- Shared MCP/API reference: `connectors/core/overlord-ticket/reference/mcp.md`
- Shared shell escaping reference: `connectors/core/overlord-ticket/reference/shell-escaping.md`
