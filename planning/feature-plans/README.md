# OpenOverlord Feature Plans — Redirect Index

> **The feature-plan documents have moved.** Each plan now lives inside the
> module that owns it, under `<module>/docs/`, so every module owns its own code,
> tests, **and** documentation (see the root [README](../../README.md#modules)).
> This file is now a redirect index — it no longer holds the plans themselves.

The source material reviewed for these plans was the local [README.md](../../README.md),
the upstream `cooperativ-labs/Overlord` README, upstream `docs/` and `docs/public/`,
`packages/overlord-cli`, and the upstream connector plugin templates and web
route/component inventory. The plans are requirements documents: they describe
entities, behaviors, command contracts, state transitions, and acceptance
criteria.

## Where each plan lives now

| Plan | New home | Owning module |
| --- | --- | --- |
| Core Domain and Lifecycle | [`cli/docs/01-core-domain-and-lifecycle.md`](../../cli/docs/01-core-domain-and-lifecycle.md) | [cli/](../../cli/README.md) |
| CLI-First Product Surface | [`cli/docs/02-cli-first-product-surface.md`](../../cli/docs/02-cli-first-product-surface.md) | [cli/](../../cli/README.md) |
| Agent Protocol | [`cli/docs/03-agent-protocol.md`](../../cli/docs/03-agent-protocol.md) | [cli/](../../cli/README.md) |
| Runner and Launch Execution | [`cli/docs/04-runner-and-launch-execution.md`](../../cli/docs/04-runner-and-launch-execution.md) | [cli/](../../cli/README.md) |
| Connectors and Agent Plugins | [`connectors/docs/05-connectors-and-agent-plugins.md`](../../connectors/docs/05-connectors-and-agent-plugins.md) | [connectors/](../../connectors/README.md) |
| Review, Artifacts, and Change Tracking | [`cli/docs/06-review-artifacts-and-change-tracking.md`](../../cli/docs/06-review-artifacts-and-change-tracking.md) | [cli/](../../cli/README.md) |
| USER_TOKEN Authentication | [`auth/docs/07-user-token-authentication.md`](../../auth/docs/07-user-token-authentication.md) | [auth/](../../auth/README.md) |
| Role-Based Access Control | [`auth/docs/08-role-based-access-control.md`](../../auth/docs/08-role-based-access-control.md) | [auth/](../../auth/README.md) |
| Database Schema Contract | [`database/docs/09-database-schema-contract.md`](../../database/docs/09-database-schema-contract.md) | [database/](../../database/README.md) |
| Schema Contract Review | [`database/docs/09-database-schema-contract-review.md`](../../database/docs/09-database-schema-contract-review.md) | [database/](../../database/README.md) |
| Database Table Groups | [`database/docs/10-database-table-groups.md`](../../database/docs/10-database-table-groups.md) | [database/](../../database/README.md) |
| Agent and Harness Configuration Architecture | [`connectors/docs/agent-harness-configuration-architecture.md`](../../connectors/docs/agent-harness-configuration-architecture.md) | [connectors/](../../connectors/README.md) |
| Web App Requirements | [`webapp/docs/web-app.md`](../../webapp/docs/web-app.md) | [webapp/](../../webapp/README.md) |

The [webapp module](../../webapp/README.md) also depends on the "REST API
Boundary" section of the database schema contract, and the [mcp module](../../mcp/README.md)
is a reserved Phase 5 slot with no plan yet.

## Component Interaction Contract

The normative specification for how all components interact lives in
[`CONTRACT.md`](../../CONTRACT.md) at the project root, with machine-readable
counterparts in [`contract/`](../../contract/). Any change that crosses module
boundaries — new protocol commands, new database columns, new connectors, new
extension points — must update the contract before updating other code. See
`.claude/skills/component-contract/SKILL.md` for the enforced agent workflow.

## Port Strategy

OpenOverlord should start as a local, CLI-first system:

- No auth required for the first version.
- One local instance, one default organization/workspace, and local trust boundaries.
- SQLite as the default persistence layer.
- CLI parity before web parity.
- Local runner before remote or cloud runners.
- Agent connectors installed locally and launched by the CLI.
- Web app requirements documented separately because OpenOverlord may not use Next.js.

The key product invariant to preserve from Overlord is:

> One ticket holds the durable goal and shared context. One objective maps to one agent session.

## Suggested Phases

### Phase 0: Project Skeleton And Local Config

- Define `overlord.toml` loading and defaults.
- Define `.overlord/project.json`, `.overlord/tmp/`, and `.overlord/logs/`.
- Add a local SQLite connection layer.
- Define the machine-readable schema source that will generate SQLite/Postgres DDL, documentation tables, and adapter conformance fixtures.
- Add a minimal `ovld` command with `version`, `help`, `init`, and config inspection.

### Phase 1: CLI Ticket Management

- Implement local projects, tickets, objectives, statuses, events, and sessions.
- Seed the default local workspace, implicit user, project statuses, and workspace-scoped ticket sequence.
- Implement `ovld create-project`, `ovld add-cwd`, `ovld create`, `ovld tickets list`, and `ovld ticket context`.
- Implement objective ordering and ticket status movement.

### Phase 2: Agent Protocol MVP

- Implement `ovld protocol attach`, `update`, `heartbeat`, `ask`, and `deliver`.
- Assemble prompt context from ticket, active objective, history, artifacts, attachments, and shared context.
- Persist session keys locally.
- Require change rationales on delivery when files changed.

### Phase 3: Local Launch And Runner

- Implement `ovld launch <agent>` for Codex and Claude first.
- Implement `ovld setup <agent>` for local connector install.
- Implement durable execution requests plus `ovld runner once/start/status/clear`.
- Implement manual run and objective auto-advance through the same queue.

### Phase 4: Review Features

- Implement artifacts, objective attachments, shared context, and hunk-level change rationale links.
- Implement read-only VCS change views scoped by ticket/objective in CLI form first.
- Add file-change review output suitable for a later web app.

### Phase 5: Expansion

- Add auth and multi-user support.
- Add the modular `USER_TOKEN` feature for user-owned CLI/API tokens, including create/list/rotate/revoke flows.
- Add role-based permissions with default `ADMIN` and `MEMBER` roles.
- Add extension migration support, namespaced metadata conventions, and adapter conformance tests before accepting community database adapters.
- Add remote/SSH execution targets.
- Add MCP surface.
- Add web app.
- Reconsider feed generation after the core workflow is stable. The current OpenOverlord README marks the Feed out of scope.

## Explicit Non-Goals For The First Implementation

- Do not require a hosted service for local CLI use.
- Do not require Next.js for the web app.
- Do not require Supabase, OAuth, passkeys, email, mobile, desktop, Slack, Everhour, Sentry, or feed-post generation for the CLI-first MVP.
- Do not upload repository contents automatically. Ticket content, summaries, artifacts, attachments, and rationales are persisted because a user or agent explicitly records them.
