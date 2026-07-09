---
name: Drift Review
description: Reviews product surface alignment across API routes, CLI commands, MCP tools, agent plugins, docs/public, and the CLI README to identify drift in functions, parameters, and capabilities.
allowed-tools: Read, Bash, Grep, Glob, Task
user-invocable: true
---

# Drift Review

<drift-review>

Review all Overlord product surfaces for alignment drift. The goal is to ensure that API routes, CLI commands, MCP tools, agent plugins, and public docs expose the same operations with matching parameters, so that agents can use any surface interchangeably.

When a change touches agent launch commands, also compare the human-launch surfaces: `packages/overlord-cli/bin/_cli/launcher.mjs`, `lib/overlord/launch-commands.ts`, and any ticket copy surfaces that emit copy/paste launch commands.

## Product Surfaces

Overlord exposes its protocol through six parallel surfaces:

| Surface | Location | Convention |
|---------|----------|------------|
| **API routes** | `apps/web/app/api/protocol/*/route.ts` | REST endpoints, kebab-case paths |
| **CLI commands** | `packages/overlord-cli/bin/_cli/protocol.mjs` | `ovld protocol <subcommand>`, `--kebab-case` flags |
| **MCP tools** | `supabase/functions/mcp/tools.ts` (hosted) + `plugins/overlord/scripts/overlord-mcp.mjs` (Codex local shim) + `plugins/antigravity/scripts/overlord-mcp.mjs` (Antigravity local shim, staged to `~/.ovld/antigravity/scripts/`) | Hosted: `snake_case` tool names, **camelCase** parameters matching API JSON. Local shims: `snake_case` parameters mapping to CLI flags. |
| **Agent plugins** | Source templates in `plugins/_source/agents/{Codex,cursor,overlord}/` plus shared include templates in `plugins/_source/shared/` render to `plugins/{Codex,cursor,overlord}/` and `packages/overlord-cli/plugins/{Codex,cursor,overlord}/`; Antigravity remains direct at `plugins/antigravity/skills/overlord-ticket/` | Skill instructions referencing CLI/MCP |
| **Public docs for agents** | `docs/public/` | AI-agent-facing explainers that help agents explain Overlord to end users |
| **CLI README** | `packages/overlord-cli/README.md` | User-facing CLI documentation and examples |

## Review Process

### Phase 1: Extract the Surface Maps

Build an inventory of every operation exposed by each surface. For each operation, record:
- **Name** (as it appears in that surface)
- **Parameters** (names, types, required/optional)
- **HTTP method** (API only)
- **Description/purpose**

#### 1. API Routes
Read each `route.ts` under `apps/web/app/api/protocol/`. Extract:
- The route path (e.g., `/api/protocol/attach`)
- Exported HTTP methods (`POST`, `GET`, etc.)
- Expected request body or query parameters (look for destructuring of `await request.json()` or `searchParams`)

#### 2. CLI Commands
Read `packages/overlord-cli/bin/_cli/protocol.mjs`. Extract:
- Each subcommand from the dispatch block (the `if (subcommand === '...')` section)
- The flags each handler function reads via `parseFlags()`
- Any flag aliases or defaults

If the task changes human launch commands, also read `packages/overlord-cli/bin/_cli/launcher.mjs` and `lib/overlord/launch-commands.ts` so you can compare `ovld launch` / `ovld restart` help, aliases, and emitted copy commands against Desktop and product copy.

#### 3. MCP Tools
Read all applicable MCP sources:
- `supabase/functions/mcp/tools.ts` — hosted MCP tool definitions (`TOOLS` array) and `supabase/functions/mcp/index.ts` dispatch
- `plugins/overlord/scripts/overlord-mcp.mjs` — Codex local MCP shim (`tools` array + `searchTicketsTool`) and CLI flag mapping
- `plugins/antigravity/scripts/overlord-mcp.mjs` — Antigravity local MCP shim (same `ovld protocol` delegation pattern; installed copy lives at `~/.ovld/antigravity/scripts/overlord-mcp.mjs`)

When auditing Antigravity-only drift, also read the installed-path patch logic in `packages/overlord-cli/bin/_cli/setup.mjs` (`patchAntigravityInstalledPaths`) so MCP `args` and hook `command` paths match the staged runtime scripts.

Extract for each tool:
- `name`, `inputSchema.properties`, `inputSchema.required`
- For the shim: the `subcommand` and `toCliFlags` / `toCliStdin` mapping

#### 4. Agent Plugin Skills
Read the `overlord-ticket` skill in each plugin directory. For Codex, Cursor, and Codex, prefer the source templates first and then confirm rendered output with `yarn plugins:check`:
- `plugins/_source/agents/Codex/skills/overlord-ticket/SKILL.md`
- `plugins/_source/agents/cursor/skills/overlord-ticket/SKILL.md`
- `plugins/_source/agents/overlord/skills/overlord-ticket/SKILL.md`
- `plugins/Codex/skills/overlord-ticket/SKILL.md`
- `plugins/cursor/skills/overlord-ticket/SKILL.md`
- `plugins/overlord/skills/overlord-ticket/SKILL.md` (Codex plugin)
- `plugins/antigravity/skills/overlord-ticket/SKILL.md`

For Antigravity, also spot-check bundled slash commands under `plugins/antigravity/commands/` (Markdown, `$ARGUMENTS`) — they are not installed via `slash-commands.ts`.

Extract which operations and parameters are documented for agents to use.

#### 5. Public Docs for Agent Messaging
Read relevant files in `docs/public/`.

These docs are specifically targeted to AI agents, and their purpose is to help agents explain Overlord to users accurately. Treat drift here as high-importance documentation drift whenever operations, parameters, or behavioral descriptions differ from API/CLI/MCP reality.

Also read `docs/for-agents/cli-reference/page.tsx` and `docs/for-agents/rules/page.tsx` to check for drift in the agent documentation.

#### 6. CLI README
Read `packages/overlord-cli/README.md`.

Extract which `ovld protocol` operations, flags, and examples are documented, then compare them to the real CLI implementation and matching API/MCP surfaces.

### Phase 2: Build the Alignment Matrix

Create a matrix comparing operations across all six surfaces:

```
| Operation         | API Route              | CLI Subcommand         | MCP Tool               | Plugin Docs | Public Docs | CLI README |
|-------------------|------------------------|------------------------|------------------------|-------------|-------------|------------|
| Attach            | POST /protocol/attach  | ovld protocol attach   | attach                 | Y / N       | Y / N       | Y / N      |
| Heartbeat         | POST /protocol/heartbeat | ovld protocol heartbeat | heartbeat            | Y / N       | Y / N       | Y / N      |
| Discover Project  | POST /protocol/disc... | ovld protocol disc...  | discover_project       | Y / N       | Y / N       | Y / N      |
| ...               | ...                    | ...                    | ...                    | ...         | ...         | ...        |
```

### Phase 3: Identify Drift

Check for these categories of drift:

#### 3a. Missing Operations
An operation exists in one surface but not another:
- API route with no corresponding CLI subcommand
- CLI subcommand with no corresponding MCP tool
- MCP tool with no corresponding API route
- Operations not documented in agent plugin skills
- Operations not documented (or inaccurately documented) in `docs/public/`
- Operations not documented (or inaccurately documented) in `packages/overlord-cli/README.md`

#### 3b. Parameter Drift
An operation exists in multiple surfaces but parameters differ:
- **Missing parameters**: A parameter accepted by the API but not exposed in the CLI or MCP tool
- **Extra parameters**: A parameter in one surface that doesn't exist in another
- **Type mismatches**: Different types for the same parameter across surfaces
- **Required vs optional**: A parameter required in one surface but optional in another
- **Naming inconsistencies**: Beyond expected convention differences (kebab-case CLI vs snake_case MCP), check for semantic name mismatches (e.g., `ticket_id` vs `ticketId` vs `id`)

#### 3c. Behavioral Drift
- Different default values for the same parameter across surfaces
- Different validation rules
- Different response shapes for the same operation
- Session-only operations like `heartbeat` accidentally creating durable ticket events on one surface but not others

#### 3d. Documentation Drift
- Agent plugin skills referencing operations or parameters that no longer exist
- Agent plugin skills missing documentation for operations that do exist
- Inconsistent descriptions of the same operation across surfaces
- `docs/public/` guidance that no longer matches the current protocol surface
- `docs/public/` explanations that would cause an AI agent to explain Overlord incorrectly
- `packages/overlord-cli/README.md` command or flag examples that no longer match `packages/overlord-cli/bin/_cli/protocol.mjs`

#### 3e. Launch Command Drift
- `ovld launch` help text, accepted flags, and alias behavior diverge from `lib/overlord/launch-commands.ts`
- Ticket copy surfaces emit stale launcher names (`ovld connect`) or omit required launch flags
- Organization resolution drifts between surfaces: ticket ids should infer org from the human-readable prefix, object-scoped sessionless calls should infer org from stable ids such as `projectId` / `resourceId` / `objectiveId` / `requestId`, browse/search flows should fan out across memberships, and explicit `--organization-id` / `x-organization-id` should remain a single-org override rather than a stored default
- Desktop launch behavior changed but `CONNECTOR_SURFACES.md` no longer documents the deliberate asymmetry

### Phase 4: Generate the Drift Report

Produce a structured report:

```markdown
# Overlord Surface Drift Report

## Summary
- Surfaces audited: API, CLI, MCP, Agent Plugins, docs/public, CLI README
- Total operations found: N
- Fully aligned operations: N
- Operations with drift: N
- Missing operations: N

## Alignment Matrix
[The full matrix from Phase 2]

## Drift Findings

### Critical Drift (missing operations)
[Operations that exist in some surfaces but not others]

### Parameter Drift
[Operations where parameters don't match across surfaces]

### Documentation Drift
[Agent plugin documentation that is out of sync]

### Recommendations
[Specific, actionable fixes ordered by impact]
```

## Naming Convention Reference

When comparing names across surfaces, these are the expected transformations (not drift):

| Concept | API JSON body | CLI Flag | Hosted MCP args | Local MCP shim args |
|---------|---------------|----------|-----------------|----------------------|
| Ticket ID | `ticketId` | `--ticket-id` | `ticketId` | `ticket_id` |
| Session Key | `sessionKey` | `--session-key` | `sessionKey` | `session_key` |
| Working Dir | `workingDirectory` | `--working-directory` | `workingDirectory` | `working_directory` |
| Ordered Objectives | `objectives` | `--objectives-json` / `--objectives-file` | `objectives` | `objectives` mapped to `--objectives-json` |
| Begin Follow-Up Work | `beginFollowUpWork` | `--begin-follow-up-work` | `beginFollowUpWork` | `begin_follow_up_work` |
| Follow-Up Intent | `followUpIntent` | `--follow-up-intent` | `followUpIntent` | `follow_up_intent` |

Hosted MCP uses camelCase to match `POST /api/protocol/*` bodies. The local shim uses snake_case because it shells to `ovld protocol` kebab-case flags.

Flag any naming that deviates from this pattern for the surface you are auditing.

## Output

Present the drift report directly to the user. Prioritize actionable drift over cosmetic differences. When parameter drift is found, include the specific parameter names and types from each surface so the fix is unambiguous.

If no drift is found, confirm alignment and note the operation count.

</drift-review>

<!-- version: 1.0.8 -->
