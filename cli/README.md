# CLI Module

The `ovld` command-line surface — Overlord's primary, CLI-first product.
This module is the home for everything a user or agent invokes as `ovld …`.

## Table of Contents

- [For Users](#for-users)
  - [Setup](#setup)
  - [First run](#first-run)
  - [How the published CLI works](#how-the-published-cli-works)
  - [Point the CLI at a backend](#point-the-cli-at-a-backend)
  - [Headless / container setup](#headless--container-setup)
  - [What requires the backend](#what-requires-the-backend)
- [For Developers](#for-developers)
  - [Contract Components](#contract-components)
  - [Documentation](#documentation)
  - [Code & Tests](#code--tests)
  - [In-repo build vs installed CLI](#in-repo-build-vs-installed-cli)
  - [Interaction Boundaries](#interaction-boundaries)

## For Users

### Setup

The CLI is **client-only**. Management commands, protocol sessions, and runner
queue operations all reach persistence through the backend URL you configure — only
`help` and `version` work without one. First-time setup is about **pointing
`ovld` at a backend** and verifying it is reachable.

### First run

Install the published package:
```bash
npm install -g --no-fund open-overlord
```

After installing the published package:

```bash
ovld auth login
```

Login verifies that a backend is configured. If none is set yet, it walks through
`ovld config` first — local setup offers `http://127.0.0.1:4310` as the default
backend URL; cloud setup accepts a hosted backend URL.

Then confirm the connection and continue with projects, missions, and agents:

```bash
ovld doctor
ovld config list
```

See [Getting Started](../docs/getting-started.md) for the full walkthrough from
install through first delivered mission.

### How the published CLI works

The npm package ships command parsing, config/auth onboarding, connector setup,
an HTTP backend client, and the local runner/agent launcher. It does **not** ship
SQLite, `better-sqlite3`, migrations, or the service-layer database runtime.

```mermaid
flowchart LR
  cli["ovld npm CLI"] -->|"HTTP /api/*"| local["Desktop or local backend"]
  cli -->|"HTTP /api/*"| cloud["Hosted backend"]
  local --> sqlite["SQLite"]
  cloud --> postgres["Postgres"]
  cli -->|"spawn"| agent["Local agent CLI"]
```

Local mode means `ovld` talks to a backend already running on your machine,
normally Desktop or a future db-only local backend. Cloud mode means `ovld`
talks to a hosted Overlord backend. In both modes, the backend owns persistence
and migrations; the CLI is a client of that backend.

### Point the CLI at a backend

Configuration lives in `overlord.toml` — a per-instance, uncommitted file
(gitignored; generate it with `ovld init`, or copy `overlord.toml.example`),
discovered from the current directory upward, or in `~/.ovld/overlord.toml` for a
global install.

| Mode | Config key | How to set it |
| ---- | ---------- | ------------- |
| **Local backend** | `backend_url` | `ovld config set local [url]` — defaults to `http://127.0.0.1:4310` |
| **Hosted backend** | `backend_url` | `ovld config set cloud <url>` |

`ovld config set` without arguments opens the interactive backend selector.
`ovld config list` shows the resolved target; `ovld doctor` checks that the
backend is reachable.

Environment overrides (useful in scripts and CI):

- `OVLD_HOME` — relocate the entire global `~/.ovld` data directory (SQLite, object storage, VCS baselines, native-session caches)
- `OVERLORD_BACKEND_URL` — production/global backend target; an *explicit* runtime value (shell export, container/launcher injection) takes precedence over the resolved `overlord.toml` `backend_url`
- `OVERLORD_BACKEND_URL_DEV` — **development-only** backend target, read solely by the in-repo source build and the dev/test tooling that runs it (`yarn dev`, the test harness). An installed/published `ovld` never reads it, and nothing aliases it into the production `OVERLORD_BACKEND_URL`
- `OVERLORD_WEB_PORT` — port the local backend binds when launched
- `OVERLORD_USER_TOKEN` / `OVLD_USER_TOKEN` / `USER_TOKEN` — bearer token sent to the backend when set (checked in that order; takes precedence over stored credentials)
- `DATABASE_URL` — Postgres connection string read by a backend you run yourself (service layer + Better Auth); the client-only CLI does not open it

Each `ovld` invocation resolves its own config and backend target
independently — it is **not** a single shared connection. Resolution order,
highest precedence first: an explicit runtime export of the channel variable
(`OVERLORD_BACKEND_URL`, or `OVERLORD_BACKEND_URL_DEV` for the dev build) set
before the CLI loads any env file → the per-instance `overlord.toml` `backend_url`
(what `ovld config set` writes) → the env-file default next to that `overlord.toml`
(`OVERLORD_BACKEND_URL_DEV` from `.env.local` for the source/dev build,
`OVERLORD_BACKEND_URL` from `.env.prod` for production/package builds) → a
hardcoded fallback. `overlord.toml` is a per-instance, **uncommitted** file
(gitignored like `.env.*`; generate it with `ovld init` / `ovld config set`, see
`overlord.toml.example`), so there is no shared config file to keep host-neutral.
A context-specific target — a Docker-internal host alias, another machine's
address — belongs in an explicit `OVERLORD_BACKEND_URL` set when that process is
launched. The dev-only `OVERLORD_BACKEND_URL_DEV` is read **only** by the source
build; an installed `ovld` resolves as production and ignores it (and `.env.local`)
even inside a dev checkout.

The local backend/Desktop package owns SQLite and migrations. The published npm
CLI only stores the backend URL and sends HTTP requests.

### Desktop and CLI authentication

Both the desktop app and the CLI authenticate to `/api/*` with a bearer token:

- **Session bearer** — from `ovld auth login` (username/password) or a desktop
  sign-in on the **local** backend. Stored in `~/.ovld/auth.json` for the CLI
  and in the desktop shell's encrypted settings for each backend profile.
- **USER_TOKEN** (`out_…`) — long-lived token from Settings → Tokens. Works for
  headless/CI use via `OVERLORD_USER_TOKEN` or `ovld auth login --token`.

For the **local** backend, desktop and CLI share `~/.ovld/auth.json`:

- Signing in through the desktop app writes the session bearer to `auth.json`, so
  `ovld` can use the same credentials without a second login.
- Running `ovld auth login` for the local backend writes `auth.json`; the desktop
  app imports that token on the next launch (or when switching back to Local) if
  it has no saved session for that profile.

**Cloud backends are separate.** Adding or switching to a cloud backend in the
desktop app updates `~/.ovld/overlord.toml` with the new `backend_url`, but it
does **not** update CLI auth. After switching backends in either surface, run
`ovld auth status` to confirm the CLI is pointed at the same URL and still
logged in. If `credentialSource` is `stored_mismatch` or `loggedIn` is false, run
`ovld config set cloud <url>` (if needed) and `ovld auth login`.

When a stored CLI credential is rejected with HTTP 401, `ovld` clears
`auth.json` and tells you to run `ovld auth login` again.

### Headless / container setup

In a container, CI job, or any non-TTY environment, configure `ovld` entirely
through environment variables and non-interactive flags — no interactive prompts
are required. Each item below is a single command:

```bash
# 1. Database URL — Postgres persistence for a backend you run in the same
#    container (consumed by the service layer + Better Auth). Omit if the CLI
#    only talks to an already-running remote backend.
export DATABASE_URL="postgres://user:password@host:5432/overlord"

# 2. Backend URL — where the CLI sends HTTP /api/* requests.
export OVERLORD_BACKEND_URL="https://overlord.example.com"

# 3. Auth token — bearer USER_TOKEN sent with every backend request.
#    Generate one in Overlord Desktop: Settings > Tokens.
export OVERLORD_USER_TOKEN="out_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# 4. Agent connector — write the local agent connector config (non-interactive).
ovld agent-setup claude            # one of: claude | codex | cursor | all
```

Then verify the backend is reachable and authenticated:

```bash
ovld doctor
```

Notes for headless use:

- **No `ovld auth login` needed.** The token env vars (`OVERLORD_USER_TOKEN`,
  `OVLD_USER_TOKEN`, or `USER_TOKEN`) are read directly and take precedence over
  stored credentials. To persist a token to `~/.ovld/auth.json` instead, run the
  non-interactive `ovld auth login --token out_...` (works without a TTY).
- `ovld agent-setup` accepts `--home <dir>` to target a specific `OVLD_HOME`,
  `--dry-run` to preview, and `--json` for machine-readable output. List
  installable connectors with `ovld agent-setup --json`.
- Set `OVLD_HOME=/some/writable/dir` if the default `~/.ovld` is not writable in
  your container; it relocates the entire CLI data directory.
- Interactive `ovld auth login` / `ovld config set` (no args) and `ovld setup`
  require a TTY; use the env vars and explicit flags above in their place.

### What requires the backend

These commands work without a backend: `ovld help`, `ovld version`,
`ovld update`, `ovld config ...`, `ovld prune`, and connector setup/inspection commands that only touch local
files. `ovld update --check` compares the installed package version with the latest
published npm version, and `ovld update` upgrades the global `open-overlord`
install through npm. Commands that read or mutate Overlord state — projects, missions,
protocol calls, runner queue operations, and launch context assembly — call the
configured backend URL.

`ovld runner` is still local in the important sense: it claims work through the
backend API, then spawns the selected agent process on your machine in the
resolved project directory. The queue state remains in the backend.

## For Developers

### Contract Components

This module is the developer-facing home for three components defined in
[`CONTRACT.md`](../CONTRACT.md):

| Component      | Stable id  | What it owns                                                                                                                                                                        |
| -------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI Layer      | `cli`      | Management command names/shapes, project linking & discovery, config file locations (`overlord.toml`, `.overlord/project.json`), human-readable output conventions                  |
| Protocol Layer | `protocol` | `ovld protocol` subcommands and flags, session lifecycle (`attach → (update\|heartbeat)* → (ask\|deliver)`), context-assembly format, delivery payload + change-rationale recording |
| Runner Layer   | `runner`   | `execution_requests` queue claiming and launch, working-directory resolution, `ovld runner` commands, execution-target selection                                                    |

These stay distinct components in the contract (separate interaction surfaces
and ownership). They are grouped into one developer module because they are all
the `ovld` command surface and tend to be worked on together.

### Documentation

Requirements and behavior specs are colocated in this module's
[`docs/`](docs/) folder (see the root [README](../README.md#modules) for the
colocation convention):

- [06 — Core Domain and Lifecycle](docs/06-core-domain-and-lifecycle.md): projects, missions, objectives, sessions, events, statuses, state transitions.
- [02 — CLI-First Product Surface](docs/02-cli-first-product-surface.md): management commands, configuration, project linking, output contracts.
- [03 — Agent Protocol](docs/03-agent-protocol.md): `ovld protocol` lifecycle, context assembly, updates, delivery, attachments.
- [04 — Runner and Launch Execution](docs/04-runner-and-launch-execution.md): execution requests, local runner, launch command generation, auto-advance.
- [11 — Review, Artifacts, and Change Tracking](docs/11-review-artifacts-and-change-tracking.md): delivery review records, artifacts, rationale coverage, local diff support.
- [Test Plan](docs/testing.md): test plan for the `cli`, `protocol`, and `runner` components — management commands, protocol lifecycle/attach-shape/validation conformance, runner queue atomicity, and surface smoke tests. Part of the root [TEST_PLAN.md](../TEST_PLAN.md).

### Code & Tests

The packaged CLI lives in this module as a self-contained Yarn sub-project:

```bash
yarn build:cli:prod       # compile TypeScript to cli/dist/
yarn test:cli             # unit + subprocess smoke tests
yarn pack:cli:prod        # produce an installable tarball
node cli/bin/ovld.mjs version
```

Layout:

```
cli/
  bin/ovld.mjs            # published bin entry (imports compiled dist/)
  src/                    # TypeScript implementation
  dist/                   # build output (gitignored)
  test/                   # colocated tests, including cli/test/e2e/
  package.json            # bin map, build scripts, pack metadata
```

The CLI ships command parsing, config/auth onboarding, connector setup, backend
client calls, and local runner/agent launch logic. Run `yarn build:cli:prod` before using
the compiled CLI (`node cli/bin/ovld.mjs …`).

### In-repo build vs installed CLI

Project-management work (`ovld protocol attach/update/deliver`, mission creation,
launching) uses the **installed** `ovld` so those calls hit the installed
Desktop instance and real mission data. Bare `ovld` on `PATH` always resolves to
the global install — keep it that way.

The two builds also choose their env profile by origin (`detectCliEnvProfile`):
the **installed** CLI (under `node_modules`) runs as **production** — it never
auto-loads `.env.local` or reads `OVERLORD_BACKEND_URL_DEV`, even when invoked
inside this repo — while the **source** build (`node cli/bin/ovld.mjs`, `yarn
ovld:dev`, the test harness) runs as **development** and reads `.env.local`. So
in-repo dev work must go through the source build, never bare `ovld`.

Testing in-repo CLI/Desktop changes must never touch the installed instance
(`~/.ovld`, `:4310`). Copy `.env.local.example` to `.env.local` so source
workflows use a repo-local dev home (`database/.local/dev-home`) and API on
`:4320` while Desktop keeps `~/.ovld` and `:4310`.

- `yarn dev` / `yarn db:*` / `yarn ovld:dev` read `.env.local` and share the
  persistent in-repo dev instance.
- `yarn test` runs under `scripts/with-ovld-home.mjs` with a throwaway temp
  home so tests never read or write `~/.ovld` or the dev-home database.

For a one-off isolated shell without `.env.local`:

```bash
export OVLD_HOME="$(mktemp -d)"
export OVERLORD_WEB_PORT=4320
export OVERLORD_BACKEND_URL_DEV=http://127.0.0.1:4320
yarn workspace @overlord/webapp start
node cli/bin/ovld.mjs doctor
```

**Never `yarn link` / `npm link` the workspace CLI** (there is deliberately no
`load:cli` script): linking shadows the global `ovld`, so `ovld protocol` calls
would run untested working-tree code against your real mission data.

### Interaction Boundaries

Per the contract, the CLI/protocol/runner surfaces reach persistence only
through the configured **REST/backend API** — never direct table writes.
See the Interaction Surfaces section of [`CONTRACT.md`](../CONTRACT.md) before
making any cross-module change.
