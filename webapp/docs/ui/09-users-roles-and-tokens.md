# 09 — Users, Roles & Tokens

Multi-user administration: managing users, assigning RBAC roles, and the
`USER_TOKEN` lifecycle. This entire surface is **capability-gated on
[Group 1](../../../database/docs/10-database-table-groups.md#group-1-multi-user-access-and-api-tokens)**
(`user_tokens`, `user_token_scopes`, `role_assignments`). In core-only,
single-user installs these routes and their nav entries do not exist — the app runs
as one implicit trusted user.

**Routes:** `/settings/users`, `/settings/tokens`.

---

## Users (`/settings/users`)

```
Users & roles                                                  [ + Add user ]
┌──────────────────────────────────────────────────────────────────────────┐
│ User            Kind     Roles            Status     Last active           │
│ jake@…          human    ADMIN            active      2m ago               │
│ ci@…            service  MEMBER           active      1h ago               │
│ alex@…          human    MEMBER           active      3d ago               │
│ old@…           human    MEMBER           disabled    —      [ Enable ]    │
└──────────────────────────────────────────────────────────────────────────┘
   row → user detail: role assignment, disable/remove, audit of changes
```

- Lists `workspace_users` (joined to `users`): identity, `kind` (`human` /
  `service` — persistent agent/runner accounts are normal users with service
  metadata, **not** a separate identity primitive), assigned roles, active/disabled,
  last activity.
- **Add user / disable / remove** are admin-only (`user:create`, `user:disable`,
  `user:delete`). The UI **prevents removing or disabling the last active
  administrator** unless an explicit break-glass path is provided.
- User detail shows the role assignments and a change history (who changed which
  role when — backed by `audit_log` if Group 2 is installed).

### Add user dialog
```
Add user
┌───────────────────────────────────────────────┐
│ Email / identity  [ ____________________ ]      │
│ Kind   (•) Human   ( ) Service (agent/runner)   │
│ Role   [ MEMBER ▾ ]   (ADMIN requires confirm)  │
│                         [ Cancel ] [ Add ]      │
└───────────────────────────────────────────────┘
```

---

## Roles

```
Roles                                                       [ View RBAC config ]
┌──────────────────────────────────────────────────────────────────────────┐
│ Role     Description                Grants (summary)         Members        │
│ ADMIN    Full instance admin        *                         1             │
│ MEMBER   Standard user / agent      ticket:* objective:* …    3             │
│ (custom roles from openoverlord.rbac.toml appear here)                      │
└──────────────────────────────────────────────────────────────────────────┘
   role → grants detail (read-only mirror of the config-backed provider)
```

- Renders the roles from the config-backed RBAC provider
  (`openoverlord.rbac.toml` / `[rbac]`). Default `ADMIN` (grants `*`) and `MEMBER`
  (project/ticket/objective/session/event/artifact + `user_token:self:*` +
  execution-request create/read/claim) plus any custom roles.
- **Grants are domain capabilities** (`ticket:create`, `role:assign`,
  `execution_request:claim`, …), not table names; wildcards (`ticket:*`, `*`) and
  self-scoped (`user_token:self:*`) render readably.
- Role **definitions** are owned by the config/provider (the UI shows them; editing
  role grants is a config operation surfaced read-only unless an editing provider is
  enabled). Role **assignment** to users is the UI's write path (`role:assign` /
  `role:revoke` → `role_assignments`). Assignment scope uses the empty-string
  sentinel for instance/workspace-level grants (per the schema contract).
- Business logic checks capabilities, never role names — so the UI also checks
  capabilities (e.g. show the "Add user" button when the actor has `user:create`),
  not `role == 'ADMIN'`.

---

## USER_TOKENs (`/settings/tokens`)

Each user manages **their own** tokens (`user_token:self:*`); admins may view all.
A `USER_TOKEN` initially confers all of the creating user's current permissions.

```
Your API tokens                                              [ + Create token ]
┌──────────────────────────────────────────────────────────────────────────┐
│ Label            Prefix     Created    Last used   Expires    Status        │
│ macbook runner   out_3f9a   Apr 2      2m ago      —          active  ⋯     │
│ ci runner        out_a1c0   Mar 10     1h ago      in 60d     active  ⋯     │
│ old laptop       out_77be   Jan 5      —           expired    revoked       │
└──────────────────────────────────────────────────────────────────────────┘
   ⋯ = Rotate · Rename · Revoke
```

### Create / rotate (one-time secret reveal)
```
Token created — copy it now, it won't be shown again
┌──────────────────────────────────────────────────────────────────────────┐
│  out_3f9a8c2b1d…full-secret…                              [ Copy ] [ Done ]│
│  Store it like a password. Use as OPENOVERLORD_USER_TOKEN.                 │
│  export OPENOVERLORD_USER_TOKEN=out_…                          [ Copy ]    │
└──────────────────────────────────────────────────────────────────────────┘
```

| Action | Behavior | Endpoint |
| --- | --- | --- |
| Create | label (+ optional expiry) → raw secret shown **once**; only hash + prefix stored | `user-token create` |
| List | never reveals secrets; shows prefix, label, created, last used, expiry, status | `user-token list` |
| Rotate | new secret shown once, old invalidated immediately, label preserved, predecessor recorded | `user-token rotate` |
| Rename | change label without rotating the secret | `user-token rename` |
| Revoke | fails auth immediately; idempotent; records time + actor | `user-token revoke` |

Hard rules the UI enforces (from the auth spec & security boundaries):

- Raw secrets are displayed **exactly once** at create/rotate and **never**
  re-fetchable. The list view shows only the non-secret prefix.
- Show the env-var usage (`OPENOVERLORD_USER_TOKEN`, alias `OVLD_USER_TOKEN`) on
  reveal so the user knows how to use it headlessly.
- A token stops working when revoked/expired or when the creating user is
  disabled/removed — the status column reflects this.
- **Future scopes** (`user_token_scopes`): when present, the create dialog can
  restrict a token to a subset of the user's permissions (additive constraint, never
  expansion). The UI presents scope absence as "full user permissions (no token
  restriction)," not "unknown."

---

## Data + realtime

| Region | Read | Realtime |
| --- | --- | --- |
| Users | `workspace_users` + `users` | `workspace_user`/`role_assignment` deltas |
| Roles | RBAC provider config + `role_assignments` | role-assignment deltas; config reload |
| Tokens | `user_tokens` (+ `user_token_scopes`) | `user_token` deltas (created/rotated/revoked) → list status |
| Change history | `audit_log` (Group 2) | audit deltas |

The change feed carries **no secrets** (no token hashes), so token list/status
updates stream safely.

---

## States

- **Group 1 absent:** routes and nav hidden entirely; the app is single implicit
  user. (A hint in Settings → Capabilities explains how to enable multi-user.)
- **Non-admin viewing Users/Roles:** read-only where they lack `user:*` /
  `role:assign`; their own Tokens remain fully manageable (`user_token:self:*`).
- **Last-admin guard:** attempting to remove/demote the only admin is blocked with a
  clear reason and the break-glass instruction.
- **Group 2 absent:** change-history panels show "audit trail not installed."

---

## Capability gating

- Whole surface: Group 1. Token scopes UI: `user_token_scopes` (within Group 1).
  Change history: Group 2. Every write is RBAC-checked by capability, and denials
  show the machine-readable reason RBAC returns.

---

## Acceptance criteria

- With Group 1 installed, an admin can add users, assign/revoke `ADMIN`/`MEMBER`
  (and custom) roles, and disable/remove users — but cannot remove the last admin.
- Roles render their domain-capability grants (with wildcard/self-scope) read from
  the config-backed provider; the UI gates buttons by capability, not role name.
- A user can create, list, rotate, rename, and revoke their own `USER_TOKEN`s; the
  raw secret appears exactly once and is never shown again.
- Revoking a token or disabling its owner invalidates it immediately, reflected live
  in the list.
- With Group 1 absent, none of these surfaces appear and the app runs as one
  implicit user with no broken links.
</content>
