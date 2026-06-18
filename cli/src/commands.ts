import { readFileSync } from 'node:fs';

import {
  flagBoolean,
  flagValue,
  parseArgs,
  rejectOversizedInlineJson,
  requireFlag
} from './args.js';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import { launchAgent } from './launch.js';
import { resolveNativeSessionId } from './native-session.js';
import { printJson, printKeyValue } from './output.js';
import { pruneStaleProjectTmp } from './project-tmp.js';
import { printProtocolHelp } from './protocol-help.js';
import type { CliRuntime } from './runtime.js';
import { promptForProject } from './select-prompt.js';
import type { TerminalLaunchSettings } from './terminal-launcher.js';
import { fetchTerminalProfile, terminalProfileToLaunchSettings } from './terminal-profile.js';
import {
  computeRunDelta,
  filterRunAttributableChanges,
  readChangedFiles,
  resetTouchedFiles,
  writeBaseline
} from './vcs.js';

type ChangedFileEntry = { filePath: string; vcsStatus?: string | null };

/** Parse an inline `--changed-files-json` value into entries (best-effort). */
function parseChangedFilesJson(value: unknown): ChangedFileEntry[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ChangedFileEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ChangedFileEntry).filePath === 'string'
    );
  } catch {
    return [];
  }
}

/** Read `--changed-files-json` or `--changed-files-file` entries (best-effort). */
function readChangedFilesFromFlags(
  flags: Record<string, string | true>,
  stdin?: string
): ChangedFileEntry[] {
  const fileFlag = flags['--changed-files-file'];
  if (typeof fileFlag === 'string') {
    const raw =
      fileFlag === '-'
        ? (stdin ?? '')
        : (() => {
            try {
              return readFileSync(fileFlag, 'utf8');
            } catch {
              return '';
            }
          })();
    return parseChangedFilesJson(raw);
  }
  return parseChangedFilesJson(flags['--changed-files-json']);
}

function writeFilteredChangedFilesToFlags({
  flags,
  files
}: {
  flags: Record<string, string | true>;
  files: ChangedFileEntry[];
}): void {
  delete flags['--changed-files-file'];
  if (files.length === 0) {
    delete flags['--changed-files-json'];
    return;
  }
  flags['--changed-files-json'] = JSON.stringify(files);
}

/**
 * Filter protocol changed-file payloads so only run-attributable paths (not in
 * the session baseline) are sent. At deliver, also merges the VCS delta when the
 * agent did not enumerate files.
 */
function applySessionChangedFiles({
  flags,
  workingDirectory,
  ticketId,
  subcommand,
  stdin
}: {
  flags: Record<string, string | true>;
  workingDirectory: string;
  ticketId: string;
  subcommand: string;
  stdin?: string;
}): void {
  const noFileChanges =
    subcommand === 'deliver' &&
    (flags['--no-file-changes'] === true || flags['--no-file-changes'] === 'true');
  const delta = computeRunDelta({ workingDirectory, ticketId });

  if (noFileChanges) {
    if (delta.length > 0) {
      console.error(
        `[overlord] --no-file-changes was set, but VCS shows ${delta.length} changed file(s) for this run: ${delta
          .map(entry => entry.filePath)
          .join(', ')}`
      );
    }
    delete flags['--changed-files-json'];
    delete flags['--changed-files-file'];
    return;
  }

  const hasExplicitPayload = '--changed-files-json' in flags || '--changed-files-file' in flags;
  if (subcommand === 'update' && !hasExplicitPayload) return;

  const explicit = readChangedFilesFromFlags(flags, stdin);
  const merged = subcommand === 'deliver' ? (hasExplicitPayload ? explicit : delta) : explicit;
  const attributable = filterRunAttributableChanges({
    workingDirectory,
    ticketId,
    files: merged.map(entry => ({
      filePath: entry.filePath,
      vcsStatus: entry.vcsStatus ?? 'changed'
    }))
  }).map(entry => ({
    filePath: entry.filePath,
    vcsStatus: entry.vcsStatus
  }));

  writeFilteredChangedFilesToFlags({ flags, files: attributable });
}

type JsonRecord = Record<string, unknown>;

function repeatedFlagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value !== undefined) {
      values.push(value);
      index += 1;
    }
  }
  return values;
}

async function resolveTerminalLaunchSettings({
  runtime,
  flags
}: {
  runtime: CliRuntime;
  flags: Map<string, string | true>;
}): Promise<TerminalLaunchSettings> {
  if (flagBoolean(flags, '--no-terminal')) {
    return { terminalLauncher: null };
  }

  const override = flagValue(flags, '--terminal');
  if (override) {
    try {
      const profile = await fetchTerminalProfile({ backend: runtime.backend });
      return {
        terminalLauncher: override,
        terminalLaunchPlacement: profile.placement,
        terminalLaunchChord: profile.chord
      };
    } catch {
      return { terminalLauncher: override };
    }
  }

  try {
    const profile = await fetchTerminalProfile({ backend: runtime.backend });
    return terminalProfileToLaunchSettings(profile);
  } catch {
    return { terminalLauncher: null };
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? (value as JsonRecord) : {};
}

function firstObjectiveId(ticket: unknown): string | undefined {
  const objectives = asRecord(ticket).objectives;
  if (!Array.isArray(objectives)) return undefined;
  const first = objectives[0];
  const id = asRecord(first).id;
  return typeof id === 'string' ? id : undefined;
}

function ticketDisplayId(ticket: unknown): string {
  const record = asRecord(ticket);
  return typeof record.displayId === 'string'
    ? record.displayId
    : typeof record.id === 'string'
      ? record.id
      : 'unknown';
}

const PROTOCOL_FILE_FLAGS = [
  '--summary-file',
  '--question-file',
  '--payload-file',
  '--artifacts-file',
  '--change-rationales-file',
  '--objectives-file',
  '--changed-files-file',
  '--value-file',
  '--prompt-file'
] as const;

/** Read piped stdin or a `--*-file` path into the protocol request `stdin` field. */
async function resolveProtocolStdin({
  flags,
  stdin
}: {
  flags: Map<string, string | true>;
  stdin?: string;
}): Promise<string | undefined> {
  if (stdin !== undefined) return stdin;

  for (const flagName of PROTOCOL_FILE_FLAGS) {
    const filePath = flagValue(flags, flagName);
    if (!filePath) continue;
    if (filePath === '-') {
      if (process.stdin.isTTY) return undefined;
      return readFileSync(0, 'utf8');
    }
    return readFileSync(filePath, 'utf8');
  }

  return undefined;
}

async function discoverProjectId(runtime: CliRuntime, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const projects = await runtime.backend.get<unknown[]>('/api/projects');
  const first = projects[0];
  const id = asRecord(first).id;
  if (typeof id !== 'string') {
    throw new CliError({ message: 'No project found. Create one with `ovld create-project`.' });
  }
  return id;
}

export async function runProtocolCommand({
  runtime,
  subcommand,
  args,
  stdin,
  primaryCommand = 'ovld'
}: {
  runtime: CliRuntime;
  subcommand: string;
  args: string[];
  stdin?: string;
  primaryCommand?: string;
}): Promise<void> {
  const parsed = parseArgs(args);
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printProtocolHelp({ primaryCommand });
    return;
  }

  rejectOversizedInlineJson({ flags: parsed.flags });

  const workingDirectory = process.cwd();
  const ticketId = flagValue(parsed.flags, '--ticket-id') ?? parsed.positional[0];
  const flags = Object.fromEntries(parsed.flags);
  const protocolStdin = await resolveProtocolStdin({ flags: parsed.flags, stdin });

  pruneStaleProjectTmp({ workingDirectory });

  // Client-side VCS capture: read git status here (the agent's machine), never on
  // the backend. Filter explicit payloads and, at deliver, merge the run delta.
  if ((subcommand === 'deliver' || subcommand === 'update') && ticketId) {
    applySessionChangedFiles({
      flags,
      workingDirectory,
      ticketId,
      subcommand,
      stdin: protocolStdin
    });
  }

  const result = await runtime.backend.post<unknown>({
    path: `/api/protocol/${encodeURIComponent(subcommand)}`,
    body: {
      args,
      positional: parsed.positional,
      flags,
      stdin: protocolStdin,
      externalSessionId:
        flagValue(parsed.flags, '--external-session-id') ??
        resolveNativeSessionId({
          explicit: undefined,
          agent: flagValue(parsed.flags, '--agent') ?? 'unknown',
          ticketId: flagValue(parsed.flags, '--ticket-id') ?? 'unknown',
          workingDirectory
        })
    }
  });

  // Record the dirty-file baseline once a work session begins, so deliver can
  // subtract pre-existing/concurrent changes from this run's reported delta.
  if ((subcommand === 'attach' || subcommand === 'resume-follow-up') && ticketId) {
    writeBaseline({
      workingDirectory,
      ticketId,
      files: readChangedFiles(workingDirectory)
    });
    resetTouchedFiles({ workingDirectory, ticketId });
  }

  const resultRecord = asRecord(result);
  if (typeof resultRecord.sessionKey === 'string') {
    printKeyValue({ SESSION_KEY: resultRecord.sessionKey });
  }
  if (typeof resultRecord.ticketId === 'string') {
    printKeyValue({ TICKET_ID: resultRecord.ticketId });
  }
  printJson(result);
}

export async function runManagementCommand({
  runtime,
  command,
  rest
}: {
  runtime?: CliRuntime;
  command: string;
  rest: string[];
}): Promise<void> {
  if (!runtime) throw new CliError({ message: `Command requires a backend: ${command}` });

  const parsed = parseArgs(rest);
  const json = flagBoolean(parsed.flags, '--json');

  switch (command) {
    case 'create-project': {
      const name = flagValue(parsed.flags, '--name') ?? parsed.positional.join(' ');
      if (!name) throw new CliError({ message: 'Missing --name' });
      const project = await runtime.backend.post<unknown>({
        path: '/api/projects',
        body: { name }
      });
      const projectId = asRecord(project).id;
      if (!flagBoolean(parsed.flags, '--no-directory') && typeof projectId === 'string') {
        await runtime.backend.post({
          path: `/api/projects/${encodeURIComponent(projectId)}/resources`,
          body: {
            directoryPath: flagValue(parsed.flags, '--directory') ?? process.cwd(),
            isPrimary: true
          }
        });
      }
      if (json) printJson({ project });
      else
        console.log(
          `Created project ${asRecord(project).name ?? name} (${projectId ?? 'unknown'})`
        );
      return;
    }
    case 'add-cwd': {
      const directory = flagValue(parsed.flags, '--directory') ?? process.cwd();
      let projectId = flagValue(parsed.flags, '--project-id');
      if (!projectId) {
        const projects =
          await runtime.backend.get<Array<{ id: string; name: string; slug: string }>>(
            '/api/projects'
          );
        if (projects.length === 0) {
          throw new CliError({
            message: 'No project found. Create one with `ovld create-project`.'
          });
        }
        if (process.stdin.isTTY) {
          const chosen = await promptForProject({ projects, directoryPath: directory });
          if (!chosen) {
            console.log('Cancelled. No changes made.');
            return;
          }
          projectId = chosen.id;
        } else {
          projectId = projects[0]?.id;
        }
      }
      if (!projectId) throw new CliError({ message: 'No project selected.' });
      const resource = await runtime.backend.post({
        path: `/api/projects/${encodeURIComponent(projectId)}/resources`,
        body: {
          directoryPath: directory,
          isPrimary: flagValue(parsed.flags, '--primary') !== 'false'
        }
      });
      if (json) printJson({ resource });
      else console.log(`Linked ${directory} to project ${projectId}`);
      return;
    }
    case 'create':
    case 'prompt': {
      const objectivesJson = flagValue(parsed.flags, '--objectives-json');
      const objective =
        parsed.positional.join(' ') ||
        flagValue(parsed.flags, '--objective') ||
        flagValue(parsed.flags, '--prompt');
      const projectId = await discoverProjectId(runtime, flagValue(parsed.flags, '--project-id'));
      const objectives = objectivesJson
        ? (JSON.parse(objectivesJson) as Array<{
            objective: string;
            title?: string | null;
            autoAdvance?: boolean;
          }>)
        : objective
          ? [{ objective, title: flagValue(parsed.flags, '--title') ?? null }]
          : [];
      const first = objectives[0];
      if (!first) {
        throw new CliError({
          message: objectivesJson
            ? 'objectives-json must contain at least one objective'
            : 'Missing objective prompt text'
        });
      }

      const title = flagValue(parsed.flags, '--title') ?? first.title ?? first.objective;
      const ticket = await runtime.backend.post<unknown>({
        path: '/api/tickets',
        body: {
          projectId,
          title,
          objectives
        }
      });
      if (objectivesJson) {
        const ticketObjectives = asRecord(ticket).objectives;
        if (Array.isArray(ticketObjectives) && ticketObjectives.length !== objectives.length) {
          throw new CliError({
            message: `Backend created ${ticketObjectives.length} objective(s), expected ${objectives.length}`
          });
        }
      }
      if (command === 'prompt') {
        const objectiveId = firstObjectiveId(ticket);
        if (objectiveId) {
          await runtime.backend.post({
            path: `/api/objectives/${encodeURIComponent(objectiveId)}/launch`,
            body: { agent: flagValue(parsed.flags, '--agent') ?? 'unknown' }
          });
        }
      }
      if (json) printJson(ticket);
      else console.log(`Created ticket ${ticketDisplayId(ticket)}`);
      return;
    }
    case 'attach':
    case 'execution': {
      const ticketId =
        command === 'attach'
          ? (parsed.positional[0] ?? flagValue(parsed.flags, '--ticket-id'))
          : requireFlag(parsed.flags, '--ticket-id');
      const agent = parsed.positional[1] ?? flagValue(parsed.flags, '--agent') ?? 'codex';
      if (!ticketId) throw new CliError({ message: 'Usage: ovld attach <ticketId> [agent]' });
      const ticket = await runtime.backend.get<unknown>(
        `/api/tickets/${encodeURIComponent(ticketId)}`
      );
      const objectiveId = flagValue(parsed.flags, '--objective-id') ?? firstObjectiveId(ticket);
      if (!objectiveId)
        throw new CliError({ message: `No launchable objective found for ${ticketId}` });
      const request = await runtime.backend.post({
        path: `/api/objectives/${encodeURIComponent(objectiveId)}/launch`,
        body: {
          agent,
          model: flagValue(parsed.flags, '--model'),
          reasoningEffort: flagValue(parsed.flags, '--thinking')
        }
      });
      if (json) printJson({ request });
      else console.log(`Queued ${agent} for ${ticketDisplayId(ticket)}`);
      return;
    }
    case 'launch':
    case 'restart':
    case 'run':
    case 'connect':
    case 'resume': {
      const agent =
        command === 'run' || command === 'connect' || command === 'resume'
          ? (flagValue(parsed.flags, '--agent') ?? parsed.positional[0] ?? 'codex')
          : parsed.positional[0];
      const ticketId =
        flagValue(parsed.flags, '--ticket-id') ??
        (command === 'run' || command === 'connect' || command === 'resume'
          ? parsed.positional[1]
          : parsed.positional[1]);
      if (!agent || !ticketId) {
        throw new CliError({ message: `Usage: ovld ${command} <agent> --ticket-id <ticketId>` });
      }
      const workingDirectory = flagValue(parsed.flags, '--working-directory') ?? process.cwd();
      const terminal = await resolveTerminalLaunchSettings({ runtime, flags: parsed.flags });
      const result = await launchAgent({
        runtime,
        options: {
          agent,
          ticketId,
          workingDirectory,
          model: flagValue(parsed.flags, '--model'),
          thinking: flagValue(parsed.flags, '--thinking'),
          flags: repeatedFlagValues(rest, '--flag'),
          preCommand: flagValue(parsed.flags, '--pre-command'),
          ...terminal,
          dryRun: flagBoolean(parsed.flags, '--dry-run')
        }
      });
      if (json || flagBoolean(parsed.flags, '--dry-run')) {
        printJson({ plan: result.plan, status: result.status, signal: result.signal });
      }
      if (result.status && result.status !== 0) {
        throw new CliError({ message: `Launch command exited with status ${result.status}` });
      }
      return;
    }
    case 'runner': {
      await runRunnerCommand({ runtime, parsed, json });
      return;
    }
    case 'tickets': {
      const sub = parsed.positional[0];
      if (sub !== 'list') {
        throw new CliError({
          message: 'Usage: ovld tickets list [--status <csv>] [--project-id <id>] [--json]'
        });
      }
      const params = new URLSearchParams();
      const query = flagValue(parsed.flags, '--query');
      const projectId = flagValue(parsed.flags, '--project-id');
      const limit = flagValue(parsed.flags, '--limit');
      if (query) params.set('q', query);
      if (projectId) params.set('projectId', projectId);
      if (limit) params.set('limit', limit);
      const result = await runtime.backend.get<{ tickets: unknown[] }>(
        `/api/tickets/search?${params}`
      );
      const tickets = result.tickets;
      if (json) printJson({ tickets });
      else {
        for (const ticket of tickets) {
          const record = asRecord(ticket);
          console.log(
            `${record.displayId ?? record.id}\t${record.statusType ?? ''}\t${record.title ?? ''}`
          );
        }
      }
      return;
    }
    case 'ticket': {
      const sub = parsed.positional[0];
      const ticketId = parsed.positional[1];
      if (!ticketId) {
        throw new CliError({
          message:
            'Usage: ovld ticket context|events|deliveries|artifacts|rationales <ticketId> [--json]'
        });
      }
      const pathBySub: Record<string, string> = {
        context: `/api/tickets/${encodeURIComponent(ticketId)}`,
        events: `/api/tickets/${encodeURIComponent(ticketId)}/events`,
        artifacts: `/api/tickets/${encodeURIComponent(ticketId)}/artifacts`,
        rationales: `/api/tickets/${encodeURIComponent(ticketId)}/file-changes`,
        deliveries: `/api/tickets/${encodeURIComponent(ticketId)}/events`
      };
      const path = sub ? pathBySub[sub] : undefined;
      if (!path) {
        throw new CliError({
          message:
            'Usage: ovld ticket context|events|deliveries|artifacts|rationales <ticketId> [--json]'
        });
      }
      const result = await runtime.backend.get<unknown>(path);
      if (json || sub === 'context') printJson(result);
      else if (Array.isArray(result)) for (const row of result) console.log(JSON.stringify(row));
      else printJson(result);
      return;
    }
    case 'changes': {
      const sub = parsed.positional[0];
      const ticketId = requireFlag(parsed.flags, '--ticket-id');
      if (sub !== 'status' && sub !== 'rationales') {
        throw new CliError({ message: 'Usage: ovld changes status|rationales --ticket-id <id>' });
      }
      const result = await runtime.backend.get<unknown[]>(
        `/api/tickets/${encodeURIComponent(ticketId)}/file-changes`
      );
      if (json) printJson({ files: result, rationales: result });
      else for (const row of result) console.log(JSON.stringify(row));
      return;
    }
    default:
      throw new CliError({ message: `Unknown command: ${command}` });
  }
}

async function runRunnerCommand({
  runtime,
  parsed,
  json
}: {
  runtime: CliRuntime;
  parsed: ReturnType<typeof parseArgs>;
  json: boolean;
}): Promise<void> {
  const sub = parsed.positional[0] ?? 'status';
  if (sub === 'status') {
    const result = await runtime.backend.get<unknown>('/api/runner/status');
    if (json) printJson(result);
    else printJson(result);
    return;
  }
  if (sub === 'clear' || sub === 'clear-all') {
    const result = await runtime.backend.post({
      path: '/api/runner/clear',
      body: {
        objectiveId: sub === 'clear' ? parsed.positional[1] : undefined,
        projectId: flagValue(parsed.flags, '--project-id')
      }
    });
    if (json) printJson(result);
    else console.log(`Cleared ${asRecord(result).cleared ?? 0} execution request(s).`);
    return;
  }
  if (sub !== 'once' && sub !== 'start') {
    throw new CliError({
      message: 'Usage: ovld runner once|start|status|clear <objective_id>|clear-all'
    });
  }

  const runOnce = async (): Promise<boolean> => {
    const claim = await runtime.backend.post<unknown>({
      path: '/api/runner/claim',
      body: { projectId: flagValue(parsed.flags, '--project-id') }
    });
    const request = asRecord(claim).request;
    if (!request) return false;
    const requestRecord = asRecord(request);
    const requestId = String(requestRecord.id);
    await runtime.backend.post({ path: `/api/runner/requests/${requestId}/launching` });
    try {
      const launchConfig = asRecord(requestRecord.launchConfig);
      const terminal = await resolveTerminalLaunchSettings({ runtime, flags: parsed.flags });
      const result = await launchAgent({
        runtime,
        options: {
          agent: String(requestRecord.requestedAgent ?? 'codex'),
          ticketId: String(requestRecord.ticketId),
          workingDirectory: String(requestRecord.workingDirectory ?? process.cwd()),
          model:
            typeof requestRecord.requestedModel === 'string'
              ? requestRecord.requestedModel
              : undefined,
          thinking:
            typeof requestRecord.requestedReasoningEffort === 'string'
              ? requestRecord.requestedReasoningEffort
              : undefined,
          flags: Array.isArray(launchConfig.flags)
            ? launchConfig.flags.filter((value): value is string => typeof value === 'string')
            : [],
          preCommand:
            typeof launchConfig.preCommand === 'string' ? launchConfig.preCommand : undefined,
          ...terminal,
          dryRun: flagBoolean(parsed.flags, '--dry-run')
        }
      });
      if (result.status && result.status !== 0) {
        await runtime.backend.post({
          path: `/api/runner/requests/${requestId}/failed`,
          body: { error: `Launch command exited with status ${result.status}` }
        });
        throw new CliError({ message: `Launch command exited with status ${result.status}` });
      }
      await runtime.backend.post({ path: `/api/runner/requests/${requestId}/launched` });
      if (json || flagBoolean(parsed.flags, '--dry-run')) {
        printJson({ request, plan: result.plan, status: result.status });
      } else {
        console.log(
          `Launched ${requestRecord.requestedAgent ?? 'codex'} for ${requestRecord.ticketId}`
        );
      }
      return true;
    } catch (error) {
      await runtime.backend.post({
        path: `/api/runner/requests/${requestId}/failed`,
        body: { error: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  };

  if (sub === 'once') {
    const launched = await runOnce();
    if (!launched) {
      if (json) printJson({ launched: false });
      else console.log('No claimable execution requests.');
    }
    return;
  }

  const intervalMs = Number.parseInt(flagValue(parsed.flags, '--poll-interval-ms') ?? '3000', 10);
  if (!json) console.log(`Runner started. Polling every ${intervalMs}ms for execution requests.`);
  while (true) {
    await runOnce();
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
