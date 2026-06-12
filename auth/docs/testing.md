# Auth Module — Test Plan

Part of the [master test plan](../../TEST_PLAN.md). Covers the `auth` contract
component: tokens, identity bridging, and RBAC. Normative sources:
[07-user-token-authentication.md](07-user-token-authentication.md),
[08-role-based-access-control.md](08-role-based-access-control.md), and the
`authToDatabase` surface in [`contract/components.yaml`](../../contract/components.yaml).

Current code under test: `src/auth/` (config, database, session, token) and
`src/rbac/` (authorizer, permissions, roles, types). `src/rbac/authorizer.test.ts`
already exists and is the seed of the RBAC suite — this plan extends it.

Auth is security-critical, so its pure logic carries the **95% coverage floor**.

---

## A. RBAC Authorizer (`src/rbac`) — L1 unit

Extends the existing `authorizer.test.ts`.

### A1. Role grants (already partially covered)
- `ADMIN` wildcard grants every domain action.
- `MEMBER` allows `ticket:*` and `user_token:self:*`, project read but not create,
  and denies user management, role assignment, connector configuration.
- No roles → everything denied.
- Denial/approval reasons include the deciding role name.

### A2. Permission-model invariants (new)
- **Capabilities, not table names.** Every permission name is a domain capability;
  a test asserts no permission string is a raw table name (contract security
  boundary: "Authorization grants use domain capabilities, not table names").
- **Wildcard semantics.** `ticket:*` grants `ticket:create/read/update/delete` but
  not `user:*`; `user_token:self:*` does not grant `user_token:` on other users.
- **Open vocab.** RBAC permission names are an open vocabulary — custom permissions
  must be namespaced (shared with [Layer 3 §3.2](../../TEST_PLAN.md#32-controlled-vocabulary-enforcement)).
- **Deterministic result shape.** `can()` always returns `{ allowed, reason }`;
  a custom auth provider must return the **same shape** (contract auth-provider
  constraint) — asserted by a shared shape test.
- **Default roles present.** `ADMIN` and `MEMBER` exist with the documented
  default permission sets (matches `openoverlord.rbac.toml`).

### A3. RBAC config loading
- `openoverlord.rbac.toml` parses into the documented roles/permissions; an unknown
  permission or malformed role fails loudly.

---

## B. Tokens (`src/auth/token`) — L1 + L2

### B1. Hash-only storage (security boundary)
> "Raw `USER_TOKEN` secrets are displayed once and never persisted."

- Creating a token returns the raw secret **once**; the persisted row stores only
  a hash + non-secret prefix — never the raw secret (assert by scanning the stored
  row; shared with [DB §10](../../database/docs/testing.md#10-security-boundaries-schema-contract--security-boundaries)).
- Verifying a token compares against the hash; a wrong secret fails.
- Lookup is by non-secret prefix, then hash compare (no full-table secret scan).

### B2. Lifecycle (create / list / rotate / revoke)
- Create → list shows prefix + metadata, never the secret.
- Rotate issues a new secret, invalidates the old, preserves token identity/scopes
  per spec.
- Revoke makes subsequent auth fail; revocation is a soft state with an audit row.
- `user_token_scopes` constrain what a token can do; an out-of-scope action is
  denied even for an otherwise-permitted role.

### B3. Self vs admin token management
- `MEMBER` can manage **own** tokens (`user_token:self:*`) but not others'.
- `ADMIN` can manage any token.

---

## C. Session Keys (`src/auth/session`)

> "Raw session keys should not be persisted. Store hashes and prefixes."

- A session key is shown once; storage is hash + prefix only (mirrors token rules).
- Session lifecycle (`attached`, liveness via heartbeat, delivery state) transitions
  per contract; `agent_sessions.delivery_state` is one of
  `not_delivered|delivered|pending_redelivery` (closed vocab, shared with
  [Layer 3 §3.2](../../TEST_PLAN.md#32-controlled-vocabulary-enforcement)).
- Heartbeat updates liveness without creating a `ticket_events` row (cross-checked
  with [CLI §B4](../../cli/docs/testing.md#b4-side-effect-fidelity)).

---

## D. Identity Bridge (`authToDatabase` surface) — L2

These tests prove the auth layer obeys its interaction-surface rules.

### D1. Bridge resolution
- Auth resolves an authenticated Better Auth identity to an Overlord `Actor` by
  reading `workspace_users` and `profiles` where `profiles.id` matches the
  Better Auth user id.
- Role resolution reads `role_assignments` by `workspace_user_id` + `workspace_id`
  to build the `Actor`'s role list.

### D2. Boundary enforcement (shared with Layer 3 §3.3)
- **Auth-internal tables are private:** no module outside `auth/`/`src/auth` reads
  `user`, `session`, `account`, `verification`, `apikey` directly.
- **Auth never writes core tables:** auth-layer source contains no writes to
  `tickets`, `projects`, `objectives`, etc.
- **Audit attribution preserved:** auth writes `actor_workspace_user_id` and
  `actor_token_id` to `audit_log` (a custom auth provider must too — contract
  auth-provider constraint).

---

## E. Audit Log

- Every permission decision that the contract requires to be audited writes an
  `audit_log` row with `result ∈ {allowed, denied, failed}` (closed vocab).
- Audit metadata is secret-redacted before persistence (no token secrets / session
  keys in audit rows).

---

## F. Auth-Provider Conformance (extension point)

For a custom auth/RBAC provider shipped as a component (per
[`extension-points.yaml`](../../contract/extension-points.yaml) `authProvider`):

- Manifest declares `componentType: auth-provider` with
  `preservesAuditAttribution: true` and `preservesTokenHashRules: true`, validated
  by the [manifest conformance test](../../TEST_PLAN.md#31-conformance-manifest-validation).
- A provided conformance test fixture proves the provider: never persists raw
  secrets, preserves audit attribution, implements role-assignment CRUD through the
  same service boundary, and returns the **same `can()` result shape** as the
  default RBAC service.

## Test Layout

```
src/rbac/authorizer.test.ts     # A1 (exists) + A2
src/rbac/permissions.test.ts    # A2 vocab/shape
auth/
  test/
    rbac-config.test.ts   # A3
    token.test.ts         # B
    session.test.ts       # C
    identity-bridge.test.ts # D (withAdapter)
    audit.test.ts         # E
    provider-conformance.test.ts # F
```
