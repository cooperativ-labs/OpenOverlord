# Database Table Groups: Core and A La Carte

This document categorizes OpenOverlord's database tables into a **core set** that every installation needs and **a la carte groups** that can be added later as requirements grow. The goal is to let a solo developer start with the minimum viable schema and adopt additional capabilities without migration-level rewrites.

The authoritative column and index definitions live in [09-database-schema-contract.md](09-database-schema-contract.md). This document focuses on which tables to install and when.

---

## Design Principle

Core tables are self-contained: they work without any a la carte table. A la carte tables depend on core tables (via FK) but never the reverse. Installing a la carte groups later requires only additive migrations — no changes to existing core tables or their data.

---

## Core Tables

Every OpenOverlord installation needs these. They cover the fundamental workflow: create a project, file a ticket, attach an agent, record progress, and deliver results.

### Identity and Workspace

| Table | Purpose |
|---|---|
| `workspaces` | The local instance (one workspace for CLI-first installs). |
| `users` | Global human and service-user identities. |
| `workspace_users` | Workspace membership; domain records reference this, not `users` directly. |

### Projects and Execution

| Table | Purpose |
|---|---|
| `projects` | Top-level containers mapped to git repositories. |
| `project_statuses` | Configurable ticket workflow states per project. |
| `devices` | Local and remote runner-capable machine identities. |
| `execution_targets` | Where objectives can run (local device, SSH host, etc.). |
| `workspace_user_execution_targets` | Per-user access and preferences for an execution target. |
| `project_resources` | Links a project to a directory on an execution target. |
| `project_user_preferences` | Per-user project UI/config defaults. |

### Tickets, Objectives, and Sessions

| Table | Purpose |
|---|---|
| `ticket_sequences` | Allocates the numeric part of human IDs like `1:1204`. |
| `tickets` | The durable work unit and review boundary. |
| `objectives` | One ordered agent pass inside a ticket. |
| `agent_sessions` | Live attachment between an agent and one objective. |

### Activity, Context, and Review

| Table | Purpose |
|---|---|
| `ticket_events` | Append-only timeline of all ticket activity. |
| `shared_context_entries` | Persistent ticket memory that survives across objectives. |
| `objective_attachments` | File metadata for uploads/imports scoped to an objective. |
| `deliveries` | Final or follow-up delivery review boundaries. |
| `artifacts` | Structured review artifacts attached to deliveries. |
| `changed_files` | Update-time file metadata recorded during a session. |
| `change_rationales` | Structured per-file records of what changed, why, and the impact. |

### Queue, Idempotency, and Change Feed

| Table | Purpose |
|---|---|
| `execution_requests` | Durable queue for manual runs and auto-advance. |
| `idempotency_keys` | Guards REST, protocol, hook, and worker calls against duplicate effects. |
| `entity_changes` | Canonical change feed for realtime, REST polling, and sync. |
| `schema_migrations` | Tracks which migrations have been applied per adapter and component. |

---

## A La Carte Groups

Each group is independent from the others unless noted. Install them in any order after core.

---

### Group 1: Multi-User Access and API Tokens

**Tables:** `user_tokens`, `user_token_scopes`, `role_assignments`

**When to add:**
- You are adding more users to the workspace and need controlled access.
- You want CLI or API tokens that authenticate with specific permissions.
- You are building an integration that calls the REST API from an external tool.

**Dependency notes:**
- `user_token_scopes` only makes sense alongside `user_tokens`; add both or neither.
- `role_assignments` can be added without tokens when all users access the system directly (no API token flow). It stores workspace-scoped role grants (`ADMIN`, `MEMBER`, etc.) that the auth layer checks.
- The local CLI-first MVP runs in implicit full-trust mode, so none of these are required until you explicitly add other users or enable API access.

**Do not skip if:**
- More than one human uses the workspace.
- Any external agent or service needs a long-lived credential.

---

### Group 2: Security Audit Trail

**Tables:** `audit_log`

**When to add:**
- Compliance requirements mandate logging of auth and permission decisions.
- You want a record of who approved or denied actions over time.
- You are running a shared or hosted deployment and need forensic capability.

**Dependency notes:**
- Technically standalone, but produces sparse data without Group 1. The most meaningful `audit_log` entries are auth grants, token revocations, role changes, and denied permission checks — all of which require the auth/RBAC tables to exist first.
- Can be added at any time without modifying core tables.

**Recommended pairing:** Group 1.

---

### Group 3: Background Job Processing

**Tables:** `worker_jobs`

**When to add:**
- You need a durable queue for non-agent background work: scheduled cleanup, async notifications, index rebuilds, blob deletions.
- A request handler needs to enqueue a side effect that should complete even if the process restarts.

**Dependency notes:**
- Independent of all other a la carte groups.
- Groups 4 and 7 benefit from this table, but it can be used alone.

---

### Group 4: Connector Monitoring and Permission UI

**Tables:** `connector_installations`, `hook_events`, `permission_requests`

**When to add:**
- You want a `doctor`/health check view showing which agent connectors are installed and at what version.
- You want to log raw connector lifecycle events (hook calls, stop events, prompt submissions) for debugging or audit.
- You want a structured record of permission prompts so a human or UI can review and approve/deny them.

**Dependency notes:**
- These three tables are loosely coupled but serve the same connector-visibility story; installing one without the others is allowed but provides less value.
- `hook_events` is append-only and grows with every connector event; plan for periodic pruning.
- `permission_requests` links to `ticket_events` and `agent_sessions` from core; no additional group dependency.

**Recommended pairing:** Group 3 (`worker_jobs`) for processing hook events asynchronously.

---

### Group 5: Ticket Tagging

**Tables:** `project_tag_definitions`, `ticket_tag_assignments`

**When to add:**
- You want custom labels on tickets beyond status and priority.
- You want to filter a board by tag (e.g., `backend`, `blocked-by-design`, `needs-review`).

**Dependency notes:**
- Both tables are required together; `ticket_tag_assignments` FKs into `project_tag_definitions`.
- Entirely independent of all other a la carte groups.

---

### Group 6: Persistent Realtime Client Registry

**Tables:** `sync_clients`, `sync_cursors`

**When to add:**
- You are building or running a web app, desktop client, or any persistent realtime consumer.
- Clients need to reconnect and resume from a known point in the change feed without re-fetching everything.

**Dependency notes:**
- `sync_cursors` FKs into `sync_clients`; add both together.
- The core `entity_changes` table is the actual change feed. This group only adds the per-client cursor tracking that lets a client say "give me everything since my last cursor."
- Stateless REST polling against `entity_changes` does not require this group; it is only needed for persistent, cursor-resuming clients.

**Recommended pairing:** Group 7 (`outbox_messages`) when realtime delivery of side effects (not just state changes) is also needed.

---

### Group 7: Reliable Side-Effect Delivery

**Tables:** `outbox_messages`

**When to add:**
- You need guaranteed delivery of side effects: webhooks, external notifications, search index updates, blob deletions.
- Side effects must survive process restarts (i.e., "at-least-once" delivery is required).

**Dependency notes:**
- Independent of Group 6; you can use the outbox without a client registry.
- Pairs naturally with Group 3 (`worker_jobs`): the outbox holds the intent, and a worker job drains it.
- The core `entity_changes` table is for state sync. The outbox is for effects. Do not conflate them.

**Do not skip if:**
- Attachment blob deletion needs to happen reliably after a soft-delete tombstone is committed.
- Any external system (webhook target, search engine, notification service) must receive events.

---

### Group 8: Full-Text Search

**Tables:** `search_documents`

**When to add:**
- Exact-match filters on workspace/project/status are not enough; users need ranked text search over ticket titles and objective text.
- The CLI `search-tickets` command or web app search bar needs sub-second full-text results.

**Dependency notes:**
- Independent of all other a la carte groups.
- This is the portable baseline. SQLite adapters can augment with FTS5 virtual tables; Postgres adapters can use `tsvector` and trigram indexes; both read from and write to `search_documents` using the same service interface.
- `content_hash` and `source_revision` columns enable incremental reindexing; tombstoning the source entity should remove or mark the corresponding search row.

---

## Dependency Map

```
core (always)
  └── Group 1: Multi-User Access and Tokens
        └── Group 2: Security Audit Trail
  └── Group 3: Background Jobs
        └── Group 4: Connector Monitoring (optional pairing)
        └── Group 7: Side-Effect Delivery (optional pairing)
  └── Group 4: Connector Monitoring
  └── Group 5: Tagging
  └── Group 6: Realtime Client Registry
  └── Group 7: Side-Effect Delivery
  └── Group 8: Full-Text Search
```

Arrows indicate "works better with" rather than strict FK dependency. No a la carte group FKs into another a la carte group. All FKs point into core.

---

## Decision Guide

Use the questions below to determine which groups to install. The questions are ordered from most-likely to least-likely for a new installation.

### Q1: How many people will use this instance?

- **Just me** → Start with core only.
- **Two or more** → Add Group 1 (auth/tokens) and Group 2 (audit trail).

### Q2: Will any external tool, script, or service call the REST API?

- **No** → Skip Group 1 for now.
- **Yes** → Add Group 1 (user tokens for API access).

### Q3: Do you want to build or run a web UI or desktop client?

- **No, CLI only** → Skip Groups 6 and 7 for now.
- **Yes, with persistent cursor support** → Add Group 6 (client registry) and Group 7 (outbox).
- **Yes, stateless REST only (no cursor resume)** → Add Group 7 alone if side-effect reliability matters; Group 6 is optional.

### Q4: Do you need full-text search over tickets?

- **Status/project filters are enough** → Skip Group 8.
- **Need ranked text search** → Add Group 8.

### Q5: Do you need custom ticket labels?

- **No** → Skip Group 5.
- **Yes** → Add Group 5.

### Q6: Do you want connector health dashboards or permission prompt UI?

- **No** → Skip Group 4.
- **Yes** → Add Group 4, and consider Group 3 for async event processing.

### Q7: Do you need background job infrastructure for async tasks?

- **No async work yet** → Skip Group 3.
- **Yes** → Add Group 3.

---

## Common Configurations

### Solo Developer, CLI Only

Install core only. Every a la carte group can be added later with additive migrations.

```
core
```

### Small Team, Shared Instance

Core plus auth, audit, and optional tagging.

```
core
+ Group 1 (auth/tokens)
+ Group 2 (audit)
+ Group 5 (tagging) — optional
```

### Web App or Desktop Client

Core plus realtime client tracking and reliable side-effect delivery. Add auth if the web app is multi-user.

```
core
+ Group 6 (realtime client registry)
+ Group 7 (side-effect delivery)
+ Group 3 (background jobs, to drain the outbox)
+ Group 8 (search) — optional but recommended for UI
+ Group 1 + 2 — add if multi-user
```

### Full Production Deployment

All groups. Order of adoption:

1. Core
2. Group 1 + 2 (auth, before opening to other users)
3. Group 3 (background jobs)
4. Group 7 (outbox, drained by group 3 workers)
5. Group 6 (client registry, once a persistent UI exists)
6. Group 4 (connector monitoring)
7. Group 5 (tagging)
8. Group 8 (search)

---

## Notes for the Agent-Based Setup Flow

When an agent guides a new user through `ovld init` configuration, it should ask questions in roughly the order of the decision guide above. Each question maps to one or more groups:

| Question | Group(s) |
|---|---|
| Will you share this instance with others or use the REST API from external tools? | 1, 2 |
| Do you need a web UI or desktop app with live updates? | 3, 6, 7 |
| Do you need full-text ticket search? | 8 |
| Do you want custom labels on tickets? | 5 |
| Do you want connector health monitoring or permission approval UI? | 3, 4 |

The agent should confirm the final group selection before running migrations, and should note that any group can be added later with additive-only migrations. The agent should never suggest removing core tables.

A future setup flow should also offer to add Group 1 automatically when the user provides more than one email address during init, and should offer Group 6 + 7 automatically when a web server port is configured.
