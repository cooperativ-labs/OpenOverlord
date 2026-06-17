# CLI First Product Surface

## Goal

Make Overlord usable from the terminal before the web app exists. Every core workflow should have a CLI path, and later UI work should call the same underlying operations.

## Command Groups

### General Commands

Requirements:

- `ovld help`: print top-level command help.
- `ovld version`: print CLI and local runtime version.
- `ovld doctor`: validate backend reachability, connector installs, supported agent binaries, project metadata, and common permission/path problems.
- `ovld serve [--host <h>] [--port <p>] [--db <path>] [--json]`: local/backend-package command, not required in the published npm CLI. It boots the web/REST server that owns SQLite for local mode. The desktop app can ship and supervise this backend; a future db-only/local backend app may do the same.
- `ovld update [--check] [--force] [--json]`: check npm for the latest published `open-overlord` version and, unless `--check` is passed, update the globally installed CLI via `npm install -g open-overlord@latest`.

### Configuration Commands

Requirements:

- `ovld init`: create or update `overlord.toml` with the default local backend URL.
- `ovld auth login`: first-run onboarding for the CLI. It verifies that a backend
  URL is configured before any login step. If not, it presents the `ovld config`
  backend selector first.
- `ovld config get/set/list`: inspect and update local configuration. `ovld
config set` opens the interactive backend selector; `ovld config set local
[url]` points the CLI at a local backend URL (default
  `http://127.0.0.1:4310`); `ovld config set cloud <url>` points it at a hosted backend URL.
- `ovld user-token create/list/rotate/revoke/rename`: manage user-owned non-interactive credentials once the `USER_TOKEN` module is enabled.
- `ovld create-project --name "<name>" [--directory <path>|--no-directory]`: create a project and optionally register the current directory.
- `ovld add-cwd [--directory <path>] [--project-id <id-or-name>] [--primary true|false]`: link a checkout to a project. When `--project-id` is omitted on an interactive terminal, lists your projects and prompts you to pick one; non-interactively it falls back to the discovered or most recent project.
- `ovld protocol discover-project [--working-directory <path>] [--project-id <id-or-name>]`: resolve the project for a path or explicit project.

### Ticket Commands For Humans

Requirements:

- `ovld create "<objective>"`: create a draft ticket/objective from a prompt-like string.
- `ovld create --objectives-json '[{"objective":"..."}]'`: create one ticket with ordered objectives.
- `ovld prompt "<objective>"`: create a ticket and immediately queue or launch execution.
- `ovld attach [ticketId] [agent]`: search/select a ticket and launch an agent interactively.
- `ovld tickets list [--status <csv>] [--project-id <id-or-name>] [--limit <n>]`: list tickets.
- `ovld ticket context <ticketId>`: print the assembled context for a ticket without starting a session.
- `ovld protocol search-tickets --query "<text>" --status next-up,execute`: search tickets.
- `ovld protocol add-objectives --ticket-id <id> --objectives-json '[...]'`: append objectives to an existing ticket.
- `ovld protocol discuss-objective --ticket-id <id>`: mark a draft objective submitted without attaching.
- `ovld protocol record-work`: record work already completed in chat as a review ticket without an active session.

### Launch Commands

Requirements:

- `ovld launch <agent> --ticket-id <ticketId>`: launch the selected agent in the right working directory with assembled context.
- `ovld restart <agent> --ticket-id <ticketId>`: resume when the agent supports native resume.
- `ovld connect`, `ovld run`, and `ovld resume` can remain compatibility aliases if useful.
- Direct launch syntax can be supported later: `ovld <agent> "<prompt>" [overlord flags] [-- agent flags]`.

Launch flags to preserve:

- `--working-directory <path>`
- `--model <identifier>`
- `--thinking <level>` where the target agent supports it
- repeated `--flag <value>` passthrough
- `--pre-command <wrapper>` for wrappers such as container or remote execution helpers
- `--terminal <launcher>` to open the agent in a new terminal window (built-in `iTerm2`/`Terminal`, or a prefix command), overriding the stored terminal profile; `--no-terminal` forces an inline launch
- `--allow-uninstalled` for custom/experimental agents

SSH flags can be deferred:

- `--ssh-command`
- `--remote-working-directory`
- `--server-multiplexer`
- `--tmux-command`

### Runner Commands

Requirements:

- `ovld runner once`: claim and launch at most one queued request.
- `ovld runner start`: poll continuously.
- `ovld runner status`: show local runner identity and visible queue.
- `ovld runner clear <objective_id>`: clear one active request.
- `ovld runner clear-all`: clear every active request visible to the local instance/user.

### Connector Commands

Requirements:

- `ovld setup`: interactive first-run configuration for backend target, agent connectors, and terminal launcher.
- `ovld agent-setup`: list installable connectors.
- `ovld agent-setup <agent>`: install/repair one connector.
- `ovld agent-setup all`: install/repair all supported connectors.
- `ovld doctor`: report connector status, stale/missing files, and malformed, expired, or revoked `USER_TOKEN` configuration once token auth is enabled.

Initial supported agents should be:

- Codex
- Claude Code

Next supported agents:

- Cursor
- Antigravity
- OpenCode
- Custom command adapters

## Output Contracts

Requirements:

- Machine-readable JSON should be available for all commands used by agents or scripts.
- Human commands should be concise by default and support `--json`.
- Protocol commands should return JSON by default.
- Commands that produce values needed by shell scripts may also print stable `KEY=value` lines on stderr, for example `SESSION_KEY=...` and `PROJECT_ID=...`.
- Errors should include an actionable fix when possible.

## Local Files

### `overlord.toml`

Requirements:

- Located at the instance or project root, depending on final packaging.
- Configure instance name, backend URL, default agent/model, terminal launch preferences, connector paths, and runner polling defaults.
- Backend keys:
  - `backend_mode` — `local` or `cloud`.
  - `backend_url` — REST/backend base URL. Local mode defaults to `http://127.0.0.1:4310`; cloud mode stores the hosted backend URL.
- Legacy database keys (`database_path`, `database_url`) are owned by local/backend packages such as Desktop, not by the published npm CLI.
- Optional `[agent_catalog]` tables customize which agents and models are offered in the web UI (merged over bundled defaults on seed and catalog refresh).
- Include commented examples for common terminals and agents.

### `.overlord/project.json`

Requirements:

- Written into linked project directories.
- Stores local project identifier, resource label, whether the directory is primary, and enough metadata for project discovery.
- Should be tracked unless the user chooses otherwise.

### `~/.ovld/` (global CLI config) and local backend data

Requirements:

- The published CLI stores global config under `~/.ovld/` (overridable with `OVLD_HOME`) and talks to a backend URL.
- Local SQLite files and `local_fs` object storage are owned by the local backend/Desktop package, not by the published CLI.

### `.overlord/tmp/` And `.overlord/logs/`

Requirements:

- Reserved for context files, connector hook diagnostics, temporary settings, and launch scratch files.
- Must be gitignored by generated `.gitignore` suggestions.
- Do not gitignore the whole `.overlord/` directory by default because `project.json` is durable metadata.

## MVP CLI Acceptance Criteria

- A user can initialize Overlord locally and create a project from an existing repository.
- A user can create a ticket with ordered objectives from the CLI.
- A user can list and inspect tickets.
- A user can launch an agent on a ticket from the CLI.
- An agent can attach, update, ask, and deliver through `ovld protocol`.
- `ovld doctor` catches missing agent binaries, missing connector installs, invalid project metadata, missing database file, and missing primary working directory.
