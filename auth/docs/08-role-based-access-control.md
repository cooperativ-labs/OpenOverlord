# Role-Based Access Control

## Goal

Add a modular role-based access control model for multi-user Overlord instances. The default model should support at least `ADMIN` and `MEMBER` roles, let administrators manage users, and provide a practical foundation for customers and developers to customize permissions without rewriting the core auth and token lifecycle.

RBAC is not required for the first local-only CLI MVP. The local MVP can continue to run as one implicit trusted user. Once Overlord supports real users, hosted access, shared instances, remote runners, HTTP APIs, MCP, or persistent service users for agents, every protected operation should go through the authorization layer.

## Design Principles

Requirements:

- Treat RBAC as an authorization module, separate from authentication and `USER_TOKEN` storage.
- Use domain capabilities as the canonical permission unit, not raw table names.
- Allow CRUD-style permission groups as shorthand where they map cleanly to domain operations.
- Do not hard-code role names such as `ADMIN` in business logic outside the authorization module.
- Evaluate authorization by asking whether an actor can perform an action on a resource in context.
- Keep role definitions configurable and replaceable by developers.
- Store role assignments durably so user membership survives config reloads and policy provider changes.
- Store role assignment scope fields as non-null values. Instance/workspace-level assignments should use empty string scope sentinels so the database can enforce one active assignment per user/role/scope on both SQLite and Postgres.
- Prefer allow-only grants in the first implementation. Defer deny rules until there is a concrete need.

## Default Roles

Overlord should ship with three default roles.

### ADMIN

`ADMIN` is the instance administrator role.

Requirements:

- Has all permissions by default.
- Can create, invite, disable, remove, and update users.
- Can assign and revoke roles for other users.
- Can configure instance-level settings, connectors, auth settings, and execution defaults.
- Can manage projects, tickets, objectives, sessions, events, artifacts, review records, execution requests, and tokens.
- At least one active administrator should exist when auth is enabled.

### MEMBER

`MEMBER` is the standard user role for ordinary humans and persistent agent/service users.

Requirements:

- Can create, read, update, and participate in project work by default.
- Can create and manage tickets, objectives, sessions, events, review artifacts, and execution requests needed for normal agent workflows.
- Can create, list, rotate, rename, and revoke that user's own `USER_TOKEN` credentials.
- Cannot create, disable, delete, or remove other users.
- Cannot assign or revoke roles.
- Cannot configure instance-wide auth or RBAC settings.
- Can create, read, update, and delete workspace attachments.
- Can read public workspace images and user images.
- Can create, update, and delete that user's own images.

### PUBLIC

`PUBLIC` is the unauthenticated read role for resources that are intentionally public.

Requirements:

- Can read public workspace images.
- Can read public user images.
- Cannot create, update, or delete storage metadata.
- Cannot read workspace attachments unless a custom policy explicitly grants that access.

Persistent agent accounts should usually be modeled as users with `kind = "service"` or equivalent metadata, not as a separate identity primitive. They can receive `MEMBER` initially, and later narrower roles such as `AGENT` or `RUNNER` if customers need them.

## Permission Shape

Canonical permission names should be domain-oriented strings:

```text
project:create
project:read
project:update
project:delete
ticket:create
ticket:read
ticket:update
ticket:delete
objective:submit
session:attach
event:create
artifact:read
workspace_image:read
workspace_image:create
workspace_image:update
workspace_image:delete
user_image:read
user_image:self:create
user_image:self:update
user_image:self:delete
attachment:read
attachment:create
attachment:update
attachment:delete
execution_request:claim
user:create
user:disable
role:assign
connector:configure
```

Requirements:

- Support wildcard expansion such as `ticket:*` and `*`.
- Support self-scoped permissions such as `user_token:self:*`.
- Support resource/context-aware checks, such as project membership or ownership, even if the first implementation only uses instance-level roles.
- Keep permission names stable enough for config files, API checks, audit messages, and future docs.
- Avoid exposing database table names as the public permission contract unless the table also represents a stable domain resource.

CRUD groups can be generated or declared for common resources:

```toml
[permission_groups.ticket_crud]
grants = [
  "ticket:create",
  "ticket:read",
  "ticket:update",
  "ticket:delete"
]
```

Non-CRUD operations should stay explicit because they often carry different risk than ordinary updates.

## Default RBAC Config

The default policy provider should be backed by a config file, for example `Overlord.rbac.toml` or an `[rbac]` section in `overlord.toml`. The final location can be chosen during implementation, but the format should support roles, groups, grants, and metadata.

Example:

```toml
[roles.ADMIN]
description = "Full instance administrator"
grants = ["*"]

[roles.MEMBER]
description = "Standard user or persistent agent account"
grants = [
  "project:read",
  "ticket:*",
  "objective:*",
  "session:*",
  "event:create",
  "event:read",
  "artifact:*",
  "workspace_image:read",
  "user_image:read",
  "user_image:self:*",
  "attachment:*",
  "user_token:self:*",
  "execution_request:create",
  "execution_request:read",
  "execution_request:claim"
]

[roles.PUBLIC]
description = "Unauthenticated public read access"
grants = [
  "workspace_image:read",
  "user_image:read"
]

[permission_groups.user_management]
grants = [
  "user:create",
  "user:update",
  "user:disable",
  "user:delete",
  "role:assign",
  "role:revoke"
]
```

Requirements:

- Validate unknown permission names unless an extension explicitly registers them.
- Validate unknown role names in user assignments unless migration or emergency recovery mode permits them.
- Make default role definitions visible to developers and administrators.
- Keep the generated default config easy to copy, edit, and version.
- Provide diagnostics through `ovld doctor` for malformed RBAC config, missing roles, and invalid grants.

## Replaceable Authorization Provider

Developers should be able to replace the config-backed RBAC provider with a custom authorization mechanism.

Requirements:

- Define a stable authorization interface similar to `can(actor, action, resource, context) -> boolean`.
- Keep authentication output separate from authorization input. Authentication should identify the user and token; authorization should decide effective access.
- Allow custom providers to use the default config, database role assignments, external IAM, SSO group mappings, OPA-style policies, hosted policy services, or customer-specific code.
- Keep all protected CLI, protocol, API, and web operations behind the same authorization boundary.
- Return machine-readable denial reasons suitable for CLI output, API responses, audit events, and web UI messages.

Business logic should call the authorization service for capabilities such as `user:create`, `role:assign`, `execution_request:claim`, and `connector:configure`. It should not check for specific role names directly.

## User And Role Lifecycle

Requirements:

- When auth is enabled, the first configured user should become an `ADMIN` unless an explicit bootstrap flow says otherwise.
- Only actors with `user:create` or equivalent permission can add users.
- Only actors with `user:disable`, `user:delete`, or equivalent permission can remove or disable users.
- Only actors with `role:assign` and `role:revoke` can change role assignments.
- Prevent removing the last active administrator unless an explicit break-glass recovery path exists.
- Record user and role changes in audit/event history with actor, target user, changed roles, and timestamp.
- Disabling or removing a user should invalidate that user's effective access and all `USER_TOKEN` access derived from that user.

## USER_TOKEN Interaction

RBAC should integrate with the existing `USER_TOKEN` plan.

Requirements:

- A `USER_TOKEN` initially confers the current permissions of the creating user.
- Token authentication should resolve both user identity and token identity before authorization.
- Future token scopes should further restrict the creating user's effective permissions, never expand them.
- Revocation, expiration, disabled-user state, and removed-user state must be evaluated before permission grants.
- Token-scoped permissions should reuse the same canonical permission names as RBAC roles.

## Acceptance Criteria

- The plan defines `ADMIN` and `MEMBER` default roles.
- Only `ADMIN` or equivalent custom policies can add, remove, disable, or assign roles to other users by default.
- Persistent agent accounts can be represented as normal users with service metadata.
- Permission checks use domain capabilities rather than direct table checks.
- CRUD permission groups exist as shorthand, but non-CRUD operations remain explicit capabilities.
- The default provider can load a config-backed role definition.
- Developers can replace the config-backed provider with another authorization mechanism without changing authentication or `USER_TOKEN` storage.
