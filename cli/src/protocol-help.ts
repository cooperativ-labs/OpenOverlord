/** Protocol subcommands implemented by the local backend (`webapp/server/protocol.ts`). */
export const SUPPORTED_PROTOCOL_SUBCOMMANDS = [
  'add-objectives',
  'ask',
  'attach',
  'attachment-list',
  'auth-status',
  'connect',
  'create',
  'deliver',
  'discover-project',
  'discuss-objective',
  'heartbeat',
  'hook-event',
  'list-organizations',
  'load-context',
  'prompt',
  'read-context',
  'record-work',
  'resume-follow-up',
  'search-tickets',
  'update',
  'write-context'
] as const;

const DEFAULT_TIMEOUT_MS = 30_000;

export function printProtocolHelp({ primaryCommand }: { primaryCommand: string }): void {
  const subcommands = SUPPORTED_PROTOCOL_SUBCOMMANDS.join(', ');

  console.log(`${primaryCommand} protocol [flags]

Use this for ticket lifecycle work from an agent runtime: create a standalone
draft with \`${primaryCommand} protocol create\`, create-and-attach with
\`${primaryCommand} protocol prompt\`, or attach to an existing ticket with
\`${primaryCommand} protocol attach --ticket-id <ticket_id>\`.

Backend and auth:
  Configure the REST backend before protocol calls:
  ${primaryCommand} init                         Create overlord.toml with a local backend URL
  ${primaryCommand} config set local [url]       Point at a local backend (default: http://127.0.0.1:4310)
  ${primaryCommand} config set cloud <url>       Point at a hosted backend URL
  ${primaryCommand} auth login                   Choose backend interactively when needed, then log in
  ${primaryCommand} doctor                       Validate backend reachability and connector installs

  To check credentials machine-readably from a script, use
  \`${primaryCommand} protocol auth-status\` (returns ok=true|false).

Project discovery:
  When prompting or creating tickets, the CLI resolves the project from your
  working directory when --project-id is omitted. Discover it explicitly with:

  ${primaryCommand} protocol discover-project
  ${primaryCommand} protocol discover-project --project-id <id-or-name>
  ${primaryCommand} protocol discover-project --directory /path/to/repo

  Humans can also link checkouts with \`${primaryCommand} add-cwd\` and create
  projects with \`${primaryCommand} create-project --name "<name>"\`.

Agent workflow (required):
  1. Attach first with \`${primaryCommand} protocol attach --ticket-id <id>\`.
  2. Post progress with \`${primaryCommand} protocol update\` or liveness with
     \`${primaryCommand} protocol heartbeat\`.
  3. Ask blocking questions with \`${primaryCommand} protocol ask\` and stop work.
  4. Deliver with \`${primaryCommand} protocol deliver\` when work is complete.
  5. Do not continue implementation after delivery without
     \`${primaryCommand} protocol resume-follow-up\` or \`--begin-follow-up-work\`
     on a still-live session.

Subcommands:
  auth-status            Return machine-readable auth/backend readiness
  discover-project       Resolve a project from the working directory or explicit id
  list-organizations     List workspaces visible to the current backend
  attach                 Start a ticket session and return full working context
  connect                Start a lightweight session without full context assembly
  load-context           Read ticket context without creating a session
  search-tickets         Find tickets by keyword, status, or project
  discuss-objective      Mark a draft objective as submitted (does not start execution)
  add-objectives         Append ordered objectives to an existing ticket
  create                 Create a draft ticket without attaching
  prompt                 Create a ticket and attach to it immediately
  record-work            Record completed-from-chat work as a review ticket (no attach)
  update                 Post progress, activity events, and optional change rationales
  heartbeat              Send a liveness ping without creating a ticket event
  ask                    Post a blocking question and move the ticket to review
  deliver                Finish work, send artifacts, and move the ticket to review
  resume-follow-up       Reopen a completed objective for post-delivery follow-up work
  hook-event             Record a connector lifecycle hook (e.g. UserPromptSubmit)
  read-context           Read shared persistent context for this ticket
  write-context          Write shared persistent context for future sessions
  attachment-list        List objective attachments visible on the ticket

Runner queue (management commands, not protocol):
  ${primaryCommand} runner once|start|status|clear|clear-all [--branch <name>] [--no-worktree]
  ${primaryCommand} launch <agent> --ticket-id <ticketId> [--branch <name>] [--no-worktree]

Environment fallback:
  --session-key  <- SESSION_KEY printed on stderr after attach/connect/prompt/resume-follow-up
  --ticket-id    <- ticket display id (e.g. coo:8) or UUID
  backend URL    <- overlord.toml backend_url, OVERLORD_BACKEND_URL, or dev OVERLORD_BACKEND_URL_DEV
  auth token     <- OVERLORD_USER_TOKEN, OVLD_USER_TOKEN, or USER_TOKEN

Common flags:
  --ticket-id <id>         Ticket identifier when operating on an existing ticket
  --session-key <key>      Session key returned by attach/connect/prompt/resume-follow-up
  --agent <identifier>     Agent identifier sent to Overlord (default: unknown)
  --model <identifier>     Model identifier to snapshot on executing objectives
  --timeout <ms>           Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})

auth-status:
  Purpose:
    Check whether the local runtime can reach the configured backend.
  Returns:
    JSON with ok=true|false plus backend URL metadata. Does not print secrets.

discover-project:
  Purpose:
    Resolve the Overlord project for the current or given working directory.
  Optional:
    --project-id <id-or-name>   Resolve this project directly
    --directory <path>          Directory to match (default: current working directory)
  Returns:
    Project JSON with id, name, and slug.

attach:
  Purpose:
    Create the working session for an agent on an existing ticket. Call this first.
  Required:
    --ticket-id <id>            Display id (e.g. coo:8) or UUID
  Optional:
    --session-key <key>         Reuse an existing session key
    --agent <identifier>
    --model <identifier>
    --external-session-id <id>  Native agent thread/session id for resume
  Returns:
    Full JSON including session.sessionKey, ticket, history, artifacts, sharedState,
    and promptContext with required workflow instructions.
  Notes:
    The client CLI records a VCS baseline at attach so deliver can report the
    run-attributable changed-file delta automatically.

connect:
  Purpose:
    Create a lightweight session when you only need a session key, not full context.
  Required:
    --ticket-id <id>
  Optional:
    --agent <identifier>
    --external-session-id <id>
  Returns:
    Session JSON and SESSION_KEY on stderr when available.

load-context:
  Purpose:
    Read ticket details without creating a session.
  Required:
    --ticket-id <id>

search-tickets:
  Purpose:
    Find tickets by keyword, status, or project.
  Optional:
    --query <text>              Free-text search
    --status <csv>              Comma-separated statuses (e.g. next-up,execute)
    --project-id <id>           Restrict to one project
    --limit <n>                 Max results (default: 25)
  Returns:
    JSON with matching tickets.

discuss-objective:
  Purpose:
    Mark the latest draft objective as submitted. Does not start execution — use attach.
  Required:
    --ticket-id <id>

add-objectives:
  Purpose:
    Append ordered objectives to an existing ticket.
  Required:
    --ticket-id <id>
    --objectives-json <json> or --objectives-file <path|->

create:
  Purpose:
    Create a draft ticket without attaching.
  Required:
    --objective "<text>" or --objectives-json / --objectives-file <path|->
  Optional:
    --title <text>
    --project-id <id>           Skips working-directory project resolution

prompt:
  Purpose:
    Create a ticket and attach to it in one call.
  Required:
    --objective "<text>" or --objectives-json / --objectives-file <path|->
  Optional:
    --title <text>
    --project-id <id>
    --agent <identifier>
    --model <identifier>
    --external-session-id <id>
  Returns:
    New ticket/session JSON plus SESSION_KEY on stderr when available.

record-work:
  Purpose:
    Record work already completed in chat as a ticket in review without a session.
    Use instead of create + attach + deliver when logging past work.
  Required:
    --objective "<text>" (or positional objective text)
    --summary or --summary-file <path|->
  Optional:
    --title <text>
    --project-id <id>
    --artifacts-json / --artifacts-file <path|->
    --change-rationales-json / --change-rationales-file <path|->

update:
  Purpose:
    Post progress or activity events during execution.
  Required:
    --session-key <key>
    --ticket-id <id>
    --summary or --summary-file <path|->
  Optional:
    --phase draft | execute | review | deliver | complete | blocked | cancelled
    --event-type update | user_follow_up | alert | discussion_summary | decision
    --begin-follow-up-work      Reopen a delivered/review ticket for execution
    --follow-up-intent discussion | execution | pending_delivery
    --payload-json / --payload-file <path|->
    --external-url <url|null>
    --external-session-id <id|null>
    --changed-files-json / --changed-files-file <path|->
    --change-rationales-json / --change-rationales-file <path|->
  Notes:
    Pass --summary-file - to read the summary from stdin and avoid shell quoting issues.
    Inline --*-json values larger than ~8 KB are rejected; use the paired --*-file - flag.
    After delivery, pass --begin-follow-up-work before posting execution updates.

heartbeat:
  Purpose:
    Send a liveness ping without creating a ticket event.
  Required:
    --session-key <key>
    --ticket-id <id>
  Optional:
    --phase <phase>
    --note <text>

ask:
  Purpose:
    Raise a blocking question for a human reviewer. Stop work after ask succeeds.
  Required:
    --session-key <key>
    --ticket-id <id>
    --question or --question-file <path|->

deliver:
  Purpose:
    Conclude the session and submit the final narrative plus artifacts/change rationales.
  Required:
    --session-key <key>
    --ticket-id <id>
    --summary or --summary-file <path|->
    or: --payload-json / --payload-file <path|-> with { summary, artifacts, changeRationales }
  Optional:
    --artifacts-json / --artifacts-file <path|->
    --change-rationales-json / --change-rationales-file <path|->
    --changed-files-json / --changed-files-file <path|->
    --no-file-changes             Assert this run changed no files
    --verification-summary <text>
    --follow-up-notes <text>
  Notes:
    Changed files are captured mechanically: the CLI records a VCS baseline at attach
    and injects the run-attributable delta at deliver. Meaningful tracked changes
    require rationales unless --no-file-changes is passed. Do not continue
    implementation after delivery without explicit follow-up.
    Inline --*-json values larger than ~8 KB are rejected; use --change-rationales-file -
    (or --payload-file -) and stream JSON on stdin. Keep --summary inline.

resume-follow-up:
  Purpose:
    Reopen a completed objective for post-delivery implementation follow-up.
  Required:
    --ticket-id <id>
  Optional:
    --objective-id <id>
    --agent <identifier>
    --model <identifier>
    --summary or --summary-file <path|->
    --external-session-id <id>
  Returns:
    attach-response-v1 JSON with a new session key.

hook-event:
  Purpose:
    Record a connector lifecycle hook without requiring a live session key.
  Required:
    --hook-type UserPromptSubmit
    --ticket-id <id>
  Optional:
    --prompt or --prompt-file <path|->
    --session-key <key>
    --external-session-id <id>
    --turn-index <n>

read-context:
  Purpose:
    Read persistent shared context written by earlier sessions.
  Required:
    --ticket-id <id>
  Optional:
    --key <substring>           Filter by key substring
    --limit <n>                 Max entries (default: 50)

write-context:
  Purpose:
    Save shared facts for future sessions.
  Required:
    --ticket-id <id>
    --key <name>
    --value <text> or --value-json / --value-file <path|->

attachment-list:
  Purpose:
    List objective attachments visible on the ticket.
  Required:
    --ticket-id <id>

list-organizations:
  Purpose:
    List workspaces visible to the configured backend (MVP: the active workspace).
  Returns:
    JSON array of { id, slug, name }.

Supported subcommands: ${subcommands}
Run \`${primaryCommand} help\` for management commands and \`${primaryCommand} protocol help\` for this reference.
`);
}
