# Connectors And Agent Plugins

## Goal

Port Overlord's connector model so OpenOverlord can launch different AI coding agents while giving each one the same ticket protocol, lifecycle rules, hooks, and context.

## Connector Model

OpenOverlord should keep four layers distinct:

- Connector core: canonical Markdown workflow instructions and protocol rules.
- Connector plugins: per-agent files that extend the core for a specific harness.
- Plugin adapters: packaging/install glue for each agent's native plugin system.
- Prompt wrappers: launch-time task and context text passed to the agent.

Requirements:

- The core workflow should be reusable across agents.
- Per-agent differences should live in connector adapters, not duplicated protocol rules.
- Setup must be idempotent.
- Doctor must detect stale, missing, or partially installed connector files.
- Connector files should avoid clobbering user settings.

## Canonical Connector Core

Required content:

- Attach first.
- Treat ticket prompt/context as authoritative.
- Post meaningful progress updates.
- Use heartbeat during long mechanical work with no meaningful update.
- Ask exactly one blocking question and stop when blocked.
- Deliver last with summary, artifacts, and change rationales.
- Record all meaningful file changes as structured rationales.
- Use stdin/file flags for shell-special content.
- Do not continue implementation after delivery unless follow-up execution is explicitly requested.
- Run local repair/diagnostic commands before asking the user to fix connector setup.

## Codex Connector

Requirements:

- Install a home-local Codex plugin.
- Include Overlord skill/workflow instructions.
- Include `UserPromptSubmit` hook to record follow-up messages.
- Include permission hook to record tool permission requests.
- Install protocol permission rules for `ovld protocol`.
- Avoid generating or relying on a repository-local `AGENTS.md` for OpenOverlord itself.
- Detect or receive Codex native session/thread IDs when possible.
- Launch with model and reasoning effort mapping:
  - `--model <model>`
  - `-c model_reasoning_effort="<level>"`
- For large context or wrappers, write a context file and pass a short prompt that points to it.

Setup/managed files should be documented once implementation paths are chosen. Upstream uses `~/.codex/plugins/overlord`, `~/.agents/plugins/marketplace.json`, Codex rules, and hook scripts.

## Claude Code Connector

Requirements:

- Install a Claude plugin/skill bundle.
- Include `UserPromptSubmit` hook.
- Include permission hook.
- Optionally include Stop hook for pending-delivery checks.
- Provide slash commands for protocol operations.
- Preserve existing Claude settings.
- Launch with:
  - `--append-system-prompt-file <context-file>`
  - `--model <model>`
  - `--effort <level>` when supported.

Setup should work without the desktop app and should not fail hard when the Claude binary is absent; warn and report through doctor.

## Cursor Connector

Can be implemented after Codex and Claude.

Requirements:

- Install local Cursor plugin/rules/commands.
- Add `beforeSubmitPrompt` hook to record follow-ups.
- Add permission allow rules for protocol commands.
- Launch with model flag where supported.
- No thinking/effort flag required initially.

## Antigravity Connector

Can be implemented after local MVP.

Requirements:

- Install Antigravity plugin.
- Provide protocol skill and commands.
- Use Antigravity model selection internally rather than passing model flags if that remains the harness behavior.
- Keep local MCP shim parity with CLI protocol commands where useful.

## OpenCode And Custom Agents

Requirements:

- Support command templates in `overlord.toml`.
- Allow custom agent identifiers and command arguments.
- Provide a generic prompt wrapper when no native plugin exists.
- Mark connector capability support, such as:
  - supports native resume
  - supports model flag
  - supports effort/thinking flag
  - supports follow-up hook
  - supports permission hook
  - supports context-file prompt

## Slash Commands

For agents with command/plugin support, provide commands for:

- `attach`
- `connect`
- `load`
- `create`
- `prompt`
- `discuss-objective`
- `add-objectives`
- `record-work`
- `spawn` or equivalent follow-up ticket creation if useful

Each command should call the same `ovld protocol` surface rather than duplicating behavior.

## Hook Requirements

### Follow-Up Hook

Requirements:

- Captures human follow-up messages after initial ticket prompt.
- Publishes `user_follow_up` events through `hook-event` or `update`.
- Preserves verbatim user text.
- Records native session/resume ID when the harness exposes one.
- Does not restart execution by itself.

### Permission Hook

Requirements:

- Publishes `permission_request` with tool/request payload.
- Does not leak secrets.
- Works without requiring a web app.

### Stop Hook

Future requirement:

- Checks whether pending delivery is needed after an agent turn.
- Returns a non-blocking delivery status to the connector.

## Setup And Doctor Requirements

`ovld setup <agent>`:

- Detect the agent binary if needed.
- Install or update plugin files.
- Merge user settings safely.
- Write executable hook scripts.
- Write a manifest of managed files.
- Remove obsolete legacy files only when clearly owned by OpenOverlord.
- Be idempotent.

`ovld doctor`:

- Check each supported connector.
- Report installed version/status.
- Detect missing hook executability.
- Detect missing permission rules.
- Detect missing agent binaries.
- Suggest exact repair commands.

## Acceptance Criteria

- Codex and Claude can both be launched on the same ticket objective and receive equivalent protocol instructions.
- Follow-up user messages are recorded without the agent manually retyping them when hooks are installed.
- Setup can be rerun safely.
- Doctor reports missing/stale connector state in a way a user can fix from the CLI.
- Adding a new connector requires a small adapter plus capability metadata, not rewriting protocol rules.
