# Overlord Component Interaction Contract

Contract Version: `0.21-draft`

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

Current version: `0.21-draft`

The contract version is incremented when any stable interface changes. All conformance manifests must declare the contract version they were validated against.

| Version      | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.21-draft` | Removes the persistent seeded `local-user` identity from fresh local databases. Initial migrations may still create the placeholder local workspace and ticket sequence, but the first human `user` / `profiles` / `workspace_users` rows must be created by the Auth Layer account creation flow. The auth-to-workspace bridge grants the first authenticated workspace member `ADMIN` when it creates that member row. Loopback protocol/runner fallback no longer fabricates `local-workspace-user` when no workspace user exists; unauthenticated local automation must wait until an account exists or authenticate with a user token. Delivered as a forward cleanup migration that deletes the untouched legacy seed identity only when it has no sessions, password/OAuth accounts, tokens, execution preferences, project preferences, projects, or tickets. |
| `0.20-draft` | Hardens the `USER_TOKEN` model per the 2026-06-18 security audit and turns RBAC enforcement on across the backend. (1) Token creation now defaults `expires_at` to 90 days when no expiry is supplied; an explicit `null` expiry still means "never expires". (2) Implements the previously-reserved token scopes: `CreateUserTokenBody` accepts a `scope` (`full` \| `ticket_lifecycle`), `UserTokenDto` returns the resolved `scope`/`scopeGrants`, and non-full scopes persist grant patterns into `user_token_scopes`. A token's effective permissions are its creating user's role grants **intersected with** its scope grants (absence of scope rows = full role grants); scopes can only restrict, never exceed, the user's role. The `ticket_lifecycle` preset grants `project:read`, `ticket:*`, `objective:*`, `session:*`, `event:create`, `event:read`, `artifact:*`, `attachment:*`, `execution_request:{create,read,claim}` and excludes project/user/role/connector admin and `user_token:self:*`. (3) Adds a unified RBAC gate (`requirePermission`) applied to every `/api` route — including `/api/protocol/*` and `/api/runner/*`, which now authenticate instead of bypassing auth — resolving an `Actor` for session auth, token auth (role ∩ scope), or a loopback-trusted local-operator fallback (no session/token from localhost keeps the existing single-trusted-user behavior). `entity_changes.actor_token_id` is now populated for token-authenticated mutations. (4) Adds the `ovld user-token` CLI command group (`create`/`list`/`revoke`/`rename`, with `--scope`, `--expires-in`, `--no-expiry`) to the CLI Layer. (5) Adds an `ovld doctor` warning when the credentials directory is nested inside a known cloud-sync root, and a shared CLI token-redaction utility. Additive to schema (reuses existing `user_token_scopes` / `actor_token_id`); no new tables, migrations, or closed-vocabulary changes. |
| `0.19-draft` | Makes `profiles.handle` mirror the Better Auth account username instead of being a freely editable handle. The auth→profiles migration bridge now copies the Better Auth `user.name` (the account username) into `profiles.handle` on user insert, and a new `AFTER UPDATE OF name ON "user"` trigger keeps `profiles.handle` (and `updated_at`/`revision`) in sync whenever the username changes. Because the handle is now bridge-managed, `PATCH /api/profile` no longer accepts a `handle` field (removed from `UpdateProfileBody`); display name, email, and avatar remain editable. The Auth Layer enables Better Auth `user.changeEmail` so the webapp Account settings page can change the account username (the username is the local-part of the synthetic `<username>@overlord.local` sign-in email) and password through the Auth surface. Additive trigger/behavior change delivered as a forward migration (`20260618000000_profile_username_mirror.sql`) that also backfills existing null handles; no closed-vocabulary or new-table impact. |
| `0.18-draft` | Allows blank `draft`/`future` objectives so the add-objective affordance can create an empty editable slot rendered directly as a `DraftObjective` card for inline authoring. The `objectives.instruction_text` column remains `NOT NULL` but no longer has a trimmed non-empty CHECK constraint; service/API validation still requires non-empty instruction text for `submitted` and later states, and `PATCH /api/objectives/:id` still rejects clearing instruction text to empty. Blank objectives get a default `New objective` title and skip async title generation until authored; the web launch button (`AgentLaunchButton`) refuses to queue an objective with no instruction. Existing initial migrations are updated in place for the draft schema; no new vocabulary impact. |
| `0.17-draft` | Adds project-scoped ticket tags. Introduces two database tables: `project_tags` (per-project tag definitions: `label`, optional `color`, `active` flag, soft-delete + revision) and `ticket_tags` (the `(ticket_id, tag_id)` assignment join). The REST API Layer gains `GET/POST /api/projects/:id/tags` and `PATCH/DELETE /api/projects/:id/tags/:tagId` for definition management, `CreateTicketBody` accepts an optional `tagIds[]`, and `TicketDto` returns a populated `tags[]`. Additive: new tables and additive DTO fields only; no closed-vocabulary or breaking-interface change. |
| `0.16-draft` | Makes changed-file capture attribute files to the agent that actually edited them under concurrency. In addition to the attach-time VCS baseline (0.12), a connector that ships a `PostToolUse` edit hook writes a per-session "touched files" log (`<OVLD_HOME|~/.ovld>/vcs-touched/<sha256(abspath(cwd)+NUL+TICKET_ID)>.json`) listing the exact paths it edited. At `deliver`, the client run-attributable set becomes the VCS working-tree delta **intersected with** the touched-files log, so files dirtied by other tickets after this session attached (which have no baseline entry) are excluded. The CLI clears the log at `attach`/`resume-follow-up` (alongside the baseline). Connectors without an edit hook write no log and fall back to the 0.12 baseline-delta behavior unchanged. Adds the `editHook` connector capability and the `PostToolUse` hook type to the Claude connector. Client-only and additive; no schema, vocabulary, or migration impact. |
| `0.15-draft` | Moves reusable per-user execution-target launch preferences from workspace-scoped target/access rows into `user_execution_target_preferences`, keyed by profile, target type, and stable target fingerprint. `execution_targets` now owns target identity/connection metadata only; `workspace_user_execution_targets` owns workspace-member access only. `ovld setup` continues configuring the default terminal through the REST launch-settings surface, but persistence now writes `user_execution_target_preferences.terminal_profile_json`. Breaking database schema change; the reset schema no longer includes `agent_flags_json` / `terminal_profile_json` on `execution_targets` or `workspace_user_execution_targets`. |
| `0.14-draft` | Adds the `OVERLORD_BACKEND_URL` environment override for the client CLI/protocol backend target, mirroring the existing `OVLD_HOME` / `OVERLORD_SQLITE_PATH` / `OVERLORD_WEB_PORT` / `OVERLORD_USER_TOKEN` overrides. It takes precedence over the resolved `overlord.toml` `backend_url`, letting an in-repo build target an isolated local instance (e.g. a dev backend on `:4320`) without editing a committed `overlord.toml`. Also clarifies that `OVLD_HOME` relocates the *entire* per-user data dir — VCS baselines and native-session caches now resolve under it too, not just the SQLite database. Additive; no schema, vocabulary, or migration impact. |
| `0.13-draft` | Moves per-agent connector installation from `ovld setup <agent>` / `ovld setup all` to `ovld agent-setup <agent>` / `ovld agent-setup all`. `ovld setup` becomes the CLI-owned interactive first-run configuration flow for backend selection, agent connector setup, and `terminal_launcher` selection. Additive to config shape and REST/database boundaries; no schema or migration impact. |
| `0.12-draft` | Makes changed-file capture mechanical instead of agent-enumerated. The client CLI records a VCS baseline (`git status` paths) when a work session begins (`attach`/`resume-follow-up`) and, at `deliver`, sends the run-attributable delta (current changed paths minus baseline) as changed files — so agents no longer have to manually list what they changed. Adds the `--no-file-changes` flag to `deliver` as the explicit "this run changed no files" escape hatch that skips rationale-coverage enforcement. `deliver` now accepts `--changed-files-json` / `--changed-files-file`, and rationale-coverage validation is objective-scoped (aggregated across all sessions for the objective) per the change-tracking spec. VCS is read on the client only; the backend persists what the client sends. Additive: no schema or migration impact. |
| `0.11-draft` | Changes the published npm CLI to a client-only runtime. The CLI owns command UX, config, connector setup, and local runner/agent launching, but it no longer opens SQLite or imports database/service internals. Local mode points at a loopback backend URL (served by Desktop/local backend) and cloud mode points at a hosted backend URL; both use the REST/backend-client surface. SQLite/native dependencies move behind the local backend package. |
| `0.10-draft` | Adds first-run CLI backend onboarding: `ovld config set` can select a local SQLite backend or a hosted/cloud Postgres backend, and `ovld auth login` must ensure a backend is configured before continuing. Additive: no schema, vocabulary, or migration impact.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `0.9-draft`  | Adds the `desktop` component (**Desktop Shell**): an optional Electron wrapper around the local webapp that supervises the bundled REST/realtime server and reuses existing surfaces — it loads the SPA + `/api/*` over the loopback origin and spawns the CLI (`ovld serve`/`runner`/`launch`) as subprocesses, owning no product logic. Adds the `desktop-shell` conformance `componentType`; the `shellToRest` and `shellToCli` interaction surfaces; and the `ovld serve` management command (boot a fully-initialized local instance: create → migrate → serve), plus the documented packaged-mode app-data fallback for `overlord.toml`/SQLite resolution. Additive: no schema, vocabulary, or migration impact. |
| `0.8-draft`  | Adds post-delivery follow-up recovery: `UserPromptSubmit` hook events may record `user_follow_up` activity without a live session, and explicit protocol follow-up resume reopens a completed objective as `pending_delivery` with a new session for changed-file tracking and redelivery.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `0.7-draft`  | Adds the `custom-automation` extension point: downstream repos that track OpenOverlord upstream register their own automations via the `OVERLORD_AUTOMATIONS_MODULE` env var (loaded at server boot by `loadExternalAutomations()`), without editing the built-in automation registry. Additive; no schema or migration impact.                                                                                                                                                                                                                                                                                                                                                                                        |
| `0.6-draft`  | Moves the default SQLite database location from the repo (`database/.local/Overlord.sqlite`) to the per-user global directory (`~/.ovld/Overlord.sqlite`, overridable via `OVLD_HOME`); the `overlord.toml` `database_path` key overrides it per instance. Adds the admin `database_url` key for pointing Overlord at a hosted/cloud database, which feeds the shared `resolveAdapter()` selection point.                                                                                                                                                                                                                                                                                                              |
| `0.5-draft`  | Removes the built-in read-only SQLite browser REST surface and replaces it with optional SQL Studio launch metadata configured by `overlord.toml`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `0.4-draft`  | Renames application identity table `users` to `profiles`; profiles are created from Better Auth `user` rows with matching IDs; `workspace_users` now references `profile_id` and no longer stores a display-name override; `user_images` references profiles only.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `0.3-draft`  | Renames the AI Tools Layer (`ai-tools`) to the Automations Layer (`automations`); renames `serviceToAiTools` to `serviceToAutomations`; renames `AiTool` interface to `Automation`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `0.2-draft`  | Adds `authToDatabase` interaction surface and Better Auth implementation tables; clarifies Better Auth uses the configured database adapter. Adds the AI Tools Layer (`ai-tools`) and `serviceToAiTools` interaction surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `0.1-draft`  | Initial component interaction contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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

- Management command names and argument shapes, including `ovld setup` (interactive first-run configuration), `ovld serve` (boot a fully-initialized local instance in local/backend packages), `ovld config set` (select local loopback backend URL or hosted/cloud backend URL), and `ovld auth login` (first-run backend onboarding before authentication)
- Project linking and discovery from working directory
- Configuration file locations and formats (`overlord.toml`, `.overlord/project.json`), resolved by walking up from the working directory with a documented packaged-mode fallback to the OS app-data directory (e.g. `~/Library/Application Support/Overlord/overlord.toml`), including backend URL settings (`backend_url` for the active REST/backend endpoint, `backend_mode` as `local` or `cloud`), optional legacy database settings consumed only by local/backend packages. Terminal launch settings live on `user_execution_target_preferences.terminal_profile_json` for the local execution target fingerprint (provisioned from the device fingerprint during `ovld setup`).
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
- `ovld agent-setup <agent>` / `ovld agent-setup all` and `ovld doctor` behavior
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
- SQL Studio launch metadata in `/api/meta` when the optional external SQL Studio process is enabled

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
- Downstream automation loading via `OVERLORD_AUTOMATIONS_MODULE` (the `custom-automation` extension point)

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

### 10. Desktop Shell

**Stable identifier**: `desktop`
**Reference spec**: [`desktop/docs/desktop-app.md`](desktop/docs/desktop-app.md)

An **optional** Electron wrapper around the local webapp. It is a thin desktop shell, not a reimplementation of product logic: it loads the local web control center in a hardened `BrowserWindow`, supervises the local processes the webapp depends on, and gives the user a native app shell.

Owns:

- The Electron app/window lifecycle and the hardened `BrowserWindow` security baseline (`contextIsolation`, `sandbox`, `nodeIntegration: false`, `preload`), the loopback-scoped CSP, single-instance lock, external-navigation handling, native window chrome (macOS `hiddenInset` title bar + inset traffic-light position so the webapp nav serves as the title bar), and the sandboxed renderer's native context menu (spellcheck/edit roles)
- Process supervision of the bundled web/REST server (forked as a Node `utilityProcess`) and, optionally, a local runner
- The minimal `preload` bridge surface exposed to the renderer as `window.overlord` (feature-detected by the SPA; never required by it)
- Desktop packaging metadata and the build/sign/notarize pipeline (`electron-builder`, entitlements, app-data layout)

Does NOT own:

- REST/SSE URL paths or DTO shapes (→ REST API Layer)
- CLI/launch/terminal configuration, including per-user terminal profiles on `user_execution_target_preferences` (→ CLI / Runner Layers)
- Authentication mechanism (→ Auth Layer)
- Database schema or adapter selection (→ Database Layer)

Depends on:

- `rest` — loads the SPA and calls `/api/*` over the loopback origin
- `cli` / `runner` — spawns `ovld serve` / `ovld runner` / `ovld launch` as subprocesses
- `auth` — in-app auth uses Better Auth session cookies on the same loopback origin; spawned CLI uses `USER_TOKEN` when a credential is required

The dependency arrow points one way only: `webapp`, `cli`, and `database` MUST NOT depend on `desktop`.

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

### CLI → REST (Backend Client Surface)

- **Transport**: HTTP/JSON to the configured backend URL (`backend_url`) over loopback for local mode or HTTPS for cloud mode
- **Rule**: The published npm CLI must not open SQLite, import database adapters, or write tables directly; mutations go through REST/backend endpoints that use the service layer/database runtime behind the backend process
- **Project context**: Resolved via backend APIs plus `.overlord/project.json` and working-directory hints sent in request payloads
- **Runner**: The CLI runner remains local and launches agents, but queue claim/status/mark-success/mark-failure operations go through backend APIs

### Connector → Protocol (Hook Surface)

- **Hooks**: `UserPromptSubmit`, `PermissionRequest`, `PostToolUse`, `Stop` (future)
- **Transport**: Shell scripts invoking `ovld protocol hook-event` or `update`
- **Rule**: Hook scripts must not write to the database directly; use protocol commands only
- **Edit capture**: a connector's `PostToolUse` edit hook records the files the agent edits into the per-session touched-files log read by the client at `deliver` to make changed-file attribution exact under concurrency (see the `0.16-draft` change-tracking notes). The hook writes only normalized absolute paths — never diffs or file contents — and must not write to the database directly
- **Follow-up capture**: `UserPromptSubmit` records `user_follow_up` activity even when the original delivery ended the session; it must not reopen implementation work by itself

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
- **Identity bridge**: Auth Layer reads `workspace_users` and `profiles` (via `profiles.id = Better Auth user.id`) to resolve an authenticated identity to an Overlord `Actor`
- **Role resolution**: Auth Layer reads `role_assignments` for the resolved workspace user to build the `Actor`'s role list
- **Rule**: Auth Layer must not write to core domain tables (tickets, projects, etc.)

### Service → Automations (Automation Surface)

- **Transport**: Service-layer function calls to the automations module's exported package API (`@overlord/automations`)
- **Configuration**: Environment variables documented in `.env.example` (`GEMINI_API_KEY`, optional model override)
- **Rule**: Automations must not read or write domain tables directly; persistence goes through caller-supplied store interfaces (e.g. `ObjectiveTitleStore`)
- **Fallback**: When a provider is unavailable or a call fails, automations return `null` and callers use deterministic local fallbacks
- **Downstream extension**: Forks add automations via `OVERLORD_AUTOMATIONS_MODULE` (`custom-automation` extension point), registering through the module API — never by editing the built-in registry

### Extension → Core (Extension Surface)

- **Database**: Migrations in `ext_<name>_` prefixed tables; `schema_migrations.component = 'ext:<name>'`
- **Metadata**: Namespaced keys in `metadata_json` / `settings_json` (reverse-DNS or package-style)
- **Reactions**: Via service APIs, `entity_changes`, and `outbox_messages`; no direct writes to core tables
- **Connector extensions**: Via `user_harness_extensions` → `workspace_harness_extensions` promotion

### Desktop Shell → REST (Renderer Surface)

- **Transport**: The hardened `BrowserWindow` loads the SPA and calls `/api/*` (including the SSE `/api/stream`) over the loopback `http`/`ws` origin — it is just another HTTP client of the existing REST surface
- **Auth**: Better Auth session cookies work natively because the renderer and API share the same loopback origin; the shell injects no headers and stores no tokens for in-app requests
- **Rule**: The shell must not fork or modify the SPA; desktop-only affordances are exposed only through the feature-detected `window.overlord` preload bridge

### Desktop Shell → CLI (Process Supervision Surface)

- **Transport**: Subprocess / Node `utilityProcess` invocation of the bundled CLI and server (`ovld serve`, `ovld runner`, `ovld launch`), analogous to the Agent → Protocol subprocess pattern
- **Credential**: For spawned CLI that needs a network credential (remote/shared deployments), the shell passes a `USER_TOKEN` via `Overlord_USER_TOKEN`; pure-loopback execution talks to the local service layer and needs none
- **Rule**: The shell triggers existing CLI/runner behavior; it must not reimplement launch, terminal, or config logic the CLI/Runner Layers own

---

## Conformance Requirements

Any component, connector, or extension that ships against Overlord must:

1. **Provide a conformance manifest** (`conformance-manifest.yaml`) at its root declaring:
   - `contractVersion`: the version this component was validated against
   - `componentType`: one of `connector`, `extension`, `database-adapter`, `auth-provider`, `rest-module`, `desktop-shell`
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

| Extension Point        | Mechanism                                                                | Boundary                |
| ---------------------- | ------------------------------------------------------------------------ | ----------------------- |
| Custom agent connector | New adapter + `conformance-manifest.yaml`                                | Connector Layer         |
| Custom harness         | `user_harness_extensions` + workspace promotion                          | Extension System        |
| Custom automation      | Module(s) via `OVERLORD_AUTOMATIONS_MODULE` calling `registerAutomation` | Automations Layer       |
| Database adapter       | Implement full logical schema + pass conformance tests                   | Database Layer          |
| Database extension     | `ext_<name>_` tables + `schema_migrations.component`                     | Database Layer          |
| Auth/RBAC provider     | Auth Layer service boundary                                              | Auth Layer              |
| REST extension         | Namespaced endpoint prefix (`/ext/<name>/`)                              | REST API Layer          |
| Open vocabulary values | Namespaced values declared in manifest                                   | Database/Protocol Layer |

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

- `workspaces.kind`, `profiles.kind`
- `execution_targets.type`, `project_resources.type`
- `artifacts.type`
- `ticket_events.source`, `entity_changes.entity_type`, `entity_changes.source`
- `outbox_messages.topic`, `worker_jobs.type`
- RBAC permission names
- Connector/agent identifiers

Full value lists live in the database schema contract "Controlled Vocabularies" section.

Post-delivery follow-up execution reuses existing vocabulary values: discussion-only
follow-ups append `ticket_events.type = user_follow_up` while the objective remains
`complete`; explicit resume transitions the objective to `pending_delivery` and
creates a new session with `agent_sessions.delivery_state = pending_redelivery`.

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

| Change                                 | Contract update required?                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| New component added                    | Yes — add to component registry and `contract/components.yaml`                   |
| New interaction surface                | Yes — add to interaction surfaces and `contract/components.yaml`                 |
| Protocol command added/renamed         | Yes — update `contract/protocol-commands.yaml`                                   |
| Protocol command flag changed          | Yes — update `contract/protocol-commands.yaml`; bump version if breaking         |
| Database table/column added            | Yes — update `09-database-schema-contract.md`                                    |
| Closed vocabulary value added          | Yes — requires contract version bump                                             |
| Open vocabulary value promoted to core | Yes — add to `09-database-schema-contract.md` Controlled Vocabularies            |
| New extension point                    | Yes — add to `contract/extension-points.yaml` and this document                  |
| New connector capability flag          | Yes — add to `approvedConnectorCapabilities` in `contract/extension-points.yaml` |
| New connector shipped                  | Conformance manifest only; no contract update unless new capabilities needed     |
| Extension shipped                      | Conformance manifest only; no contract update unless new extension points needed |

### Procedure for contract-modifying changes

1. Read and understand the current contract (this document + relevant `contract/*.yaml` files)
2. Draft the required contract changes
3. **Increment the contract version** in this document header and in `contract/components.yaml`
4. Add a changelog entry to this document
5. Implement the changes in code and other docs
6. Verify any affected component's conformance manifest passes `ovld contract check`

**The implementation code must not land before the contract update.** If you are implementing code that would conflict with or extend the existing contract without updating it first, stop and update the contract first.
