# Organization → Workspace → Project Hierarchy

Mission: coo:135 — Migrate Workspace to Organization.

This document reviews the proposal (questions, risks, improvements) and lays out the
migration implementation plan. The design keeps **workspaces as the only RBAC layer**,
exactly as proposed; organizations are a grouping + identity layer above them.

---

## Part 1 — Proposal review

### 1.1 What exists today (facts the plan is built on)

- **Workspace IDs are slugified names, not opaque IDs.** `backend/workspaces.ts`
derives the id from the name (`desiredWorkspaceId`), and renaming/re-slugging
**re-keys** `workspace_id` **across every table** via `rekeyWorkspaceReferences`
(dynamic table scan + deferred FKs). Moving to UUIDs deletes this entire
machinery — a significant simplification and de-risking win.
- **Slugs are globally unique** (`idx_workspaces_slug`); `uniqueWorkspaceSlug`
appends `-2`, `-3`, … on collision.
- **Mission display IDs are denormalized**: `missions.display_id = '<slug>:<seq>'`
written at creation (`backend/repository.ts:2940`), unique per
`(workspace_id, display_id)`. Sequences live in `mission_sequences` with
`scope_type = 'workspace'`.
- **RBAC**: `role_assignments` rows are `(workspace_id, workspace_user_id, role_key)`;
role grants come from `openoverlord.rbac.toml` (`ADMIN` = `*`, `MEMBER`, `PUBLIC`)
plus the `Role` enum in `auth/src/rbac/types.ts`.
- **Request scoping**: the backend binds one *active workspace* per request from the
`overlord_active_workspace` cookie or `X-Overlord-Active-Workspace` header
(validated against `workspace_users`), with a server-side `/api/workspaces/:id/activate`
mutation. The SPA persists the choice in localStorage (`webapp/web/lib/api-base.ts`).
- **All app queries are single-workspace scoped** (projects list, My Missions, feed,
search). The sidebar never shows content from two workspaces at once today.
- **Onboarding**: `needsSetup` (untouched seeded `local-workspace`) →
`InitialSetupScreen` (name + slug for the seeded workspace); zero memberships →
`CreateWorkspaceOnboardingScreen`.
- **Workspace settings modal** (from the switcher): General (name, logo dropzone,
read-only slug, workspace ID), Members, Archived projects, Danger zone.
- **Storage**: `storage_buckets.workspace_id` is `NOT NULL`; the workspace logo lives
in the `workspace-images` bucket and its URL in `workspaces.settings_json`.
- **Invitations**: `workspace_invitations` carry a `role_key` granted on acceptance;
invites are the only way into a workspace.
- **entity_changes.workspace_id is NOT NULL** and the change feed / realtime /
`data_version` are workspace-scoped. `entity_type` is an open vocabulary
(length check only), so an `organization` entity type needs no CHECK migration.
- **user_tokens are workspace-scoped at issuance, profile-scoped at auth** — since
`20260702103000_user_tokens_profile_scope`, authentication resolves the token by
hash and the workspace membership separately; `user_tokens.workspace_id` is audit
metadata (but still `NOT NULL`, which matters for Q10 below).



### 1.2 Clarifying questions — resolved

All ten questions have been answered by the PM (coo:135 follow-up discussion).
Decisions are recorded inline; the plan in Part 2 implements them.

1. **How do existing workspaces map to organizations?**
  **Decision: one organization holding all existing workspaces.** The migration
   creates a single org, seeding its identity (name + logo) from the oldest live
   workspace — workspaces lose their image in the new model, so the first
   workspace's logo moves up to the org. All existing workspaces (three, in the
   production Postgres database — see the data-scope decision in R2) attach to this
   org. Workspaces keep their names and slugs, so all `slug:seq` mission refs, git
   checkpoint refs, and webhook payloads stay valid; slugs are globally unique
   today, so attaching them all to one org cannot collide with the new per-org
   uniqueness rule.
2. **Who is an "org admin"?** A user can be ADMIN of workspace A and MEMBER of
  workspace B in the same org, so "admins of constituent workspaces" needs a sharp
   definition.
   **Decision: org admin = ADMIN of *every* constituent workspace** — this is the
   invariant the "add org admin" flow maintains. An admin of *some* workspace may
   **view** org settings, but only org admins can rename the org, change the logo,
   add/remove org admins, or create workspaces (otherwise a single-workspace ADMIN
   could add themselves as org admin and gain ADMIN everywhere — risk R1). The UI
   should normally prevent partial-admin situations from arising: admin changes flow
   through the org-level add/remove actions, and org settings surfaces (and offers
   to repair) any partial-admin state instead of leaving it ambiguous.
3. **Workspace creation/deletion rights.**
  **Decision: creation requires org admin; deletion requires ADMIN of the target
   workspace** (matches current behavior). On creation, ADMIN is auto-granted to
   **all current org admins** — not just the creator — so the org-admin invariant
   survives workspace creation.
4. **Exact MANAGER grants.**
  **Decision: MANAGER also manages projects.** Grants: MEMBER grants +
   `workspace:update` + `member:invite`/`member:remove`/`invitation:*` (capped at
   MANAGER) + `project:*`. MEMBER stays as today: `project:read`, `mission:*`,
   `objective:*`, etc.
5. **Where does "My Missions" live now?**
  **Decision: aggregate across all workspaces the user belongs to in the selected
   org.** For v1 the board simply shows the union of every workspace's status
   columns; combining/de-duping like statuses across workspaces is an explicitly
   deferred later step.
6. **Does the server-side "active workspace" survive?**
  **Decision (default stands):** keep the active-workspace binding as the *default*
   scope (protocol/CLI need it; deep links need it) but the SPA passes explicit
   workspace scope wherever the UI is per-workspace, and `/activate` is demoted to a
   preference update. Full retirement of the binding is out of scope.
7. **Invited users and org creation.**
  **Decision: agreed** — a "Create organization" action in the org switcher
   (mirrors today's "Create workspace" item), so invitees can later found their own
   org.
8. **Moving a workspace between orgs.**
  **Decision: out of scope** (slug collisions and admin-invariant churn make it a
   separate feature).
9. **Zero-org state.**
  **Decision: allowed.** Deleting the last workspace of an org deletes the org;
   deleting your last org's last workspace returns you to onboarding. The old
   "last remaining workspace cannot be deleted" rule is dropped.
10. **Local single-operator mode / seeding.**
  **Decision: do not seed a workspace at all — wait for onboarding.** The seed
    existed for legacy reasons that no longer hold (name-derived IDs made
    create-later expensive; per-workspace seed data was hung off migrations;
    CLI-first usage needed a workspace on boot). Local and hosted converge on one
    flow: the first authenticated user with zero memberships sees the org+workspace
    onboarding screen (org name required, logo optional, workspace name default
    `general`, slug in an "advanced" row since it still prefixes mission
    identifiers). Consequences:
  - The backend tolerates a **zero-workspace boot**: the live `WORKSPACE` binding
  is null until onboarding, and workspace-scoped routes fail with a clear
  "complete onboarding" error. (This state must be robust anyway per Q9.)
  - Delete `needsInitialSetup`/`completeInitialSetup`, the seed-identity checks
  (`SEED_WORKSPACE_NAME`/`SLUG`), and `InitialSetupScreen`; the router gate
  simplifies to "zero memberships → onboarding".
  - Historical migrations (`001`–`004`) still create `local-workspace` seed rows
  on fresh databases; the organizations migration deletes the seed workspace
  (with its seeded statuses, buckets, membership, and role assignment) when it
  is still pristine — untouched seed name/slug and no projects/missions — so
  fresh installs end the migration chain at **zero orgs and zero workspaces**.
  Boot-time seeding code paths (`database/src/storage-seed.ts`,
  `launch-local.ts`) drop workspace seeding.
  - **CLI-only operation is preserved via a new** `ovld org-setup` **command** that
  drives the same onboarding endpoint — see the spec in Phase 5.



### 1.3 Warnings / risks

- **R1 — Privilege escalation through org-admin management.** If "any constituent
workspace admin" can add org admins, a single-workspace ADMIN can grant themselves
ADMIN everywhere. Gate org-admin add/remove (and workspace creation) on the
*all-workspaces* org-admin test. Also guard against removing the **last** org
admin.
- **R2 — The workspace-ID rekey, now Postgres-only.**
**Decision (PM): the current local SQLite database will be wiped — only the
production Postgres database (three workspaces) needs data migration.** This
shrinks the original risk substantially:
  - The **Postgres** migration carries the real backfill: new org, `organization_id`,
  and the UUID rekey of `workspaces.id` + every `workspace_id` column (explicit
  table list, enumerated at authoring time), plus `mission_sequences.scope_id`
  and a `search_documents` purge (reindexed lazily).
  - Rekey technique that avoids depending on DEFERRABLE constraints: **insert the
  new workspace row under the new UUID, repoint all child rows, then delete the
  old row** (the FKs stay satisfied at every step). `SET CONSTRAINTS ALL DEFERRED`
  only helps for constraints declared deferrable, so don't rely on it.
  - The **SQLite** migration stays schema-identical (fresh installs run the whole
  chain) but needs no data-preserving rekey — fresh databases contain only the
  pristine seed, which the same migration deletes per Q10.
  - Stale references to old slug-ids die naturally: local DBs are wiped, and stale
  localStorage active-workspace ids already fall back to first membership
  (coo:96).
- **R3 — Display-ID continuity.** `coo:135`-style refs appear in git checkpoint refs,
webhook payloads, Everhour links, and users' heads. The migration must **not**
regenerate `display_id`s: keep each workspace's slug unchanged. Per-org slug
uniqueness means display IDs are no longer globally unique in a hosted, multi-org
database — every lookup is already workspace-scoped
(`idx_missions_workspace_display_id`), but webhook consumers treating `displayId` as a global key should be warned in docs. 
- **R4 — Org-level rows don't fit workspace-scoped plumbing.** `entity_changes`,
realtime, and `data_version` are all keyed by `workspace_id NOT NULL`. Org mutations
(rename, logo, admin changes) need a decision: recommended — **fan out one**
`entity_changes` **row per constituent workspace** (bounded, keeps every invariant
and wakes every affected client) rather than making `workspace_id` nullable, which
would ripple through the change feed, realtime filters, and both data layers.
- **R5 — Storage for org logos.** `storage_buckets.workspace_id` is `NOT NULL`, and
workspace deletion tombstones its buckets — an org logo must not live in a
member workspace's bucket or it dies with that workspace. Recommended: add a
nullable `organization_id` to `storage_buckets` with a CHECK that exactly one of
`workspace_id`/`organization_id` is set, plus an `organization-images` bucket per
org and a `PUBLIC` grant `organization_image:read` (mirroring `workspace_image:read`).
- **R6 — Server-side invite caps.** MANAGER's "invite up to MANAGER" must be enforced
in `inviteWorkspaceMember` *and* `updateWorkspaceMemberRole` (both directions:
a MANAGER can neither grant ADMIN nor demote/remove an ADMIN). UI-only enforcement
is not enforcement.
- **R7 — Dual dialects + dual data layers.** Every schema change lands twice
(`database/sqlite/migrations` + `database/postgres/migrations`), plus kysely type
regen, plus both data layers (`backend/repository.ts` REST paths and the
protocol/service paths) where org data is surfaced. The postgres conformance tests
(`workspaces.postgres-conformance.test.ts`, `workspace-isolation.…`) must be
extended to orgs.
- **R8 — Losing the "+" button.** Replacing the sidebar "+" with a chevron removes
the only always-visible "New project" affordance. The plan adds a "New project"
row at the bottom of each workspace's expanded project list (also keeps the
empty-state "Create a project" button). Cheap to change if a different placement is
preferred.
- **R9 — CONTRACT.md impact.** `WorkspaceDto`, meta shape, onboarding endpoints, RBAC
role vocabulary, and storage bucket keys are stable interfaces; this feature
requires a **contract version bump** and updates to the Component Registry
(Database, REST API, Auth, Desktop Shell sections), `components.yaml`, and the
controlled-vocabulary list (new `MANAGER` role key; `organization` entity type is
open-vocab and needs only documentation).



### 1.4 Suggested improvements to the proposal

- **Adopt UUIDs as the moment to delete ID-choosing UX everywhere**: drop
`CreateWorkspaceBody.id`, `CompleteInitialSetupBody.id`, `desiredWorkspaceId`,
`ensureWorkspaceIdAvailable`, and `rekeyWorkspaceReferences`. Workspace rename becomes a plain UPDATE. (I agree)
- **Only** `workspaces` **gets** `organization_id`. Do not add `organization_id` to mission/project/etc. tables — org scope always derives through the workspace join. Keeps the blast radius to one FK and avoids a second tenancy column drifting. (agree)
- **Keep the org-admin concept purely derived + invariant-maintained**, exactly as
proposed. Implement as service helpers (`listOrganizationAdmins`,
`addOrganizationAdmin`, `removeOrganizationAdmin`) that read/write ordinary
`role_assignments` rows transactionally. No new RBAC scope type. (agree)
- **Give organizations a** `settings_json` from day one (logo URL lives there,
mirroring workspaces; future billing lands there without a migration).
- **Delete the org's storage objects when the last workspace goes** (org deletion
path must purge the `organization-images` object, not just tombstone rows). (agree)
- **Slug immutability**: with slugs now only display-ID prefixes, consider making the slug editable only at workspace creation (today re-slugging exists but display IDs don't retroactively change, which confuses). Recommended: keep slug read-only in settings UI (as today) and drop the re-slug code path.(agree)

---



## Part 2 — Implementation plan

Ordering principle: schema → auth/RBAC → backend services & API → SPA → parity
(CLI/MCP/docs/desktop) → migration verification. Only one real user exists and legacy
support is explicitly out of scope, so there are **no compatibility shims**: each
phase cuts over completely. Data migration correctness matters **only for Postgres**
(R2); the local SQLite database will be wiped.

### Phase 0 — Contract

1. Update `CONTRACT.md` (version bump to 4): add `organizations` to the Database
  Layer, org endpoints to the REST API Layer, MANAGER to the role vocabulary,
   org-logo bucket key, onboarding endpoint (web + `ovld org-setup`), meta shape
   change, zero-workspace boot state.
2. Update `contract/components.yaml` + DTOs in `packages/contract/src/index.ts`:
  - `OrganizationDto { id, name, logoUrl, workspaceCount, isActive?, createdAt }`
  - `WorkspaceDto`: add `organizationId`; **remove** `logoUrl`; keep `slug`, drop
  `isActive` in favor of client-side selection (or keep as preference echo).
  - `CreateOrganizationOnboardingBody { organizationName, workspaceName /* default "general" */, workspaceSlug? }`
  — no logo field: the logo is uploaded *after* creation (the org bucket doesn't
  exist until the org does), then patched via `UpdateOrganizationBody`.
  - `UpdateOrganizationBody { name?, logoUrl? }`
  - `OrganizationAdminDto` + add/remove bodies.
  - `CreateWorkspaceBody`: drop `id`, add `organizationId`.
  - `WorkspaceMemberDto.roleKeys` gains `MANAGER`; invitation bodies unchanged
  (role_key already free-form) but documented cap semantics.
  - Meta DTO: `organization` + `organizations[]` + `workspaces[]` for the active
  org; `workspace` becomes nullable (zero-workspace boot, Q10).



### Phase 1 — Database migrations (SQLite + Postgres, one migration pair)

Single migration `2026_____organizations.sql` per dialect. Schema changes are
identical in both dialects; the data backfill only has to be correct on **Postgres**
(three live workspaces); on SQLite it just has to be harmless on a fresh/seed-only
database (R2).

1. `CREATE TABLE organizations (id TEXT PK /* uuid */, name, settings_json, created_at,
  updated_at, deleted_at, revision)`— same column conventions as`workspaces`.
2. **No-seed cleanup (Q10)**: delete the `local-workspace` seed — and its seeded
  statuses, buckets, workspace_user, and role assignment — when it is still
   pristine (untouched seed name/slug, no projects/missions). Fresh databases end
   the migration chain with **zero orgs and zero workspaces**; no new seed rows are
   created.
3. Backfill (Q1, Postgres data path): insert **one** organization (`id = uuid`),
  taking `name` and `settings_json.logoUrl` from the **oldest live workspace**;
   skipped when no live workspace remains after step 2.
4. `workspaces`: add `organization_id TEXT NOT NULL REFERENCES organizations(id)
  ON DELETE RESTRICT`pointing every live workspace at the single org (SQLite:  table rebuild; Postgres:`ADD COLUMN`+ backfill +`SET NOT NULL`). Remove`  logoUrl`from`workspaces.settings_json`.
5. **UUID rekey** (Postgres data path): for each workspace, insert a copy of the
  row under a new UUID, repoint every `workspace_id` column (explicit table list —
   the ~30 workspace-scoped tables enumerated at authoring time) plus
   `mission_sequences.scope_id` (`scope_type='workspace'`), then delete the old
   row — FKs stay satisfied at every step without relying on DEFERRABLE
   constraints. Purge `search_documents` (reindexed lazily). `display_id`s
   untouched (R3).
6. Slug uniqueness: drop `idx_workspaces_slug`, create
  `UNIQUE (organization_id, slug) WHERE deleted_at IS NULL`.
7. Storage: add `organization_id` to `storage_buckets` (nullable, CHECK exactly one
  of workspace/org set); insert an `organization-images` bucket for the org; move
   the oldest workspace's logo object metadata to it (bytes: copy under the new
   object key or accept a one-time re-upload — bytes migration was already skipped
   once in `20260702111500`, recommend the same here given one user).
8. `user_tokens.workspace_id` becomes **nullable** (it has been audit metadata since
  `20260702103000` — auth resolves by hash + membership separately) so a fresh
   zero-membership user can mint a token and run `ovld org-setup` headless.
9. Regenerate kysely types (`kysely-codegen` skill) for both dialects.



### Phase 2 — Auth / RBAC

1. `auth/src/rbac/types.ts`: add `MANAGER` to `Role`.
2. `openoverlord.rbac.toml`: add `[roles.MANAGER]` per Q4 (MEMBER grants +
  `workspace:update` + member/invitation management + `project:*`); document caps.
3. `backend/rbac.ts`: add `actorIsManager`-style helper or generalize
  `requireWorkspaceRole(workspaceId, minRole)`; add
   `isOrganizationAdmin(profileId, orgId)` = active ADMIN assignment in **every**
   live workspace of the org (Q2), and `canViewOrganizationSettings` = ADMIN in ≥1.
4. Enforce caps (R6): `inviteWorkspaceMember`, `updateWorkspaceMemberRole`,
  `removeWorkspaceMember` — MANAGER actors limited to targets/roles ≤ MANAGER.



### Phase 3 — Backend services & API

1. New `backend/organizations.ts`:
  - `listOrganizationsForUser` (orgs containing ≥1 workspace where the profile has
   an active membership) with workspace + member counts.
  - `updateOrganization` (name/logo; org-admin gate; entity_changes fan-out per R4).
  - `listOrganizationAdmins` / `addOrganizationAdmin` / `removeOrganizationAdmin`
  (transactional invariant maintenance; refuse removing the last org admin; only
  org admins may call; add = grant ADMIN in every constituent workspace, remove =
  demote to MEMBER in every workspace).
  - `deleteOrganizationIfEmpty` invoked from `deleteWorkspace` when the last live
  workspace of the org is tombstoned (also purge org logo object, R5 improvement).
2. `backend/workspaces.ts` rewrite of the identity parts:
  - `newId()` UUIDs for creation; delete `desiredWorkspaceId`,
   `ensureWorkspaceIdAvailable`, `rekeyWorkspaceReferences`, the re-slug path,
   `needsInitialSetup`, and `completeInitialSetup` (superseded by onboarding).
  - `createWorkspace(orgId, …)`: org-admin gate (Q3); slug uniqueness scoped to org;
  auto-grant ADMIN to all current org admins (Q3); remove `logoUrl` handling.
  - `deleteWorkspace`: allow deleting the last workspace (Q9) → org deletion hook;
  keep the active-workspace fallback re-pointing (or clear to null when none
  remain).
3. New onboarding endpoint `POST /api/onboarding` (zero-membership users only):
  creates org + workspace ("general" default) + membership + ADMIN role + buckets +
   statuses in one transaction; returns meta. **Shared verbatim by the web
   onboarding screen and** `ovld org-setup` — the CLI is just another client, so
   validation, slug suggestion, and the zero-membership gate cannot drift.
4. **Zero-workspace boot (Q10)**: the live `WORKSPACE` binding starts null on fresh
  instances; auth, meta, and onboarding endpoints work without it, and
   workspace-scoped routes return a clear "no organization yet — complete
   onboarding" error. No code path may assume a workspace row exists before
   onboarding.
5. Meta & scoping (Q5/Q6):
  - `/api/meta`: active org, org list, and the accessible workspaces of the active
   org (with project counts); `workspace` nullable pre-onboarding.
  - Projects: `GET /api/workspaces/:id/projects` (or `?workspaceId=`) so the sidebar
  can render several workspaces; membership validated per target workspace
  (pattern from coo:96).
  - My Missions: org-scoped aggregation across the caller's memberships; v1 board
  shows the union of status columns per Q5.
  - `/activate` becomes a lightweight preference (still used by protocol/CLI
  default-scope resolution).
6. Change feed: `recordChange` fan-out helper for org entities (R4). Storage routes:
  `/api/storage/organization-images/…` upload/read with PUBLIC read grant.



### Phase 4 — Web app

1. **OrganizationSwitcher** replaces `WorkspaceSwitcher` (same dropdown pattern:
  org logo/initial, org list, "Create organization", "Organization settings" —
   settings item visible per `canViewOrganizationSettings`).
2. **Sidebar** (`app-sidebar.tsx`): for each accessible workspace in the active org,
  a section headed by the **workspace name** with a **chevron** (collapse/expand,
   persisted locally), the DnD project list inside, a small **settings** button below
   the list (opens `WorkspaceSettingsModal` for that workspace), and a "New project"
   row (R8). "My Missions" stays pinned above, now org-scoped.
3. **Onboarding screen**: org name (required), org logo (optional dropzone —
  uploaded after the create call succeeds, then patched onto the org), workspace
   name (required, prefilled "general"), optional slug in an advanced row. Replaces
   **both** `InitialSetupScreen` and `CreateWorkspaceOnboardingScreen` (both
   deleted); the router gate simplifies to "zero memberships → onboarding"
   (`needsSetup` is gone).
4. **Workspace settings**: remove logo dropzone and Workspace ID field from
  `GeneralPage`; keep name, slug (read-only), members (role select gains MANAGER,
   with caps mirroring the server), archived projects, danger zone.
5. **Organization settings modal**: General (name, logo), Admins (add from org
  members / remove, disabled on last admin; surfaces and offers to repair
   partial-admin states per Q2), gated as above.
6. Query layer: workspace-parameterized project queries, org queries, invalidation
  keys; localStorage: `overlord:active-organization` + per-org workspace collapse
   state; stale ids fall back gracefully (existing pattern).



### Phase 5 — Parity & docs

1. **CLI: new** `ovld org-setup` (top-level command, following the
  `ovld create-project` precedent):
  - Same fields as the onboarding form: `--org-name` (required),
  `--workspace-name` (default `general`), `--workspace-slug` (optional,
  suggested from the name), `--logo <path>` (optional).
  - Interactive prompts for omitted fields on a TTY; `--no-input` for scripts
  errors on missing required flags.
  - Calls the shared `POST /api/onboarding` endpoint, then uploads the logo to the
  org bucket and patches the org — a failed logo upload is a warning, not a
  rollback.
  - Precondition mirrors the web: authenticated profile with zero memberships.
  With memberships it errors with guidance; `--if-needed` exits 0 as a no-op so
  pod/CI bootstrap scripts can call it unconditionally.
  - Fresh CLI-only flow: `ovld auth login` (or signup) → `ovld org-setup` →
  `ovld create-project` → normal mission work. (Token minting pre-membership is
  enabled by Phase 1 step 8; local loopback operator resolution keeps working.)
2. CLI/protocol otherwise: service context unchanged (token → workspace);
  `discover-project`/`create-project` surfaces reviewed for `--organization-id`
   naming; protocol `load-context` mission payloads unchanged (display IDs
   preserved).
3. MCP tools / agent plugins / `docs/public` / CLI README: run the `drift-review`
  skill after implementation; document that `displayId` is unique per workspace,
   not globally (R3).
4. Desktop shell: no contract change beyond meta shape; verify macOS traffic-light
  inset region still covers the new switcher; assume immediate desktop update per
   mission note.
5. Email templates: invitation copy gains org context ("join  at ").



### Phase 6 — Tests & migration verification

1. Unit: org service (admin invariant incl. last-admin guard, implicit org deletion,
  escalation attempts from single-workspace admins — R1), MANAGER caps (R6),
   per-org slug uniqueness incl. cross-org duplicates, onboarding transaction,
   zero-workspace boot (meta/auth/onboarding reachable, scoped routes error
   cleanly), `org-setup` CLI e2e against the shared endpoint (incl. `--if-needed`
   idempotence).
2. Conformance: extend the postgres conformance suites to organizations; both-dialect
  migration tests, including the fresh-install path (seed created by `001`–`004`,
   deleted by the organizations migration → zero-org state).
3. **Migration rehearsal on a copy of the production Postgres database** (the only
  data that must survive — R2): assert after migration — same mission count, every
   `display_id` unchanged, tokens still authenticate (hashes untouched,
   workspace_id rekeyed), a single org carrying the oldest workspace's name/logo
   containing all three prior workspaces, role assignments intact.
4. SPA smoke via jsdom (no browser in the pod): router gates for onboarding, sidebar
  rendering with multi-workspace fixtures.



### Suggested objective breakdown (for follow-up missions)

1. Phase 0 + 1 (contract + schema + no-seed cleanup + Postgres rekey migration +
  kysely regen)
2. Phase 2 + 3 backend (RBAC, org service, onboarding endpoint, zero-workspace boot,
  meta/scoping)
3. Phase 4 SPA (switcher, sidebar, onboarding, settings modals)
4. Phase 5 + 6 (`ovld org-setup`, parity, docs, drift review, migration rehearsal,
  tests)

