# Active-Workspace Transport Retirement Migration Plan

Status: proposed
Mission: coo:379
Date: 2026-07-21
Predecessors:

- `planning/feature-plans/resource-derived-workspace-scoping.md`
- `planning/feature-plans/workspace-scoping-audit.md`

## 1. Decision

Retire `X-Overlord-Active-Workspace` and the `overlord_active_workspace`
cookie as request-scoping transports. They are ambient compatibility state,
not an authorization boundary, and they contradict account-wide project and
mission aggregation.

The replacement model is:

- authentication establishes the global profile, credential scope, and client
  identity;
- a named resource establishes its workspace and the caller's membership in
  that workspace;
- workspace-owned settings use an explicit `/api/workspaces/:id/...` path;
- account-wide indexes and realtime aggregate over the caller's authorized
  memberships on the server;
- parentless creation requests carry an explicit workspace id; and
- navigation defaults come from one server-backed default-project preference,
  never from request auth context.

The selected workspace may remain client-side route/navigation state. It must
not be attached to unrelated API, protocol, MCP, or realtime requests.

## 2. Invariants

The migration is complete only when all of the following are true:

1. A request with the same credential and payload has the same authorization
   result whether or not the legacy header/cookie is present.
2. Every resource-owned operation resolves `(workspaceId, workspaceUserId)`
   from the resource before RBAC, persistence, provider access, audit, change
   feed, or webhook attribution.
3. Every workspace-owned operation names the workspace in its path or body.
4. Every account-wide read authorizes each membership and aggregates on the
   server; clients do not fan out by impersonating an active workspace.
5. A parentless create either supplies `workspaceId` or fails as ambiguous.
   Clients may fill it from an explicit user choice, the default project's
   workspace, or the sole accessible workspace.
6. A default project is a profile preference only. It grants no access, is
   ignored when stale/inaccessible, and never scopes a request.
7. Audit and issuance-context fields record a resource-derived or explicitly
   chosen workspace. When an operation is genuinely profile-global, nullable
   workspace attribution is preferable to a fabricated default workspace.

## 3. Current dependency map

| Dependency                   | Current behavior                                                                                                                                                                                            | Required replacement                                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth request binding         | `backend/auth.ts` reads the header/cookie and `ensureWorkspaceUser` chooses one membership for the request context.                                                                                         | Resolve only the authenticated profile/token at the edge. Resolve memberships per resource, explicit workspace, or aggregate operation.                                                                                                                     |
| Ambient backend context      | `backend/db.ts` carries `activeWorkspace` and `actorWorkspaceUserId`; legacy helpers read `WORKSPACE` or `getActiveWorkspaceId()`.                                                                          | Keep profile/token/client identity in request context; pass an explicit service scope for workspace operations. Remove ambient workspace accessors after their final callers migrate.                                                                       |
| Navigation/meta              | Workspace activation routes set the cookie; `/api/meta` and `WorkspaceDto.isActive` echo it.                                                                                                                | Client route state plus a server-backed default project. `/api/meta` may expose `defaultProjectId`, but not an active authorization scope.                                                                                                                  |
| Legacy workspace routes      | `/api/workspace/statuses*`, `/api/agent-catalog*`, `/api/launch-settings*`, workspace integration settings, uploads, and unbound webhook operations infer a workspace.                                      | Use existing or new `/api/workspaces/:id/...` routes. Resource-id routes continue deriving scope from the resource.                                                                                                                                         |
| Projects and mission search  | Backend aggregate implementations exist, but CLI paths still fan out with `BackendClient.forWorkspace`; hosted protocol/MCP search remains bound to request context.                                        | Make the aggregate backend/service operation canonical and have CLI, protocol, and MCP call it once.                                                                                                                                                        |
| Mission references           | UUIDs derive their workspace; display ids can currently fall back to the active workspace.                                                                                                                  | Resolve display ids across authorized memberships. If more than one match exists, return an ambiguity error with stable ids/workspace labels and require a UUID or explicit project/workspace context.                                                      |
| Realtime/catch-up            | Connection admission checks one active membership, while `readChangesAfter` reads the global `entity_changes` sequence without an authorized-workspace filter. Workspace switching forces a coarse refresh. | Build an authorized aggregate feed over all readable memberships, filter before projection, and remove switch-triggered refreshes.                                                                                                                          |
| Token/OAuth attribution      | Profile-global `USER_TOKEN` issuance and hosted MCP OAuth approval borrow the active membership for permission and issuance metadata.                                                                       | Authorize the profile-global self-service permission across memberships/account policy; store nullable issuance workspace unless the flow explicitly names one. Tokens remain profile credentials whose effective rights are evaluated per target resource. |
| Default project              | `overlord:lastUsedProjectId` and `overlord.quickTask.defaultProjectId` are independent browser-local values.                                                                                                | One server-backed, explicitly editable preference used by all create/navigation surfaces and synchronized across web/desktop sessions.                                                                                                                      |
| CLI request transport        | `cli/src/backend-client.ts` can attach the legacy header to every request.                                                                                                                                  | Delete `forWorkspace` after fan-outs migrate. Explicit workspace endpoints put the id in the URL/body.                                                                                                                                                      |
| Remote desktop/web transport | Bearer-session requests attach the selected workspace header because cross-site cookies are unavailable.                                                                                                    | Continue bearer-session auth without the workspace header. The selected workspace remains local route state.                                                                                                                                                |
| Contract/docs                | `CONTRACT.md`, `contract/components.yaml`, auth docs, MCP docs, CLI docs, and UI docs describe active-workspace binding.                                                                                    | Revise all affected surfaces in the contract-first cutover described below.                                                                                                                                                                                 |

## 4. Default-project preference design

### 4.1 Storage

Use the existing `project_user_preferences` table rather than Auth-owned tables
or a new schema object. Store a namespaced boolean marker such as
`preferences_json.overlord.defaultProject = true` on the chosen project's row.
The service updates the preference transactionally:

1. resolve the authenticated profile;
2. load all active memberships for that profile;
3. validate `projectId` is live and readable through its owning membership;
4. clear the marker from every preference row owned by those memberships; and
5. upsert the marker on the selected project/membership row.

This gives one account-wide preference while preserving the table's existing
project/user ownership and cleanup behavior. Project deletion, membership
removal, or permission loss makes the preference unreadable; the read API then
returns `null`. It must never silently persist a fallback.

### 4.2 API

Add an authenticated profile preference surface:

- `GET /api/profile/default-project`
- `PUT /api/profile/default-project` with `{ projectId }`
- `DELETE /api/profile/default-project`

The read result is `{ projectId: string | null }`. An additive
`defaultProjectId` field may also be included in `/api/meta` to avoid an extra
bootstrap round trip. The write authorizes the named project; it does not use a
route-level active-workspace permission check.

### 4.3 Client behavior and local migration

- Project routes keep their route project as the immediate default.
- Otherwise all mission-create and quick-task surfaces use the server default.
- When no valid default exists, clients may visually preselect the first
  accessible project but do not persist it without an explicit user action.
- Add “Set as default project” and “Clear default project” actions in project
  settings/navigation.
- On the first compatible web bootstrap only, if the server preference is null,
  migrate a valid `overlord:lastUsedProjectId`; otherwise try the quick-task
  value. Use a compare-if-null write so two clients cannot overwrite an
  already-chosen server preference. Clear both legacy keys only after success.
- Subsequent project use does not mutate the default automatically.

## 5. Phased migration

### Phase 0 — Contract delta and safety baseline

Before implementation, update the contract first:

- bump the contract version because the final phase removes a stable HTTP
  header/cookie binding, REST routes/DTO fields, and ambient MCP workspace
  semantics;
- update `CONTRACT.md` and `contract/components.yaml` for Auth → Database,
  Desktop → REST, MCP → Auth, REST, CLI, and realtime surfaces;
- document the default-project preference key and API in the schema/REST
  contract;
- deprecate, but do not yet remove, the legacy routes and transport; and
- add a compatibility matrix for old client/new server and new client/old
  server combinations.

Add characterization tests before behavior changes:

- header, cookie, no preference, stale preference, and unauthorized preference;
- resource in workspace B while navigation points at A;
- two organizations with colliding workspace slugs/display ids;
- zero, one, and many memberships;
- Local cookie auth, hosted web bearer sessions, desktop remote sessions,
  `USER_TOKEN`, hosted MCP OAuth, and loopback CLI; and
- realtime rows from readable and unreadable workspaces.

### Phase 1 — Fix aggregate realtime and explicit attribution

This phase is first because removing the header must not leave a feed admitted
by one membership but projected from all tenants.

1. Include `workspace_id` in the internal change row and add additive
   `workspaceId` to `EntityChangeDto`.
2. Resolve the caller's readable workspace memberships at connect/catch-up.
3. Scan the global sequence in bounded windows, filter rows to those workspaces
   before DTO projection, and advance the cursor to the last scanned global
   sequence even when every row was filtered. This avoids replay loops and
   preserves a monotonic cursor.
4. Revalidate or close streams after membership/role changes. Never keep a
   membership snapshot indefinitely.
5. Remove active-workspace admission checks and switch-triggered global refresh;
   admission succeeds when the caller has at least one readable membership.
6. Make audit, `entity_changes`, outbox, token issuance, and OAuth issuance
   accept explicit workspace/actor attribution. Profile-global events use null
   workspace attribution where the schema permits it; if it does not, make that
   schema change explicitly rather than selecting the oldest membership.

Exit gate: a caller cannot observe an entity-change identifier from a workspace
they cannot read, and changing navigation state has no feed effect.

### Phase 2 — Add all replacement surfaces

Land additive replacements while old clients still work:

- default-project API and UI from section 4;
- canonical account-wide project list and mission search used by REST and the
  protocol service;
- account-wide mission-reference resolution with an explicit ambiguity error;
- `/api/workspaces/:id/statuses*` (already present) as the only new-client status
  surface;
- `/api/workspaces/:id/agent-catalog*` and
  `/api/workspaces/:id/launch-settings*` (already present) as the only new-client
  configuration surfaces;
- explicit workspace routes for workspace integration connect/disconnect,
  unbound webhooks, workspace images, and any remaining parentless storage
  operation;
- profile-global avatar storage that does not borrow an active workspace, or an
  explicit workspace-owned upload route if the product intentionally keeps
  avatars workspace-owned; record that product choice in the schema contract;
  and
- required `workspaceId` for project creation and every other parentless create
  when the caller has multiple memberships. Clients may automatically supply
  the sole membership or the default project's workspace, but the backend
  receives the id explicitly.

Keep resource-id routes resource-derived. Do not add `workspaceId` redundantly
to mission/project/objective routes; doing so creates two authorities that can
disagree.

Exit gate: every legacy ambient route has an exercised replacement, and current
clients can run without sending the header.

### Phase 3 — Migrate clients, protocol, and MCP

Web/desktop:

- stop attaching `X-Overlord-Active-Workspace` in `api-base.ts` and
  `api-transport.ts`;
- replace activation calls with client route/navigation selection;
- consume the default-project preference everywhere currently reading either
  local-storage key;
- use explicit workspace routes for settings and parentless creation; and
- stop treating `/api/meta.workspace` or `WorkspaceDto.isActive` as server scope.

CLI/protocol:

- remove the `search-missions` fan-out in `cli/src/commands.ts`;
- remove the `missions list` fan-out;
- replace `listAccessibleProjects` fan-out with the canonical aggregate
  `/api/projects` projection;
- make project-bound protocol operations derive scope from the project/mission;
- make parentless protocol operations require explicit project/workspace input;
- make attach/load/update/deliver context report the mission's owning workspace,
  not request context; and
- remove `BackendClient.forWorkspace` and the header injection only after no
  caller remains.

Hosted MCP/connectors:

- make mission search account-wide unless `projectId` narrows it;
- update tool descriptions from “connected workspace” to “accessible projects”;
- require project identity for writes as today;
- resolve display-id ambiguity explicitly; and
- regenerate/synchronize connector adapters and versions when their published
  scripts or manifests change.

Exit gate: repository tests and an HTTP capture show no first-party client sends
the header or depends on the cookie.

### Phase 4 — Compatibility window and server cutover

Use three release stages:

1. **Additive release:** server accepts the header/cookie, emits a bounded
   deprecation metric/log, but new clients do not send them.
2. **Ignore release:** server ignores both values for authorization and
   behavior, expires the cookie with `Max-Age=0`, and continues accepting the
   header so older clients fail only where they still call a retired unscoped
   route. The CORS allowlist may retain the header for this one stage.
3. **Removal release:** remove header parsing, cookie writes, activation route,
   unscoped routes, `WorkspaceDto.isActive`, `/api/meta.workspace`, CORS
   allowance, `activeWorkspace` request state, `WORKSPACE`, and active-workspace
   helpers. Rejecting the obsolete header is optional; ignoring unknown headers
   is sufficient once it has no semantics.

Do not remove the legacy routes in the same release that first-party clients
stop using them. The ignore stage provides rollback room without restoring
ambient authorization.

### Phase 5 — Static enforcement and documentation cleanup

- Replace the current ambient-workspace AST allowlist with a zero-use rule for
  production code.
- Add a source check forbidding the header/cookie literals outside a narrowly
  time-boxed compatibility test fixture.
- Remove switch-related realtime refresh logic and stale cache invalidations.
- Update auth/RBAC, CLI, MCP, REST, desktop, web UI, and public documentation.
- Validate every affected conformance manifest against the new contract
  version.
- Delete compatibility metrics after at least one release with zero first-party
  use and an agreed external-client sunset period.

## 6. Component impact

| Component       | Impact                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contract        | Version bump; replace ambient binding text, deprecate/remove stable routes and DTO fields, document aggregate realtime and default project.                                                                  |
| Database        | No new table for the chosen preference design; document the namespaced `project_user_preferences` key. Potential migration only if profile-global attribution/storage requires nullable workspace ownership. |
| Auth            | Authenticate profiles/credentials without selecting a membership; authorize token/OAuth self-service without a fabricated active workspace.                                                                  |
| REST/backend    | Add preference and explicit workspace routes, canonical aggregates, ambiguity handling, filtered realtime, then remove activation/ambient routes and context.                                                |
| CLI             | Remove three workspace fan-outs, `forWorkspace`, and global header injection; pass explicit workspace only in path/body where required.                                                                      |
| Protocol        | Derive context from project/mission/objective; aggregate search; reject ambiguous display ids. Protocol lifecycle and session-key semantics do not change.                                                   |
| MCP             | Account-wide read search, explicit project writes, no active-workspace binding or header guidance.                                                                                                           |
| Webapp          | One default-project query/mutation; route-only workspace navigation; delete duplicate local persistence after migration.                                                                                     |
| Desktop         | No workspace header injection in remote bearer mode; no auth-storage change.                                                                                                                                 |
| Realtime        | Membership-filtered aggregate stream/catch-up with global cursor scanning and explicit `workspaceId` projection.                                                                                             |
| Extensions      | Workspace integration settings become path-scoped; project/mission operations remain resource-derived.                                                                                                       |
| Connectors/docs | Update generated MCP adapters, manifests/versions where applicable, command help, examples, and public auth guidance.                                                                                        |

## 7. Verification matrix

Required automated coverage:

- resource authorization is identical with header A, header B, stale header,
  hostile header, cookie-only, and neither;
- a B resource read/write/audit/change/webhook stays in B while UI navigation is
  A;
- aggregate lists/search return the union of only authorized workspaces and
  globally enforce sort/limit after aggregation;
- realtime never returns unauthorized rows, advances across filtered-only
  windows, reconnects from a cursor, and reacts correctly to role removal;
- default project set/get/clear, concurrent compare-if-null migration, deleted
  project, archived project, removed membership, insufficient permission, and
  cross-device synchronization;
- display-id resolution succeeds uniquely and fails safely when ambiguous;
- parentless creates are explicit with multiple memberships and remain ergonomic
  with one membership;
- old client/new server during additive and ignore stages, plus new client/old
  server during the additive deployment window;
- Local SQLite and Cloud Postgres; cookie, bearer session, `USER_TOKEN`, and MCP
  OAuth authentication; and
- contract checks, backend/webapp/CLI typechecks, focused integration suites,
  connector version sync, and the new static gates.

## 8. Rollback and observability

Track, without logging workspace ids or secrets:

- requests carrying the deprecated header/cookie by client/version and route;
- calls to each deprecated unscoped route;
- ambiguous display-id resolutions;
- aggregate query latency and result counts;
- realtime rows scanned, returned, and filtered;
- stale/invalid default-project reads; and
- explicit-scope failures by surface.

Rollback may re-enable a deprecated route adapter that forwards to an explicit
service operation. It must not restore header-driven resource authorization or
an unfiltered realtime feed. The server should keep the additive replacement
surfaces throughout rollback.

## 9. Definition of done

1. No first-party request sends or reads `X-Overlord-Active-Workspace` or
   `overlord_active_workspace`.
2. No production service reads an ambient active workspace or actor membership.
3. The active-workspace activation route and every unscoped workspace settings
   route are removed.
4. CLI/protocol/MCP search and project discovery make one aggregate backend
   request, with global sort/limit semantics.
5. Realtime is authorized per membership and never projects unauthorized rows.
6. One explicit, server-backed default project drives navigation/create
   defaults across web and desktop; both legacy local-storage keys are gone.
7. Resource, audit, change-feed, webhook, token, and OAuth attribution follows
   the invariants in section 2.
8. The contract version and all affected conformance manifests are updated and
   validated.
9. Static checks prevent reintroduction of ambient workspace transport or
   accessors.
