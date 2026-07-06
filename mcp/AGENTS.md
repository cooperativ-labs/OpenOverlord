# MCP Module — Agent Extension Guide

Read [`CONTRACT.md`](../CONTRACT.md) and the
[component-contract skill](../.claude/skills/component-contract/SKILL.md) before
changing this module. MCP is a contract component as of contract version 8.

## What MCP Owns

The MCP module owns:

- `/mcp` MCP endpoint behavior and protocol-version advertisement.
- MCP tool names, input schemas, prompt names, resource URI patterns, and
  JSON-RPC response shaping.
- OAuth protected-resource metadata for the hosted MCP resource.
- Mapping MCP tool calls to existing service/protocol operations.

It does not own auth, RBAC, database schema, protocol lifecycle semantics, REST
DTOs outside `/mcp`, local filesystem operations, runner queue claiming, or
branch actions.

## Adding a Tool

1. Confirm the tool maps to an existing service/protocol function.
2. Add the tool definition and handler in [`server.ts`](server.ts) or split a
   domain-specific file if the catalog grows.
3. Let backend auth resolve the caller first, then rely on the corresponding
   service/protocol RBAC gate.
4. Do not read or write database tables directly.
5. Update [`README.md`](README.md) and `CONTRACT.md` if the public tool catalog
   or resource URI contract changes.
6. Add focused tests for tool catalog shape and dispatch behavior.

## Hosted MCP Rules

- Mission creation must require explicit `projectId` or a resolved project
  identity. Hosted MCP must not choose a default project implicitly.
- Keep checkout-local operations out of hosted MCP. Local connector MCP shims
  remain the correct place for CLI/worktree behavior.
- Tool names use the `overlord_<verb>_<noun>` prefix.
- Tool responses should be structured JSON serialized as MCP text content unless
  a richer MCP content type is intentionally added and documented.
