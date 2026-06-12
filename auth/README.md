# Auth Module

User identity, API/CLI tokens, and role-based access control (RBAC).
Designed so developers can **mix and match** authentication and authorization:
swap the token/auth mechanism without touching RBAC, and replace the
authorization provider without touching token storage.

## Contract Component

Maps to the **Auth Layer** (`auth`) in [`CONTRACT.md`](../CONTRACT.md), which owns:

- Token creation, rotation, revocation, and hash storage
- Role assignment CRUD
- The permission-check interface
- Audit-log attribution fields

It does **not** own user-identity schema (co-owned with the Database Layer via
the schema contract) or business-logic gating (callers act on the result of a
permission check).

## Two mix-and-match sub-areas

### Authentication (tokens)
- Spec: [07 — USER_TOKEN Authentication](docs/07-user-token-authentication.md)
- User-owned API/CLI tokens: create, list, rotate, revoke; hashes only, never raw secrets.
- Pluggable: a deployment can attach its own auth mechanism behind the same Auth Layer boundary.

### Authorization (RBAC)
- Spec: [08 — Role-Based Access Control](docs/08-role-based-access-control.md)
- Default `ADMIN` / `MEMBER` roles, capability grants, config-backed policy, replaceable authorization provider.
- Default policy config: [`../Overlord.rbac.toml`](../Overlord.rbac.toml)

## Code & Tests

The RBAC authorizer is the first implemented slice. It currently lives under
[`src/rbac/`](src/rbac) with its test colocated:

- `src/rbac/authorizer.ts` — `can(actor, action, resource)` evaluation + `AuthorizationProvider` interface
- `src/rbac/roles.ts`, `permissions.ts`, `types.ts`

The full auth/RBAC/token test plan — tokens (hash-only storage), session keys,
identity bridging, audit attribution, and auth-provider conformance — is in
[`docs/testing.md`](docs/testing.md), part of the root [TEST_PLAN.md](../TEST_PLAN.md).
- `src/rbac/authorizer.test.ts` — colocated unit test

The authorization logic deliberately lives **above** the database layer; the DB
(`002_rbac.sql`) only provides `role_assignments`, `user_tokens`, and
`user_token_scopes`. See [`database/`](../database/README.md).

`src/auth/createAuth` accepts either the existing SQLite database path or an
explicit database configuration. Shared/private-network deployments should pass
`{ database: { type: 'postgres', connectionString: process.env.DATABASE_URL } }`
so Better Auth sessions and Overlord identity-bridge reads use the same
PostgreSQL database as the domain schema.

## Interaction Boundaries

Other components must consume auth only through the Auth Layer service boundary
(token validation + permission check), never by reading auth tables directly.
A custom Auth/RBAC provider is a sanctioned [extension point](../CONTRACT.md).
