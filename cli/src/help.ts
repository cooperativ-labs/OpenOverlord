export function printHelp({ primaryCommand }: { primaryCommand: string }): void {
  console.log(`Overlord CLI

Primary command: ${primaryCommand}

General:
  ${primaryCommand} help                         Show this help message
  ${primaryCommand} version [--json]             Show the installed CLI version
  ${primaryCommand} init [--json]                Create overlord.toml and local database
  ${primaryCommand} doctor [--json]              Validate config, database, and connector installs
  ${primaryCommand} config list [--json]         Show local configuration

Connectors:
  ${primaryCommand} setup [--json]               List installable agent connectors
  ${primaryCommand} setup <agent> [--dry-run]    Install/repair one connector (e.g. claude)
  ${primaryCommand} setup all [--dry-run]        Install/repair all supported connectors

Projects:
  ${primaryCommand} create-project --name "<name>" [--directory <path>|--no-directory]
  ${primaryCommand} add-cwd [--directory <path>] [--project-id <id>] [--primary true|false]

Tickets:
  ${primaryCommand} create "<objective>" [--objectives-json '[...]'] [--json]
  ${primaryCommand} prompt "<objective>" [--json]
  ${primaryCommand} tickets list [--status <csv>] [--project-id <id>] [--json]
  ${primaryCommand} ticket context <ticketId> [--json]

Protocol (JSON output by default):
  ${primaryCommand} protocol attach --ticket-id <id>
  ${primaryCommand} protocol update --ticket-id <id> --session-key <key> --summary "..."
  ${primaryCommand} protocol heartbeat --ticket-id <id> --session-key <key>
  ${primaryCommand} protocol ask --ticket-id <id> --session-key <key> --question "..."
  ${primaryCommand} protocol deliver --ticket-id <id> --session-key <key> --summary "..."
  ${primaryCommand} protocol search-tickets --query "<text>" --status next-up,execute
  ${primaryCommand} protocol load-context --ticket-id <id>
  ${primaryCommand} protocol help

See cli/docs/ for the full command reference.
`);
}
