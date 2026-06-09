# OpenOverlord Feature Plans

This directory captures the feature requirements needed to port the working parts of Overlord into OpenOverlord. The source material reviewed for this plan was:

- Local [README.md](../../README.md)
- Upstream `cooperativ-labs/Overlord` README
- Upstream `docs/` and `docs/public/`
- Upstream `packages/overlord-cli`
- Upstream connector plugin templates and connector surface notes
- Upstream web route/component inventory for the separate web app plan

These plans are primarily requirements documents. They describe entities, behaviors, command contracts, state transitions, and acceptance criteria. The first-pass persistence proposal now lives in the database schema contract.

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

## Feature Plan Map

- [Core Domain And Lifecycle](01-core-domain-and-lifecycle.md): projects, tickets, objectives, sessions, events, statuses, and state transitions.
- [CLI First Product Surface](02-cli-first-product-surface.md): human commands, management commands, configuration, local project linking, and output contracts.
- [Agent Protocol](03-agent-protocol.md): `ovld protocol` lifecycle, context assembly, updates, delivery, attachments, and shared context.
- [Runner And Launch Execution](04-runner-and-launch-execution.md): execution requests, local runner, launch command generation, working directory resolution, and auto-advance.
- [Connectors And Agent Plugins](05-connectors-and-agent-plugins.md): connector core, plugins, adapters, hooks, setup, doctor, and launch mapping.
- [Review, Artifacts, And Change Tracking](06-review-artifacts-and-change-tracking.md): delivery review records, artifacts, rationale coverage, and local diff support.
- [USER_TOKEN Authentication Module](07-user-token-authentication.md): user-owned API/CLI tokens, creation, rotation, revocation, current full-user permission behavior, and future scoped permissions.
- [Role-Based Access Control](08-role-based-access-control.md): default `ADMIN`/`MEMBER` roles, capability grants, config-backed policy, and replaceable authorization providers.
- [Database Schema Contract](09-database-schema-contract.md): portable persistence contract, default database recommendation, core tables, realtime/sync support, and migration discipline.
- [Database Table Groups: Core and A La Carte](10-database-table-groups.md): which tables are required for every install versus optional, grouped a la carte sets with guidance on when to adopt each, and decision-tree for the agent-based setup flow.
- [Web App Requirements](web-app.md): deferred UI/control-center requirements kept separate from CLI-first implementation.

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
