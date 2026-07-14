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
- treat mission context as authoritative
- update or heartbeat while working
- ask exactly one blocking question and stop
- deliver last with artifacts and change rationales
- use safe stdin/file flags for shell-special payloads
- repair local auth/setup before asking the user to intervene

You do not install Connector Core directly. It is bundled into each agent adapter
(Claude, Codex, Cursor, PI) when you run `ovld agent-setup <agent>`. See the
[connectors module README](../README.md) for setup instructions.

## For Developers

### Core vs adapter responsibilities

Adapters own harness-specific packaging:

- native plugin manifests
- slash commands, commands, or MCP tool aliases
- hook registration and scripts
- launch prompt wrappers
- model, effort, and context-file flag mapping

When building a Connector Plugin, adapter skill templates include `<!-- @connector-core -->`.
`ovld agent-setup <agent>` interpolates connector core content from
`connectors/core/overlord-mission/` into that marker and copies core reference files
into the installable plugin package. Do not fork the core protocol rules into each adapter.

### Files

- `overlord-mission/SKILL.md` — shared mission lifecycle workflow.
- `overlord-mission/reference/` — shared protocol, context, device, MCP/API, and shell-escaping references.
