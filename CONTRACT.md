# Overlord Component Interaction Contract

Contract Version: `0.3-draft`

## Purpose

This is the normative specification for how Overlord's components interact. It defines:

- The **component registry** — what each component owns and is responsible for
- **Interaction surfaces** — the only sanctioned communication paths between components
- **Stable interfaces** — what cannot change without a contract version bump
- **Extension points** — the only sanctioned ways to extend Overlord
- **Conformance requirements** — what a shipped component must satisfy before integration
- **Maintenance rules** — when and how to update this document

**Agents and developers MUST read this document before implementing any change that crosses module boundaries, and MUST update it before implementing any change that extends or conflicts with the current contract.**

See `.claude/skills/component-contract.md` for the enforced agent workflow.

## Contract Version

Current version: `0.3-draft`

The contract version is incremented when any stable interface changes. All conformance manifests must declare the contract version they were validated against.

| Version | Changes |
| --- | --- |
| `0.3-draft` | Renames the AI Tools Layer (`ai-tools`) to the Automations Layer (`automations`); renames `serviceToAiTools` to `serviceToAutomations`; renames `AiTool` interface to `Automation`. |
| `0.2-draft` | Adds `authToDatabase` interaction surface and Better Auth implementation tables; clarifies Better Auth uses the configured database adapter. Adds the AI Tools Layer (`ai-tools`) and `serviceToAiTools` interaction surface. |
| `0.1-draft` | Initial component interaction contract. |

---

## Component Registry

Each component owns a defined set of responsibilities. No component may directly access another's internals — use only the declared interaction surfaces.

### 1. Protocol Layer

**Stable identifier**: `protocol`
**Reference spec**: [`cli/docs/03-agent-protocol.md`](cli/docs/03-agent-protocol.md)

Owns:
- All `ovld protocol` subcommand names and their required/optional flags
- Session lifecycle: `attach → (update|heartbeat)* → (ask|deliver)`
- Context assembly format returned by `attach`
- Delivery payload structure and validation rules
- Changed-file and change-rationale recording protocol
- Idempotency key scope naming for protocol operations (`protocol.*`)

Does NOT own:
- Connector installation (→ Connector Layer)
- Database schema (→ Database Layer)
- Authentication mechanism (→ Auth Layer)

### 2. Database Layer

**Stable identifier**: `database`
**Reference spec**: [`database/docs/09-database-schema-contract.md`](database/docs/09-database-schema-contract.md)

Owns:
- Table definitions, column types, indexes, foreign keys, CHECK constraints
- Controlled vocabularies (closed and open sets)
- Soft-delete and revision semantics
- Migration versioning via `schema_migrations`
- Extension table naming rules (`ext_<name>_`)
- Logical types and their adapter mappings

Does NOT own:
- Service-layer business logic (owned by the layer calling into the database)
- REST response shapes (→ REST API Layer)

### 3. CLI Layer

**Stable identifier**: `cli`
**Reference spec**: [`cli/docs/02-cli-first-product-surface.md`](cli/docs/02-cli-first-product-surface.md)

Owns:
- Management command names and argument shapes
- Project linking and discovery from working directory
- Configuration file locations and formats (`overlord.toml`, `.overlord/project.json`), including web bind settings such as `web_host` and `web_port`
- Human-readable CLI output format conventions

Does NOT own:
- Protocol commands (→ Protocol Layer)
- Agent connector installation (→ Connector Layer)

### 4. Connector Layer

**Stable identifier**: `connector`
**Reference spec**: [`connectors/docs/05-connectors-and-agent-plugins.md`](connectors/docs/05-connectors-and-agent-plugins.md)

Owns:
- Connector core workflow instructions
- Per-agent plugin/adapter files and managed file manifests
- Hook scripts and their event contracts
- `ovld setup <agent>` and `ovld doctor` behavior
- Connector capability declarations (the approved capability flag set)

Does NOT own:
- Protocol command implementations (→ Protocol Layer)
- Harness extension catalog (→ Extension System)

### 5. Runner Layer

**Stable identifier**: `runner`
**Reference spec**: [`cli/docs/04-runner-and-launch-execution.md`](cli/docs/04-runner-and-launch-execution.md)

Owns:
- `execution_requests` queue claiming and launch
- Working directory resolution
- `ovld runner` commands
- Execution target selection logic

Does NOT own:
- Protocol session lifecycle (→ Protocol Layer)
- Connector installation (→ Connector Layer)

### 6. REST API Layer

**Stable identifier**: `rest`
**Reference spec**: `database/docs/09-database-schema-contract.md` → REST API Boundary section

Owns:
- URL paths and HTTP method contracts
- Request/response DTO shapes (derived from the logical schema's camelCase field names)
- REST auth integration points
- SSE/WebSocket realtime endpoint
- Read-only SQLite browser endpoints under `/api/sqlite-browser/*`

Does NOT own:
- Database schema (→ Database Layer)
- Protocol CLI surface (→ Protocol Layer)

### 7. Auth Layer

**Stable identifier**: `auth`
**Reference specs**: [`auth/docs/07-user-token-authentication.md`](auth/docs/07-user-token-authentication.md), [`auth/docs/08-role-based-access-control.md`](auth/docs/08-role-based-access-control.md)

Owns:
- Token creation, rotation, revocation, and hash storage
- Role assignment CRUD
- Permission check interface
- Audit log attribution fields
- Better Auth implementation tables (`user`, `session`, `account`, `verification`, `apikey`) — these are auth-internal and must not be read directly by other components

Does NOT own:
- User identity schema (co-owned with Database Layer via schema contract)
- Application business logic gating (callers act on the result of a permission check)

### 8. Automations Layer

**Stable identifier**: `automations`
**Reference spec**: [`automations/docs/01-automations-overview.md`](automations/docs/01-automations-overview.md)

Owns:
- Pluggable automation interface (`Automation`) and built-in automation registry
- Provider configuration for optional Gemini-backed tools (`GEMINI_API_KEY`, model selection)
- Reference summarization tools (text summarization, objective title generation)
- Fire-and-forget automation helpers that callers invoke through injected persistence callbacks

Does NOT own:
- Database schema (→ Database Layer)
- Ticket/objective lifecycle state machines (→ CLI / service layer callers)
- Agent protocol or connector behavior (→ Protocol / Connector Layers)

### 9. Extension System

**Stable identifier**: `extension`
**Reference specs**: `database/docs/09-database-schema-contract.md` → Extension Points section; [`connectors/docs/agent-harness-configuration-architecture.md`](connectors/docs/agent-harness-configuration-architecture.md)

Owns:
- `user_harness_extensions` authoring workflow
- `workspace_harness_extensions` catalog promotion workflow
- Extension table namespace (`ext_<name>_`)
- Extension migration component naming (`ext:<name>`)
- Namespaced JSON metadata keys inside core tables

Does NOT own:
- Core table schemas (→ Database Layer)
- Built-in connector catalog (→ Connector Layer)

---

## Interaction Surfaces

These are the **only sanctioned paths** between components. Bypassing these surfaces is a contract violation.

### Agent → Protocol (Primary Ticket Surface)

- **Transport**: Subprocess CLI invocation of `ovld protocol <command>`
- **Authentication**: Session key passed as flag or environment variable
- **Required sequence**: `attach → (update|heartbeat)* → (ask|deliver)`
- **Response format**: JSON on stdout; non-zero exit on error
- **Shell-special content**: Must use `--summary-file -` / `--payload-file -` with stdin heredoc

### Protocol → Database (Service Layer)

- **Transport**: Service layer function calls within ACID transactions
- **Rule**: No direct table writes from protocol handlers; use the service layer
- **Concurrency**: Optimistic compare-and-set via `revision`; zero-row update = `409` conflict
- **Change feed**: `entity_changes` appended in same transaction as domain mutation
- **Idempotency**: Protocol-scope idempotency keys in `idempotency_keys`

### CLI → Database (Management Surface)

- **Transport**: Service layer function calls
- **Rule**: Same service layer as Protocol Layer; identical transaction semantics
- **Project context**: Resolved via `.overlord/project.json` and working directory

### Connector → Protocol (Hook Surface)

- **Hooks**: `UserPromptSubmit`, `PermissionRequest`, `Stop` (future)
- **Transport**: Shell scripts invoking `ovld protocol hook-event` or `update`
- **Rule**: Hook scripts must not write to the database directly; use protocol commands only

### Runner → Database (Queue Surface)

- **Transport**: Service layer function calls in ACID transactions
- **Claiming**: Atomic compare-and-set claim on `execution_requests`; verify launchable state
- **Side effects**: Claim must append `ticket_events` and `entity_changes` in same transaction

### REST API → Database (HTTP Surface)

- **Transport**: Service layer function calls; same service layer as CLI and Protocol
- **Auth**: Token or session auth via Auth Layer before service call
- **Response shape**: Derived from logical schema camelCase field names
- **Idempotency**: REST-scope idempotency keys for retried writes

### Auth → Database (Identity Bridge)

- **Transport**: Better Auth's configured database adapter for auth tables; direct service-layer/database adapter queries for identity bridging
- **Auth tables owned**: `user`, `session`, `account`, `verification`, `apikey` — auth-internal; no other component accesses them directly
- **Identity bridge**: Auth Layer reads `workspace_users` and `users` (via `users.external_subject` / `users.auth_provider = 'better-auth'`) to resolve an authenticated identity to an Overlord `Actor`
- **Role resolution**: Auth Layer reads `role_assignments` for the resolved workspace user to build the `Actor`'s role list
- **Rule**: Auth Layer must not write to core domain tables (tickets, projects, etc.)

### Service → Automations (Automation Surface)

- **Transport**: Service-layer function calls to the automations module's exported API (`src/automations/`)
- **Configuration**: Environment variables documented in `.env.example` (`GEMINI_API_KEY`, optional model override)
- **Rule**: Automations must not read or write domain tables directly; persistence goes through caller-supplied store interfaces (e.g. `ObjectiveTitleStore`)
- **Fallback**: When a provider is unavailable or a call fails, automations return `null` and callers use deterministic local fallbacks

### Extension → Core (Extension Surface)

- **Database**: Migrations in `ext_<name>_` prefixed tables; `schema_migrations.component = 'ext:<name>'`
- **Metadata**: Namespaced keys in `metadata_json` / `settings_json` (reverse-DNS or package-style)
- **Reactions**: Via service APIs, `entity_changes`, and `outbox_messages`; no direct writes to core tables
- **Connector extensions**: Via `user_harness_extensions` → `workspace_harness_extensions` promotion

---

## Conformance Requirements

Any component, connector, or extension that ships against Overlord must:

1. **Provide a conformance manifest** (`conformance-manifest.yaml`) at its root declaring:
   - `contractVersion`: the version this component was validated against
   - `componentType`: one of `connector`, `extension`, `database-adapter`, `auth-provider`, `rest-module`
   - `componentKey`: stable lowercase identifier
   - All capabilities and extension points it uses

2. **Pass validation** via `ovld contract check <manifest-file>`
   (or the equivalent validation script until `ovld contract` is implemented)

3. **Respect ownership boundaries**: only interact with other components through declared surfaces

4. **Use namespaced identifiers** for all extension values — table names, JSON keys, event types, vocabulary extensions

5. **Declare all vocabulary extensions** from open vocabularies in its conformance manifest

See [`contract/conformance-manifest.schema.yaml`](contract/conformance-manifest.schema.yaml) for the required manifest shape.

---

## Extension Points

The only sanctioned ways to extend Overlord:

| Extension Point | Mechanism | Boundary |
| --- | --- | --- |
| Custom agent connector | New adapter + `conformance-manifest.yaml` | Connector Layer |
| Custom harness | `user_harness_extensions` + workspace promotion | Extension System |
| Database adapter | Implement full logical schema + pass conformance tests | Database Layer |
| Database extension | `ext_<name>_` tables + `schema_migrations.component` | Database Layer |
| Auth/RBAC provider | Auth Layer service boundary | Auth Layer |
| REST extension | Namespaced endpoint prefix (`/ext/<name>/`) | REST API Layer |
| Open vocabulary values | Namespaced values declared in manifest | Database/Protocol Layer |

Attempting to extend Overlord through any other path — patching core tables directly, adding undeclared hook types, using closed vocabulary values — is a contract violation that must be resolved before the component ships.

See [`contract/extension-points.yaml`](contract/extension-points.yaml) for machine-readable declarations and the approved capability flag list.

---

## Controlled Vocabularies

### Closed (contract-version-bump required to add values)

- `objectives.state`: `future`, `draft`, `submitted`, `launching`, `executing`, `pending_delivery`, `complete`
- `project_statuses.type`: `draft`, `execute`, `review`, `complete`, `blocked`, `cancelled`
- `execution_requests.status`: `queued`, `claimed`, `launching`, `launched`, `failed`, `cleared`, `cancelled`, `expired`
- `agent_sessions.delivery_state`: `not_delivered`, `delivered`, `pending_redelivery`
- `ticket_events.type`: `update`, `user_follow_up`, `alert`, `discussion_summary`, `decision`, `ask`, `permission_request`, `delivery`, `execution_requested`, `awaiting_approval`, `status_change`
- `permission_requests.status`: `requested`, `approved`, `denied`, `expired`, `not_required`
- `idempotency_keys.status`: `in_progress`, `completed`, `failed`
- `audit_log.result`: `allowed`, `denied`, `failed`

### Open (extensions may add namespaced values)

- `workspaces.kind`, `users.kind`
- `execution_targets.type`, `project_resources.type`
- `artifacts.type`
- `ticket_events.source`, `entity_changes.entity_type`, `entity_changes.source`
- `outbox_messages.topic`, `worker_jobs.type`
- RBAC permission names
- Connector/agent identifiers

Full value lists live in the database schema contract "Controlled Vocabularies" section.

---

## Machine-Readable Contract Files

The `contract/` directory contains machine-readable counterparts:

- [`contract/components.yaml`](contract/components.yaml) — Component registry with capabilities and interface declarations
- [`contract/protocol-commands.yaml`](contract/protocol-commands.yaml) — Protocol command names, required flags, and response shape versions
- [`contract/extension-points.yaml`](contract/extension-points.yaml) — Sanctioned extension points and approved capability flags
- [`contract/conformance-manifest.schema.yaml`](contract/conformance-manifest.schema.yaml) — JSON Schema (YAML) for conformance manifests

---

## Contract Maintenance Rules

### When to update this document

| Change | Contract update required? |
| --- | --- |
| New component added | Yes — add to component registry and `contract/components.yaml` |
| New interaction surface | Yes — add to interaction surfaces and `contract/components.yaml` |
| Protocol command added/renamed | Yes — update `contract/protocol-commands.yaml` |
| Protocol command flag changed | Yes — update `contract/protocol-commands.yaml`; bump version if breaking |
| Database table/column added | Yes — update `09-database-schema-contract.md` |
| Closed vocabulary value added | Yes — requires contract version bump |
| Open vocabulary value promoted to core | Yes — add to `09-database-schema-contract.md` Controlled Vocabularies |
| New extension point | Yes — add to `contract/extension-points.yaml` and this document |
| New connector capability flag | Yes — add to `approvedConnectorCapabilities` in `contract/extension-points.yaml` |
| New connector shipped | Conformance manifest only; no contract update unless new capabilities needed |
| Extension shipped | Conformance manifest only; no contract update unless new extension points needed |

### Procedure for contract-modifying changes

1. Read and understand the current contract (this document + relevant `contract/*.yaml` files)
2. Draft the required contract changes
3. **Increment the contract version** in this document header and in `contract/components.yaml`
4. Add a changelog entry to this document
5. Implement the changes in code and other docs
6. Verify any affected component's conformance manifest passes `ovld contract check`

**The implementation code must not land before the contract update.** If you are implementing code that would conflict with or extend the existing contract without updating it first, stop and update the contract first.
