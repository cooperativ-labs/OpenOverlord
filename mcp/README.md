# MCP Module — PLANNED / DEFERRED

A Model Context Protocol (MCP) server surface that would expose Overlord
capabilities (missions, objectives, protocol operations) to MCP-aware clients.

## Table of Contents

- [For Users](#for-users)
  - [Status](#status)
- [For Developers](#for-developers)
  - [Contract Component](#contract-component)
  - [Documentation](#documentation)

## For Users

### Status

> **Not yet implemented.** There is no MCP server to install today. Agent
> connectors (Claude, Codex, Cursor) ship their own MCP bridges to
> `ovld protocol` — see the [connectors module](../connectors/README.md).

## For Developers

### Contract Component

MCP is **not yet a component** in [`CONTRACT.md`](../CONTRACT.md). When this
module is implemented it will become a new component connected via the contract,
which means — per the [Contract Maintenance Rules](../CONTRACT.md) — the contract
must be updated **before** any MCP implementation code lands:

1. Add an `mcp` entry to the Component Registry and `contract/components.yaml`.
2. Declare its interaction surface (likely MCP server → service layer, mirroring
   the REST and protocol surfaces — no direct table writes).
3. Add a changelog entry and bump the contract version if a stable interface changes.

Like REST and the CLI protocol, an MCP server should reach persistence only
through the shared **service layer**, never by touching tables directly.

This directory reserves the module slot and records the intended design so the
surface lands in a consistent place when work begins.

### Documentation

No dedicated feature plan exists yet. The expansion intent is noted in the
[feature-plans README](../planning/feature-plans/README.md). Add an
`mcp.md` feature plan here (or in `planning/feature-plans/`) when scoping begins.
