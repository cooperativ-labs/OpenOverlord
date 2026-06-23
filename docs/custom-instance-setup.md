# Setting Up a Custom Overlord Instance

You just forked Open Overlord and want to stand up your own instance. This guide
is the ordered list of questions to answer **before** you write backend config,
pick a database, point the CLI at a backend URL, or run a migration. Work top to
bottom: each answer narrows the next decision.

It serves two audiences:

- **A developer** configuring their own instance — read the questions, record
  your answers, and copy the matching `overlord.toml` from
  [Worked Configurations](#worked-configurations).
- **An agent** asked "set Overlord up for me" — this is the interview script.
  Ask Q1–Q10 in order, confirm the answers, then write the config and run
  migrations. Never run migrations before confirming Q2 (database) and Q6
  (schema groups).

The two decisions that drive everything else are **Q1 (how many people / where
state lives)** and **Q2 (which database)**. Get those right and the rest is
filling in fields.

> Reference material this guide is built on: the config schema
> (`cli/src/config.ts`), adapter selection (`database/src/adapter.ts`), the
> [database table-groups decision guide](../database/docs/10-database-table-groups.md),
> the [Private-Network PostgreSQL deployment plan](../database/docs/12-private-network-postgresql-deployment-plan.md),
> the [auth module](../auth/README.md), and the [connectors module](../connectors/README.md).

---

## Quick decision tree

```
Q1 Who uses it?
 ├─ Just me, one machine ........... local backend + SQLite, core tables
 ├─ A small team (2–5) ............. PostgreSQL, + auth/audit groups
 └─ An organization / runners ...... PostgreSQL service deployment, all groups

Q2 Database follows from Q1:
 ├─ SQLite  → local backend owns the SQLite file
 └─ Postgres → hosted/backend service owns DATABASE_URL

CLI target:
 ├─ Local backend → ovld config set local http://127.0.0.1:4310
 └─ Hosted backend → ovld config set cloud https://overlord.example.com
```

---

## The questions, in order

### Q1 — How many people (and machines) will use this instance, and where does the authoritative state live?

This is the root decision; everything else hangs off it.

| Answer | What it implies |
| --- | --- |
| **Just me, on one workstation** | SQLite behind a local backend is the right default. State is local application state. CLI-first; web app optional. |
| **A small team (≈2–5), shared org** | PostgreSQL from the start. State is shared organization state, not a local file. Add auth + audit schema groups. |
| **An organization with remote/distributed runners** | PostgreSQL behind an Overlord service process on a private network; clients and runners call the protocol/REST layer, never the DB directly. All schema groups in play. |

> **Rule of thumb:** the moment more than one machine needs to write the same
> state, you have crossed out of SQLite territory. Sharing a SQLite file across
> machines couples correctness to filesystem locking — don't.

### Q2 — Which database: SQLite or PostgreSQL?

Follows directly from Q1. The backend selects the adapter at runtime in
`resolveAdapter()`. The published CLI does not select a database adapter; it
selects a backend URL.

- If `DATABASE_URL` is set to a `postgres://` / `postgresql://` connection
  string → **PostgreSQL**.
- Otherwise → **SQLite** at the resolved `database_path`.

| Choose | When | How you configure it |
| --- | --- | --- |
| **SQLite (default local backend)** | Solo dev, single host, offline drafts, local cache, test fixtures, zero-setup MVP | Run Desktop/local backend. Leave backend `DATABASE_URL` unset. Optionally set backend-owned `database_path` / `OVERLORD_SQLITE_PATH`. Point the CLI at it with `ovld config set local`. |
| **PostgreSQL** | Shared/team/org state, multiple writers, distributed runner queue claiming (`FOR UPDATE SKIP LOCKED`), auditability, network-addressable DB | Configure the backend service with `DATABASE_URL=postgres://user:pass@host:5432/overlord`. Point the CLI at the service with `ovld config set cloud <url>`. |

Notes:

- The schema is portable: the same logical contract is implemented for both
  adapters, so you can prototype on SQLite and move to Postgres later.
- For Postgres, also pass the same DB to the auth layer — Better Auth and the
  Overlord identity bridge must use the same database
  (`createAuth({ database: { type: 'postgres', connectionString: process.env.DATABASE_URL } })`).

### Q3 — What is this instance called, and what host/port should it use?

These are the plain identity/networking fields of `overlord.toml`:

| Question | Field | Default | Notes |
| --- | --- | --- | --- |
| What should the instance/org be named? | `instance_name` | `"Local Overlord"` | Shown in the UI/CLI. |
| What backend should the CLI call? | `backend_url` | `http://127.0.0.1:4310` | Stored by `ovld config`; local points at Desktop/local backend, cloud points at a hosted backend. |
| Where does the SQLite file live? | backend-owned `database_path` | backend default | Consumed by local/backend packages, not by the published CLI. Ignored when backend `DATABASE_URL` is set. |
| What address should the web app bind to? | `web_host` | `127.0.0.1` | Use `0.0.0.0` only behind a trusted network/VPN, never raw on the public internet. |
| What port for the web app? | `web_port` | `4310` | Started via `ovld serve`. |

### Q4 — Will you use the web app, or stay CLI-only?

Open Overlord is CLI-first; the web app is a secondary surface.

- **CLI-only** → you can ignore `web_host`/`web_port` beyond their defaults and
  skip the realtime schema groups (Q6, Group 6/7).
- **Web app / desktop client** → you'll run `ovld serve`, and you should plan
  for the realtime client-registry and side-effect groups (Q6). If the web app
  is multi-user, that also pulls in auth (Q5).

### Q5 — Who can do what? (authentication + roles)

The local CLI-first MVP runs in **implicit full-trust mode** — no tokens, no
roles required. You add auth the moment a second human or an external caller
appears.

Ask, in order:

1. **Will more than one human use this workspace?** If yes → you need roles
   (`role_assignments`).
2. **Will any external tool, script, or service call the REST API, or any
   long-lived agent account need a credential?** If yes → you need API tokens
   (`user_tokens`, `user_token_scopes`).
3. **Do you have compliance/forensic needs (who approved/denied what)?** If yes
   → add the audit trail (`audit_log`).

Roles come from `openoverlord.rbac.toml` (copy and edit to customize):

- `ADMIN` — full instance administrator (`grants = ["*"]`).
- `MEMBER` — standard user or persistent agent account (scoped grants:
  `mission:*`, `objective:*`, `session:*`, etc.).
- `PUBLIC` — unauthenticated read access (images only by default).

> For a multi-user instance, assume every human/agent user needs at least
> `ADMIN` or `MEMBER`. Authentication and authorization are mix-and-match: you
> can swap the token mechanism without touching RBAC, and replace the
> authorization provider without touching token storage.

### Q6 — Which schema groups do you install now?

Every install gets the **core tables** (workspaces, projects, missions,
objectives, sessions, events, shared context, queue, change feed). Beyond that,
schema is à la carte — and **any group can be added later with additive-only
migrations**, so when in doubt, defer. The
[table-groups decision guide](../database/docs/10-database-table-groups.md) is
authoritative; the short version:

| If you answered "yes" to… | Add group(s) |
| --- | --- |
| Multiple users / REST API tokens (Q5) | **Group 1** — Multi-User Access & API Tokens |
| Compliance / forensic logging (Q5) | **Group 2** — Security Audit Trail (pairs with Group 1) |
| Async background work (cleanup, notifications, draining the outbox) | **Group 3** — Background Jobs |
| Custom harness extensions, connector health (`doctor`) dashboards, permission-approval UI | **Group 4** — Connector Extensions & Monitoring (pairs with Group 3) |
| Custom mission labels/tags | **Group 5** — Mission Tagging |
| Web/desktop client with cursor-resuming live updates | **Group 6** — Realtime Client Registry |
| Guaranteed side-effect delivery (webhooks, search reindex, blob deletion) | **Group 7** — Reliable Side-Effect Delivery (pairs with Group 3) |
| Ranked full-text mission search | **Group 8** — Full-Text Search |

Confirm the final group selection **before** running migrations. Never remove
core tables.

### Q7 — Which agent(s) and model(s) are the default?

These drive the web app "run" button and the bundled agent catalog.

| Question | Field | Default |
| --- | --- | --- |
| Default agent for new objectives? | `default_agent` | `"claude"` |
| Default model (optional)? | `default_model` | unset (commented out) |
| Do you want to customize which agents/models are offered? | `[agent_catalog.*]` tables | bundled defaults |

The optional `[agent_catalog]` section is merged over the bundled defaults on
first seed/refresh — use it to add models, change labels, or gate availability.
Example:

```toml
[agent_catalog.claude]
label = "Claude Code"
available_by_default = true
reasoning_label = "Thinking"

[[agent_catalog.claude.models]]
id = "claude-sonnet-4-6"
display_name = "Sonnet 4.6"
reasoning_options = ["low", "medium", "high"]
```

### Q8 — Which agent harnesses will connect, and how do they launch?

Overlord connects to harnesses (Claude Code, Codex, Cursor, …) through
**connectors**. After the instance exists, you install connectors per harness:

- Run `ovld agent-setup <agent>` to install a connector bundle into a harness.
- Run `ovld doctor` to verify what's installed and at what version.
- The runner (and `ovld launch`) can open agents in a new terminal window. Configure
  terminal settings during `ovld setup`; they are stored on
  `user_execution_target_preferences.terminal_profile_json` for this user's
  local target fingerprint (auto-provisioned from the device fingerprint). Built-in
  macOS launchers `"iTerm2"` and `"Terminal"` open a fresh window in the project
  directory; any other launcher value is treated as a prefix command. After
  choosing a terminal, setup also asks whether agents open in a **new window**
  (default), a **new tab**, or a **split pane** via a typed keyboard shortcut
  (for example `cmd+d` — type it during setup, do not press it).

  Override per launch with `ovld launch <agent> --terminal "Terminal"`, or force
  an inline (current-terminal) launch with `--no-terminal`. When the stored
  profile uses inline launch, the agent runs in the current terminal.
  Split-pane placement for iTerm2 uses native AppleScript splits for `cmd+d` and
  `cmd+shift+d`; other terminals receive the shortcut through System Events.

### Q9 — Do you want the local SQL inspector?

`sql-studio` is an optional local database browser, off by default.

| Question | Field | Default |
| --- | --- | --- |
| Enable SQL Studio? | `sql_studio_enabled` | `false` |
| Host / port for it? | `sql_studio_host` / `sql_studio_port` | `127.0.0.1` / `4311` |
| Binary name/path? | `sql_studio_binary` | `"sql-studio"` |

Leave it disabled for shared/production instances; enable it only for local
inspection.

### Q10 — Where will objectives actually run? (devices & execution targets)

For a solo local instance the answer is "this machine," and you can move on. If
you plan to run objectives on remote workstations or cloud runners, you'll
configure devices/execution targets and (for distributed claiming) you need
PostgreSQL from Q2 plus the service deployment from
[doc 12](../database/docs/12-private-network-postgresql-deployment-plan.md).
Clients and runners must claim work through the service layer, never by writing
the database directly.

---

## Worked Configurations

### A. Solo developer, local backend (SQLite)

Answers: Q1 just me · Q2 SQLite · Q4 CLI-only · Q5 no auth · Q6 core only.

```toml
# overlord.toml
instance_name = "Local Overlord"
backend_mode = "local"
backend_url = "http://127.0.0.1:4310"
web_host = "127.0.0.1"
web_port = 4310
sql_studio_enabled = false
sql_studio_host = "127.0.0.1"
sql_studio_port = 4311
sql_studio_binary = "sql-studio"
default_agent = "claude"
# default_model = ""
```

No backend `DATABASE_URL`. Desktop/local backend owns SQLite and migrations:
core only. The CLI points at that backend with `ovld config set local`.

### B. Small team, shared instance (PostgreSQL)

Answers: Q1 small team · Q2 Postgres · Q4 web app · Q5 multi-user + tokens +
audit · Q6 core + Groups 1, 2, 5.

```toml
# overlord.toml
instance_name = "Acme Overlord"
backend_mode = "cloud"
backend_url = "https://overlord.acme.example"
web_host = "0.0.0.0"          # behind VPN/private network only
web_port = 4310
sql_studio_enabled = false
sql_studio_host = "127.0.0.1"
sql_studio_port = 4311
sql_studio_binary = "sql-studio"
default_agent = "claude"
```

```bash
# backend service environment
export DATABASE_URL="postgres://overlord:***@db.internal:5432/overlord"
# optional: export OVERLORD_PG_SCHEMA="overlord"
```

Migrations: core + Group 1 (auth/tokens) + Group 2 (audit) + Group 5 (tagging).
Copy `openoverlord.rbac.toml` and grant each user `ADMIN` or `MEMBER`.

### C. Organization with distributed runners (PostgreSQL service)

Answers: Q1 org/runners · Q2 Postgres · Q4 web app · Q5 full auth + audit · Q6
all groups · Q10 remote execution targets.

Same `overlord.toml` shape as B, plus: run a dedicated Overlord service process
next to the database, put clients/runners on the private network/VPN, use TLS,
configure backups + a tested restore path, and add connection pooling as
client/runner count grows. Follow the
[Private-Network PostgreSQL deployment plan](../database/docs/12-private-network-postgresql-deployment-plan.md)
end to end. Adopt schema groups in this order: core → 1+2 → 3 → 7 → 6 → 4 → 5 →
8.

---

## Agent setup checklist

If you are an agent asked to "set Overlord up," confirm these before writing
files or running migrations:

1. **Q1/Q2** — number of users + machines → database (SQLite vs Postgres). *Block
   on this; don't guess.*
2. **Q3** — `instance_name`, CLI `backend_url`, backend `database_path`
   (SQLite) or backend `DATABASE_URL` (Postgres), `web_host`, `web_port`.
3. **Q4** — web app or CLI-only.
4. **Q5** — multi-user? external API callers? compliance? → which auth/RBAC.
5. **Q6** — confirm the exact schema group list, then run migrations. *Never
   migrate before this is confirmed.*
6. **Q7** — `default_agent` / `default_model` / `[agent_catalog]`.
7. **Q8** — which harness connectors to `ovld agent-setup`, plus terminal profile setup for the local execution target.
8. **Q9** — SQL Studio on/off.
9. **Q10** — local-only or remote execution targets.

Then: write `overlord.toml`, set environment variables, copy/edit
`openoverlord.rbac.toml` if multi-user, run migrations for the confirmed groups,
`ovld agent-setup <agent>` the chosen connectors, and `ovld doctor` to verify.

> Any à la carte schema group can be added later with additive-only migrations,
> so prefer the minimal set now and grow into the rest.
