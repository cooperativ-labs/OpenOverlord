# Cloud Agent Overlord MCP

Mission: `coo:150` - Develop Cloud Agent Overlord MCP
Date: 2026-07-06
Status: implementation plan, no code started

## TL;DR

Build a first-class hosted MCP surface that cloud agents such as ChatGPT, Claude,
and other MCP clients can connect to over the public internet and use to read and
manipulate Overlord tickets. Authentication must be OAuth-based: users should
click "Connect" inside the agent product, sign in to Overlord, consent to the
requested workspace/scopes, and have the agent call Overlord's MCP endpoint with
short-lived bearer tokens.

The right architecture is:

1. Add `mcp` as a contract component before implementation.
2. Host a Streamable HTTP MCP endpoint on the existing Railway/backend service,
   canonical URL `https://<backend>/mcp`.
3. Add an Auth-owned OAuth 2.1 authorization-server surface for MCP clients:
   authorization code + PKCE, protected-resource metadata, authorization-server
   metadata, dynamic client registration or client metadata document support,
   short-lived access tokens, refresh tokens, revocation, and consent.
4. MCP handlers authenticate through the Auth Layer, resolve an Overlord `Actor`,
   enforce RBAC, and call the shared service layer. They must never write tables
   directly.
5. Keep the existing local connector MCP shims as local/CLI bridges; the hosted
   MCP is a separate cloud-facing product surface.

## External Requirements Reviewed

As of 2026-07-06, target the latest stable MCP specification (`2025-11-25`) and
track the `2026-07-28` release candidate separately before implementation.

Official references reviewed:

- MCP Authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- MCP Streamable HTTP transport: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- OpenAI MCP docs: https://developers.openai.com/api/docs/mcp
- OpenAI remote MCP/connectors guide: https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- Claude custom remote MCP connectors: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
- Claude Messages API MCP connector: https://platform.claude.com/docs/en/agents-and-tools/mcp-connector

Important compatibility points from those docs:

- Remote MCP servers use HTTP transport and must be reachable from the provider's
  cloud infrastructure.
- OAuth-protected MCP servers act as resource servers and must advertise auth
  metadata through OAuth Protected Resource Metadata.
- Clients may be public or confidential. Authorization code + PKCE is mandatory
  for public clients.
- OpenAI API usage can pass an already-obtained OAuth bearer token; ChatGPT UI
  custom connectors use the server URL/configured connector flow.
- Claude Team/Enterprise owners configure custom connector URLs, then each user
  connects and authenticates individually.

## Current Repo State

The repo already reserves an `mcp/` module, but it is explicitly planned/deferred:

- `mcp/README.md` says there is no MCP server to install today.
- `mcp/AGENTS.md` says MCP is not yet a `CONTRACT.md` component and must be
  added contract-first.
- Local agent connectors already ship local MCP bridge scripts that shell out to
  `ovld protocol`; those are connector conveniences, not a hosted MCP service.
- `connectors/core/overlord-mission/reference/mcp.md` mentions a hosted
  `/functions/v1/mcp` path. That should be treated as stale/upstream wording and
  replaced with the canonical backend route chosen here. Overlord Cloud is now
  Railway backend + Vercel frontend, not Supabase edge functions.

Existing pieces to reuse:

- Auth already resolves Better Auth sessions and `USER_TOKEN` bearer auth into
  Overlord actors.
- `USER_TOKEN` scopes include a `mission_lifecycle` preset that approximates the
  permissions an agent needs.
- `POST /api/protocol/:subcommand` already adapts protocol command envelopes to
  shared service-layer calls.
- Core protocol service functions already implement session lifecycle,
  mission/objective creation, updates, asks, delivery, attachments, shared
  context, and change rationales.

The hosted MCP should reuse service functions, not wrap the CLI.

## Goals

- Let a user connect ChatGPT, Claude, or another cloud MCP client to Overlord
  with OAuth.
- Let the agent create, search, read, update, and progress Overlord missions and
  objectives.
- Preserve Overlord RBAC: the agent can only do what the connected user can do in
  the selected workspace.
- Provide a stable, documented MCP tool/resource catalog.
- Work in Overlord Cloud first, while keeping Local edition behavior unchanged.
- Keep local MCP shims working for Claude Code, Codex, Cursor, Antigravity, and
  similar local harnesses.

## Non-Goals For V1

- Do not expose local filesystem/worktree operations through hosted MCP.
- Do not expose runner queue claiming or local branch actions through hosted MCP.
- Do not require Overlord Local/offline users to configure OAuth.
- Do not make ChatGPT/Claude account identity the Overlord identity. The user
  signs in to Overlord through OAuth; the MCP client receives delegated access.
- Do not implement a separate data model for tickets. Use existing missions,
  objectives, events, artifacts, attachments, and shared context.

## Contract Impact

This feature cannot be implemented under the current contract because `mcp` is
not a registered component and hosted MCP introduces a new interaction surface.
Before code lands, update:

- `CONTRACT.md`
  - Bump contract version.
  - Add `mcp` to the Component Registry.
  - Add an `MCP Server -> Service Layer` interaction surface.
  - Add an `MCP Server -> Auth Layer` auth resolution rule.
  - Declare canonical hosted endpoint path (`/mcp`) and metadata endpoints.
  - Define ownership: MCP owns tool names, resource URI patterns, prompt names,
    MCP protocol/version support, and MCP response shaping.
  - State that MCP does not own persistence, RBAC, protocol lifecycle semantics,
    connector install state, or runner/local target operations.
- `contract/components.yaml`
  - Add `mcp` component.
  - Add `mcpToService` and `mcpToAuth` surfaces.
  - Add dependency on `auth`, `database` through service layer, and `protocol`
    service functions where reused.
- `contract/extension-points.yaml`
  - Decide whether "MCP extension module" is a new extension point. If yes, add
    it before supporting namespaced third-party MCP tools.
- `contract/conformance-manifest.schema.yaml`
  - Add `componentType: mcp-server` only if MCP server packages/components need
    manifests. Core MCP inside Overlord may not need a separate manifest.
- `mcp/README.md`, `mcp/AGENTS.md`
  - Replace "planned/deferred" with implementation guidance after Phase 1.
- `connectors/core/overlord-mission/reference/mcp.md`
  - Replace `/functions/v1/mcp` with `/mcp`.

## Architecture

### Runtime Placement

Run the hosted MCP server inside the existing backend process:

```text
ChatGPT / Claude / other cloud MCP client
  -> HTTPS POST/GET https://<overlord-backend>/mcp
  -> MCP transport adapter
  -> Auth Layer token validation
  -> RBAC actor resolution
  -> shared service layer
  -> database
```

Why backend, not Vercel functions:

- Overlord Cloud already places mutable product state behind the Railway backend.
- The backend owns auth, RBAC, service-layer transactions, realtime, and protocol
  write paths.
- Vercel functions are not the canonical state authority and are a poor fit for
  long-lived/streaming MCP transport behavior.

### Endpoint Shape

Canonical MCP endpoint:

- `GET /mcp`
- `POST /mcp`

OAuth discovery/metadata:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/openid-configuration` if OIDC discovery is supported

OAuth authorization-server endpoints, exact paths to finalize during contract
update:

- `GET /oauth/authorize`
- `POST /oauth/token`
- `POST /oauth/register` for Dynamic Client Registration, if supported
- `POST /oauth/revoke`
- `GET /oauth/consents` and `DELETE /oauth/consents/:id` for Overlord settings UI

### OAuth Model

Treat the MCP endpoint as an OAuth-protected resource server. Add an Auth-owned
OAuth authorization-server module rather than reusing raw `USER_TOKEN`s as the
external credential.

V1 grant support:

- Authorization Code + PKCE.
- Confidential clients with client secret where ChatGPT/Claude organization
  settings provide one.
- Public clients with PKCE where the MCP client cannot safely hold a secret.
- Refresh tokens with rotation.
- Revocation.
- Optional Dynamic Client Registration. If full DCR is too much for the first
  beta, support static client registration plus OAuth Client ID Metadata
  Documents, then add DCR before public connector distribution.

The authorization screen should:

- Require an interactive Overlord login via existing Better Auth session.
- Let the user choose an organization/workspace when they have more than one.
- Show requested scopes in plain language.
- Store consent per `{profile, client, workspace, scopes}`.
- Produce short-lived access tokens audience-bound to the MCP resource URL.

Access tokens should be opaque server-side tokens or signed JWTs with server-side
revocation checks. Prefer opaque hashed tokens for consistency with
`USER_TOKEN`s unless provider compatibility requires JWT introspection-less
validation.

### Scope Model

OAuth scopes should be stable public product scopes, mapped internally to RBAC
permissions and optional token-scope grants.

Suggested V1 scopes:

| OAuth scope | Internal meaning |
| --- | --- |
| `overlord.missions.read` | Read projects, missions, objectives, mission events, artifacts, shared context, and attachments metadata. |
| `overlord.missions.write` | Create/update missions and objectives, write events/shared context/artifacts, manage objective attachments. |
| `overlord.sessions.execute` | Attach/update/heartbeat/ask/deliver protocol sessions for objectives. |

Default connector request:

```text
overlord.missions.read overlord.missions.write overlord.sessions.execute
```

Implementation should still intersect these scopes with the connected user's
current RBAC role at request time. Scopes restrict; they never grant access beyond
the user's actual workspace permissions.

### Workspace Binding

V1 should bind each OAuth consent/access token to one workspace selected during
authorization. This avoids requiring ChatGPT/Claude to send an active-workspace
header and keeps accidental cross-workspace reads unlikely.

MCP tools may accept `workspaceId` later, but cross-workspace operation should be
a V2 feature with explicit consent UX.

### Project Discovery And Resource Context

Hosted MCP cannot see the cloud agent's local current working directory, so
project resolution must be explicit and tool-driven. This is required for prompts
like "add a new mission to this project."

Project resolution order:

1. Use `projectId` when the MCP caller supplies it explicitly or when it is
   already present in mission/objective/resource context.
2. If the user has exposed a repository or directory resource to the agent, read
   that resource's `.overlord/project.json` and pass its project id as
   `projectId`. Overlord already writes this file when a resource directory is
   registered, so it is the portable project identity source for repo-backed
   work.
3. If `.overlord/project.json` contains multiple project mappings, return an
   ambiguity result with project names/ids and require the agent to ask the user;
   never silently pick one.
4. As a last resort, call a `resolve_project` / `discover_project` tool with a
   project name, slug, repository URL, or `workingDirectory` hint. Because the
   hosted backend cannot inspect the agent's filesystem, working-directory
   matching is only useful when the directory has already been registered as a
   project resource on an execution target.

`create_mission` should require either `projectId` or a successful prior
`resolve_project` result. If neither exists, it should fail with a structured
`project_required` response listing visible projects in the OAuth-bound
workspace rather than creating the ticket in an arbitrary default project.

### MCP Capabilities

V1 should expose tools and resources. Prompts are optional.

Resources:

- `overlord://workspace`
- `overlord://projects`
- `overlord://projects/{projectId}`
- `overlord://missions/{missionId}`
- `overlord://missions/{missionId}/objectives`
- `overlord://missions/{missionId}/history`
- `overlord://missions/{missionId}/artifacts`
- `overlord://objectives/{objectiveId}/attachments`

Tools, read-oriented:

- `search_missions`
- `get_mission`
- `list_mission_history`
- `list_objectives`
- `list_projects`
- `list_shared_context`
- `list_attachments`
- `get_attachment_download_url`
- `resolve_project`

Tools, write/session-oriented:

- `create_mission`
- `add_objectives`
- `discuss_objective`
- `attach_session`
- `update_session`
- `heartbeat_session`
- `ask_question`
- `deliver_session`
- `write_shared_context`
- `record_change_rationales`
- `prepare_attachment_upload`
- `finalize_attachment_upload`

Defer from hosted MCP:

- `revert`
- local changed-file preflight
- runner queue claim/launch tools
- branch action tools that mutate local worktrees
- `prompt` if it implies local runner launch; offer `create_mission` plus an
  explicit future `request_execution` only after a cloud-safe execution model is
  designed

### Tool Semantics

Do not mirror CLI flags directly. Use JSON schemas with camelCase keys:

```jsonc
{
  "missionId": "coo:150",
  "sessionKey": "sess_...",
  "summary": "...",
  "phase": "execute"
}
```

For protocol lifecycle operations:

- `create_mission` requires `projectId` or an immediately preceding
  `resolve_project` result. The server should reject ambiguous project context
  with candidates rather than defaulting silently.
- `attach_session` returns the same structured attach context as protocol
  `attach`, minus CLI-only instructions.
- `deliver_session` accepts explicit `changeRationales`; hosted MCP cannot infer
  local VCS changes.
- `record_change_rationales` writes the same `file_changes` rows as CLI
  `record-change-rationales`.
- All write tools require idempotency keys or server-generated request IDs where
  duplicate model/tool retries are likely.

### Audit And Safety

Every MCP request should record:

- OAuth client id / name.
- Profile id.
- Workspace user id.
- Workspace id.
- MCP method/tool name.
- Token id or grant id.
- Result: allowed, denied, failed.

Security rules:

- Validate `Origin` for browser-originated MCP calls where present.
- Require HTTPS in Cloud.
- Rate-limit per OAuth client, user, and workspace.
- Redact bearer tokens, session keys, attachment URLs, and OAuth codes in logs.
- Keep tool descriptions tight; do not put secrets or long private data in tool
  schemas.
- Prefer read-only tool annotations where MCP clients support them.
- Require explicit user/model approval in clients for high-impact tools where the
  client supports approvals; inside Overlord, enforce RBAC regardless.
- Do not let an OAuth token mint `USER_TOKEN`s or manage roles/users in V1.

## Implementation Phases

### Phase 0 - Compatibility Spike

- Verify current ChatGPT custom connector OAuth behavior against a throwaway MCP
  server.
- Verify Claude custom connector flow for Pro/Max and Team/Enterprise where
  possible.
- Decide whether the official TypeScript MCP SDK is production-ready for the
  backend's runtime and TypeScript build.
- Confirm whether Better Auth can serve as the OAuth authorization server via a
  supported plugin. If not, implement a small Overlord-owned OAuth module in
  `auth/`.

Exit criteria:

- Confirmed endpoint, metadata, and callback expectations for ChatGPT and Claude.
- Chosen MCP SDK/transport library.
- Chosen OAuth implementation approach.

### Phase 1 - Contract And Docs

- Update `CONTRACT.md` and `contract/components.yaml`.
- Decide and document whether MCP extensions are a new extension point.
- Update `mcp/README.md` and `mcp/AGENTS.md` from placeholder to contract-first
  implementation guide.
- Update connector-core MCP reference to the canonical `/mcp` route.

Exit criteria:

- Contract check passes.
- No implementation code relies on an undeclared component/surface.

### Phase 2 - OAuth Foundation

Database additions, owned by Auth/Database:

- OAuth clients or registrations.
- Authorization codes.
- Access token records or signing key metadata.
- Refresh tokens.
- Consents.
- Revocation/audit metadata.

Auth/backend additions:

- Authorization endpoint using existing Better Auth login session.
- Consent screen.
- Token endpoint.
- Protected resource metadata.
- Authorization server metadata / OIDC discovery.
- Revocation.
- Dynamic client registration or static client admin UI.

Exit criteria:

- A test OAuth client can complete auth code + PKCE and call a protected test
  endpoint.
- Tokens are workspace-bound and RBAC-intersected.
- Revocation works immediately.

### Phase 3 - MCP Transport Skeleton

- Add `mcp/` server package/module.
- Mount `GET/POST /mcp` in backend.
- Implement initialize, tools/list, resources/list, resources/read.
- Add auth middleware that validates OAuth MCP tokens and creates a
  `ServiceContext`.
- Add conformance tests for unauthorized, insufficient scope, wrong workspace,
  and valid token paths.

Exit criteria:

- ChatGPT/Claude can discover the server and list at least one read-only tool.
- Unauthorized calls return OAuth-compatible `WWW-Authenticate` challenges.

### Phase 4 - Read Tools And Resources

- Implement project/mission/objective/history/artifact/shared-context reads.
- Keep result sizes bounded and paginated.
- Add stable resource URI parsing.
- Add tool result redaction/summarization rules for long mission histories.

Exit criteria:

- Connected user can ask an agent what tickets exist and inspect ticket state.
- A user with no workspace access cannot read anything.

### Phase 5 - Ticket Mutation And Session Lifecycle

- Implement create/update objective flows.
- Implement attach/update/heartbeat/ask/deliver flows.
- Add idempotency handling for model retries.
- Add explicit change-rationale handling for hosted delivery.
- Add attachment upload/download URL tools if provider clients support the flow
  cleanly; otherwise defer attachment bytes and keep metadata/download-only.

Exit criteria:

- A connected cloud agent can create a mission, add an objective, attach to an
  objective, post progress, and deliver.
- Delivery records normal mission events/artifacts and moves the ticket exactly
  like CLI protocol delivery.

### Phase 6 - UX, Admin, And Provider Setup

- Add Settings -> MCP / Connected Agents.
- Show configured OAuth clients, active consents, last-used timestamps, and
  revoke controls.
- Add copyable connector setup instructions for ChatGPT and Claude.
- Add env/config docs for Cloud deployment.
- Add a health/diagnostics endpoint or doctor check for metadata/callback issues.

Exit criteria:

- A normal user can connect their ChatGPT/Claude account without CLI work.
- An admin can revoke a client/user consent.

### Phase 7 - Hardening And Beta Rollout

- End-to-end tests against a local mock MCP client.
- Manual smoke tests in ChatGPT and Claude.
- Security review for OAuth redirects, token storage, prompt-injection surfaces,
  audit logs, and data minimization.
- Load/rate-limit testing for tool calls.
- Feature flag: `OVERLORD_MCP_ENABLED`.

Exit criteria:

- Enabled for selected Cloud workspaces.
- Local edition remains unchanged when the feature flag/OAuth config is absent.

## Acceptance Criteria

- ChatGPT can connect to `https://<backend>/mcp` through OAuth and list tools.
- Claude can connect to the same endpoint through OAuth and list tools.
- A connected user can create/read/update/deliver Overlord missions through MCP.
- A user removed from a workspace immediately loses MCP access to that workspace.
- OAuth tokens are short-lived, revocable, audience-bound, and never logged raw.
- MCP handlers call the service layer and pass RBAC; no direct table writes.
- Local connector MCP shims continue to work.
- Contract, docs, and tests describe the new component and public surface.

## Open Questions

- Should Overlord support Dynamic Client Registration in V1, or start with
  static client registration plus client metadata documents?
- Should access tokens be opaque database-backed tokens or signed JWTs with
  server-side revocation checks?
- Should `deliver_session` require a `sessionKey`, or should OAuth-bound MCP
  sessions use a server-side session id hidden from the model? Keeping
  `sessionKey` visible matches protocol parity but exposes another bearer-like
  secret to the client transcript.
- Should hosted MCP expose attachments upload in V1, given provider-specific
  file handling differences?
- Should MCP tools include project board/status mutation, or stay mission-first
  until ticket lifecycle primitives are proven safe?
