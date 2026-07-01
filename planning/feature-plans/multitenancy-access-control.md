# Multi-Tenancy Access Control Implementation Plan

Status: draft
Origin: Overlord mission `coo:94` — "Investigate User Access and RBAC Configuration"
Owner: jake@cooperativ.io

## 1. Problem

Overlord was built as a **single-tenant, single-operator** application and is now
being served as a **shared cloud**. The investigation for `coo:94` established
three facts that together let one user read another user's tickets:

1. **One process-global workspace.** `WORKSPACE` (`backend/db.ts:170`) is a
   module-level `let` binding — a single "active workspace" for the entire server
   process. It is chosen as the **oldest** workspace in the database at boot
   (`refreshActiveWorkspaceFromClient` → `oldestWorkspaceRowFromClient`,
   `backend/db.ts:286-292`). Every read/write in `backend/repository.ts` and the
   service layer scopes by this one global `WORKSPACE.id`, **never by the
   authenticated user**. Unlike actor/token identity (which lives in an
   `AsyncLocalStorage` request context), the workspace binding is *not*
   per-request, so it cannot represent "which tenant is this request for."

2. **Auto-join on login.** `ensureWorkspaceUser()` (`backend/auth.ts:98-158`) runs
   on **every** browser session (`backend/auth.ts:175`). If the logged-in profile
   is not already an active member of the global workspace, it silently INSERTs a
   `workspace_users` row joining them **and** grants them ADMIN
   (`grantWorkspaceAdminRole`). No invitation, no approval.

3. **RBAC governs actions, not tenancy.** `openoverlord.rbac.toml` /
   `backend/rbac.ts` decide *what actions* a role may perform (`mission:read`,
   `mission:*`, …). The MEMBER role already grants `mission:*` and auto-joined
   users are ADMIN anyway, so every check passes. Nothing gates *whether a user
   should belong to a workspace*.

A workspace invite email template exists (`backend/email-templates/invite-user.ts`)
but is wired to **no route and no membership gate** — the invitation flow it
anticipates was never built.

## 2. Target model

- **A workspace is the tenant boundary.** A user sees only the workspaces they are
  an active member of, and only the data inside those workspaces.
- **Creating a workspace makes you its ADMIN.** (Already true in
  `createWorkspace`, `backend/workspaces.ts:343`.)
- **Everyone else joins only by invitation.** No implicit auto-join, no implicit
  ADMIN. A new user who signs up with no invitation lands in an empty state and
  must either create their own workspace or accept an invite.
- **The active workspace is resolved per request** from the authenticated user's
  memberships, not from a process-global singleton.
- **Data isolation is enforced at the query layer** (workspace scoping) *and*
  membership is verified before a request is allowed to act on a workspace.

## 3. Key architectural decision: retire the global `WORKSPACE` singleton

This is the crux and the highest-risk change. Today `WORKSPACE` and
`ACTOR_WORKSPACE_USER_ID` are module globals; the request context
(`withRequestContextAsync`, `backend/db.ts:196-220`) already carries
`actorWorkspaceUserId`, `activeTokenId`, etc. per request via `AsyncLocalStorage`.

The plan moves the **active workspace** into that same request context so two
concurrent requests from different tenants never share a workspace binding.
`WORKSPACE.id` reads scattered across `repository.ts` / service become
`getActiveWorkspaceId()` (context-backed) with the same call shape, minimizing
churn.

The desktop / self-hosted single-operator edition keeps working: when there is
exactly one workspace and one member, per-request resolution deterministically
returns it, so local usage is unchanged.

---

## Phase 0 — Remove auto-join

There are no real users yet, so there is nothing to migrate, audit, or hot-fix —
this is a clean-slate change, not an emergency guardrail.

1. **Do not auto-grant membership or ADMIN on login.** In
   `ensureWorkspaceUser` (`backend/auth.ts:98-158`), remove the "INSERT membership
   + `grantWorkspaceAdminRole`" branch for profiles that are not already members.
   A session for a non-member resolves to *no active workspace* instead of being
   folded into the oldest workspace.

Exit criteria: a freshly signed-up second account is not a member of any existing
workspace. Verified with an integration test (two profiles, no invite → no shared
workspace).

## Phase 1 — Per-request workspace resolution

Goal: replace the global `WORKSPACE` singleton with per-request tenant scoping.

1. **Extend `RequestContext`** (`backend/db.ts:180-194`) with
   `activeWorkspaceId` / `activeWorkspace`. Add `getActiveWorkspaceId()` and
   `getActiveWorkspace()` reading from `requestContext()`.
2. **Resolve the workspace per request.** In `requireAuthenticatedSession`
   (`backend/auth.ts`), after identifying the actor, resolve the target workspace
   from: (a) an explicit workspace header/param the client sends, validated
   against the user's memberships; else (b) the user's default/most-recent
   membership. Reject requests targeting a workspace the actor is not an active
   member of with `403`.
3. **Mechanical migration.** Replace `WORKSPACE.id` reads in `backend/repository.ts`,
   `backend/workspaces.ts`, and `packages/core/service/*` with
   `getActiveWorkspaceId()`. Keep the export name/shape where a compatibility
   shim reduces diff size, but back it with the request context.
4. **Preserve the CLI/runner loopback path.** The non-browser surface
   (`usesNonBrowserAuthSurface`, `backend/auth.ts:68-76`) and USER_TOKEN auth must
   resolve the workspace from the **token's** `workspace_id`
   (`user_tokens.workspace_id`, `database/sqlite/migrations/003_rbac.sql:38`),
   which is already workspace-scoped — no global needed.
5. **`activateWorkspace` becomes per-user.** Switching the active workspace writes
   the user's preference, not a process global.

Exit criteria: two authenticated requests from different users hitting the server
concurrently each read only their own workspace's data. Covered by a Postgres
conformance test in the style of `backend/workspaces.postgres-conformance.test.ts`.

## Phase 2 — Workspace ownership on creation

Goal: guarantee the creator is the workspace ADMIN, and no one else is a member.

1. **Confirm `createWorkspace`** (`backend/workspaces.ts:343-410`) adds the
   creating profile as the sole `workspace_users` row and grants ADMIN
   (already does via `grantWorkspaceAdminRole`). Make the creator profile the
   *authenticated user*, not `resolveLocalUserId()`'s "oldest human profile"
   fallback (`backend/workspaces.ts:201-218`) — that fallback is a single-operator
   assumption and must not apply on the hosted edition.
2. **New-user onboarding.** When an authenticated user has zero active
   memberships (post-Phase-0), the web app routes them to a "create your
   workspace" screen instead of a shared board. First workspace they create makes
   them ADMIN of it.

Exit criteria: a brand-new user with no invite can create a workspace, is its
ADMIN, and sees only their own data.

## Phase 3 — Member invitation flow (from Workspace Settings)

Goal: the only way to add another user to a workspace, using the existing
`backend/email-templates/invite-user.ts` template.

**Data model**

1. New table `workspace_invitations` (SQLite + Postgres migrations, mirroring the
   dual-dialect pattern of `003_rbac.sql`):
   `id`, `workspace_id` (FK), `email`, `role_key` (default `MEMBER`),
   `token_hash` + `token_prefix` (never store the raw token — mirror
   `user_tokens`, `003_rbac.sql:42-43`), `status`
   (`pending` | `accepted` | `revoked` | `expired`), `invited_by_workspace_user_id`,
   `expires_at`, timestamps, `revision`. Unique active index on
   `(workspace_id, email)`.
2. Register the table with the existing change-feed / kysely-codegen path so both
   data layers and generated types stay in sync.

**Backend (service + routes)**

3. `inviteWorkspaceMember(workspaceId, { email, role })` in `backend/workspaces.ts`:
   requires the caller to be ADMIN of `workspaceId` (reuse `requireWorkspaceAdmin`,
   `backend/workspaces.ts:233-243`); generates a single-use token; stores the hash;
   sends the email.
4. Wire the email: add `sendInviteEmailViaResend` alongside
   `sendVerificationEmailViaResend` (`backend/email-verification.ts`) using
   `inviteUserHtml` / `inviteUserSubject` from
   `backend/email-templates/invite-user.ts`. `confirmationUrl` points at the
   accept route with the raw token; gate on `RESEND_API_KEY` the same way
   verification email is (`verificationEmailSenderFromEnv`).
5. `acceptWorkspaceInvitation(rawToken)`: validates token + expiry + status,
   binds the accepting authenticated profile to the workspace via a
   `workspace_users` row with the invited `role_key`, marks the invite `accepted`.
   If the email has no account yet, funnel through signup first, then accept.
6. `listWorkspaceInvitations(workspaceId)` / `revokeWorkspaceInvitation(id)` for
   settings management, ADMIN-gated.
7. New permissions in `openoverlord.rbac.toml` and `backend/rbac.ts`
   (`member:invite`, `member:remove`, `invitation:read`, `invitation:revoke`) and
   corresponding `PERMISSIONS.*` constants used by the `handle(...)` route gate.

**Routes** (follow the pattern at `backend/index.ts:372-387`):

- `GET  /api/workspaces/:id/invitations` → `listWorkspaceInvitations`
- `POST /api/workspaces/:id/invitations` → `inviteWorkspaceMember`
- `DELETE /api/workspaces/:id/invitations/:invitationId` → `revokeWorkspaceInvitation`
- `POST /api/invitations/accept` → `acceptWorkspaceInvitation` (token in body)
- `DELETE /api/workspaces/:id/members/:workspaceUserId` → remove a member

**Frontend (Workspace Settings)**

8. Add a **Members** section to Workspace Settings: list current members
   (`listWorkspaceMembers`, `backend/workspaces.ts:676`), an "Invite by email" form
   (with role select), a pending-invites list with resend/revoke, and member
   removal for ADMINs. Non-admins see a read-only roster.
9. An accept-invite landing page consumes the token from the email link and calls
   `POST /api/invitations/accept`.

Exit criteria: an ADMIN can invite `test@cooperativ.io` from Workspace Settings;
the recipient gets the branded email, accepts, and joins **only** that workspace
with the granted role. A user who was never invited cannot join.

## Phase 4 — Roles, removal, and least privilege

1. **Stop defaulting everyone to ADMIN.** Invited members default to `MEMBER`
   (per `openoverlord.rbac.toml`), not ADMIN. Only workspace creators and
   explicitly promoted members are ADMIN.
2. **Role management UI/API** for ADMINs: promote/demote members
   (`role_assignments`, `003_rbac.sql:14-33`), remove members (soft-delete the
   `workspace_users` row + revoke role rows).
3. **Guard the last admin**: a workspace must always retain ≥1 ADMIN; block
   removing/demoting the final one (mirrors the "cannot delete the only
   workspace" guard, `backend/workspaces.ts:633`).

## Phase 5 — Tests and security review

No data backfill is needed — there are no real users or shared-cloud workspaces to
migrate.

1. **Regression suite.** Extend `backend/workspaces.test.ts`,
   `backend/my-missions.test.ts`, and add
   `backend/workspace-invitations.test.ts` covering: no auto-join, per-request
   isolation, invite→accept happy path, expired/revoked token rejection,
   cross-workspace read denial (`403`), and last-admin guard. Include a Postgres
   conformance test.
2. **Security review.** Run the `security-audit` skill against the new invitation
   surface (token entropy, single-use enforcement, email enumeration, IDOR on
   `/api/workspaces/:id/*`).

---

## Risks & notes

- **Highest-effort change is Phase 1** (retiring the global `WORKSPACE`). With no
  users yet there is no live data at risk, but it touches every query, so build
  and review it carefully. Phase 0 is a small precursor, not an emergency hotfix.
- **Dual data layers.** Per the codebase, schema/scoping changes must update both
  `backend/repository.ts` (REST) and `packages/core/service/*` (protocol/CLI),
  plus kysely types and contract DTOs.
- **Contract.** Adding member/invitation module interactions must be reflected in
  `CONTRACT.md` (per `CLAUDE.md`); list the impact on the auth, database, and
  webapp modules.
- **Local/self-hosted parity.** All changes must preserve the single-operator
  desktop edition: one workspace, one member, no invitations required.

## Sequencing summary

| Phase | Outcome | Blocks |
| --- | --- | --- |
| 0 | Remove auto-join on login | — |
| 1 | Per-request workspace isolation | after 0 |
| 2 | Creator is ADMIN; new users start empty | after 1 |
| 3 | Invite flow from settings via `invite-user.ts` | after 2 |
| 4 | Least-privilege roles & member management | after 3 |
| 5 | Tests & security review | after 3–4 |
