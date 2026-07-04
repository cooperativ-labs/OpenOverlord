/** Protocol subcommands implemented by the local backend (`backend/protocol.ts`). */
export const SUPPORTED_PROTOCOL_SUBCOMMANDS = [
  'add-objectives',
  'ask',
  'attach',
  'attachment-download-url',
  'attachment-list',
  'auth-status',
  'changes',
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
  'search-missions',
  'update',
  'write-context'
] as const;

const DEFAULT_TIMEOUT_MS = 30_000;

export function printProtocolHelp({ primaryCommand }: { primaryCommand: string }): void {
  const subcommands = SUPPORTED_PROTOCOL_SUBCOMMANDS.join(', ');

  console.log(`${primaryCommand} protocol [flags]

Use this for mission lifecycle work from an agent runtime: create a standalone
draft with \`${primaryCommand} protocol create\`, create-and-attach with
\`${primaryCommand} protocol prompt\`, or attach to an existing mission with
\`${primaryCommand} protocol attach --mission-id <mission_id>\`.

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
  When prompting or creating missions, the CLI resolves the project from your
  working directory when --project-id is omitted. Discover it explicitly with:

  ${primaryCommand} protocol discover-project
  ${primaryCommand} protocol discover-project --project-id <id-or-name>
  ${primaryCommand} protocol discover-project --directory /path/to/repo

  Humans can also link checkouts with \`${primaryCommand} add-cwd\` and create
  projects with \`${primaryCommand} create-project --name "<name>"\`.

Agent workflow (required):
  1. Attach first with \`${primaryCommand} protocol attach --mission-id <id>\`.
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
  list-organizations     Legacy name; returns only the caller's current workspace context (not organizations)
  attach                 Start a mission session and return full working context
  connect                Start a lightweight session without full context assembly
  load-context           Read mission context without creating a session
  search-missions         Find missions by keyword, status, or project
  discuss-objective      Mark a draft objective as submitted (does not start execution)
  add-objectives         Append ordered objectives to an existing mission
  create                 Create a draft mission without attaching
  prompt                 Create a mission and attach to it immediately
  record-work            Record completed-from-chat work as a review mission (no attach)
  update                 Post progress, activity events, and optional change rationales
  heartbeat              Send a liveness ping without creating a mission event
  ask                    Post a blocking question and move the mission to review
  deliver                Finish work, send artifacts, and move the mission to review
  resume-follow-up       Reopen a completed objective for post-delivery follow-up work
  hook-event             Record a connector lifecycle hook (e.g. UserPromptSubmit)
  record-touched         Local-only: append an edit hook's touched files to the session log
  changes                Local-only: preflight — print classified mine/claimed/unclaimed
                         paths and drafted rationales before delivering; run this instead
                         of hand-triaging \`git status\`
  read-context           Read shared persistent context for this mission
  write-context          Write shared persistent context for future sessions
  attachment-list        List all attachments for the mission
  attachment-download-url  Get the download URL for a specific attachment

Runner queue (management commands, not protocol):
  ${primaryCommand} runner once|start|status|clear|clear-all [--branch <name>] [--no-worktree]
  ${primaryCommand} launch <agent> --mission-id <missionId> [--branch <name>] [--no-worktree]

Environment fallback:
  --session-key  <- SESSION_KEY printed on stderr after attach/connect/prompt/resume-follow-up
  --mission-id    <- mission display id (e.g. coo:8) or UUID
  backend URL    <- overlord.toml backend_url, OVERLORD_BACKEND_URL, or dev OVERLORD_BACKEND_URL_DEV
  auth token     <- OVERLORD_USER_TOKEN, OVLD_USER_TOKEN, or USER_TOKEN

Common flags:
  --mission-id <id>         Mission identifier when operating on an existing mission
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
    Create the working session for an agent on an existing mission. Call this first.
  Required:
    --mission-id <id>            Display id (e.g. coo:8) or UUID
  Optional:
    --session-key <key>         Reuse an existing session key
    --agent <identifier>
    --model <identifier>
    --execution-request-id <id> Link this attach to a runner execution request
    --external-session-id <id>  Native agent thread/session id for resume
  Returns:
    Full JSON including session.sessionKey, mission, history, artifacts, sharedState,
    and agentInstructions with required workflow instructions and structured-field pointers.
  Notes:
    The client CLI records a VCS baseline at attach so deliver can report the
    run-attributable changed-file delta automatically.

connect:
  Purpose:
    Create a lightweight session when you only need a session key, not full context.
  Required:
    --mission-id <id>
  Optional:
    --agent <identifier>
    --external-session-id <id>
  Returns:
    Session JSON and SESSION_KEY on stderr when available.

load-context:
  Purpose:
    Read mission details without creating a session.
  Required:
    --mission-id <id>

search-missions:
  Purpose:
    Find missions by keyword, status, or project.
  Optional:
    --query <text>              Free-text search
    --status <csv>              Comma-separated statuses (e.g. next-up,execute)
    --project-id <id>           Restrict to one project
    --limit <n>                 Max results (default: 25)
  Returns:
    JSON with matching missions.

discuss-objective:
  Purpose:
    Mark the latest draft objective as submitted. Does not start execution — use attach.
  Required:
    --mission-id <id>

add-objectives:
  Purpose:
    Append ordered objectives to an existing mission.
  Required:
    --mission-id <id>
    --objectives-json <json> or --objectives-file <path|->

create:
  Purpose:
    Create a draft mission without attaching.
  Required:
    --objective "<text>" or --objectives-json / --objectives-file <path|->
  Optional:
    --title <text>
    --project-id <id>           Skips working-directory project resolution

prompt:
  Purpose:
    Create a mission and attach to it in one call.
  Required:
    --objective "<text>" or --objectives-json / --objectives-file <path|->
  Optional:
    --title <text>
    --project-id <id>
    --agent <identifier>
    --model <identifier>
    --external-session-id <id>
  Returns:
    New mission/session JSON plus SESSION_KEY on stderr when available.

record-work:
  Purpose:
    Record work already completed in chat as a mission in review without a session.
    Use instead of create + attach + deliver when logging past work.
  Required:
    --objective "<text>" (or positional objective text)
    --summary or --summary-file <path|->
  Optional:
    --title <text>
    --project-id <id>
    --artifacts-json / --artifacts-file <path|->
    --change-rationales-json / --change-rationales-file <path|->
  Notes:
    Change-rationale entries use the same shape documented under \`deliver\`
    (file_path, label, summary, why, impact; summary is named "summary", not "rationale").

update:
  Purpose:
    Post progress or activity events during execution.
  Required:
    --session-key <key>
    --mission-id <id>
    --summary or --summary-file <path|->
  Optional:
    --phase draft | execute | review | deliver | complete | blocked | cancelled
    --event-type update | user_follow_up | alert | discussion_summary | decision
    --begin-follow-up-work      Reopen a delivered/review mission for execution
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
    Change-rationale entries use the same shape documented under \`deliver\`
    (file_path, label, summary, why, impact; summary is named "summary", not "rationale").

heartbeat:
  Purpose:
    Send a liveness ping without creating a mission event.
  Required:
    --session-key <key>
    --mission-id <id>
  Optional:
    --phase <phase>
    --note <text>

ask:
  Purpose:
    Raise a blocking question for a human reviewer. Stop work after ask succeeds.
  Required:
    --session-key <key>
    --mission-id <id>
    --question or --question-file <path|->

deliver:
  Purpose:
    Conclude the session and submit the final narrative plus artifacts/change rationales.
  Required:
    --session-key <key>
    --mission-id <id>
    --summary or --summary-file <path|->
    or: --payload-json / --payload-file <path|-> with { summary, artifacts, changeRationales }
  Optional:
    --artifacts-json / --artifacts-file <path|->
    --change-rationales-json / --change-rationales-file <path|->
    --changed-files-json / --changed-files-file <path|->
    --no-file-changes             Assert this run changed no files
    --skip-rationale-for-json / --skip-rationale-for-file <path|->
    --verification-summary <text>
    --follow-up-notes <text>
  Change-rationale entry shape (each item in --change-rationales-json / -file):
    {
      "file_path": "src/api.ts",   // required. repo-relative path. "filePath" also accepted; no "path" field.
      "label":     "Add retry",     // required. short reviewer-facing title.
      "summary":   "Added retry.",  // required. WHAT changed. The field is named "summary", NOT "rationale".
      "why":       "Flaky calls.",  // required. WHY it changed.
      "impact":    "Retries 3x.",   // required. behavioral impact.
      "hunks":     [{ "header": "@@ -10,6 +10,14 @@" }]  // optional.
    }
    Pass an array of these. Do NOT wrap entries under a "rationale" key and do not send a
    top-level "file_changes" artifact. label/summary/why/impact must be non-empty strings.
  Skip-rationale-for entry shape (each item in --skip-rationale-for-json / -file):
    {
      "file_path": "webapp/package.json",  // required. repo-relative path. "filePath" also accepted.
      "reason":    "Concurrent host-side edit; not made by this mission."
    }
    Use when deliver would fail missing_rationale for a file you did not change. Do not
    fabricate a change rationale and do not revert the file.
  Notes:
    Changed files are captured mechanically: the CLI records a VCS baseline at attach
    and injects the run-attributable delta at deliver. Meaningful tracked changes
    require rationales unless --no-file-changes is passed or the file is listed in
    --skip-rationale-for-*. Do not continue
    implementation after delivery without explicit follow-up.
    Inline --*-json values larger than ~8 KB are rejected; use --change-rationales-file -
    (or --payload-file -) and stream JSON on stdin. Keep --summary inline.
    Run \`${primaryCommand} protocol changes --mission-id <id>\` first instead of hand-
    triaging \`git status\` — it prints the same mine/claimed/unclaimed classification
    deliver uses, plus drafted rationales. If deliver still rejects with
    missing_rationale, the error includes a per-path classification and a ready-to-use
    --skip-rationale-for-json value for every non-'mine' path — one mechanical retry.

changes:
  Purpose:
    Local-only preflight: print every currently dirty path classified as 'mine'
    (confirmed by this session's touched-files log), 'claimed' (confirmed by another
    active session's log), or 'unclaimed' (dirty, but confirmed by nobody), plus
    draft rationales from local edit notes and ready-to-use --skip-rationale-for-json
    entries for 'claimed' paths. Makes no backend call; safe to run at any time.
  Required:
    --mission-id <id>

resume-follow-up:
  Purpose:
    Reopen a completed objective for post-delivery implementation follow-up.
  Required:
    --mission-id <id>
  Optional:
    --objective-id <id>
    --agent <identifier>
    --model <identifier>
    --summary or --summary-file <path|->
    --external-session-id <id>
  Returns:
    attach-response-v3 JSON with a new session key.

hook-event:
  Purpose:
    Record a connector lifecycle hook without requiring a live session key.
  Required:
    --hook-type UserPromptSubmit
    --mission-id <id>
  Optional:
    --prompt or --prompt-file <path|->
    --session-key <key>
    --external-session-id <id>
    --turn-index <n>

read-context:
  Purpose:
    Read persistent shared context written by earlier sessions.
  Required:
    --mission-id <id>
  Optional:
    --key <substring>           Filter by key substring
    --limit <n>                 Max entries (default: 50)

write-context:
  Purpose:
    Save shared facts for future sessions.
  Required:
    --mission-id <id>
    --key <name>
    --value <text> or --value-json / --value-file <path|->

attachment-list:
  Purpose:
    List all attachments for the mission (across all objectives).
    Each entry includes id, filename, mimeType, sizeBytes, status, storageKey, and url.
    The url field is a server-relative path; prepend the backend base URL to download.
  Required:
    --mission-id <id>

attachment-download-url:
  Purpose:
    Return the download URL for a specific attachment on the mission.
  Required:
    --mission-id <id>
    --attachment-id <id>  (use the id from attachment-list output)

list-organizations:
  Purpose:
    Legacy name predating the real organizations hierarchy (coo:135) — despite the
    name, returns only the caller's current *workspace* context, not organization
    data. Kept as-is to avoid a breaking protocol rename.
  Returns:
    JSON array with a single { id, slug, name } entry for the active workspace.

Supported subcommands: ${subcommands}
Run \`${primaryCommand} help\` for management commands and \`${primaryCommand} protocol help\` for this reference.
`);
}
