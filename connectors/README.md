# Agent Connectors Module

How Overlord plugs into AI coding harnesses (Claude Code, Codex, Cursor,
OpenCode, Antigravity, and others). A connector is what lets an agent speak the
`ovld protocol` and inherit ticket context inside its native harness.

## Contract Component

Maps to the **Connector Layer** (`connector`) in [`CONTRACT.md`](../CONTRACT.md), which owns:

- Connector core workflow instructions
- Per-agent plugin/adapter files and their managed-file manifests
- Hook scripts and their event contracts (`UserPromptSubmit`, `PermissionRequest`, `Stop`)
- `ovld setup <agent>` and `ovld doctor` behavior
- Connector capability declarations (the approved capability flag set)

It does **not** own protocol command implementations (→ [CLI module](../cli/README.md))
or the harness extension catalog (→ Extension System, see [Database module](../database/README.md)).

## The four layers (from the root README "Surfaces and Interfaces")

- **Connector Core** — primary instructions in Markdown; the base every plugin extends. The shared source lives in [`core/`](core/).
- **Connector Plugins** — customizable extensions of the core, per harness.
- **Plugin Adapters** — package plugins into a harness via its native plugin/connector manager (Claude, Codex, Cursor).
- **Prompt Wrappers** — instructions + key data wrapping the user's prompt at LLM submission time.

## Documentation

- [Connector Core](core/README.md): shared workflow instructions and protocol references consumed by connector plugins.
- [05 — Connectors and Agent Plugins](docs/05-connectors-and-agent-plugins.md): connector core, plugins, adapters, hooks, setup, doctor, launch mapping.
- [Agent and Harness Configuration Architecture](docs/agent-harness-configuration-architecture.md): ownership boundaries for agent catalogs, user harnesses, execution-target launch settings, objective launch overrides.

## Extension Point

A custom agent connector is a sanctioned extension point: a new adapter plus a
`conformance-manifest.yaml` validated by `ovld contract check`. See the
[Conformance Requirements](../CONTRACT.md) and the example manifest at
[`../contract/examples/connector-claude-conformance-manifest.yaml`](../contract/examples/connector-claude-conformance-manifest.yaml).

## Connector Bundles

- [Claude Code](adapters/claude/README.md): installable Claude plugin bundle with a Claude overlay for the shared core, slash commands, hooks, adapter manifest, prompt wrapper notes, and connector conformance manifest.
