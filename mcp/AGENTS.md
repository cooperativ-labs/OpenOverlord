# MCP Module — Agent Extension Guide

This file tells agents how to extend the MCP module to add new capabilities for users. The MCP module is **planned but not yet implemented** (Phase 5). Read [`CONTRACT.md`](../CONTRACT.md) and the [component-contract skill](../.claude/skills/component-contract/SKILL.md) before making any cross-module change.

---

## What "extending MCP" means

The MCP module will expose Overlord capabilities (tickets, objectives, protocol operations) to MCP-aware clients. Once implemented, extensions will fall into:

| Extension type | Example user request |
| --- | --- |
| New MCP tool | "Expose `create_ticket` as an MCP tool" |
| New MCP resource | "Expose ticket history as a readable MCP resource" |
| MCP extension module | "Add namespaced tools for a third-party integration" |

---

## Before You Start: Contract-First Requirement

**MCP is not yet a component in `CONTRACT.md`.** Before any MCP implementation code lands:

1. **Add `mcp` to the Component Registry** in `CONTRACT.md` — define what it owns (MCP tool names, resource URIs, auth integration) and what it does not own.
2. **Add `mcp` to `contract/components.yaml`** — declare its capabilities and interaction surfaces.
3. **Declare the interaction surface**: MCP server → service layer (mirroring the REST and protocol surfaces — no direct table writes).
4. **Add a changelog entry** to `CONTRACT.md` and **increment the contract version** in `contract/components.yaml`.
5. Only then write implementation code.

---

## Intended Architecture (Pre-Implementation)

When MCP is implemented, it should follow the same patterns as the REST API Layer:

- MCP tool handlers call the **service layer** — the same functions used by `cli/` and `webapp/`.
- Auth is resolved via the **Auth Layer** before any service call.
- No direct database table writes from MCP handlers.
- MCP tool names follow a consistent naming convention (e.g. `overlord_create_ticket`, `overlord_list_objectives`).

---

## Adding a New MCP Tool (once MCP is implemented)

**Steps:**

1. **Confirm the tool maps to an existing service function** — do not implement new business logic inside MCP handlers.
2. **Add the tool definition** to `mcp/tools/<area>.ts` (one file per resource domain).
3. **Auth before service call**: resolve the MCP client's identity to an `Actor` via the Auth Layer, then call `can(actor, action, resource)`.
4. **Update `CONTRACT.md`** MCP component section with the new tool name and input/output schema.
5. **Write tests** colocated with the tool definition (`mcp/tools/<area>.test.ts`).

---

## Adding a New MCP Resource

MCP resources expose read-only data to clients. Resources derive from the same logical schema as REST responses.

**Steps:**

1. **Define the resource URI pattern** (e.g. `overlord://tickets/{ticketId}/history`).
2. **Implement** in `mcp/resources/<area>.ts`.
3. **Document** the URI pattern and response shape in `CONTRACT.md` MCP section.

---

## Adding a Namespaced MCP Extension

Third-party MCP extensions should use a namespaced tool prefix to avoid conflicts with core tools.

**Rules:**
- Tool names must be prefixed `<name>_` (e.g. `myapp_generate_report`).
- Extension handlers must authenticate via the Auth Layer and call through the service layer.
- Declare the extension in a `conformance-manifest.yaml`.

---

## File Placement Convention (intended)

```
mcp/
  tools/                  ← MCP tool definitions, one file per resource domain
    tickets.ts
    objectives.ts
    <area>.ts
    <area>.test.ts
  resources/              ← MCP resource definitions
  ext/
    <name>/               ← namespaced extension tools
  AGENTS.md               ← this file
  README.md               ← architectural overview
```

---

## Cross-Module Checklist (for when MCP implementation begins)

- [ ] Add `mcp` component to `CONTRACT.md` and `contract/components.yaml` **first**
- [ ] Declare MCP → service layer interaction surface in `CONTRACT.md`
- [ ] Bump contract version and add changelog entry
- [ ] MCP handlers → service layer only, never direct table writes
- [ ] Auth: resolve client identity → Actor via Auth Layer before every tool call
- [ ] Tool names and resource URIs documented in `CONTRACT.md` MCP section
