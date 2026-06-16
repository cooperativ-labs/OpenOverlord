# Getting Started with Overlord

This guide walks you from a fresh `ovld` install to your first completed agent
ticket in about ten minutes.

**What you'll have by the end:**

- A running local Overlord instance
- A project linked to a git repository
- An agent connector installed in your harness (Claude Code, Codex, or Cursor)
- A delivered ticket with change rationales you can inspect

---

## Prerequisites

- **Node.js 20+** (needed to run the CLI)
- **`ovld` installed** — install from the published tarball or build from source:

  ```bash
  # From a release tarball
  npm install -g open-overlord-cli-<version>.tgz

  # From source (builds the CLI, then symlinks or adds to PATH)
  yarn build:cli
  node cli/bin/ovld.mjs version   # smoke-test: prints the version
  ```

- **A git repository** you want Overlord to manage work in (can be any project)

---

## Step 1 — Initialize your instance

Run this once, in the directory that will hold your Overlord config:

```bash
ovld init
```

`init` writes `overlord.toml` next to where you run it and creates the local
SQLite database (`database/.local/Overlord.sqlite` by default). The defaults
are sensible for a solo developer:

```toml
# overlord.toml (created by ovld init)
instance_name = "Local Overlord"
database_path = "database/.local/Overlord.sqlite"
web_host      = "127.0.0.1"
web_port      = 4310
default_agent = "claude"
```

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

A **project** is Overlord's container for tickets. It knows which git repository
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

## Step 3 — Install an agent connector

Connectors let your AI harness (Claude Code, Codex, Cursor, …) speak the
Overlord protocol and receive ticket context automatically.

```bash
# See what connectors are available
ovld setup

# Install the Claude Code connector
ovld setup claude

# Install all supported connectors at once
ovld setup all

# Verify the install
ovld doctor
```

The connector installs a plugin into the harness and wires up the
`UserPromptSubmit` hook so ticket context is injected at prompt time. You only
need to do this once per harness; re-running `ovld setup <agent>` repairs or
updates it.

---

## Step 4 — Create your first ticket

A **ticket** is a unit of work. It holds one or more sequential **objectives**,
each of which maps to one agent session. Create a ticket with a single
objective:

```bash
# Simple one-objective ticket
ovld create "Add a user-facing error message when the upload fails"

# Multi-objective ticket (plan then implement)
ovld create "Refactor the auth middleware" \
  --objectives-json '[
    {"objective": "Draft a plan for the auth middleware refactor"},
    {"objective": "Implement the refactor per the plan"}
  ]'
```

The command prints the ticket ID (e.g. `1:1042`). You can also list tickets:

```bash
ovld tickets list --status next-up,execute
```

---

## Step 5 — Launch an agent on the ticket

```bash
ovld launch claude --ticket-id 1:1042
```

This opens a terminal window with Claude Code pointed at your repository, with
the ticket context pre-loaded. The agent will attach (`ovld protocol attach`),
do the work, post progress updates, and deliver when done.

> **Tip:** `ovld runner start` keeps a background process that claims tickets
> from the queue automatically — useful when you have many tickets to run
> through.

---

## Step 6 — Review the results

Once the agent delivers, inspect what it produced:

```bash
# Read the delivery summary
ovld ticket deliveries 1:1042

# See all file changes with rationale
ovld changes rationales --ticket-id 1:1042

# Diff the exact changes
ovld changes diff --ticket-id 1:1042

# Full ticket context (history, shared state, artifacts)
ovld ticket context 1:1042
```

The change rationales explain what each file change does and why — an audit
trail that lives alongside the diff.

---

## Step 7 — Open the web app (optional)

```bash
ovld serve
```

This starts the Overlord web app at `http://127.0.0.1:4310` — a Kanban board
where you can create, edit, and launch tickets without using the CLI.

---

## Step 8 — Inspect the database with SQL Studio (optional)

Overlord can launch [SQL Studio](https://github.com/frectonz/sql-studio), an
external local database browser, alongside the web app so you can inspect your
Overlord database directly. It is **off by default** — you opt in per instance.

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
| Understand the core data model (projects, tickets, objectives, sessions) | [Core Concepts](../README.md#core-concepts) |
| Write a custom connector for a different harness | [Connectors Module](../connectors/README.md) |
| Understand the full `ovld protocol` command surface | `ovld protocol help` |
