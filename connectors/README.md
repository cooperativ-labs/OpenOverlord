# Agent Connectors Module

How Overlord plugs into AI coding harnesses (Claude Code, Codex, Cursor,
OpenCode, Antigravity, and others). A connector is what lets an agent speak the
`ovld protocol` and inherit ticket context inside its native harness.

## Table of Contents

- [For Users](#for-users)
  - [Setting up connectors](#setting-up-connectors)
  - [Connector bundles](#connector-bundles)
  - [Extension point](#extension-point)
- [For Developers](#for-developers)
  - [Contract Component](#contract-component)
  - [The four layers](#the-four-layers)
  - [Documentation](#documentation)

## For Users

### Setting up connectors

Install or refresh a connector with:

```bash
ovld agent-setup <agent>    # claude | codex | cursor | all
ovld doctor                 # verify managed files and permissions
```

Each adapter README documents harness-specific install steps, slash commands,
and namespaced component names. Re-run `ovld agent-setup` safely whenever the
connector contract version changes.

### Connector bundles

- [Claude Code](adapters/claude/README.md): installable Claude plugin bundle with a Claude overlay for the shared core, slash commands, hooks, adapter manifest, prompt wrapper notes, and connector conformance manifest.
- [Codex](adapters/codex/README.md): Codex plugin with hooks, MCP bridge, and permission warmup.
- [Cursor](adapters/cursor/README.md): Cursor plugin with slash commands, hooks, rules, and MCP bridge.

### Extension point

A custom agent connector is a sanctioned extension point: a new adapter plus a
`conformance-manifest.yaml` validated by `ovld contract check`. See the
[Conformance Requirements](../CONTRACT.md) and the example manifest at
[`../contract/examples/connector-claude-conformance-manifest.yaml`](../contract/examples/connector-claude-conformance-manifest.yaml).

## For Developers

### Contract Component

Maps to the **Connector Layer** (`connector`) in [`CONTRACT.md`](../CONTRACT.md), which owns:

- Connector core workflow instructions
- Per-agent plugin/adapter files and their managed-file manifests
- Hook scripts and their event contracts (`UserPromptSubmit`, `PermissionRequest`, `Stop`)
- `ovld agent-setup <agent>` / `ovld agent-setup all` and `ovld doctor` behavior
- Connector capability declarations (the approved capability flag set)

It does **not** own protocol command implementations (→ [CLI module](../cli/README.md))
or the harness extension catalog (→ Extension System, see [Database module](../database/README.md)).

### The four layers

- **Connector Core** — primary instructions in Markdown; the base every plugin extends. The shared source lives in [`core/`](core/).
- **Connector Plugins** — customizable extensions of the core, per harness.
- **Plugin Adapters** — package plugins into a harness via its native plugin/connector manager (Claude, Codex, Cursor).
- **Prompt Wrappers** — instructions + key data wrapping the user's prompt at LLM submission time.

### Documentation

- [Connector Core](core/README.md): shared workflow instructions and protocol references consumed by connector plugins.
- [05 — Connectors and Agent Plugins](docs/05-connectors-and-agent-plugins.md): connector core, plugins, adapters, hooks, setup, doctor, launch mapping.
- [Agent and Harness Configuration Architecture](docs/agent-harness-configuration-architecture.md): ownership boundaries for agent catalogs, user harnesses, execution-target launch settings, objective launch overrides.
- [Test Plan](docs/testing.md): structural + behavioral test plan for connectors — manifest/capability conformance, managed-files integrity, hook-script protocol-only boundary, setup/doctor, and the new-connector admission gate. Part of the root [TEST_PLAN.md](../TEST_PLAN.md).
