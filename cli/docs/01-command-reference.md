# CLI Command Reference

Exhaustive reference for the `ovld` command surface. Primary command name is `ovld` (alias: `open-overlord` when installed from npm).

For behavioral specs and acceptance criteria, see the other docs in this folder. For protocol workflow guidance, run `ovld protocol help`.

**Output conventions**

| Surface | Default output | Machine-readable |
| ------- | -------------- | ---------------- |
| Management commands | Human text | Pass `--json` |
| Protocol subcommands | JSON on stdout | Default (no flag needed) |
| Session keys | `SESSION_KEY=…` on stderr after attach, connect, prompt, resume-follow-up | Same |

**Global environment variables** (fallbacks when flags are omitted)

| Variable | Used by |
| -------- | ------- |
| `OVERLORD_USER_TOKEN`, `OVLD_USER_TOKEN`, `USER_TOKEN` | Backend auth (checked in that order) |
| `OVERLORD_BACKEND_URL`, `OVERLORD_BACKEND_URL_DEV` | Backend URL resolution |
| `OVERLORD_EXECUTION_REQUEST_ID` | `protocol attach` (links to runner request) |
| `SESSION_KEY` | Protocol commands that require `--session-key` (also cached per working directory + mission) |
| `OVLD_HOME` | Relocate `~/.ovld` credentials and config |
| `OVERLORD_WEB_HOST`, `OVERLORD_WEB_PORT`, `OVERLORD_SQLITE_PATH` | `ovld serve` defaults |

---

## General

| Command | Description | Positional args | Flags |
| ------- | ----------- | --------------- | ----- |
| `ovld` | Same as `ovld help` | — | — |
| `ovld help` | Print top-level command summary | — | — |
| `ovld version` | Print installed CLI version | — | `--json` |
| `ovld update` | Check for or install the latest published `open-overlord` via npm | — | `--check` (compare only), `--force` (install even when current), `--json` |
| `ovld init` | Create `overlord.toml` with a local backend URL | — | `--json` |
| `ovld serve` | Boot the web/REST server (repo/local backend package; not in published npm workflow) | — | `--host <h>`, `--port <p>`, `--db <path>`, `--json` |
| `ovld doctor` | Validate backend reachability, connector installs, agent binaries, credentials sync-root warnings | — | `--json` |
| `ovld prune` | Delete contents of `.overlord/tmp` in the current directory | — | `--json` |

---

## Auth and configuration

| Command | Description | Positional args | Flags |
| ------- | ----------- | --------------- | ----- |
| `ovld auth login` | Configure backend (interactive if unset), then log in | — | `--token <out_…>` (USER_TOKEN login), `--json` |
| `ovld auth status` | Show backend URL and login status | — | `--json` |
| `ovld config list` | Show resolved local configuration | — | `--json` |
| `ovld config get <key>` | Print one config key (`backend`, `backend_mode`, `backend_url`, `web_host`, `web_port`, `default_agent`) | `key` (default: `backend`) | `--json` |
| `ovld config set` | Interactive backend selector (local or cloud) | — | `--json` |
| `ovld config set local [url]` | Point at a local backend URL (default `http://127.0.0.1:4310`) | `url` (optional) | `--json`, `--path`, `--url` (alternate value sources) |
| `ovld config set cloud <url>` | Point at a hosted backend URL | `url` (required) | `--json` |
| `ovld setup` | Interactive first-run: backend, auth, connectors, terminal profile | — | `--json` |
| `ovld user-token create` | Mint a USER_TOKEN (secret printed once) | `label` (or use flag) | `--label <l>` (required), `--expires-in <duration>` (e.g. `90d`, `12w`, `3mo`, `6h`, `1y`), `--no-expiry`, `--scope` (`full`, `mission-lifecycle`), `--json` |
| `ovld user-token list` | List tokens (never shows secrets) | — | `--json` |
| `ovld user-token revoke` | Revoke a token immediately | `id` | `--id <id>`, `--json` |
| `ovld user-token rename` | Rename a token without rotating it | `id`, `label` | `--id <id>`, `--label <l>`, `--json` |

---

## Connectors

| Command | Description | Positional args | Flags |
| ------- | ----------- | --------------- | ----- |
| `ovld agent-setup` | List installable agent connectors | — | `--json` |
| `ovld agent-setup <agent>` | Install or repair one connector (e.g. `claude`, `codex`, `cursor`) | `agent` | `--dry-run`, `--home <path>`, `--json` |
| `ovld agent-setup all` | Install or repair all supported connectors | — | `--dry-run`, `--home <path>`, `--json` |

---

## Projects

| Command | Description | Positional args | Flags |
| ------- | ----------- | --------------- | ----- |
| `ovld create-project` | Create a project and optionally link the current directory | — | `--name <name>` (required), `--directory <path>`, `--no-directory`, `--json` |
| `ovld add-cwd` | Link a checkout directory to a project | — | `--directory <path>` (default: cwd), `--project-id <id-or-name>`, `--primary` (`true`, `false`) (default: true), `--json` |

When `--project-id` is omitted on an interactive terminal, the CLI prompts to pick a project. Non-interactively it uses the first available project.

---

## Missions (human commands)

| Command | Description | Positional args | Flags |
| ------- | ----------- | --------------- | ----- |
| `ovld create` | Create a draft mission | `"<objective>"` | `--objectives-json <json>`, `--title <text>`, `--project-id <id>`, `--json` |
| `ovld prompt` | Create a mission and queue execution | `"<objective>"` | `--objectives-json <json>`, `--title <text>`, `--project-id <id>`, `--agent <id>`, `--json` |
| `ovld attach` | Queue an agent for a mission (does not spawn locally) | `missionId`, `agent` (optional) | `--mission-id <id>`, `--objective-id <id>`, `--agent <id>`, `--model <id>`, `--thinking <level>`, `--json` |
| `ovld execution` | Alias of `ovld attach` with required `--mission-id` | — | `--mission-id <id>` (required), `--objective-id <id>`, `--agent <id>`, `--model <id>`, `--thinking <level>`, `--json` |
| `ovld missions list` | List missions (tab-separated human output) | — | `--query <text>`, `--project-id <id>`, `--limit <n>`, `--json` |
| `ovld mission context` | Print assembled mission context | `missionId` | `--json` |
| `ovld mission events` | List mission events | `missionId` | `--json` |
| `ovld mission deliveries` | List delivery-related events | `missionId` | `--json` |
| `ovld mission artifacts` | List mission artifacts | `missionId` | `--json` |
| `ovld mission rationales` | List file-change rationales | `missionId` | `--json` |

---

## Launch

| Command | Description | Positional args | Flags |
| ------- | ----------- | --------------- | ----- |
| `ovld launch` | Spawn an agent locally with assembled mission context | `agent` | `--mission-id <id>` (required), `--working-directory <path>`, `--model <id>`, `--thinking <level>`, `--branch <name>`, `--no-worktree`, `--pre-command <wrapper>`, `--terminal <launcher>`, `--no-terminal`, `--flag <value>` (repeatable passthrough), `--dry-run`, `--json` |
| `ovld restart` | Resume when the agent supports native resume | `agent` | Same as `launch` |
| `ovld run` | Compatibility alias for `launch` | `agent`, `missionId` (positional) | Same as `launch` (also accepts `--agent`) |
| `ovld connect` | Compatibility alias for `launch` | `agent`, `missionId` (positional) | Same as `launch` |
| `ovld resume` | Compatibility alias for `launch` | `agent`, `missionId` (positional) | Same as `launch` |

`--terminal` accepts built-in names (`Terminal`, `iTerm2`) or a prefix command (e.g. `open -a Ghostty --args`). When omitted, the stored terminal profile is used.

---

## Runner

| Command | Description | Positional args | Flags |
| ------- | ----------- | --------------- | ----- |
| `ovld runner once` | Claim and launch at most one queued execution request | — | `--project-id <id>`, `--branch <name>`, `--no-worktree`, `--dry-run`, `--json` |
| `ovld runner start` | Poll continuously for execution requests | — | `--project-id <id>`, `--branch <name>`, `--no-worktree`, `--poll-interval-ms <n>` (default: 3000), `--dry-run`, `--json` |
| `ovld runner status` | Show runner identity and visible queue | — | `--json` |
| `ovld runner clear` | Clear one active execution request | `objective_id` | `--project-id <id>`, `--json` |
| `ovld runner clear-all` | Clear every active request visible to the runner | — | `--project-id <id>`, `--json` |

---

## Changes

| Command | Description | Positional args | Flags |
| ------- | ----------- | --------------- | ----- |
| `ovld changes status` | Show file-change status for a mission | — | `--mission-id <id>` (required), `--json` |
| `ovld changes rationales` | List change rationales for a mission | — | `--mission-id <id>` (required), `--json` |

---

## Protocol (`ovld protocol <subcommand>`)

Protocol commands return JSON on stdout by default. Run `ovld protocol help` for workflow instructions and payload shapes.

### Common protocol flags

| Flag | Description |
| ---- | ----------- |
| `--mission-id <id>` | Mission display id (e.g. `coo:8`) or UUID |
| `--session-key <key>` | Session key from attach, connect, prompt, or resume-follow-up |
| `--agent <identifier>` | Agent identifier (default: `unknown`) |
| `--model <identifier>` | Model identifier |
| `--timeout <ms>` | Request timeout in milliseconds (default: 30000) |

File-backed payloads: any `-*-json` flag has a paired `-*-file <path>` flag (use `-` for stdin). Only one `-*-file -` per invocation. Inline JSON larger than ~8 KB is rejected — use file/stdin instead.

### Protocol subcommands

| Subcommand | Description | Required flags / args | Optional flags |
| ---------- | ----------- | --------------------- | -------------- |
| `auth-status` | Machine-readable auth and backend readiness | — | — |
| `discover-project` | Resolve project from working directory or explicit id | — | `--project-id <id-or-name>`, `--directory <path>` |
| `list-organizations` | List workspaces visible to the backend | — | — |
| `attach` | Start a mission session; returns full working context | `--mission-id <id>` | `--session-key <key>`, `--agent <id>`, `--model <id>`, `--execution-request-id <id>`, `--external-session-id <id>` |
| `connect` | Lightweight session (session key only) | `--mission-id <id>` | `--agent <id>`, `--external-session-id <id>` |
| `load-context` | Read mission context without creating a session | `--mission-id <id>` | — |
| `search-missions` | Find missions by keyword, status, or project | — | `--query <text>`, `--status <csv>`, `--project-id <id>`, `--limit <n>` (default: 25) |
| `discuss-objective` | Mark latest draft objective submitted (does not start execution) | `--mission-id <id>` | — |
| `add-objectives` | Append ordered objectives | `--mission-id <id>`, `--objectives-json <json>` or `--objectives-file <path>` | — |
| `create` | Create draft mission without attaching | `--objective "<text>"` or `--objectives-json` / `--objectives-file` | `--title <text>`, `--project-id <id>` |
| `prompt` | Create mission and attach immediately | `--objective "<text>"` or `--objectives-json` / `--objectives-file` | `--title <text>`, `--project-id <id>`, `--agent <id>`, `--model <id>`, `--external-session-id <id>` |
| `record-work` | Record completed chat work as review mission (no session) | `--objective "<text>"` (or positional), `--summary <text>` or `--summary-file <path>` | `--title <text>`, `--project-id <id>`, `--artifacts-json` / `--artifacts-file`, `--change-rationales-json` / `--change-rationales-file` |
| `update` | Post progress or activity events | `--session-key <key>`, `--mission-id <id>`, `--summary <text>` or `--summary-file <path>` | `--phase` (draft, execute, review, deliver, complete, blocked, cancelled), `--event-type` (update, user_follow_up, alert, discussion_summary, decision), `--begin-follow-up-work`, `--follow-up-intent` (discussion, execution, pending_delivery), `--payload-json` / `--payload-file`, `--external-url`, `--external-session-id`, `--changed-files-json` / `--changed-files-file`, `--change-rationales-json` / `--change-rationales-file` |
| `heartbeat` | Liveness ping without creating a mission event | `--session-key <key>`, `--mission-id <id>` | `--phase <phase>`, `--note <text>` |
| `ask` | Blocking question; stop work after success | `--session-key <key>`, `--mission-id <id>`, `--question <text>` or `--question-file <path>` | — |
| `deliver` | Finish session; submit summary, artifacts, rationales | `--session-key <key>`, `--mission-id <id>`, `--summary <text>` or `--summary-file <path>` (or `--payload-json` / `--payload-file` with `{ summary, artifacts, changeRationales }`) | `--artifacts-json` / `--artifacts-file`, `--change-rationales-json` / `--change-rationales-file`, `--changed-files-json` / `--changed-files-file`, `--no-file-changes`, `--skip-rationale-for-json` / `--skip-rationale-for-file`, `--verification-summary <text>`, `--follow-up-notes <text>` |
| `resume-follow-up` | Reopen completed objective for post-delivery work | `--mission-id <id>` | `--objective-id <id>`, `--agent <id>`, `--model <id>`, `--summary <text>` or `--summary-file`, `--external-session-id <id>` |
| `hook-event` | Record connector lifecycle hook | `--hook-type UserPromptSubmit`, `--mission-id <id>` | `--prompt <text>` or `--prompt-file <path>`, `--session-key <key>`, `--external-session-id <id>`, `--turn-index <n>` |
| `read-context` | Read shared persistent mission context | `--mission-id <id>` | `--key <substring>`, `--limit <n>` (default: 50) |
| `write-context` | Write shared persistent mission context | `--mission-id <id>`, `--key <name>`, `--value <text>` or `--value-json` / `--value-file` | — |
| `attachment-list` | List all mission attachments | `--mission-id <id>` | — |
| `attachment-download-url` | Get download URL for one attachment | `--mission-id <id>`, `--attachment-id <id>` | — |
| `help` | Print protocol reference (this document's protocol section in long form) | — | — |

### Change-rationale entry shape (`deliver`, `update`, `record-work`)

Each item in `--change-rationales-json` / `--change-rationales-file`:

| Field | Required | Description |
| ----- | -------- | ----------- |
| `file_path` | yes | Repo-relative path (`filePath` also accepted) |
| `label` | yes | Short reviewer-facing title |
| `summary` | yes | What changed (field name is `summary`, not `rationale`) |
| `why` | yes | Why it changed |
| `impact` | yes | Behavioral impact |
| `hunks` | no | Array of `{ "header": "@@ … @@" }` diff hunk headers |

### Skip-rationale entry shape (`deliver`)

Each item in `--skip-rationale-for-json` / `--skip-rationale-for-file`:

| Field | Required | Description |
| ----- | -------- | ----------- |
| `file_path` | yes | Repo-relative path (`filePath` also accepted) |
| `reason` | yes | Why this file should not require a rationale |

---

## Commands that do not require a backend

`help`, `version`, `update`, `init`, `doctor`, `setup`, `agent-setup`, `serve`, `config`, `auth`, `user-token`, `prune`

All other commands require a configured, reachable backend URL and authentication (except `protocol auth-status`, which reports readiness either way).

---

## Related docs

- [02 — CLI-First Product Surface](02-cli-first-product-surface.md) — requirements and acceptance criteria
- [03 — Agent Protocol](03-agent-protocol.md) — protocol lifecycle and delivery contract
- [04 — Runner and Launch Execution](04-runner-and-launch-execution.md) — runner queue and launch behavior
- [11 — Review, Artifacts, and Change Tracking](11-review-artifacts-and-change-tracking.md) — rationales and file-change tracking
