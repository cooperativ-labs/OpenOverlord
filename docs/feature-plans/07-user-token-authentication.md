# USER_TOKEN Authentication Module

## Goal

Add a modular `USER_TOKEN` feature that lets each user create, inspect, rotate, and revoke long-lived tokens for CLI, agent, runner, and future API use. This feature should be designed as a separable authentication module so the database design can reserve the right ownership, lifecycle, and future permission-scoping concepts without forcing auth into the local unauthenticated MVP.

Use the name `USER_TOKEN` for this concept. Do not use agent-specific token naming in OpenOverlord planning or implementation unless a migration note explicitly requires it.

## Position In The Roadmap

`USER_TOKEN` is not required for the first local-only CLI MVP. The local MVP can run as an implicit trusted user. Once OpenOverlord supports real users, remote runners, HTTP APIs, MCP, or multi-device workflows, `USER_TOKEN` becomes the preferred non-interactive credential type.

Requirements:

- Treat `USER_TOKEN` as a module with clear service boundaries.
- Do not couple token storage directly to any one connector.
- Do not make tokens agent-specific; agents, CLI, runners, and future API clients can all use the same user-owned token mechanism.
- Design the module so future extensions can restrict token permissions without replacing the token lifecycle.

## Permission Model

Initial behavior:

- A `USER_TOKEN` confers all permissions of the user who created it.
- Authorization checks should resolve the token to its creating user, then evaluate the same permissions that user would have.
- The token itself does not have independent permission scope in the first implementation.
- When role-based access control is enabled, token requests should pass through the same authorization provider as interactive user requests.

Future behavior:

- Extensions may allow users to specify which permissions a token includes.
- Scoped tokens should be additive constraints on top of the creating user's current permissions, not a way to exceed them.
- A token should become less powerful if the creating user's permissions are reduced.
- A token should stop working if the creating user is disabled, removed from a workspace, or otherwise loses access.

Schema-planning implication:

- Model token ownership separately from future token grants/scopes.
- Leave room for token-level labels, metadata, expiration, revocation, and scope records.
- Avoid baking "full user permissions forever" into the persistence model.

## Token Lifecycle

### Create

Requirements:

- User can create a token from the CLI.
- Future web app can create a token from settings.
- Token has a user-supplied label.
- Optional expiration should be supported or at least reserved as a future field.
- The raw token secret is shown exactly once at creation.
- Persist only a secure hash of the token secret.
- Store a non-secret token identifier/prefix for lookup, display, and audit.
- Record creation time and creator user.

Suggested command:

```bash
ovld user-token create --label "macbook runner"
ovld user-token create --label "ci runner" --expires-in 90d
```

### List

Requirements:

- User can list their tokens from the CLI.
- Output must never reveal raw token secrets.
- Show identifier/prefix, label, created time, last used time, expiration, revoked status, and coarse use/context metadata when available.

Suggested command:

```bash
ovld user-token list
ovld user-token list --json
```

### Revoke

Requirements:

- User can revoke a token from the CLI.
- Revoked tokens fail authentication immediately.
- Revocation should record time and actor.
- Revocation should be safe and idempotent.

Suggested command:

```bash
ovld user-token revoke <token-id-or-prefix>
```

### Rotate

Requirements:

- User can rotate a token from the CLI.
- Rotation should create a replacement secret and invalidate the old secret.
- The replacement secret is shown exactly once.
- Rotation should preserve useful metadata such as label unless explicitly changed.
- Rotation should record predecessor/successor relationship for audit and troubleshooting.

Suggested commands:

```bash
ovld user-token rotate <token-id-or-prefix>
ovld user-token rotate <token-id-or-prefix> --label "new label"
```

### Rename

Requirements:

- User can update a token label without rotating the secret.

Suggested command:

```bash
ovld user-token rename <token-id-or-prefix> "office workstation"
```

## CLI And Environment Requirements

Requirements:

- The CLI should accept a `USER_TOKEN` through an environment variable for non-interactive use.
- Prefer `OPENOVERLORD_USER_TOKEN` for OpenOverlord-specific configuration.
- Optionally support `OVLD_USER_TOKEN` as a short alias.
- Avoid reusing upstream agent-specific token environment variable naming in new OpenOverlord docs.
- `ovld auth status` should report whether a user token is present and usable without printing it.
- `ovld doctor` should detect malformed or revoked token configuration and suggest repair steps.

Example:

```bash
export OPENOVERLORD_USER_TOKEN=out_...
ovld protocol attach --ticket-id 1:1204
ovld runner start
```

Token commands should be grouped under either:

- `ovld user-token ...` for clear naming, or
- `ovld auth token ...` if the CLI later groups all auth commands together.

Pick one primary command group before implementation and keep aliases minimal.

## Protocol And API Requirements

Requirements:

- Protocol requests should authenticate with a `USER_TOKEN` when no local interactive session is available.
- Token authentication must resolve to a user identity before permission checks.
- Protocol event history should attribute actions to the resolved user and, where useful, the token identifier.
- Token lifecycle operations should be available through CLI first and can later be exposed as local/web API endpoints.
- Token lifecycle operations must never return raw token secrets except from create/rotate responses.

Potential protocol commands:

- `ovld protocol auth-status`
- `ovld user-token create`
- `ovld user-token list`
- `ovld user-token revoke`
- `ovld user-token rotate`
- `ovld user-token rename`

## Security Requirements

- Store only token hashes, never raw secrets.
- Generate high-entropy secrets with a recognizable prefix such as `out_` for OpenOverlord user token.
- Show the raw secret exactly once.
- Allow immediate revocation.
- Record last-used timestamp and, when safe, coarse client metadata.
- Do not log raw tokens.
- Redact token-like values in diagnostics.
- Treat tokens like passwords in docs and warnings.

## Future Scoped Permission Extension

The initial full-user-permission behavior should be implemented through an authorization resolver that can later add scope checks.

Future scope examples:

- Read-only ticket access.
- Create/update tickets but not delete projects.
- Runner-only execution request claim/complete.
- Connector setup only.
- Project-limited access.
- Expiring CI token.

Requirements for future readiness:

- Token authentication should produce both user identity and token identity.
- Permission evaluation should be able to ask, "does this token further restrict this user's permission?"
- Scope absence in v1 means "no token-level restriction" rather than "unknown".
- Revocation and expiration must apply before scope evaluation.
- Token scopes should reuse the canonical permission names defined by the RBAC module.

## Acceptance Criteria

- The feature plan uses `USER_TOKEN` consistently.
- A user can create, list, rotate, rename, and revoke tokens from the CLI once auth is implemented.
- A `USER_TOKEN` initially confers exactly the creating user's current permissions.
- The design leaves room for future token-level scopes without changing the user/token ownership model.
- Raw token secrets are never persisted or displayed after create/rotate.
