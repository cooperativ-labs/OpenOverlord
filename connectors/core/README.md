# Connector Core

Connector Core is the shared source for Overlord workflow instructions that every agent connector extends.

Core owns durable protocol behavior:

- attach before execution work
- treat ticket context as authoritative
- update or heartbeat while working
- ask exactly one blocking question and stop
- deliver last with artifacts and change rationales
- use safe stdin/file flags for shell-special payloads
- repair local auth/setup before asking the user to intervene

Adapters own harness-specific packaging:

- native plugin manifests
- slash commands, commands, or MCP tool aliases
- hook registration and scripts
- launch prompt wrappers
- model, effort, and context-file flag mapping

When building a Connector Plugin, materialize this core into the installable plugin package and layer the adapter-specific overlay beside it. Do not fork the core protocol rules into each adapter.

## Files

- `overlord-ticket/SKILL.md` — shared ticket lifecycle workflow.
- `overlord-ticket/reference/` — shared protocol, context, device, MCP/API, and shell-escaping references.
