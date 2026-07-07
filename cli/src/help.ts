export function printHelp({ primaryCommand }: { primaryCommand: string }): void {
  console.log(`Overlord CLI
    
INSTRUCTIONS FOR AI AGENTS: run \`${primaryCommand} protocol help\` for the full mission lifecycle reference.

Primary command: ${primaryCommand}

General:
  ${primaryCommand} auth login [--token <out_...>]   Configure backend and log in
  ${primaryCommand} auth status [--json]           Show backend URL and login status
  ${primaryCommand} user-token create --label <l> [--expires-in 90d] [--no-expiry] [--scope full|mission-lifecycle]
                                                 Mint a USER_TOKEN (prints the secret once)
  ${primaryCommand} user-token list [--json]       List your tokens (never shows secrets)
  ${primaryCommand} user-token revoke <id>         Revoke a token immediately
  ${primaryCommand} user-token rename <id> <label> Rename a token without rotating it
  ${primaryCommand} help                         Show this help message
  ${primaryCommand} version [--json]             Show the installed CLI version
  ${primaryCommand} update [--check] [--force] [--json]
                                                 Check for or install the latest published CLI
  ${primaryCommand} init [--json]                Create overlord.toml with a local backend URL
  ${primaryCommand} serve [--host <h>] [--port <p>] [--db <path>] [--json]
                                                 Boot the web/REST server (creates + migrates the DB on first run)
  ${primaryCommand} doctor [--json]              Validate backend and connector installs
  ${primaryCommand} prune [--json]               Delete the contents of .overlord/tmp in the current directory
  ${primaryCommand} config list [--json]         Show local configuration
  ${primaryCommand} config set                   Choose local/cloud backend interactively
  ${primaryCommand} config set local [url]       Use a local backend URL (default: http://127.0.0.1:4310)
  ${primaryCommand} config set cloud <url>       Use a hosted backend URL
  ${primaryCommand} setup [--json]               Configure backend, agents, and terminal interactively

Connectors:
  ${primaryCommand} agent-setup [--json]         List installable agent connectors
  ${primaryCommand} agent-setup <agent> [--dry-run]
                                                 Install/repair one connector (e.g. claude)
  ${primaryCommand} agent-setup all [--dry-run]  Install/repair all supported connectors

Organizations:
  ${primaryCommand} org-setup --org-name "<name>" [--workspace-name <name>] [--workspace-slug <slug>]
                              [--logo <path>] [--no-input] [--if-needed] [--json]
                                                 One-time org + first-workspace onboarding for a
                                                 profile with zero workspace memberships. Prompts
                                                 interactively on a TTY; --if-needed is a no-op (exit 0)
                                                 once you already belong to an organization.

Projects:
  ${primaryCommand} create-project --name "<name>" [--directory <path>|--no-directory]
  ${primaryCommand} add-cwd [--directory <path>] [--project-id <id>] [--key <resourceKey>] [--primary true|false]
                                                 (prompts to pick a project when --project-id is omitted)

Missions:
  ${primaryCommand} create "<objective>" [--objectives-json '[...]'] [--json]
  ${primaryCommand} prompt "<objective>" [--json]
  ${primaryCommand} attach <missionId> [agent] [--json]
  ${primaryCommand} missions list [--status <csv>] [--project-id <id>] [--json]
  ${primaryCommand} mission context|events|deliveries|artifacts|rationales <missionId> [--json]

Launch and runner:
  ${primaryCommand} launch <agent> --mission-id <missionId> [--branch <name>] [--no-worktree] [--dry-run] [--json]
  ${primaryCommand} runner once|start|status|clear|clear-all [--branch <name>] [--no-worktree] [--json]

Changes:
  ${primaryCommand} changes status --mission-id <id> [--objective-id <id>] [--json]
  ${primaryCommand} changes rationales --mission-id <id> [--objective-id <id>] [--json]

Agents:
  Built-in agents (claude, codex, cursor) need an installed connector
  (${primaryCommand} agent-setup <agent>). Launch with:
  ${primaryCommand} launch <agent> --mission-id <missionId>
  Use ${primaryCommand} protocol help for the full mission lifecycle reference.
  Key protocol commands: auth-status, discover-project, create, prompt, attach,
  connect, load-context, update, heartbeat, ask, deliver.

Protocol (JSON output by default):
  ${primaryCommand} protocol attach --mission-id <id>
  ${primaryCommand} protocol update --mission-id <id> --session-key <key> --summary "..."
  ${primaryCommand} protocol heartbeat --mission-id <id> --session-key <key>
  ${primaryCommand} protocol ask --mission-id <id> --session-key <key> --question "..."
  ${primaryCommand} protocol deliver --mission-id <id> --session-key <key> --summary "..."
  ${primaryCommand} protocol search-missions --query "<text>" --status next-up,execute
  ${primaryCommand} protocol load-context --mission-id <id>
  ${primaryCommand} protocol help

After installation, run \`${primaryCommand} auth login\` to choose your backend.

See cli/docs/ for the full command reference.
`);
}
