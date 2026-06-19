---
name: overlord-ticket
description: Cursor adapter overlay for the shared Overlord ticket workflow.
---

# Cursor Overlord Ticket

This Cursor skill is the adapter-specific entrypoint for the shared Connector Core at `connectors/core/overlord-ticket/SKILL.md`.

When working inside an Overlord source checkout, read and follow that core before using the Cursor-specific notes below. When this plugin is packaged for installation, setup copies the bundled skill and reference files into the installed plugin so the runtime package is self-contained.

## Cursor Adapter Notes

- Agent identifier: `cursor` for `ovld protocol create` and `ovld protocol prompt`.
- Native commands: `/attach`, `/connect`, `/load`, `/create`, `/prompt`, `/discuss-objective`, `/add-objectives`, `/record-work`.
- Follow-up capture: the installed `beforeSubmitPrompt` hook records ordinary post-delivery user messages. Do not manually publish `user_follow_up` unless the hook is unavailable.
- MCP bridge: the installed `overlord` MCP server exposes attach, update, and deliver helpers backed by `ovld protocol`.
- Authentication: use shared `ovld auth` credentials, Overlord-launched environment variables, or `Overlord_USER_TOKEN` / `OVLD_USER_TOKEN`.

## Cursor Command Mapping

- Create draft ticket: `/create` or `ovld protocol create --agent cursor --objectives-json '[{"objective":"..."}]'`
- Create and execute immediately: `/prompt` or `ovld protocol prompt --agent cursor --objectives-json '[{"objective":"..."}]'`
- Load context without a session: `/load` or `ovld protocol load-context --ticket-id <ticket_id>`
- Submit a draft objective for discussion: `/discuss-objective` or `ovld protocol discuss-objective --ticket-id <ticket_id>`
- Connect this session: `/connect` or `ovld protocol connect --ticket-id <ticket_id>`
- Attach for execution: `/attach` or `ovld protocol attach --ticket-id <ticket_id>`
- Resume delivered work for follow-up execution: `ovld protocol resume-follow-up --ticket-id <ticket_id>`
- Add ordered follow-up objectives: `/add-objectives` or `ovld protocol add-objectives --ticket-id <ticket_id> --objectives-json '[{"objective":"..."}]'`

## Shared Lifecycle

Follow the shared Connector Core lifecycle rules in the bundled reference files:

1. Attach first with `ovld protocol attach --ticket-id <ticket_id>`.
2. Post updates while working with `ovld protocol update` or liveness with `ovld protocol heartbeat`.
3. Ask blocking questions with `ovld protocol ask` and stop work.
4. Deliver with `ovld protocol deliver` when work is complete, including `changeRationales` only for meaningful file changes made as part of this ticket. Do not include unrelated worktree changes in the delivery report or rationales, even to mark them as pre-existing.
5. Do not continue implementation after delivery without `ovld protocol resume-follow-up` or `--begin-follow-up-work` on a still-live session.

For full command syntax, flags, phase values, and event types see [reference/cli.md](reference/cli.md).

## References

- Shared source: `connectors/core/overlord-ticket/SKILL.md`
- [reference/cli.md](reference/cli.md)
- [reference/context.md](reference/context.md)
- [reference/devices.md](reference/devices.md)
- [reference/mcp.md](reference/mcp.md)
- [reference/shell-escaping.md](reference/shell-escaping.md)
