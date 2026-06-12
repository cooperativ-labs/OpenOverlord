# Auth Module — Agent Extension Guide

This file tells agents how to extend the Auth module to add new capabilities for users. Read [`CONTRACT.md`](../CONTRACT.md) and the [component-contract skill](../.claude/skills/component-contract/SKILL.md) before making any cross-module change.

---

## What "extending auth" means

The Auth module owns two separable sub-areas: **authentication** (token lifecycle) and **authorization** (RBAC). Extensions in this module fall into four categories:

| Extension type | Example user request |
| --- | --- |
| New auth provider | "Support OAuth / SSO login" |
| New role | "Add a read-only VIEWER role" |
| New permission | "Add a `runner:manage` permission" |
| Token behavior change | "Allow token expiration / scoping" |

Each type has a different procedure below.

---

## Before You Start

1. Read `CONTRACT.md` — Auth Layer section (stable id: `auth`).
2. Read [`auth/docs/07-user-token-authentication.md`](docs/07-user-token-authentication.md) and [`auth/docs/08-role-based-access-control.md`](docs/08-role-based-access-control.md).
3. Check `auth/src/rbac/` for existing authorization code patterns.
4. If your change adds a new interaction surface between Auth and another component, update the contract first (see [contract/AGENTS.md](../contract/AGENTS.md)).

---

## Adding a New Auth Provider

An auth provider replaces or supplements the built-in `USER_TOKEN` mechanism. This is a sanctioned [extension point](../CONTRACT.md).

**Steps:**

1. **Create a conformance manifest** at `auth/providers/<name>/conformance-manifest.yaml` declaring `componentType: auth-provider` and `contractVersion: 0.2-draft`.
2. **Implement the `AuthenticationProvider` interface** (define the interface in `auth/src/auth/` if it does not exist yet). The provider must accept a credential and resolve it to an Overlord `Actor` or reject it.
3. **Do not read Better Auth tables directly** (`user`, `session`, `account`, `verification`, `apikey`). Only the Auth Layer's own identity bridge code may read those.
4. **Wire the identity bridge**: read `workspace_users` and `profiles` (where `profiles.id` matches the Better Auth user id) to resolve the external identity to an `Actor`.
5. **Update the migration if needed**: if your provider needs a new schema column, add a numbered migration in `database/sqlite/migrations/` following the [database extension procedure](../database/AGENTS.md).
6. **No contract version bump needed** for a new auth provider — it is a sanctioned extension point. Add your `conformance-manifest.yaml` and run `ovld contract check` on it.

---

## Adding a New Role

Default roles (`ADMIN`, `MEMBER`) are defined in `auth/src/rbac/roles.ts` and enforced by the RBAC policy in [`Overlord.rbac.toml`](../Overlord.rbac.toml).

**Steps:**

1. Add the role name constant to `auth/src/rbac/roles.ts`.
2. Declare the role's default capability grants in `Overlord.rbac.toml`. Follow the existing `[role.ADMIN]` / `[role.MEMBER]` blocks.
3. Update the RBAC authorizer tests in `auth/src/rbac/authorizer.test.ts` to cover the new role's permissions.
4. If the new role is meant to be workspace-configurable (not just code-defined), note it in [`auth/docs/08-role-based-access-control.md`](docs/08-role-based-access-control.md).
5. No contract update needed unless you are adding this role to a closed vocabulary (roles are an open vocabulary — see `CONTRACT.md`).

---

## Adding a New Permission

Permissions are domain-capability strings (e.g. `project:create`, `ticket:read`). They are an open vocabulary; new ones do not require a contract version bump.

**Steps:**

1. Define the permission name string in `auth/src/rbac/permissions.ts` (create the file if it does not exist, following the pattern in `auth/src/rbac/`).
2. Add the permission to the relevant role grant blocks in `Overlord.rbac.toml`.
3. Add a `can(actor, action, resource)` call wherever the permission is enforced in the service layer. **Do not gate access in database queries or CLI handlers directly** — always call through the `AuthorizationProvider` interface.
4. Write a test in `auth/src/rbac/authorizer.test.ts` covering the new permission for each role that should (and should not) hold it.
5. If this permission is being promoted from an extension-namespace value to a core value, update the "RBAC permission names" open vocabulary section in `database/docs/09-database-schema-contract.md`.

---

## Changing Token Behavior

Token lifecycle (create, rotate, revoke, expiration, scoping) is documented in [`auth/docs/07-user-token-authentication.md`](docs/07-user-token-authentication.md). The schema foundation is in `database/sqlite/migrations/002_rbac.sql`.

**Steps for adding token expiration:**

1. Add the column to `user_tokens` via a new numbered migration in `database/sqlite/migrations/`.  
2. Update the token-create service function to accept and persist the expiration.  
3. Update the token-validate path to reject expired tokens.  
4. Add CLI surface in the CLI module (`cli/`) to expose `--expires-in` on `ovld user-token create`.  
5. Update `auth/docs/07-user-token-authentication.md` to document the new field.

**Steps for adding token scopes:**

`user_token_scopes` is already reserved by `002_rbac.sql`. Populate it when implementing scope-restricted tokens, and update the permission-check path in the RBAC authorizer to intersect token scopes with user permissions.

---

## File Placement Convention

```
auth/
  docs/          ← spec docs for this module
  AGENTS.md      ← this file
  README.md      ← architectural overview
  src/
    auth/        ← Better Auth config, session bridge, token lifecycle
    rbac/        ← RBAC authorization logic (colocated with tests)
      authorizer.ts
      authorizer.test.ts
      roles.ts
      permissions.ts
      types.ts
```

New auth provider implementations go under `auth/providers/<name>/` or `auth/src/auth/<name>/` — keep the pattern consistent with whatever `auth/src/rbac/` establishes.

---

## Cross-Module Checklist

- [ ] Read `CONTRACT.md` Auth Layer section
- [ ] If adding a new surface between Auth and another component → update contract first
- [ ] If adding a database column → follow [database extension procedure](../database/AGENTS.md)
- [ ] If adding a new CLI command for auth → follow [cli extension procedure](../cli/AGENTS.md)
- [ ] Conformance manifest created and validated (`ovld contract check`) for shipped auth providers
