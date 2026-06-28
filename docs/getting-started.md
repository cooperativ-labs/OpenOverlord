# Getting Started with Overlord

This guide walks you from a fresh `ovld` install to your first completed agent
mission in about ten minutes.

**What you'll have by the end:**

- A running local Overlord instance
- A project linked to a git repository
- An agent connector installed in your harness (Claude Code, Codex, or Cursor)
- A delivered mission with change rationales you can inspect

---

## Prerequisites

- **Node.js 20+** (needed to run the CLI)
- **A running Overlord backend**:
  - Local mode: run the Desktop app or a local backend listening on
    `http://127.0.0.1:4310`.
  - Cloud mode: use the URL for a hosted Overlord backend.
- **`ovld` installed** — install from the published tarball or build from source:

  ```bash
  # From a release tarball
  npm install -g --no-fund open-overlord-<version>.tgz

  # From source (builds the CLI, then symlinks or adds to PATH)
  yarn build:cli:prod
  node cli/bin/ovld.mjs version   # smoke-test: prints the version
  ```

- **A git repository** you want Overlord to manage work in (can be any project)

---

## Step 1 — Point `ovld` at a backend

Run this after installing the CLI:

```bash
ovld auth login
```

`auth login` verifies that the CLI has a backend URL. If not, it walks you
through `ovld config` first. Local mode defaults to the Desktop/local backend at
`http://127.0.0.1:4310`; cloud mode stores the hosted backend URL.

You can configure the backend non-interactively:

```bash
# Local Desktop/local backend
ovld config set local
ovld config set local http://127.0.0.1:4310

# Hosted backend
ovld config set cloud https://overlord.example.com
```

The resulting `overlord.toml` stores the backend target:

```toml
instance_name = "Local Overlord"
backend_mode = "local"
backend_url = "http://127.0.0.1:4310"
default_agent = "claude"
```

The published npm CLI does not create or migrate SQLite. SQLite lives behind the
Desktop/local backend; Postgres lives behind a hosted backend.

> **Setting up a team or custom instance?** See
> [Setting Up a Custom Overlord Instance](custom-instance-setup.md) for
> the full decision guide (database choice, schema groups, `overlord.toml`
> fields, and multi-user auth).

Verify everything looks good:

```bash
ovld doctor
ovld config list
```

---

## Step 2 — Create a project and link it to your repo

A **project** is Overlord's container for missions. It knows which git repository
holds the work and which local directory to use when launching an agent.

```bash
# Create a project and point it at your repo directory
ovld create-project --name "My App" --directory /path/to/your/repo

# If you are already inside the repo directory, link it to the project
ovld add-cwd --primary true
```

Overlord stores a `.overlord/project.json` file in the linked directory so
future commands can resolve the project automatically.

---

## Step 3 — Configure Overlord

Run the guided setup to choose a local or cloud backend, configure agent
connectors, and pick the default terminal used for launched agents:

```bash
ovld setup
```

For local mode, setup asks whether the Desktop app is installed. If it is not,
it prints the latest Desktop download URL before writing the local backend URL.

---

## Step 4 — Install or repair an agent connector directly

Connectors let your AI harness (Claude Code, Codex, Cursor, …) speak the
Overlord protocol and receive mission context automatically.

```bash
# See what connectors are available
ovld agent-setup

# Install the Claude Code connector
ovld agent-setup claude

# Install all supported connectors at once
ovld agent-setup all

# Verify the install
ovld doctor
```

The connector installs a plugin into the harness and wires up the
`UserPromptSubmit` hook so mission context is injected at prompt time. You only
need to do this once per harness; re-running `ovld agent-setup <agent>` repairs
or updates it.

---

## Step 5 — Create your first mission

A **mission** is a unit of work. It holds one or more sequential **objectives**,
each of which maps to one agent session. Create a mission with a single
objective:

```bash
# Simple one-objective mission
ovld create "Add a user-facing error message when the upload fails"

# Multi-objective mission (plan then implement)
ovld create "Refactor the auth middleware" \
  --objectives-json '[
    {"objective": "Draft a plan for the auth middleware refactor"},
    {"objective": "Implement the refactor per the plan"}
  ]'
```

The command prints the mission ID (e.g. `1:1042`). You can also list missions:

```bash
ovld missions list --status next-up,execute
```

---

## Step 6 — Launch an agent on the mission

```bash
ovld launch claude --mission-id 1:1042
```

This opens a terminal window with Claude Code pointed at your repository, with
the mission context pre-loaded. The agent will attach (`ovld protocol attach`),
do the work, post progress updates, and deliver when done.

> **Tip:** `ovld runner start` keeps a background process that claims missions
> from the queue automatically — useful when you have many missions to run
> through.

---

## Step 7 — Review the results

Once the agent delivers, inspect what it produced:

```bash
# Read the delivery summary
ovld mission deliveries 1:1042

# See all file changes with rationale
ovld changes rationales --mission-id 1:1042

# Diff the exact changes
ovld changes diff --mission-id 1:1042

# Full mission context (history, shared state, artifacts)
ovld mission context 1:1042
```

The change rationales explain what each file change does and why — an audit
trail that lives alongside the diff.

---

## Step 8 — Open the web app (optional)

```bash
yarn dev
```

From a source checkout, this starts the local web/API backend at
`http://127.0.0.1:4310` — a Kanban board where you can create, edit, and launch
missions without using the CLI. In a packaged install, Desktop owns starting and
supervising the local backend.

### Checkout-local features (Desktop vs browser)

Repository browsing, `@` mentions, branch lists, branch actions, and worktree
management run **on your machine** — not on the hosted control plane. For the
full product experience, use **Overlord Desktop** (Electron). The desktop shell
exposes `window.overlord.invokeLocalTarget`, which routes git/fs work through the
same capability bodies as the CLI.

| Surface | Postgres (Cloud) | Loopback SQLite (local dev) |
| --- | --- | --- |
| **Overlord Desktop** | Full checkout/git via IPC bridge | Full checkout/git via IPC bridge |
| **Browser only** | Degraded — control-plane metadata only; UI shows `LocalTargetRequiredNotice` where git is needed | Degraded by default; optional dev proxy (below) |

The web app reads `GET /api/meta` → `capabilities.localTarget` to decide whether
a browser session can call the server's in-process dev proxy:

| Value | Meaning |
| --- | --- |
| `unavailable` | No server-side checkout proxy. Use Desktop, or (SQLite only) enable the dev flag below. |
| `in_process_server` | Opt-in dev fallback: browser may `POST /api/local-target/invoke` on loopback SQLite only. |

**Browser-only local dev (contributors):** when running `yarn dev` against
loopback SQLite, you can enable the in-process server proxy without Electron:

```bash
# In repo-root .env.local (or export before starting the server)
OVERLORD_DEV_IN_PROCESS_LOCAL_TARGET=true
```

Then restart the web/API server. This path is **for local development only** —
it is disabled on Postgres backends and is not a substitute for Desktop in
production or Cloud workspaces.

---

## Step 9 — Inspect the database with SQL Studio (optional)

The local backend can launch [SQL Studio](https://github.com/frectonz/sql-studio),
an external local database browser, alongside the web app so you can inspect
the local Overlord database directly. It is **off by default** — you opt in per
instance.

**1. Install the `sql-studio` binary.** It is a standalone tool, not bundled
with Overlord. Install it via its release script or with Cargo, then confirm it
is on your `PATH`:

```bash
# Release install script (see the project README for the latest command)
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/frectonz/sql-studio/releases/latest/download/sql-studio-installer.sh | sh

# …or with Cargo
cargo install sql-studio

# Confirm it resolves
sql-studio --version
```

**2. Enable it in `overlord.toml`.** Add (or flip) these keys next to your
existing config:

```toml
sql_studio_enabled = true
sql_studio_host     = "127.0.0.1"
sql_studio_port     = 4311
sql_studio_binary   = "sql-studio"   # name on PATH, or an absolute path
```

| Setting | `overlord.toml` key | Env override | Default |
| --- | --- | --- | --- |
| Enable SQL Studio | `sql_studio_enabled` | `OVERLORD_SQL_STUDIO_ENABLED` | `false` |
| Bind host | `sql_studio_host` | `OVERLORD_SQL_STUDIO_HOST` | `127.0.0.1` |
| Bind port | `sql_studio_port` | `OVERLORD_SQL_STUDIO_PORT` | `4311` |
| Binary name or path | `sql_studio_binary` | `OVERLORD_SQL_STUDIO_BINARY` | `"sql-studio"` |

**3. Activate it.** SQL Studio starts as part of the web app, so just (re)start
the server:

```bash
ovld serve
```

On startup you'll see a `[sql-studio] launching http://127.0.0.1:4311` line, and
the web app sidebar shows an **Open SQL Studio** button that opens the browser
pointed at your Overlord SQLite database. If the binary can't be found, the
server logs a warning and keeps running without it — fix the install or
`sql_studio_binary` path and restart.

> **Keep it local.** Leave SQL Studio disabled on shared or production
> instances; it is meant for local inspection only.

---

## What's next

| Goal | Where to look |
| --- | --- |
| Fork Overlord and stand up a custom instance | [Setting Up a Custom Overlord Instance](custom-instance-setup.md) |
| Keep up with upstream changes in a customized fork | [Adopting Upstream Changes](upstream-adoption.md) |
| Understand the core data model (projects, missions, objectives, sessions) | [Core Concepts](../README.md#core-concepts) |
| Write a custom connector for a different harness | [Connectors Module](../connectors/README.md) |
| Understand the full `ovld protocol` command surface | `ovld protocol help` |
