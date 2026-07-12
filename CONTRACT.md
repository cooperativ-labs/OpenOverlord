# Overlord Component Interaction Contract

Contract Version: `3`

## Purpose

This is the normative specification for how Overlord's components interact. It defines:

- The **component registry** — what each component owns and is responsible for
- **Interaction surfaces** — the only sanctioned communication paths between components
- **Stable interfaces** — what cannot change without a contract version bump
- **Extension points** — the only sanctioned ways to extend Overlord
- **Conformance requirements** — what a shipped component must satisfy before integration
- **Maintenance rules** — when and how to update this document

**Agents and developers MUST read this document before implementing any change that crosses module boundaries, and MUST update it before implementing any change that extends or conflicts with the current contract.**

See `.claude/skills/component-contract/SKILL.md` for the enforced agent workflow.

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

Current version: `5`

The contract version is incremented when any stable interface changes. All conformance manifests must declare the contract version they were validated against.

| Version | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `5`     | Resource registration completion (coo:263). `ovld add-cwd --key` reuses the project-scoped logical resource identity and upserts its target-scoped `local_checkout` source. Adds `ovld add-url --url <git-url>` to register or update a project-global `git` source for that same identity. `POST /api/projects/:id/resources` accepts either a local `directoryPath` or a Git `sourceUrl`; source descriptors remain typed and secret-free.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `4`     | Workspace execution-target settings (coo:263). Adds the authenticated, workspace-scoped read projection `GET /api/workspaces/:id/execution-targets`, returning target identity, non-secret type/status/owner display metadata, reachability, and active workspace-member access count. The settings UI uses this projection to separate all workspace targets into individual expandable cards; it does not expose connection details, credentials, target creation, registration, or membership mutation. Project settings continue to select only the acting member's eligible targets through the existing project-target selection surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `3`     | Provider-neutral virtual execution targets and resource identity/source split (coo:258, coo:263). Adds `virtual` as a documented core `execution_targets.type`, the external **Virtual Target Gateway** boundary and its versioned `/api/virtual-targets/v1/*` REST surface (registration, claim, progress, launched, failed, grant exchange, mission resources, delegated actions), the `rest-consumer` conformance component type, seven new core tables (`execution_target_registrations`, `project_environment_definitions`, `project_resource_sources`, `execution_request_snapshots`, `execution_request_grants`, `execution_request_observations`, `mission_target_resources`) plus `execution_requests` snapshot/failure/gateway columns. `project_resources` is one project-scoped logical identity (`resource_key`, label, primary/lifecycle metadata) and `project_resource_sources` owns all target-specific/global materialization descriptors (local checkout paths, Git, bundles, opaque handles). Existing resource rows and observations are intentionally discarded so users re-add sources. The immutable `VirtualExecutionQueueItemV1` carries resource identities plus typed sources, not paths; `execution_requests.status` and every other closed vocabulary are unchanged. |
| `2`     | ChatGPT Apps publication surface (coo:224). Adds explicit MCP tool output schemas and safety annotations, standard `ui://overlord/*` MCP Apps widget resources, structured tool results, and OAuth resource binding across approval and token exchange. Hosted MCP errors now distinguish tool failures from transport failures without exposing local checkout or runner capabilities.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `1`     | Resource-bound objectives and sibling resource context (coo:169). Adds logical `project_resources.resource_key`, target-portable `objectives.resource_key`, resource-scoped mission branch observations, additive `attach-response-v3` project resource manifest fields, optional `executionTargetId` protocol context input, `.overlord/project.json` `resourceKey`, `ovld add-cwd --key`, branch-action `resourceKey`, and resource-scoped worktree-path vectors. The worktree path algorithm now includes `resourceKey`, forcing this contract version bump.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `0`     | Initial public release baseline (coo:144). Describes the full component registry (including the MCP Server), interaction surfaces, stable interfaces (`attach-response-v3`, webhook delivery, organization → workspace → project hierarchy, multi-target `.overlord/project.json` linking, target-workspace project APIs, deliver `observedDirtyPaths` reconciliation, and `ovld protocol changes` preflight), extension points, and controlled vocabularies as shipped in Open Overlord v0. Pre-release contract versions 1–8 were consolidated into this baseline at public release.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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
- The `organizations` table (grouping layer above `workspaces`: `id` uuid, `name`, `settings_json` incl. `logoUrl`, timestamps, `deleted_at`, `revision`) and the required `workspaces.organization_id` FK; workspaces remain the sole RBAC layer, and slugs are unique per organization, not instance-wide
- The virtual execution target core tables (`execution_target_registrations`, `project_environment_definitions`, `project_resource_sources`, `execution_request_snapshots`, `execution_request_grants`, `execution_request_observations`, `mission_target_resources`) and the additive `execution_requests` snapshot/failure/gateway columns — these are **core** (not `ext_` extension) because they drive queue status, audit, authorization, and UI. The immutable `execution_request_snapshots` row (canonical `payload_json` + SHA-256 `payload_digest`) is created in the same transaction as its `queued` request and is never updated; retrying only increments `attempt_count`. Grant records store hashes/opaque IDs, never bearer values
- Controlled vocabularies (closed and open sets)
- Soft-delete and revision semantics
- Migration versioning via `schema_migrations`
- Extension table naming rules (`ext_<name>_`)
- Logical types and their adapter mappings
- The async `DatabaseClient` adapter that owns the underlying handle/pool and serves every read/write on both editions through `?`-placeholder SQL (including the SQLite-only `sqliteDataVersion()` external-write probe); production callers never hold a raw synchronous `better-sqlite3` handle
- Ambient transactions: while a root `DatabaseClient`'s `transaction(async tx => ...)` callback is running, any query issued through that same root client from inside that async context automatically joins the open transaction (via `AsyncLocalStorage`, scoped per root instance) instead of deadlocking (SQLite) or executing outside the transaction on another pooled connection (Postgres); a transaction-scoped client captured and reused after its transaction has committed or rolled back throws `TransactionClosedError`

Does NOT own:

- Service-layer business logic (owned by the layer calling into the database)
- REST response shapes (→ REST API Layer)

### 3. CLI Layer

**Stable identifier**: `cli`
**Reference spec**: [`cli/docs/02-cli-first-product-surface.md`](cli/docs/02-cli-first-product-surface.md)

Owns:

- Management command names and argument shapes, including `ovld setup` (interactive first-run configuration), `ovld serve` (boot a fully-initialized local instance in local/backend packages), `ovld config set` (select local loopback backend URL or hosted/cloud backend URL), and `ovld auth login` (first-run backend onboarding before authentication)
- Project linking and discovery from working directory
- Configuration file locations and formats (`overlord.toml`, `.overlord/project.json`), resolved by walking up from the working directory with a documented packaged-mode fallback to the OS app-data directory (e.g. `~/Library/Application Support/Overlord/overlord.toml`), including backend URL settings (`backend_url` for the active REST/backend endpoint, `backend_mode` as `local` or `cloud`), optional legacy database settings consumed only by local/backend packages. Terminal launch settings live on `user_execution_target_preferences.terminal_profile_json` for the local execution target fingerprint (provisioned from the device fingerprint during `ovld setup`). `.overlord/project.json` remains CLI-owned local link metadata: the legacy top-level `resourceId` stays required for backward compatibility, while the additive `resourceIdsByExecutionTarget` object may map `execution_targets.id` to target-scoped `project_resources.id`; readers must accept either shape and prefer the target-specific id when they know the acting execution target. The additive `resourceKey` field records the logical project resource key for this checkout and is reused when linking the same logical resource from another target. Config resolution layers, highest precedence first: an explicit runtime export of the channel variable (shell / container launcher) set before any env file loads, then the resolved `overlord.toml` `backend_url` (per-instance, e.g. written by `ovld config set`), then the profile env-file default (`.env.local`/`.env.prod`, backfilled), then a hardcoded fallback — see `resolveBackendUrl` in `cli/src/config.ts`. Development and production read **separate** backend env vars so the two channels never collide: development resolves `OVERLORD_BACKEND_URL_DEV` (`.env.local`, e.g. a dev backend on `:4320`) and never reads or writes the production `OVERLORD_BACKEND_URL`; production resolves `OVERLORD_BACKEND_URL` (`.env.prod`). No tooling aliases the dev channel into the production variable. The dev-only `OVERLORD_BACKEND_URL_DEV` must never reach a production app: a bare `ovld` invocation chooses its profile by build origin — an **installed/published** CLI (under `node_modules`) runs as `production` and never auto-loads `.env.local` or reads `OVERLORD_BACKEND_URL_DEV`, even inside a dev checkout, while only the in-repo source build and the dev/test tooling that runs it (`yarn dev`, `with-ovld-home`) default to `development` (`detectCliEnvProfile` in `cli/src/env.ts`). The webapp server and desktop pass their own profile explicitly (source-vs-bundled). A backfilled env-file value is only a default: an explicit `overlord.toml` outranks it (so `ovld config set`/`ovld init` take effect), and only a deliberate shell export of the channel variable outranks the toml. `overlord.toml` and `.overlord/project.json` are per-instance/per-deployment artifacts that are **not committed** — they are gitignored like `.env.local`/`.env.prod`, generated for a deployment by `ovld init`/`ovld setup`, with `overlord.toml.example` as the committed template. Local development needs no `overlord.toml`: it runs off `.env.local` plus code defaults. Each `ovld` process resolves its own config independently from its own working directory/env. A CLI running inside a container/agent pod is a pure consumer of the injected runtime `OVERLORD_BACKEND_URL` and **must not persist config**: `writeConfig` refuses to write `overlord.toml` when `isRunningInContainer()` (an explicit launcher `OVERLORD_IN_POD` marker, or the Docker `/.dockerenv` sentinel) is true unless `OVERLORD_ALLOW_CONFIG_WRITE=1` overrides it — preventing a context-specific value from leaking through a host-mounted file onto every host process that resolves it.
- Project resource registration commands: `ovld add-cwd` accepts optional `--key <resourceKey>` to bind/upsert a local checkout source for a stable logical resource key; `ovld add-url --url <git-url>` binds/upserts a project-global Git source for that same identity.
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
- Working directory resolution, ordered as explicit `workingDirectory`, objective `resource_key` on the claiming execution target, primary project resource for the target, then matching cwd `.overlord/project.json` fallback; a missing objective-bound resource fails with `objective_resource_not_connected`
- Per-mission branch/worktree preparation before local agent spawn when enabled, including the deterministic branch/worktree **planning** algorithm (`cli/src/branch-planning.ts`) — co-owned with the service layer and pinned to `contract/branch-planning-vectors.json` (see "Shared Deterministic Algorithms")
- Same-mission branch/worktree reuse: if the planned worktree already exists and is checked out on the expected mission branch, the runner may launch into it even when it has uncommitted changes, so sequential objectives can continue work on the same branch without forcing an intermediate commit
- Runner launch environment variables, including `OVERLORD_PROJECT_RESOURCES` as a JSON sibling-resource manifest resolved for the launching execution target
- `ovld runner` commands
- The persistent runner service: `ovld runner supervise` (the long-lived adaptive-polling loop that delegates each poll to the same one-shot claim-and-launch path as `ovld runner once`) and the `ovld runner service <install|start|stop|restart|status|uninstall>` management commands that register/control an OS-level user service (macOS `launchd` LaunchAgent `io.overlord.runner`, Linux `systemd --user` unit `overlord-runner.service`). Adaptive polling uses a fast cadence (3s) while a job launched within the last two hours and a slow cadence (10s) afterwards, keyed on the "last launched job" clock with ~10% jitter. Local diagnostic state (installed service kind/identifier, resolved exec path, backend URL, last heartbeat/claim/launch timestamps, last error, current poll interval) is stored in `~/.ovld/runner-service.json`; it is local-only and not a backend source of truth. Service definition files embed a captured environment snapshot (backend URL, `OVLD_HOME`, user token, minimal `PATH`, and — when the installer itself runs under Electron-as-Node, e.g. driven by the desktop shell — `ELECTRON_RUN_AS_NODE=1` so the recorded Electron exec path keeps running as the CLI) and are written owner-read/write only. Windows is not yet supported. The desktop app may drive these commands but must not reimplement the supervisor or service management
- Execution target selection logic
- Runner queue REST operations used by `ovld runner`: `GET /api/runner/status`, `POST /api/runner/claim`, `POST /api/runner/clear`, `POST /api/runner/requests/:id/launching`, `POST /api/runner/requests/:id/launched`, and `POST /api/runner/requests/:id/failed`
- Branch-preparation acknowledgement through `POST /api/missions/:id/branch-prepared`

Does NOT own:

- Protocol session lifecycle (→ Protocol Layer)
- Connector installation (→ Connector Layer)
- Virtual execution target claiming and environment realization (→ REST **Virtual Target Queue Surface** + external gateway). The runner claims and launches only local/device execution targets; it never resolves a working directory for a `virtual` target

### 6. REST API Layer

**Stable identifier**: `rest`
**Reference spec**: `database/docs/09-database-schema-contract.md` → REST API Boundary section

Owns:

- URL paths and HTTP method contracts
- Request/response DTO shapes (derived from the logical schema's camelCase field names)
- Realtime `EntityChangeDto` projections from `entity_changes`, including `changedFields` parsed from `changed_fields_json`
- Read-only derived mission branch metadata (`MissionBranchDto`) from `missions.active_branch`, predicted via the service layer's copy of the shared branch/worktree planning algorithm (`backend/branch-planning.ts`) — co-owned with the Runner Layer and pinned to `contract/branch-planning-vectors.json` (see "Shared Deterministic Algorithms")
- On-demand branch-action git mutations (`POST /api/missions/:id/branch/action`: commit / merge-with-parent / push-parent / publish) run host-side against the project's worktrees under `~/.ovld/worktrees` and the selected project resource (`resourceKey` request field, defaulting to the primary resource) (`backend/repository.ts`). The Runner Layer owns launching the _agent_ into a worktree, not these on-demand mutations.
- REST auth integration points
- SSE/WebSocket realtime endpoint
- SQL Studio launch metadata in `/api/meta` when the optional external SQL Studio process is enabled
- Webhook subscription management (`/api/webhooks*`: list/create, update/delete, rotate-secret, test, deliveries, redeliver) and the in-process webhook dispatcher (`backend/webhook-dispatcher.ts`, a `RealtimeHub`-style singleton polling loop that claims `outbox_messages` rows and delivers HMAC-signed HTTP POSTs). SSRF guards (HTTPS-only, private-network block) apply to external endpoints; hosts matching the `OVERLORD_WEBHOOK_INTERNAL_HOSTS` env allowlist (plus implicit `localhost` in Local edition) are treated as internal — exempt from the SSRF block and the HTTPS requirement, and default to the `full` payload mode
- Organization management endpoints: list organizations for the caller, update an organization (name/logo; org-admin gated), and list/add/remove organization admins (transactional invariant: an org admin is `ADMIN` of _every_ constituent workspace)
- The shared onboarding endpoint (`POST /api/onboarding`, zero-membership users only): creates an organization, a workspace (default `general`), the caller's membership, and the `ADMIN` role in one transaction, then returns `/api/meta` — used verbatim by both the web onboarding screen and the `ovld org-setup` CLI command so the two clients cannot drift
- Storage routes for the `organization-images` bucket key (`/api/storage/organization-images/…`) with a `PUBLIC organization_image:read` grant, mirroring `workspace_image:read`
- Workspace target projection (`GET /api/workspaces/:id/execution-targets`): authenticated members may view every non-deleted target in that workspace, including non-secret identity/status/owner metadata, reachability, and active-member access count. It never exposes `connection_json`, credentials, or target-access mutation; project selection remains constrained to the caller's eligible targets.
- Workspace agent catalog management (`GET /api/agent-catalog`, `PUT /api/agent-catalog`, `POST /api/agent-catalog/refresh`) for `workspaces.settings_json.agentCatalog`
- Hosted MCP OAuth endpoints: dynamic client registration (`POST /oauth/register`), authorization-code + PKCE token exchange (`POST /oauth/token`), revocation (`POST /oauth/revoke`), browser authorization redirect (`GET /oauth/authorize` → web approval UI), and authenticated approval helpers (`POST /oauth/authorize/request`, `POST /oauth/authorize/approve`)
- The versioned **virtual-target gateway route family** (`/api/virtual-targets/v1/*`): `PUT …/registration`, `POST …/claim`, `POST …/requests/:id/progress`, `POST …/requests/:id/launched`, `POST …/requests/:id/failed`, `POST …/grants/:id/exchange`, `GET …/missions/:id/resources`, and `POST …/missions/:id/actions`. REST owns the DTO shapes, target-authenticated auth/RBAC enforcement, per-request idempotency, and bounded/redacted output for this surface. The immutable `VirtualExecutionQueueItemV1` payload and its digest are built by the service layer at queue time and returned only to the authenticated claiming gateway; the local `/api/runner/*` routes are unchanged

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
- Numeric one-time codes (OTP): an optional `sendEmailOTP` callback (`CreateAuthOptions.sendEmailOTP`) enables Better Auth's `emailOTP` plugin (6-digit codes, 1-hour expiry), the same caller-supplied-callback pattern as `sendVerificationEmail`. When enabled, the sign-up verification email carries **both** the existing magic link **and** a real 6-digit code minted via `auth.api.createVerificationOTP` and passed to `sendVerificationEmail` as `otp` — replacing the previous behavior of showing the raw (untypable) verification link token in the code block. The plugin also exposes `/api/auth/email-otp/*` server endpoints (notably `verify-email`, `check-verification-otp`, `send-verification-otp`, `sign-in/email-otp`, `forget-password`/`reset-password`) and the corresponding `authClient.emailOtp.*` client methods for typed-code sign-in and password reset. When `sendEmailOTP` is omitted, the plugin is left off and no OTP endpoints exist. The backend sender is `emailOTPSenderFromEnv()` in `backend/email-verification.ts` (Resend-backed)
- Hosted MCP OAuth consent and token issuance: OAuth approval creates a scoped `USER_TOKEN` with the `mission_lifecycle` preset after an authenticated browser session approves the request. Authorization codes are short-lived, single-use, PKCE-protected, and exchanged for bearer access tokens; refresh tokens are not issued through contract version `2`. A code that expires unexchanged, or whose exchange fails its client/PKCE/resource checks, revokes the `USER_TOKEN` it would have delivered, so no orphaned active token outlives its authorization code.

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
- The minimal `preload` bridge surface exposed to the renderer as `window.overlord` (feature-detected by the SPA; never required by it), including the additive backend-config ops `getActiveBackend()`, `listBackends()`, `addBackend()`, `removeBackend()`, and `switchBackend(id)`, plus `writeProjectMetadata(...)` for local checkout metadata writes in remote-client mode, `invokeLocalTarget(call)` for unified checkout-local capabilities, and `runnerService.{getStatus,install,start,stop,restart,uninstall}()` which drives the CLI-owned `ovld runner service <action>` operations as a subprocess and returns their parsed JSON result (the shell never manages the service process itself)
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

### 11. MCP Server

**Stable identifier**: `mcp`
**Reference spec**: [`mcp/README.md`](mcp/README.md)

An optional hosted Model Context Protocol surface for cloud agents such as
ChatGPT, Claude, and other MCP clients. It runs inside the backend process and
is enabled only when `OVERLORD_MCP_ENABLED=true`.

Owns:

- MCP endpoint path (`/mcp`) and supported MCP protocol-version advertisement
- MCP tool names, input/output schemas, safety annotations, MCP Apps resource
  URI patterns, prompt names, and MCP JSON-RPC response shaping. The public
  ChatGPT surface is mission-first: project resolution and selection, mission
  search, mission-context reads, and explicit mission/session writes. Widget
  resources are presentation-only and consume the structured result of a
  corresponding render tool; they never call local filesystem or runner APIs.
- OAuth protected-resource metadata for the hosted MCP resource
- Mapping MCP tool calls to existing service/protocol operations

Does NOT own:

- Database schema or persistence rules (→ Database Layer)
- Authentication mechanism, token issuance, consent, or RBAC policy (→ Auth Layer)
- Protocol lifecycle semantics such as attach/update/deliver state transitions (→ Protocol Layer)
- REST URL/DTO contracts outside `/mcp` and OAuth discovery metadata (→ REST API Layer)
- Local filesystem, worktree, runner claim, or branch-action operations (→ CLI / Runner / REST Layers)

Depends on:

- `auth` — resolves the MCP caller to an authenticated profile/workspace actor
- `protocol` / service layer — executes mission lifecycle and project discovery operations
- `database` — reached only through existing service/protocol functions

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
- **Effect queue**: `enqueueWebhookEvent()` (`packages/core/service/webhook-events.ts`) appends matching `outbox_messages` rows in the same transaction as the domain mutation — a second shared-single-writer rule alongside `insertEntityChange`, called from both the protocol service core and the REST data layer so no origin path silently skips webhook delivery
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

### Virtual Gateway → REST (Virtual Target Queue Surface)

- **Transport**: HTTPS/JSON to the configured backend under the versioned `/api/virtual-targets/v1/*` route family
- **Authentication**: A gateway principal credential scoped to exactly one `execution_targets` row of type `virtual` (target-authenticated, **not** device-authenticated). A gateway cannot enumerate, claim, or observe another target's work; `execution_requests.claimed_by_execution_target_id` is the universal claimant identity and `claimed_by_device_id` stays nullable for virtual claims
- **Registration**: `PUT /api/virtual-targets/v1/registration` registers/refreshes the target's gateway identity (`gateway_key`, `gateway_instance_id`), advertised capabilities, supported agents, supported queue schema versions, adapter key/version, and heartbeat. Registration **replaces** rather than creates a target when a stable gateway identity matches
- **Claiming**: `POST /api/virtual-targets/v1/claim` atomically claims a queued request assigned to the caller's target and returns the immutable `VirtualExecutionQueueItemV1` snapshot, a `claimId`, an expiry, and only request-scoped opaque launch-grant references — never filesystem paths or raw secrets. Replaying the same gateway + request returns the same claim and payload. `resolveWorkingDirectory` never runs on a virtual claim
- **Observed state**: `POST …/requests/:id/progress` appends a bounded, monotonic preparation observation and does **not** change status; `POST …/requests/:id/launched` validates request/claim/target/digest, records a `VirtualTargetLaunchObservationV1`, then makes the normal `launching → launched` transition exactly once; `POST …/requests/:id/failed` records a typed, redacted `VirtualTargetFailureV1` and makes the allowed transition to `failed` (its `retryable` flag informs existing retry policy but does not itself requeue). All three are idempotent by request and observation `sequence`
- **Grants**: `POST …/grants/:id/exchange` swaps an authenticated, unexpired opaque grant for narrowly scoped credentials or attachment-download access, bound to request + target + gateway instance; every exchange is audited and never returns the user's Overlord token
- **Mission resources / actions**: `GET …/missions/:id/resources` returns summarized opaque lifecycle resources and source-compatibility observations; `POST …/missions/:id/actions` authorizes an explicit `start`/`stop`/`archive`/`delete`/`enqueue`/`retry`/`dequeue` action and delegates it to the target. Delegated-action output becomes an observation and can **never** change mission completion — only an agent protocol delivery completes an objective
- **Boundary rule**: Desired launch state (Overlord's immutable snapshot) and observed realization state (gateway reports) are kept separate. Paths and raw credentials never cross this boundary. The gateway owns source/environment realization and observed-state reporting; Overlord owns durable queue delivery, leases/retries, and status transitions

### REST API → Database (HTTP Surface)

- **Transport**: Service layer function calls; same service layer as CLI and Protocol
- **Auth**: Token or session auth via Auth Layer before service call
- **Response shape**: Derived from logical schema camelCase field names
- **Idempotency**: REST-scope idempotency keys for retried writes

### MCP Server → Auth (Hosted Agent Auth Surface)

- **Transport**: HTTP bearer credentials on `GET/POST /mcp`
- **Discovery**: `GET /.well-known/oauth-protected-resource` and
  `GET /.well-known/oauth-protected-resource/mcp` advertise the MCP resource URL
  and authorization-server metadata locations
- **Authorization server**: OAuth-aware clients use dynamic registration (`POST /oauth/register`), browser approval (`GET /oauth/authorize` redirecting to the web approval page), authorization-code + PKCE token exchange (`POST /oauth/token`), and token revocation (`POST /oauth/revoke`). The web app may serve same-domain `.well-known` metadata and proxy `/mcp` plus `/oauth/*` traffic to the backend when deployed separately from the backend.
- **OAuth resource binding**: when an OAuth client supplies the RFC 8707
  `resource` parameter, approval and token exchange bind it to the canonical
  hosted `/mcp` resource; a mismatched resource is an OAuth `invalid_target`
  error. This prevents an authorization code minted for Overlord from being
  replayed against a different resource.
- **Rule**: MCP handlers must resolve the caller through the Auth Layer before
  listing or invoking tools. A request that is missing or fails authentication
  returns an OAuth-compatible `WWW-Authenticate: Bearer` challenge.
- **Workspace binding**: the active workspace is resolved by the Auth Layer from
  the bearer credential plus `X-Overlord-Active-Workspace` when supplied; MCP
  must not silently select another workspace after auth.

### MCP Server → Service Layer

- **Transport**: In-process function calls from MCP tool handlers to existing
  service/protocol functions
- **Rule**: MCP handlers must not read or write database tables directly.
- **Authorization**: Every tool call must pass through the same RBAC gates as the
  corresponding REST or protocol operation.
- **Project context**: Hosted MCP cannot observe a cloud agent's current working
  directory. Mutating mission creation tools must require explicit `projectId`
  or a prior resolved project identity; missing or ambiguous project context is
  a tool error, not an implicit default selection.
- **Locality**: Hosted MCP must not expose local filesystem/worktree inspection,
  runner queue claiming, execution target mutation, or branch-action tools.
- **Widget safety**: MCP Apps resources use `ui://overlord/*` URIs and return
  self-contained HTML. They may render only the associated tool's
  `structuredContent`; resources must not embed third-party frames, browser
  credentials, secrets, or unrestricted network access.

### Auth → Database (Identity Bridge)

- **Transport**: Better Auth's configured database adapter for auth tables; direct service-layer/database adapter queries for identity bridging. The auth domain query helpers (`queryOne`/`queryAll`/`execute`) run against the async `DatabaseClient` (preferred) or, for tests/legacy callers, a raw `better-sqlite3` handle or a bare `PostgresQueryExecutor`; the webapp routes both editions through the `DatabaseClient`
- **Auth tables owned**: `user`, `session`, `account`, `verification`, `apikey` — auth-internal; no other component accesses them directly
- **Identity bridge**: Auth Layer reads `workspace_users` and `profiles` (via `profiles.id = Better Auth user.id`) to resolve an authenticated identity to an Overlord `Actor`; browser sessions may request their active workspace with the `overlord_active_workspace` cookie, and bearer-authenticated web clients may use the equivalent `X-Overlord-Active-Workspace` header when cookies are unavailable. Both values are treated only as preferences and are accepted only after re-validating active membership in `workspace_users`
- **Role resolution**: Auth Layer reads `role_assignments` for the resolved workspace user to build the `Actor`'s role list
- **Rule**: Auth Layer must not write to core domain tables (missions, projects, etc.) itself
- **Exception**: the `deleteUser` `beforeDelete` hook invokes a backend-supplied `onDeleteUser(userId)` callback (`backend/account-deletion.ts`, injected via `CreateAuthOptions`) to hard-purge the `ON DELETE RESTRICT` children of `profiles` and `workspace_users` — `workspace_users`, `user_tokens`, `user_images`, `role_assignments`, `workspace_user_execution_targets`, `project_user_preferences` — before the auth `user` row is hard-deleted, which in turn hard-cascades `session`, `account`, `profiles`, and `user_execution_target_preferences`. `RESTRICT` blocks on row existence regardless of `deleted_at`, so this must be a hard purge, not a tombstone; each purge still emits an `entity_changes` row. The write happens inside the caller-supplied callback, not in Auth Layer code, mirroring the Service → Automations delegation pattern (caller-supplied persistence callbacks)
- **Email delivery**: sign-up/sign-in verification emails are sent through a backend-supplied `sendVerificationEmail(params)` callback (`backend/email-verification.ts`, injected via `CreateAuthOptions`), the same caller-supplied-callback pattern as `onDeleteUser`. Auth Layer invokes the callback with Better Auth's `{ user, url, token }` plus a minted 6-digit `otp` (when the `emailOTP` plugin is enabled via `sendEmailOTP`); it does not know about or depend on the concrete provider (Resend, configured via `RESEND_API_KEY` and the `notifications.cooperativ.io` domain). The verification email shows the `otp` in its code block and uses `token` only to build the clickable link — the raw `token` is never displayed as a typed code
- **One-time codes (OTP)**: when `sendEmailOTP` is injected, the `emailOTP` plugin is registered and writes codes to the auth-internal `verification` table (identifier `email-verification-otp-<email>` etc.). It adds `/api/auth/email-otp/*` endpoints; the sign-up confirmation code is minted inside `sendVerificationEmail` (no separate email), while `sendEmailOTP` delivers standalone codes for passwordless sign-in and password reset. Codes are 6 digits and expire after 1 hour

### Service → Automations (Automation Surface)

- **Transport**: Service-layer function calls to the automations module's exported package API (`@overlord/automations`)
- **Browser-safe subpaths**: SPA / renderer callers that need pure lifecycle or scheduling helpers MUST import `@overlord/automations/objective-manager` or `@overlord/automations/scheduling-engine` instead of the package root. The root barrel also re-exports Gemini-backed title tools and therefore pulls `@google/genai` into the client graph when imported from the webapp.
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
- **Auth**: In **Local** mode, Better Auth session cookies work natively because the renderer and API share the same loopback origin; the shell injects no headers and stores no tokens. In **Remote** mode (cross-origin), the shell prefers a **bearer token** over cross-site cookies: it is obtained at login, persisted per-backend via `safeStorage`, and injected into the SPA's API client — unifying with the CLI `USER_TOKEN` model. Because cross-site cookies are not the workspace preference source in this mode, the SPA may send `X-Overlord-Active-Workspace` with the selected workspace id; the backend validates membership exactly as it does for the local cookie before scoping the request
- **Rule**: The shell must not fork or modify the SPA; desktop-only affordances are exposed only through the feature-detected `window.overlord` preload bridge. Navigation stays scoped to the shell origin in both modes

### Desktop Shell → CLI (Process Supervision Surface)

- **Transport**: Subprocess / Node `utilityProcess` invocation of the bundled CLI and server (`ovld serve`, `ovld runner`, `ovld launch`, `ovld runner service <action>`), analogous to the Agent → Protocol subprocess pattern
- **Credential**: For spawned CLI that needs a network credential (remote/shared deployments), the shell passes a `USER_TOKEN` via `Overlord_USER_TOKEN`; pure-loopback execution talks to the local service layer and needs none
- **Persistent runner control**: The `runnerService.*` preload ops spawn `ovld runner service <install|start|stop|restart|status|uninstall> --json` in the shell's main process, injecting the active backend URL and (remote mode) token so an install captures the right credential; the parsed JSON status is returned to the renderer. The shell never claims runner queue work, supervises the loop, or generates service files itself — those stay CLI/Runner-owned
- **Rule**: The shell triggers existing CLI/runner behavior; it must not reimplement launch, terminal, or config logic the CLI/Runner Layers own

---

## Conformance Requirements

Any component, connector, or extension that ships against Overlord must:

1. **Provide a conformance manifest** (`conformance-manifest.yaml`) at its root declaring:
   - `contractVersion`: the version this component was validated against
   - `componentType`: one of `connector`, `extension`, `database-adapter`, `auth-provider`, `rest-module`, `rest-consumer`, `desktop-shell`, `mcp-server`
   - `componentKey`: stable lowercase identifier
   - All capabilities and extension points it uses

2. **Pass validation** via `ovld contract check <manifest-file>`
   (or the equivalent validation script until `ovld contract` is implemented)

3. **Respect ownership boundaries**: only interact with other components through declared surfaces

4. **Use namespaced identifiers** for all extension values — table names, JSON keys, event types, vocabulary extensions

5. **Declare all vocabulary extensions** from open vocabularies in its conformance manifest

### Virtual Target Gateway conformance

A **Virtual Target Gateway** is a `rest-consumer` (e.g. Racecar) that realizes virtual execution requests. In addition to the requirements above, it must:

1. **Never access the Overlord database directly.** It interacts only through the documented `/api/virtual-targets/v1/*` REST surface; no direct DB access is possible or required.
2. **Be idempotent by `executionRequestId`.** Claim, retry, duplicate delivery, and gateway restart for the same request must yield exactly one realized environment and one run; a post-launch gateway crash must not destroy or duplicate the environment.
3. **Preserve the normal protocol lifecycle.** A gateway records observations and drives the `launching → launched|failed` transition, but it never completes an objective — only an agent protocol delivery does. It must not introduce a parallel request state machine.
4. **Vendor the published virtual-target DTOs**, validate against this contract version, and declare its called endpoints and its namespaced adapter key (e.g. `racecar`) in its `conformance-manifest.yaml` (`componentType: rest-consumer`). The adapter key is an open-vocabulary value, not a new `execution_targets.type`.

See [`contract/conformance-manifest.schema.yaml`](contract/conformance-manifest.schema.yaml) for the required manifest shape, and [`contract/examples/rest-consumer-racecar-conformance-manifest.yaml`](contract/examples/rest-consumer-racecar-conformance-manifest.yaml) for a Virtual Target Gateway template.

---

## Shared Deterministic Algorithms

A few pure, deterministic computations must produce **identical** results in more than one component. Rather than share a runtime package (which couples the components' build/publish graphs), each component keeps its own copy of the algorithm and both copies are pinned to a single committed **conformance fixture** of golden input→output vectors. CI runs both component test suites against the same fixture, so the implementations cannot drift apart.

### Per-mission branch/worktree planning

- **Algorithm**: `planMissionBranch`, `previewMissionBranch`, `missionWorktreePath`, `sanitizeBranchName`, `canonicalMissionBranch`, `slugifyBranchTitle` (and the `BranchDecision*` types). `missionWorktreePath` takes `worktreeRoot`, `projectSlug`, `resourceKey`, and `branch`, and the resource key is always included between the project slug and branch leaf.
- **Implementations** (must stay byte-for-byte equivalent in behavior):
  - Runner Layer — `cli/src/branch-planning.ts`, used by `cli/src/branch-preparation.ts` to **prepare** the real branch/worktree before launch.
  - Service layer (backend) — `backend/branch-planning.ts`, used by `backend/repository.ts` to **predict** `MissionBranchDto` branch metadata surfaced over REST.
- **Conformance fixture**: [`contract/branch-planning-vectors.json`](contract/branch-planning-vectors.json). Both `cli/test/branch-planning.test.ts` and `backend/branch-planning.test.ts` assert their implementation against every vector, including resource-scoped worktree paths.
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
- RBAC role names (`role_assignments.role_key` core, non-extension values; enumerated in `auth/src/rbac/types.ts`'s `Role` enum and `overlord.rbac.toml`): `ADMIN`, `MANAGER`, `MEMBER`, `PUBLIC`

### Open (extensions may add namespaced values)

- `workspaces.kind`, `profiles.kind`
- `execution_targets.type` (documents `local`, `ssh`, and now `virtual` as core values; a virtual target is realized by an external gateway over the Virtual Target Queue Surface), `project_resource_sources.source_kind`
- Gateway **adapter keys** (e.g. `racecar`) and virtual source/observation/failure/grant/action kinds — namespaced open-vocabulary values declared in a gateway's `rest-consumer` conformance manifest, never new closed-vocabulary values or `execution_targets.type` values
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
