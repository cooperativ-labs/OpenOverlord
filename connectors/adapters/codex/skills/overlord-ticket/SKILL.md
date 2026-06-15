---
name: overlord-ticket
description: Codex adapter overlay for the shared Overlord ticket workflow.
---

# Codex Overlord Ticket

This Codex skill is the adapter-specific entrypoint for the shared Connector Core at `connectors/core/overlord-ticket/SKILL.md`.

When working inside an Overlord source checkout, read and follow that core before using the Codex-specific notes below. When this plugin is packaged for installation, setup copies the bundled skill and reference files into the installed plugin so the runtime package is self-contained.

## Codex Adapter Notes

- Agent identifier: `codex` for `ovld protocol create` and `ovld protocol prompt`.
- Follow-up capture: the installed `UserPromptSubmit` hook records ordinary post-delivery user messages. Do not manually publish `user_follow_up` unless the hook is unavailable.
- Permission capture: the installed `PermissionRequest` hook publishes permission activity through `ovld protocol`.
- Native resume: the follow-up hook reports Codex thread/session IDs from `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, or rollout files under `~/.codex/sessions`.
- MCP bridge: the installed `overlord` MCP server exposes attach, update, and deliver helpers backed by `ovld protocol`.
- Authentication: use shared `ovld auth` credentials, Overlord-launched environment variables, or `Overlord_USER_TOKEN` / `OVLD_USER_TOKEN`.
- Do not create or rely on a repository-local `AGENTS.md` for Overlord itself.

## Codex Command Mapping

- Create draft ticket: `ovld protocol create --agent codex --objectives-json '[{"objective":"..."}]'`
- Create and execute immediately: `ovld protocol prompt --agent codex --objectives-json '[{"objective":"..."}]'`
- Load context without a session: `ovld protocol load-context --ticket-id <ticket_id>`
- Submit a draft objective for discussion: `ovld protocol discuss-objective --ticket-id <ticket_id>`
- Connect this session: `ovld protocol connect --ticket-id <ticket_id>`
- Attach for execution: `ovld protocol attach --ticket-id <ticket_id>`
- Resume delivered work for follow-up execution: `ovld protocol resume-follow-up --ticket-id <ticket_id>`
- Add ordered follow-up objectives: `ovld protocol add-objectives --ticket-id <ticket_id> --objectives-json '[{"objective":"..."}]'`

## Shared Lifecycle

Follow the shared Connector Core lifecycle rules in the bundled reference files:

1. Attach first with `ovld protocol attach --ticket-id <ticket_id>`.
2. Post updates while working with `ovld protocol update` or liveness with `ovld protocol heartbeat`.
3. Ask blocking questions with `ovld protocol ask` and stop work.
4. Deliver with `ovld protocol deliver` when work is complete, including `changeRationales` for meaningful file changes.
5. Do not continue implementation after delivery without `ovld protocol resume-follow-up` or `--begin-follow-up-work` on a still-live session.

For full command syntax, flags, phase values, and event types see [reference/cli.md](reference/cli.md).

## References

- Shared source: `connectors/core/overlord-ticket/SKILL.md`
- [reference/cli.md](reference/cli.md)
- [reference/context.md](reference/context.md)
- [reference/devices.md](reference/devices.md)
- [reference/mcp.md](reference/mcp.md)
- [reference/shell-escaping.md](reference/shell-escaping.md)
