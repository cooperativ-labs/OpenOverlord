# CLI First Product Surface

## Goal

Make Overlord usable from the terminal before the web app exists. Every core workflow should have a CLI path, and later UI work should call the same underlying operations.

## Command Groups

### General Commands

Requirements:

- `ovld help`: print top-level command help.
- `ovld version`: print CLI and local runtime version.
- `ovld doctor`: validate configuration, database accessibility, connector installs, supported agent binaries, project metadata, and common permission/path problems.
- `ovld update`: optional for packaged releases; can be deferred until distribution is defined.

### Configuration Commands

Requirements:

- `ovld init`: create or update `overlord.toml` for a local instance.
- `ovld config get/set/list`: inspect and update local configuration.
- `ovld user-token create/list/rotate/revoke/rename`: manage user-owned non-interactive credentials once the `USER_TOKEN` module is enabled.
- `ovld create-project --name "<name>" [--directory <path>|--no-directory]`: create a project and optionally register the current directory.
- `ovld add-cwd [--directory <path>] [--project-id <id-or-name>] [--primary true|false]`: link a checkout to a project.
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
- `--terminal <launcher>` to open the agent in a new terminal window (built-in `iTerm2`/`Terminal`, or a prefix command), overriding `terminal_launcher`; `--no-terminal` forces an inline launch
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

- `ovld setup`: interactive connector setup.
- `ovld setup <agent>`: install/repair one connector.
- `ovld setup all`: install/repair all supported connectors.
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
- Configure instance name, SQLite database location, web port, optional SQL Studio launch settings, default agent/model, terminal launch preferences, connector paths, and runner polling defaults.
- Optional `[agent_catalog]` tables customize which agents and models are offered in the web UI (merged over bundled defaults on seed and catalog refresh).
- Include commented examples for common terminals and agents.

### `.overlord/project.json`

Requirements:

- Written into linked project directories.
- Stores local project identifier, resource label, whether the directory is primary, and enough metadata for project discovery.
- Should be tracked unless the user chooses otherwise.

### `database/.local/`

Requirements:

- Git-ignored runtime data for the local SQLite database (`Overlord.sqlite`) and `local_fs` object storage buckets.
- Default `database_path` in `overlord.toml`; override per instance when needed.

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
