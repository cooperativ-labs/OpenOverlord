# MCP Module

The MCP module exposes a hosted Model Context Protocol endpoint for cloud
agents such as ChatGPT, Claude, and other MCP clients.

## Status

The first hosted implementation is mounted by the backend when
`OVERLORD_MCP_ENABLED=true`:

- `GET /mcp` returns server/tool metadata for authenticated callers.
- `POST /mcp` accepts JSON-RPC MCP requests.
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`

The endpoint is intentionally backend-hosted, not a CLI shim. Local connector
MCP scripts for Codex, Claude Code, Cursor, and Antigravity continue to use
`ovld protocol` for checkout-local workflows.

## Authentication

MCP requests must authenticate through the backend Auth Layer before tools are
listed or invoked. Unauthenticated `/mcp` calls return a `WWW-Authenticate:
Bearer` challenge that points clients at the protected-resource metadata.

This build exposes OAuth protected-resource and authorization-server metadata,
and uses the existing bearer-authenticated backend request context for tool
execution. The advertised `/oauth/*` endpoints currently return a structured
`501` until the next phase adds dynamic client registration, consent
management, authorization-code + PKCE token issuance, refresh tokens, and
revocation UI.

## Tools

The current tool catalog is mission-first:

- `overlord_resolve_project`
- `overlord_search_missions`
- `overlord_create_mission`
- `overlord_load_mission_context`
- `overlord_add_objectives`
- `overlord_attach_session`
- `overlord_update_session`
- `overlord_deliver_session`

Hosted MCP cannot observe an agent's local current working directory. Tools
that create missions require explicit `projectId`; clients should call
`overlord_resolve_project` first when project identity comes from an exposed
repository resource carrying `.overlord/project.json`.

## Boundaries

MCP handlers call existing service/protocol functions and rely on their RBAC
checks. They must not write database tables directly. Hosted MCP intentionally
does not expose local filesystem inspection, runner queue claiming, execution
target mutation, or branch actions.
