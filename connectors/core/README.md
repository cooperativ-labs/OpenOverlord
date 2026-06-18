# Connector Core

Connector Core is the shared source for Overlord workflow instructions that every agent connector extends.

## Table of Contents

- [For Users](#for-users)
  - [What Connector Core provides](#what-connector-core-provides)
- [For Developers](#for-developers)
  - [Core vs adapter responsibilities](#core-vs-adapter-responsibilities)
  - [Files](#files)

## For Users

### What Connector Core provides

Connector Core defines the durable protocol behavior every agent connector must
follow:

- attach before execution work
- treat ticket context as authoritative
- update or heartbeat while working
- ask exactly one blocking question and stop
- deliver last with artifacts and change rationales
- use safe stdin/file flags for shell-special payloads
- repair local auth/setup before asking the user to intervene

You do not install Connector Core directly. It is bundled into each agent adapter
(Claude, Codex, Cursor) when you run `ovld agent-setup <agent>`. See the
[connectors module README](../README.md) for setup instructions.

## For Developers

### Core vs adapter responsibilities

Adapters own harness-specific packaging:

- native plugin manifests
- slash commands, commands, or MCP tool aliases
- hook registration and scripts
- launch prompt wrappers
- model, effort, and context-file flag mapping

When building a Connector Plugin, materialize this core into the installable plugin package and layer the adapter-specific overlay beside it. Do not fork the core protocol rules into each adapter.

### Files

- `overlord-ticket/SKILL.md` — shared ticket lifecycle workflow.
- `overlord-ticket/reference/` — shared protocol, context, device, MCP/API, and shell-escaping references.
