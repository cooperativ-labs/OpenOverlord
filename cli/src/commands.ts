import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  flagBoolean,
  flagValue,
  parseArgs,
  rejectOversizedInlineJson,
  requireFlag
} from './args.js';
import { type BranchAutomationPayload, prepareMissionBranch } from './branch-preparation.js';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import { clientDeviceIdentity } from './device-identity.js';
import { launchAgent } from './launch.js';
import { resolveNativeSessionId } from './native-session.js';
import { printJson, printKeyValue } from './output.js';
import { pruneStaleProjectTmp } from './project-tmp.js';
import { printProtocolHelp } from './protocol-help.js';
import type { CliRuntime } from './runtime.js';
import { promptForProject } from './select-prompt.js';
import {
  clearCachedSessionKey,
  readCachedSessionKey,
  writeCachedSessionKey
} from './session-key.js';
import type { TerminalLaunchSettings } from './terminal-launcher.js';
import { fetchTerminalProfile, terminalProfileToLaunchSettings } from './terminal-profile.js';
import {
  computeRunDelta,
  draftChangeRationalesFromNotes,
  filterRunAttributableChanges,
  readChangedFiles,
  resetRationaleNotes,
  resetTouchedFiles,
  writeBaseline
} from './vcs.js';

type ChangedFileEntry = { filePath: string; vcsStatus?: string | null };
type ChangeRationaleEntry = {
  file_path?: string;
  filePath?: string;
  label?: string;
  summary?: string;
  why?: string;
  impact?: string;
  [key: string]: unknown;
};
type SkipRationaleEntry = {
  file_path?: string;
  filePath?: string;
  reason?: string;
  [key: string]: unknown;
};

const PROJECT_JSON_VERSION = 1;

function writeProjectJson({
  directoryPath,
  projectId,
  resourceId,
  isPrimary
}: {
  directoryPath: string;
  projectId: string;
  resourceId: string;
  isPrimary: boolean;
}): void {
  const overlordDir = path.join(directoryPath, '.overlord');
  mkdirSync(overlordDir, { recursive: true });
  mkdirSync(path.join(overlordDir, 'tmp'), { recursive: true });
  mkdirSync(path.join(overlordDir, 'logs'), { recursive: true });
  writeFileSync(
    path.join(overlordDir, 'project.json'),
    `${JSON.stringify(
      {
        version: PROJECT_JSON_VERSION,
        projectId,
        resourceId,
        isPrimary,
        linkedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  );
}

function writeProjectJsonFromResource({
  directory,
  projectId,
  resource
}: {
  directory: string;
  projectId: string;
  resource: unknown;
}): void {
  const record = asRecord(resource);
  if (typeof record.id !== 'string') return;
  writeProjectJson({
    directoryPath: directory,
    projectId,
    resourceId: record.id,
    isPrimary: record.isPrimary !== false
  });
}

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

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readJsonFlagContent({
  flags,
  fileInputs,
  jsonFlag,
  fileFlag
}: {
  flags: Record<string, string | true>;
  fileInputs: Record<string, string>;
  jsonFlag: string;
  fileFlag: string;
}): string | undefined {
  const filePath = flags[fileFlag];
  if (typeof filePath === 'string') {
    if (fileInputs[fileFlag] !== undefined) return fileInputs[fileFlag];
    try {
      return readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }
  return typeof flags[jsonFlag] === 'string' ? flags[jsonFlag] : undefined;
}

function readChangeRationalesFromFlags({
  flags,
  fileInputs
}: {
  flags: Record<string, string | true>;
  fileInputs: Record<string, string>;
}): ChangeRationaleEntry[] {
  const direct = parseJsonArray(
    readJsonFlagContent({
      flags,
      fileInputs,
      jsonFlag: '--change-rationales-json',
      fileFlag: '--change-rationales-file'
    })
  ).filter((entry): entry is ChangeRationaleEntry => typeof entry === 'object' && entry !== null);

  const payloadRaw = readJsonFlagContent({
    flags,
    fileInputs,
    jsonFlag: '--payload-json',
    fileFlag: '--payload-file'
  });
  let payloadRationales: ChangeRationaleEntry[] = [];
  if (payloadRaw) {
    try {
      const payload = JSON.parse(payloadRaw) as { changeRationales?: unknown };
      payloadRationales = Array.isArray(payload.changeRationales)
        ? payload.changeRationales.filter(
            (entry): entry is ChangeRationaleEntry => typeof entry === 'object' && entry !== null
          )
        : [];
    } catch {
      payloadRationales = [];
    }
  }

  return [...payloadRationales, ...direct];
}

function rationalePath(rationale: ChangeRationaleEntry): string {
  return (rationale.file_path ?? rationale.filePath ?? '').replace(/\\/g, '/').trim();
}

function readSkipRationaleForFromFlags({
  flags,
  fileInputs
}: {
  flags: Record<string, string | true>;
  fileInputs: Record<string, string>;
}): SkipRationaleEntry[] {
  return parseJsonArray(
    readJsonFlagContent({
      flags,
      fileInputs,
      jsonFlag: '--skip-rationale-for-json',
      fileFlag: '--skip-rationale-for-file'
    })
  ).filter((entry): entry is SkipRationaleEntry => typeof entry === 'object' && entry !== null);
}

function skipRationalePath(entry: SkipRationaleEntry): string {
  return (entry.file_path ?? entry.filePath ?? '').replace(/\\/g, '/').trim();
}

/**
 * Filter protocol changed-file payloads so only run-attributable paths (not in
 * the session baseline) are sent. At deliver, merge explicit payloads with the
 * VCS delta so a partial explicit list does not suppress mechanically observed
 * files.
 */
function applySessionChangedFiles({
  flags,
  workingDirectory,
  missionId,
  subcommand,
  stdin,
  fileInputs = {}
}: {
  flags: Record<string, string | true>;
  workingDirectory: string;
  missionId: string;
  subcommand: string;
  stdin?: string;
  fileInputs?: Record<string, string>;
}): void {
  const noFileChanges =
    subcommand === 'deliver' &&
    (flags['--no-file-changes'] === true || flags['--no-file-changes'] === 'true');
  const delta = computeRunDelta({ workingDirectory, missionId });

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
  const merged =
    subcommand === 'deliver'
      ? [...explicit, ...delta].filter(
          (entry, index, all) => all.findIndex(item => item.filePath === entry.filePath) === index
        )
      : explicit;
  const attributable = filterRunAttributableChanges({
    workingDirectory,
    missionId,
    files: merged.map(entry => ({
      filePath: entry.filePath,
      vcsStatus: entry.vcsStatus ?? 'changed'
    }))
  }).map(entry => ({
    filePath: entry.filePath,
    vcsStatus: entry.vcsStatus
  }));

  const skipPaths =
    subcommand === 'deliver'
      ? new Set(
          readSkipRationaleForFromFlags({ flags, fileInputs })
            .map(skipRationalePath)
            .filter(Boolean)
        )
      : new Set<string>();
  const filtered =
    skipPaths.size > 0
      ? attributable.filter(entry => !skipPaths.has(entry.filePath))
      : attributable;

  writeFilteredChangedFilesToFlags({ flags, files: filtered });
}

function applyDraftChangeRationales({
  flags,
  fileInputs,
  workingDirectory,
  missionId
}: {
  flags: Record<string, string | true>;
  fileInputs: Record<string, string>;
  workingDirectory: string;
  missionId: string;
}): void {
  const changedFiles = readChangedFilesFromFlags(flags, fileInputs['--changed-files-file']).map(
    entry => ({
      filePath: entry.filePath,
      vcsStatus: entry.vcsStatus ?? 'changed'
    })
  );
  if (changedFiles.length === 0) return;

  const explicitRationales = readChangeRationalesFromFlags({ flags, fileInputs });
  const covered = new Set(explicitRationales.map(rationalePath).filter(Boolean));
  const drafts = draftChangeRationalesFromNotes({
    workingDirectory,
    missionId,
    files: changedFiles
  }).filter(draft => !covered.has(draft.file_path));
  if (drafts.length === 0) return;

  const merged = [...explicitRationales, ...drafts];
  if (typeof flags['--change-rationales-file'] === 'string') {
    fileInputs['--change-rationales-file'] = JSON.stringify(merged, null, 2);
  } else {
    flags['--change-rationales-json'] = JSON.stringify(merged);
  }

  console.error(
    `[overlord] prefilled ${drafts.length} draft change rationale(s) from local edit notes.`
  );
}

type JsonRecord = Record<string, unknown>;

type LaunchSettingsShape = {
  worktreeBranchAutomationEnabled?: unknown;
};

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

async function readWorktreeBranchAutomationEnabled(runtime: CliRuntime): Promise<boolean> {
  try {
    const settings = await runtime.backend.get<LaunchSettingsShape>('/api/launch-settings');
    return settings.worktreeBranchAutomationEnabled === true;
  } catch {
    return false;
  }
}

async function recordBranchPrepared({
  runtime,
  missionId,
  requestId,
  branchAutomation
}: {
  runtime: CliRuntime;
  missionId: string;
  requestId?: string | null;
  branchAutomation: BranchAutomationPayload | null;
}): Promise<void> {
  if (!branchAutomation) return;
  await runtime.backend.post({
    path: `/api/missions/${encodeURIComponent(missionId)}/branch-prepared`,
    body: { requestId: requestId ?? null, branchAutomation }
  });
}

function firstObjectiveId(mission: unknown): string | undefined {
  const objectives = asRecord(mission).objectives;
  if (!Array.isArray(objectives)) return undefined;
  const first = objectives[0];
  const id = asRecord(first).id;
  return typeof id === 'string' ? id : undefined;
}

/** The agent already assigned to an objective on a fetched mission payload, if any. */
function objectiveAssignedAgent(mission: unknown, objectiveId: string): string | undefined {
  const objectives = asRecord(mission).objectives;
  if (!Array.isArray(objectives)) return undefined;
  const match = objectives.find(objective => asRecord(objective).id === objectiveId);
  const agent = asRecord(match).assignedAgent;
  return typeof agent === 'string' && agent.trim() ? agent.trim() : undefined;
}

function missionDisplayId(mission: unknown): string {
  const record = asRecord(mission);
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
  '--skip-rationale-for-file',
  '--objectives-file',
  '--changed-files-file',
  '--value-file',
  '--prompt-file'
] as const;

/** Protocol subcommands that require a session key the cache can auto-inject. */
const SESSION_KEY_SUBCOMMANDS = new Set([
  'update',
  'heartbeat',
  'ask',
  'deliver',
  'record-change-rationales'
]);

/**
 * Resolve EACH `--*-file` flag independently into a `fileInputs` map so multiple
 * file payloads in one invocation no longer collide on a single `stdin` field.
 * At most one flag may use literal `-` (true stdin); real file paths are unlimited.
 * The single `-` payload is also returned as `stdin` so the backend keeps honoring
 * `body.stdin` for backward compatibility.
 */
export async function resolveProtocolFileInputs({
  flags,
  stdin
}: {
  flags: Map<string, string | true>;
  stdin?: string;
}): Promise<{ fileInputs: Record<string, string>; stdin?: string }> {
  const stdinFlags = PROTOCOL_FILE_FLAGS.filter(name => flagValue(flags, name) === '-');
  if (stdinFlags.length > 1) {
    throw new CliError({
      message:
        `Only one --*-file flag may read from stdin ('-') at a time, but received: ` +
        `${stdinFlags.join(', ')}. Pipe a single payload on stdin and pass the others ` +
        `as inline values or real file paths.`
    });
  }

  let stdinContent: string | undefined;
  const readStdinOnce = (): string => {
    if (stdinContent !== undefined) return stdinContent;
    if (stdin !== undefined) {
      stdinContent = stdin;
    } else if (process.stdin.isTTY) {
      stdinContent = '';
    } else {
      stdinContent = readFileSync(0, 'utf8');
    }
    return stdinContent;
  };

  const fileInputs: Record<string, string> = {};
  let stdinPayload: string | undefined;

  for (const flagName of PROTOCOL_FILE_FLAGS) {
    const filePath = flagValue(flags, flagName);
    if (!filePath) continue;
    if (filePath === '-') {
      const content = readStdinOnce();
      fileInputs[flagName] = content;
      stdinPayload = content;
    } else {
      fileInputs[flagName] = readFileSync(filePath, 'utf8');
    }
  }

  // No file flags but a piped/explicit stdin was supplied: preserve it as the
  // single backward-compatible payload (legacy behavior).
  if (stdinPayload === undefined && stdin !== undefined && Object.keys(fileInputs).length === 0) {
    stdinPayload = stdin;
  }

  return { fileInputs, stdin: stdinPayload };
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
  const missionId = flagValue(parsed.flags, '--mission-id') ?? parsed.positional[0];
  const flags = Object.fromEntries(parsed.flags);
  if (
    subcommand === 'attach' &&
    typeof flags['--execution-request-id'] !== 'string' &&
    process.env.OVERLORD_EXECUTION_REQUEST_ID
  ) {
    flags['--execution-request-id'] = process.env.OVERLORD_EXECUTION_REQUEST_ID;
  }
  const { fileInputs, stdin: protocolStdin } = await resolveProtocolFileInputs({
    flags: parsed.flags,
    stdin
  });

  // Session-key cache: when a command that needs a session key is missing the
  // flag, fall back to the key cached at attach for this (workingDir, mission).
  // An explicit --session-key always wins.
  if (
    SESSION_KEY_SUBCOMMANDS.has(subcommand) &&
    missionId &&
    (typeof flags['--session-key'] !== 'string' || flags['--session-key'].trim() === '')
  ) {
    const cached = readCachedSessionKey({ missionId, workingDirectory });
    if (cached) flags['--session-key'] = cached;
  }

  pruneStaleProjectTmp({ workingDirectory });

  // Client-side VCS capture: read git status here (the agent's machine), never on
  // the backend. Filter explicit payloads and, at deliver, merge the run delta.
  if ((subcommand === 'deliver' || subcommand === 'update') && missionId) {
    applySessionChangedFiles({
      flags,
      workingDirectory,
      missionId,
      subcommand,
      stdin: fileInputs['--changed-files-file'] ?? protocolStdin,
      fileInputs
    });
  }

  if (subcommand === 'deliver' && missionId) {
    applyDraftChangeRationales({
      flags,
      fileInputs,
      workingDirectory,
      missionId
    });
  }

  const result = await runtime.backend.post<unknown>({
    path: `/api/protocol/${encodeURIComponent(subcommand)}`,
    body: {
      args,
      positional: parsed.positional,
      flags,
      stdin: protocolStdin,
      fileInputs,
      externalSessionId:
        flagValue(parsed.flags, '--external-session-id') ??
        resolveNativeSessionId({
          explicit: undefined,
          agent: flagValue(parsed.flags, '--agent') ?? 'unknown',
          missionId: flagValue(parsed.flags, '--mission-id') ?? 'unknown',
          workingDirectory
        })
    }
  });

  // Record the dirty-file baseline once a work session begins, so deliver can
  // subtract pre-existing/concurrent changes from this run's reported delta.
  if ((subcommand === 'attach' || subcommand === 'resume-follow-up') && missionId) {
    writeBaseline({
      workingDirectory,
      missionId,
      files: readChangedFiles(workingDirectory)
    });
    resetTouchedFiles({ workingDirectory, missionId });
    resetRationaleNotes({ workingDirectory, missionId });
  }

  const resultRecord = asRecord(result);
  if (typeof resultRecord.sessionKey === 'string') {
    printKeyValue({ SESSION_KEY: resultRecord.sessionKey });
    // Persist the freshly minted key so subsequent commands in other shells for
    // this (workingDir, mission) can auto-resolve it without --session-key.
    if (missionId) {
      writeCachedSessionKey({ missionId, workingDirectory, sessionKey: resultRecord.sessionKey });
    }
  }
  // The session ends at deliver: drop the cached key so it can't bind to a later
  // session for the same working dir + mission.
  if (subcommand === 'deliver' && missionId) {
    clearCachedSessionKey({ missionId, workingDirectory });
  }
  if (typeof resultRecord.missionId === 'string') {
    printKeyValue({ MISSION_ID: resultRecord.missionId });
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
        const directory = flagValue(parsed.flags, '--directory') ?? process.cwd();
        const resource = await runtime.backend.post({
          path: `/api/projects/${encodeURIComponent(projectId)}/resources`,
          body: {
            directoryPath: directory,
            isPrimary: true
          }
        });
        writeProjectJsonFromResource({ directory, projectId, resource });
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
      writeProjectJsonFromResource({ directory, projectId, resource });
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
      const mission = await runtime.backend.post<unknown>({
        path: '/api/missions',
        body: {
          projectId,
          title,
          objectives
        }
      });
      if (objectivesJson) {
        const missionObjectives = asRecord(mission).objectives;
        if (Array.isArray(missionObjectives) && missionObjectives.length !== objectives.length) {
          throw new CliError({
            message: `Backend created ${missionObjectives.length} objective(s), expected ${objectives.length}`
          });
        }
      }
      if (command === 'prompt') {
        const objectiveId = firstObjectiveId(mission);
        if (objectiveId) {
          await runtime.backend.post({
            path: `/api/objectives/${encodeURIComponent(objectiveId)}/launch`,
            body: { agent: flagValue(parsed.flags, '--agent') ?? 'unknown' }
          });
        }
      }
      if (json) printJson(mission);
      else console.log(`Created mission ${missionDisplayId(mission)}`);
      return;
    }
    case 'attach':
    case 'execution': {
      const missionId =
        command === 'attach'
          ? (parsed.positional[0] ?? flagValue(parsed.flags, '--mission-id'))
          : requireFlag(parsed.flags, '--mission-id');
      const explicitAgent = parsed.positional[1] ?? flagValue(parsed.flags, '--agent');
      if (!missionId) throw new CliError({ message: 'Usage: ovld attach <missionId> [agent]' });
      const mission = await runtime.backend.get<unknown>(
        `/api/missions/${encodeURIComponent(missionId)}`
      );
      const objectiveId = flagValue(parsed.flags, '--objective-id') ?? firstObjectiveId(mission);
      if (!objectiveId)
        throw new CliError({ message: `No launchable objective found for ${missionId}` });
      // Honor an explicit agent; otherwise reuse the agent already stored on the
      // objective (the db is the source of truth) so launching never overrides the
      // chosen agent, and fall back to the configured default rather than codex.
      const agent =
        explicitAgent ?? objectiveAssignedAgent(mission, objectiveId) ?? loadConfig().defaultAgent;
      const request = await runtime.backend.post({
        path: `/api/objectives/${encodeURIComponent(objectiveId)}/launch`,
        body: {
          agent,
          model: flagValue(parsed.flags, '--model'),
          reasoningEffort: flagValue(parsed.flags, '--thinking')
        }
      });
      if (json) printJson({ request });
      else console.log(`Queued ${agent} for ${missionDisplayId(mission)}`);
      return;
    }
    case 'launch':
    case 'restart':
    case 'run':
    case 'connect':
    case 'resume': {
      const agent =
        command === 'run' || command === 'connect' || command === 'resume'
          ? (flagValue(parsed.flags, '--agent') ??
            parsed.positional[0] ??
            loadConfig().defaultAgent)
          : parsed.positional[0];
      const missionId =
        flagValue(parsed.flags, '--mission-id') ??
        (command === 'run' || command === 'connect' || command === 'resume'
          ? parsed.positional[1]
          : parsed.positional[1]);
      if (!agent || !missionId) {
        throw new CliError({ message: `Usage: ovld ${command} <agent> --mission-id <missionId>` });
      }
      const workingDirectory = flagValue(parsed.flags, '--working-directory') ?? process.cwd();
      const terminal = await resolveTerminalLaunchSettings({ runtime, flags: parsed.flags });
      const dryRun = flagBoolean(parsed.flags, '--dry-run');
      const prepared = await prepareMissionBranch({
        runtime,
        options: {
          missionId,
          workingDirectory,
          workspaceAutomationEnabled: await readWorktreeBranchAutomationEnabled(runtime),
          dryRun,
          overrideBranch: flagValue(parsed.flags, '--branch'),
          noWorktree: flagBoolean(parsed.flags, '--no-worktree')
        }
      });
      await recordBranchPrepared({
        runtime,
        missionId,
        branchAutomation: prepared.branchAutomation
      });
      const result = await launchAgent({
        runtime,
        options: {
          agent,
          missionId,
          workingDirectory: prepared.workingDirectory,
          model: flagValue(parsed.flags, '--model'),
          thinking: flagValue(parsed.flags, '--thinking'),
          flags: repeatedFlagValues(rest, '--flag'),
          preCommand: flagValue(parsed.flags, '--pre-command'),
          ...terminal,
          dryRun
        }
      });
      if (json || dryRun) {
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
    case 'missions': {
      const sub = parsed.positional[0];
      if (sub !== 'list') {
        throw new CliError({
          message: 'Usage: ovld missions list [--status <csv>] [--project-id <id>] [--json]'
        });
      }
      const params = new URLSearchParams();
      const query = flagValue(parsed.flags, '--query');
      const projectId = flagValue(parsed.flags, '--project-id');
      const limit = flagValue(parsed.flags, '--limit');
      if (query) params.set('q', query);
      if (projectId) params.set('projectId', projectId);
      if (limit) params.set('limit', limit);
      const result = await runtime.backend.get<{ missions: unknown[] }>(
        `/api/missions/search?${params}`
      );
      const missions = result.missions;
      if (json) printJson({ missions });
      else {
        for (const mission of missions) {
          const record = asRecord(mission);
          console.log(
            `${record.displayId ?? record.id}\t${record.statusType ?? ''}\t${record.title ?? ''}`
          );
        }
      }
      return;
    }
    case 'mission': {
      const sub = parsed.positional[0];
      const missionId = parsed.positional[1];
      if (!missionId) {
        throw new CliError({
          message:
            'Usage: ovld mission context|events|deliveries|artifacts|rationales <missionId> [--json]'
        });
      }
      const pathBySub: Record<string, string> = {
        context: `/api/missions/${encodeURIComponent(missionId)}`,
        events: `/api/missions/${encodeURIComponent(missionId)}/events`,
        artifacts: `/api/missions/${encodeURIComponent(missionId)}/artifacts`,
        rationales: `/api/missions/${encodeURIComponent(missionId)}/file-changes`,
        deliveries: `/api/missions/${encodeURIComponent(missionId)}/events`
      };
      const path = sub ? pathBySub[sub] : undefined;
      if (!path) {
        throw new CliError({
          message:
            'Usage: ovld mission context|events|deliveries|artifacts|rationales <missionId> [--json]'
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
      const missionId = requireFlag(parsed.flags, '--mission-id');
      if (sub !== 'status' && sub !== 'rationales') {
        throw new CliError({ message: 'Usage: ovld changes status|rationales --mission-id <id>' });
      }
      const result = await runtime.backend.get<unknown[]>(
        `/api/missions/${encodeURIComponent(missionId)}/file-changes`
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
      body: {
        projectId: flagValue(parsed.flags, '--project-id'),
        ...clientDeviceIdentity()
      }
    });
    const request = asRecord(claim).request;
    if (!request) return false;
    const requestRecord = asRecord(request);
    const requestId = String(requestRecord.id);
    await runtime.backend.post({ path: `/api/runner/requests/${requestId}/launching` });
    try {
      // The execution request's agent is decided upstream from the objective row,
      // so a missing value is an invariant violation — never silently substitute a
      // default agent, which would launch work as the wrong tool. Fail the request
      // up front (the catch below reports it) so the cause surfaces instead of being
      // masked, and so no branch/terminal work is done for a request that can't run.
      const requestedAgent =
        typeof requestRecord.requestedAgent === 'string' ? requestRecord.requestedAgent.trim() : '';
      if (!requestedAgent) {
        throw new CliError({
          message: `Execution request ${requestId} has no agent; the objective must specify one before it can be launched.`
        });
      }
      const launchConfig = asRecord(requestRecord.launchConfig);
      const terminal = await resolveTerminalLaunchSettings({ runtime, flags: parsed.flags });
      const missionId = String(requestRecord.missionId);
      const dryRun = flagBoolean(parsed.flags, '--dry-run');
      const prepared = await prepareMissionBranch({
        runtime,
        options: {
          missionId,
          workingDirectory: String(requestRecord.workingDirectory ?? process.cwd()),
          workspaceAutomationEnabled: await readWorktreeBranchAutomationEnabled(runtime),
          dryRun,
          overrideBranch: flagValue(parsed.flags, '--branch'),
          noWorktree: flagBoolean(parsed.flags, '--no-worktree')
        }
      });
      await recordBranchPrepared({
        runtime,
        missionId,
        requestId,
        branchAutomation: prepared.branchAutomation
      });
      const result = await launchAgent({
        runtime,
        options: {
          agent: requestedAgent,
          missionId,
          workingDirectory: prepared.workingDirectory,
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
          executionRequestId: requestId,
          ...terminal,
          dryRun
        }
      });
      if (result.status && result.status !== 0) {
        throw new CliError({ message: `Launch command exited with status ${result.status}` });
      }
      await runtime.backend.post({ path: `/api/runner/requests/${requestId}/launched` });
      if (json || dryRun) {
        printJson({ request, plan: result.plan, status: result.status });
      } else {
        console.log(`Launched ${requestedAgent} for ${requestRecord.missionId}`);
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
