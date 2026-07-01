# Overlord Component Interaction Contract

Contract Version: `0`

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

## Editions

Overlord ships in two editions that share one contract:

- **Overlord Local** (default): the Electron desktop shell supervises a loopback
  backend over SQLite on the user's machine. No account or network dependency.
- **Overlord Cloud** (additive): the backend and system-of-record database run as
  a hosted control plane; the desktop app, web app, CLI, and execution targets
  connect over HTTPS. Same REST, protocol, and realtime contract — only
  `backend_url` and auth differ.

Both editions are first-class. A contract change for Cloud must never regress Local;
where a surface differs by edition this document calls it out explicitly.

## Contract Version

Current version: `0`

The contract version is incremented when any stable interface changes. All conformance manifests must declare the contract version they were validated against.

| Version | Changes |
| ------- | ------- |
| `0` | Initial public release baseline. Describes the full component registry, interaction surfaces, stable interfaces, extension points, and controlled vocabularies as shipped in Open Overlord v0. |

---

---

## Component Registry

Each component owns a defined set of responsibilities. No component may directly access another's internals — use only the declared interaction surfaces.

### 1. Protocol Layer

**Stable identifier**: `protocol`
**Reference spec**: [`cli/docs/03-agent-protocol.md`](cli/docs/03-agent-protocol.md)

Owns:

- All `ovld protocol` subcommand names and their required/optional flags
- The `packages/core/` protocol/service core source package: shared service functions, repository helpers, and generated database types used by protocol, REST, CLI tests, and database harnesses
- Session lifecycle: `attach → (update|heartbeat)* → (ask|deliver)`
- Context assembly format returned by `attach`
- Delivery payload structure and validation rules
- Changed-file and change-rationale recording protocol
- Idempotency key scope naming for protocol operations (`protocol.*`)

Does NOT own:

- Connector installation (→ Connector Layer)
- Database schema (→ Database Layer)
- Authentication mechanism (→ Auth Layer)
- Runner queue/device/project-resource management commands (→ CLI / Runner / REST Layers)

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
- The async `DatabaseClient` adapter that owns the underlying handle/pool and serves every read/write on both editions through `?`-placeholder SQL (including the SQLite-only `sqliteDataVersion()` external-write probe); production callers never hold a raw synchronous `better-sqlite3` handle

Does NOT own:

- Service-layer business logic (owned by the layer calling into the database)
- REST response shapes (→ REST API Layer)

### 3. CLI Layer

**Stable identifier**: `cli`
**Reference spec**: [`cli/docs/02-cli-first-product-surface.md`](cli/docs/02-cli-first-product-surface.md)

Owns:

- Management command names and argument shapes, including `ovld setup` (interactive first-run configuration), `ovld serve` (boot a fully-initialized local instance in local/backend packages), `ovld config set` (select local loopback backend URL or hosted/cloud backend URL), and `ovld auth login` (first-run backend onboarding before authentication)
- Project linking and discovery from working directory
- Configuration file locations and formats (`overlord.toml`, `.overlord/project.json`), resolved by walking up from the working directory with a documented packaged-mode fallback to the OS app-data directory (e.g. `~/Library/Application Support/Overlord/overlord.toml`), including backend URL settings (`backend_url` for the active REST/backend endpoint, `backend_mode` as `local` or `cloud`), optional legacy database settings consumed only by local/backend packages. Terminal launch settings live on `user_execution_target_preferences.terminal_profile_json` for the local execution target fingerprint (provisioned from the device fingerprint during `ovld setup`). Config resolution layers, highest precedence first: an explicit runtime export of the channel variable (shell / container launcher) set before any env file loads, then the resolved `overlord.toml` `backend_url` (per-instance, e.g. written by `ovld config set`), then the profile env-file default (`.env.local`/`.env.prod`, backfilled), then a hardcoded fallback — see `resolveBackendUrl` in `cli/src/config.ts`. Development and production read **separate** backend env vars so the two channels never collide: development resolves `OVERLORD_BACKEND_URL_DEV` (`.env.local`, e.g. a dev backend on `:4320`) and never reads or writes the production `OVERLORD_BACKEND_URL`; production resolves `OVERLORD_BACKEND_URL` (`.env.prod`). No tooling aliases the dev channel into the production variable. The dev-only `OVERLORD_BACKEND_URL_DEV` must never reach a production app: a bare `ovld` invocation chooses its profile by build origin — an **installed/published** CLI (under `node_modules`) runs as `production` and never auto-loads `.env.local` or reads `OVERLORD_BACKEND_URL_DEV`, even inside a dev checkout, while only the in-repo source build and the dev/test tooling that runs it (`yarn dev`, `with-ovld-home`) default to `development` (`detectCliEnvProfile` in `cli/src/env.ts`). The webapp server and desktop pass their own profile explicitly (source-vs-bundled). A backfilled env-file value is only a default: an explicit `overlord.toml` outranks it (so `ovld config set`/`ovld init` take effect), and only a deliberate shell export of the channel variable outranks the toml. `overlord.toml` and `.overlord/project.json` are per-instance/per-deployment artifacts that are **not committed** — they are gitignored like `.env.local`/`.env.prod`, generated for a deployment by `ovld init`/`ovld setup`, with `overlord.toml.example` as the committed template. Local development needs no `overlord.toml`: it runs off `.env.local` plus code defaults. Each `ovld` process resolves its own config independently from its own working directory/env. A CLI running inside a container/agent pod is a pure consumer of the injected runtime `OVERLORD_BACKEND_URL` and **must not persist config**: `writeConfig` refuses to write `overlord.toml` when `isRunningInContainer()` (an explicit launcher `OVERLORD_IN_POD` marker, or the Docker `/.dockerenv` sentinel) is true unless `OVERLORD_ALLOW_CONFIG_WRITE=1` overrides it — preventing a context-specific value from leaking through a host-mounted file onto every host process that resolves it.
- The optional per-repo `.overlordignore` file (git repo root): gitignore-style patterns for paths the client-side changed-file capture must never report as run-attributable changes (see [`cli/docs/11-review-artifacts-and-change-tracking.md`](cli/docs/11-review-artifacts-and-change-tracking.md)). Parsed and applied entirely on the client in `cli/src/vcs.ts`.
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
- Per-mission branch/worktree preparation before local agent spawn when enabled, including the deterministic branch/worktree **planning** algorithm (`cli/src/branch-planning.ts`) — co-owned with the service layer and pinned to `contract/branch-planning-vectors.json` (see "Shared Deterministic Algorithms")
- `ovld runner` commands
- Execution target selection logic
- Runner queue REST operations used by `ovld runner`: `GET /api/runner/status`, `POST /api/runner/claim`, `POST /api/runner/clear`, `POST /api/runner/requests/:id/launching`, `POST /api/runner/requests/:id/launched`, and `POST /api/runner/requests/:id/failed`
- Branch-preparation acknowledgement through `POST /api/missions/:id/branch-prepared`

Does NOT own:

- Protocol session lifecycle (→ Protocol Layer)
- Connector installation (→ Connector Layer)

### 6. REST API Layer

**Stable identifier**: `rest`
**Reference spec**: `database/docs/09-database-schema-contract.md` → REST API Boundary section

Owns:

- URL paths and HTTP method contracts
- Request/response DTO shapes (derived from the logical schema's camelCase field names)
- Realtime `EntityChangeDto` projections from `entity_changes`, including `changedFields` parsed from `changed_fields_json`
- Read-only derived mission branch metadata (`MissionBranchDto`) from `missions.active_branch`, predicted via the service layer's copy of the shared branch/worktree planning algorithm (`backend/branch-planning.ts`) — co-owned with the Runner Layer and pinned to `contract/branch-planning-vectors.json` (see "Shared Deterministic Algorithms")
- On-demand branch-action git mutations (`POST /api/missions/:id/branch/action`: commit / merge-with-parent / push-parent / publish) run host-side against the project's worktrees under `~/.ovld/worktrees` and primary repo (`backend/repository.ts`). The Runner Layer owns launching the *agent* into a worktree, not these on-demand mutations.
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
- Self-service account deletion trigger (`user.deleteUser`), delegating the cascade to a backend-supplied callback
- Sign-up/sign-in email verification: an optional `sendVerificationEmail` callback (`CreateAuthOptions.sendVerificationEmail`) delegates delivery to a backend-supplied sender, mirroring the `onDeleteUser` delegation pattern. When provided, Better Auth also enables `emailAndPassword.requireEmailVerification` so unverified accounts cannot sign in. When omitted (the default, e.g. Local/offline editions with no configured email provider), verification stays fully disabled and behavior is unchanged. The backend's concrete sender (`backend/email-verification.ts`) uses Resend, configured via the `RESEND_API_KEY` env var and the `notifications.cooperativ.io` sending domain

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
- Mission/objective lifecycle state machines (→ CLI / service layer callers)
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

An **optional** Electron wrapper around the webapp. It is a thin desktop shell, not a reimplementation of product logic: it loads the web control center in a hardened `BrowserWindow`, supervises the local processes the webapp depends on (Local mode), and gives the user a native app shell.

The shell runs in one of two modes, selected by the active **backend profile** (Local is the default and the unchanged behavior all prior contract text describes):

- **Local profile** (unchanged): fork the embedded web/REST server (`utilityProcess`) and load the bundled SPA from the loopback origin; API base = the loopback origin; Better Auth session cookies are same-origin; CSP/nav guard are scoped to that single loopback origin.
- **Remote profile** (additive): **do not** fork the embedded server. The bundled SPA still loads from a local origin (privileged renderers never load remote content), but its runtime-injected **API base URL** points at the hosted backend. Auth uses a per-backend **bearer token** obtained at login and persisted via `safeStorage`/keychain, injected into the SPA's API client and into any spawned `ovld` process (not the local defaults). CSP `connect-src` and the navigation guard are recomputed from the active profile to allow the remote REST + `wss://` origins while keeping navigation shell-local; `/api/health` checks support HTTPS with a Local fallback.

Owns:

- The Electron app/window lifecycle and the hardened `BrowserWindow` security baseline (`contextIsolation`, `sandbox`, `nodeIntegration: false`, `preload`), the loopback-scoped CSP, single-instance lock, external-navigation handling, native window chrome (macOS `hiddenInset` title bar + inset traffic-light position so the webapp nav serves as the title bar), and the sandboxed renderer's native context menu (spellcheck/edit roles)
- Process supervision of the bundled web/REST server (forked as a Node `utilityProcess` in **Local** mode only; **not forked** in Remote mode) and, optionally, a local runner
- Persisted backend **profiles** (`{ id, label, mode: 'local' | 'remote', backendUrl }` + active profile id) in `userData/settings.json`, per-profile Electron **session partitions** (`persist:backend-<id>`), per-backend bearer-token storage via `safeStorage`, and the reload-and-login switcher / first-run chooser
- The minimal `preload` bridge surface exposed to the renderer as `window.overlord` (feature-detected by the SPA; never required by it), including the additive backend-config ops `getActiveBackend()`, `listBackends()`, `addBackend()`, `removeBackend()`, and `switchBackend(id)`, plus `writeProjectMetadata(...)` for local checkout metadata writes in remote-client mode and `invokeLocalTarget(call)` for unified checkout-local capabilities
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

### Agent → Protocol (Primary Mission Surface)

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
- **Edit capture**: a connector's `PostToolUse` edit hook records the files the agent edits into the per-session touched-files log read by the client at `deliver` to make changed-file attribution exact under concurrency (see change-tracking in `cli/docs/11-review-artifacts-and-change-tracking.md`). The hook writes only normalized absolute paths — never diffs or file contents — and must not write to the database directly
- **Follow-up capture**: `UserPromptSubmit` records `user_follow_up` activity even when the original delivery ended the session; it must not reopen implementation work by itself

### Runner → REST (Queue Surface)

- **Transport**: HTTP/JSON to the configured backend URL
- **Endpoints**: `GET /api/runner/status`, `POST /api/runner/claim`, `POST /api/runner/clear`, `POST /api/runner/requests/:id/launching`, `POST /api/runner/requests/:id/launched`, `POST /api/runner/requests/:id/failed`, and `POST /api/missions/:id/branch-prepared`
- **Claiming**: Backend performs an atomic compare-and-set claim on `execution_requests`; verifies launchable state
- **Side effects**: Backend claim and state transitions append `mission_events` and `entity_changes` in the same transaction
- **Claim metadata**: Claim must set `claimed_by_device_id`, `claimed_by_execution_target_id` when known, and `claim_expires_at`
- **State transitions**: `queued → claimed → launching → launched|failed`; active requests may be cleared; stale claims and launched-without-attach requests may move to `expired`; other terminal statuses are sinks unless a new request is explicitly queued
- **Attach correlation**: Protocol attach links the launched request to `agent_sessions` via `execution_requests.launched_session_id` when the launched context supplies an execution request id

### REST API → Database (HTTP Surface)

- **Transport**: Service layer function calls; same service layer as CLI and Protocol
- **Auth**: Token or session auth via Auth Layer before service call
- **Response shape**: Derived from logical schema camelCase field names
- **Idempotency**: REST-scope idempotency keys for retried writes

### Auth → Database (Identity Bridge)

- **Transport**: Better Auth's configured database adapter for auth tables; direct service-layer/database adapter queries for identity bridging. The auth domain query helpers (`queryOne`/`queryAll`/`execute`) run against the async `DatabaseClient` (preferred) or, for tests/legacy callers, a raw `better-sqlite3` handle or a bare `PostgresQueryExecutor`; the webapp routes both editions through the `DatabaseClient`
- **Auth tables owned**: `user`, `session`, `account`, `verification`, `apikey` — auth-internal; no other component accesses them directly
- **Identity bridge**: Auth Layer reads `workspace_users` and `profiles` (via `profiles.id = Better Auth user.id`) to resolve an authenticated identity to an Overlord `Actor`
- **Role resolution**: Auth Layer reads `role_assignments` for the resolved workspace user to build the `Actor`'s role list
- **Rule**: Auth Layer must not write to core domain tables (missions, projects, etc.) itself
- **Exception**: the `deleteUser` `beforeDelete` hook invokes a backend-supplied `onDeleteUser(userId)` callback (`backend/account-deletion.ts`, injected via `CreateAuthOptions`) to hard-purge the `ON DELETE RESTRICT` children of `profiles` and `workspace_users` — `workspace_users`, `user_tokens`, `user_images`, `role_assignments`, `workspace_user_execution_targets`, `project_user_preferences` — before the auth `user` row is hard-deleted, which in turn hard-cascades `session`, `account`, `profiles`, and `user_execution_target_preferences`. `RESTRICT` blocks on row existence regardless of `deleted_at`, so this must be a hard purge, not a tombstone; each purge still emits an `entity_changes` row. The write happens inside the caller-supplied callback, not in Auth Layer code, mirroring the Service → Automations delegation pattern (caller-supplied persistence callbacks)
- **Email delivery**: sign-up/sign-in verification emails are sent through a backend-supplied `sendVerificationEmail(params)` callback (`backend/email-verification.ts`, injected via `CreateAuthOptions`), the same caller-supplied-callback pattern as `onDeleteUser`. Auth Layer only invokes the callback with Better Auth's `{ user, url, token }`; it does not know about or depend on the concrete provider (Resend, configured via `RESEND_API_KEY` and the `notifications.cooperativ.io` domain)

### Service → Automations (Automation Surface)

- **Transport**: Service-layer function calls to the automations module's exported package API (`@overlord/automations`)
- **Configuration**: Environment variables documented in `.env.prod.example` / `.env.local.example` (`GEMINI_API_KEY`, optional model override)
- **Rule**: Automations must not read or write domain tables directly; persistence goes through caller-supplied store interfaces (e.g. `ObjectiveTitleStore`)
- **Fallback**: When a provider is unavailable or a call fails, automations return `null` and callers use deterministic local fallbacks
- **Downstream extension**: Forks add automations via `OVERLORD_AUTOMATIONS_MODULE` (`custom-automation` extension point), registering through the module API — never by editing the built-in registry

### Extension → Core (Extension Surface)

- **Database**: Migrations in `ext_<name>_` prefixed tables; `schema_migrations.component = 'ext:<name>'`
- **Metadata**: Namespaced keys in `metadata_json` / `settings_json` (reverse-DNS or package-style)
- **Reactions**: Via service APIs, `entity_changes`, and `outbox_messages`; no direct writes to core tables
- **Connector extensions**: Via `user_harness_extensions` → `workspace_harness_extensions` promotion

### Desktop Shell → REST (Renderer Surface)

- **Transport**: The hardened `BrowserWindow` loads the SPA and calls `/api/*` (including the SSE realtime stream) — over the loopback `http`/`ws` origin in **Local** mode, or over the hosted backend's HTTPS/`wss` origin (a separate origin from the local shell) in **Remote** mode, via the SPA's runtime-injected API base URL. Either way the SPA is just another HTTP client of the existing REST surface
- **Auth**: In **Local** mode, Better Auth session cookies work natively because the renderer and API share the same loopback origin; the shell injects no headers and stores no tokens. In **Remote** mode (cross-origin), the shell prefers a **bearer token** over cross-site cookies: it is obtained at login, persisted per-backend via `safeStorage`, and injected into the SPA's API client — unifying with the CLI `USER_TOKEN` model
- **Rule**: The shell must not fork or modify the SPA; desktop-only affordances are exposed only through the feature-detected `window.overlord` preload bridge. Navigation stays scoped to the shell origin in both modes

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

## Shared Deterministic Algorithms

A few pure, deterministic computations must produce **identical** results in more than one component. Rather than share a runtime package (which couples the components' build/publish graphs), each component keeps its own copy of the algorithm and both copies are pinned to a single committed **conformance fixture** of golden input→output vectors. CI runs both component test suites against the same fixture, so the implementations cannot drift apart.

### Per-mission branch/worktree planning

- **Algorithm**: `planMissionBranch`, `previewMissionBranch`, `missionWorktreePath`, `sanitizeBranchName`, `canonicalMissionBranch`, `slugifyBranchTitle` (and the `BranchDecision*` types).
- **Implementations** (must stay byte-for-byte equivalent in behavior):
  - Runner Layer — `cli/src/branch-planning.ts`, used by `cli/src/branch-preparation.ts` to **prepare** the real branch/worktree before launch.
  - Service layer (backend) — `backend/branch-planning.ts`, used by `backend/repository.ts` to **predict** `MissionBranchDto` branch metadata surfaced over REST.
- **Conformance fixture**: [`contract/branch-planning-vectors.json`](contract/branch-planning-vectors.json). Both `cli/test/branch-planning.test.ts` and `backend/branch-planning.test.ts` assert their implementation against every vector.
- **Rule**: Neither component may import the other's copy across the boundary. Any change to the algorithm MUST update both copies, regenerate the fixture, and **bump the contract version** — the fixture is a stable interface.

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
- `workspace_statuses.type`: `draft`, `execute`, `review`, `complete`, `blocked`, `cancelled`
- `execution_requests.status`: `queued`, `claimed`, `launching`, `launched`, `failed`, `cleared`, `cancelled`, `expired`
- `agent_sessions.delivery_state`: `not_delivered`, `delivered`, `pending_redelivery`
- `mission_events.type`: `update`, `user_follow_up`, `alert`, `discussion_summary`, `decision`, `ask`, `permission_request`, `delivery`, `execution_requested`, `awaiting_approval`, `status_change`
- `permission_requests.status`: `requested`, `approved`, `denied`, `expired`, `not_required`
- `idempotency_keys.status`: `in_progress`, `completed`, `failed`
- `audit_log.result`: `allowed`, `denied`, `failed`
- `workspace_invitations.status`: `pending`, `accepted`, `revoked`, `expired`

### Open (extensions may add namespaced values)

- `workspaces.kind`, `profiles.kind`
- `execution_targets.type`, `project_resources.type`
- `artifacts.type`
- `mission_events.source`, `entity_changes.entity_type`, `entity_changes.source`
- `outbox_messages.topic`, `worker_jobs.type`
- RBAC permission names
- Connector/agent identifiers

Full value lists live in the database schema contract "Controlled Vocabularies" section.

Post-delivery follow-up execution reuses existing vocabulary values: discussion-only
follow-ups append `mission_events.type = user_follow_up` while the objective remains
`complete`; explicit resume transitions the objective to `pending_delivery` and
creates a new session with `agent_sessions.delivery_state = pending_redelivery`.

---

## Machine-Readable Contract Files

The `contract/` directory contains machine-readable counterparts:

- [`contract/components.yaml`](contract/components.yaml) — Component registry with capabilities and interface declarations
- [`contract/protocol-commands.yaml`](contract/protocol-commands.yaml) — Protocol command names, required flags, and response shape versions
- [`contract/extension-points.yaml`](contract/extension-points.yaml) — Sanctioned extension points and approved capability flags
- [`contract/conformance-manifest.schema.yaml`](contract/conformance-manifest.schema.yaml) — JSON Schema (YAML) for conformance manifests
- [`contract/branch-planning-vectors.json`](contract/branch-planning-vectors.json) — Golden input→output vectors pinning the duplicated per-mission branch/worktree planning algorithm (see "Shared Deterministic Algorithms")

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
