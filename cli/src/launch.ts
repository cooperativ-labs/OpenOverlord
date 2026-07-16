import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveAgentBinary } from './agent-binaries.js';
import { ensureProjectTmpDir, pruneStaleProjectTmp } from './project-tmp.js';
import type { CliRuntime } from './runtime.js';
import {
  type LaunchExecution,
  resolveLaunchExecution,
  terminalLaunchScriptContent,
  type TerminalLaunchSettings,
  tmpEnvFor
} from './terminal-launcher.js';

export type LaunchOptions = {
  agent: string;
  missionId: string;
  workingDirectory: string;
  model?: string | null;
  thinking?: string | null;
  flags?: string[];
  preCommand?: string | null;
  executionRequestId?: string | null;
  executionTargetId?: string | null;
  /**
   * Open the agent in a new terminal window. A built-in name (`iTerm2`,
   * `Terminal`) or a raw prefix command (e.g. `open -a Ghostty --args`).
   * When omitted/null the agent runs inline in the current terminal.
   */
  terminalLauncher?: string | null;
  terminalLaunchPlacement?: TerminalLaunchSettings['terminalLaunchPlacement'];
  terminalLaunchChord?: string | null;
  dryRun?: boolean;
};

type LaunchPlan = {
  command: string;
  args: string[];
  prompt: string;
  contextFile: string;
  workingDirectory: string;
  execution: LaunchExecution;
  env: Record<string, string>;
};

type MissionContext = {
  displayId: string;
  title: string;
  launchContext: string;
};

function overlordLaunchEnv({
  backendUrl,
  missionId,
  executionRequestId,
  projectResources
}: {
  backendUrl: string;
  missionId: string;
  executionRequestId?: string | null;
  projectResources?: unknown[] | null;
}): Record<string, string> {
  return {
    MISSION_ID: missionId,
    OVERLORD_MISSION_ID: missionId,
    OVERLORD_BACKEND_URL: backendUrl,
    ...(executionRequestId ? { OVERLORD_EXECUTION_REQUEST_ID: executionRequestId } : {}),
    ...(projectResources && projectResources.length > 0
      ? { OVERLORD_PROJECT_RESOURCES: JSON.stringify(projectResources) }
      : {})
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Operational lifecycle event types excluded from the "Recent Activity" history
 * surfaced to the agent. The agent only cares
 * about substantive events (updates, deliveries, asks, alerts, discussion), not
 * runner/orchestration status churn.
 */
const AGENT_HISTORY_EXCLUDED_EVENT_TYPES = new Set([
  'status_change',
  'execution_requested',
  'awaiting_approval'
]);

/** Keep the execution intent visible even when context falls back to a file. */
const EXECUTION_DIRECTIVE =
  'This is an execution session. After attaching, immediately execute the current objective. Do not wait for more instructions or ask for confirmation; only stop to ask a question when blocked.';

async function loadMissionContext({
  runtime,
  missionId
}: {
  runtime: CliRuntime;
  missionId: string;
}): Promise<MissionContext> {
  const mission = asRecord(
    await runtime.backend.get(`/api/missions/${encodeURIComponent(missionId)}`)
  );
  const events = await runtime.backend
    .get<unknown[]>(`/api/missions/${encodeURIComponent(missionId)}/events`)
    .catch(() => []);
  const artifacts = await runtime.backend
    .get<unknown[]>(`/api/missions/${encodeURIComponent(missionId)}/artifacts`)
    .catch(() => []);
  const displayId = String(mission.displayId ?? mission.id ?? missionId);
  const title = String(mission.title ?? '(untitled)');
  const objectives = Array.isArray(mission.objectives) ? mission.objectives.map(asRecord) : [];

  // Attachments are stored per objective and are not part of the mission detail
  // payload, so fetch them for each objective. Surfacing them in the launch
  // prompt is what lets the agent know files were attached to its objective
  // (otherwise it only ever sees them if it parses the raw attach JSON).
  const attachmentLines: string[] = [];
  await Promise.all(
    objectives.map(async (objective, index) => {
      const objectiveId = objective.id;
      if (typeof objectiveId !== 'string' || objectiveId.length === 0) return;
      const attachments = await runtime.backend
        .get<unknown[]>(`/api/objectives/${encodeURIComponent(objectiveId)}/attachments`)
        .catch(() => []);
      for (const attachment of attachments) {
        const record = asRecord(attachment);
        const filename = String(record.filename ?? 'attachment');
        const contentType = record.contentType ? ` (${String(record.contentType)})` : '';
        attachmentLines.push(`- [objective ${index + 1}] ${filename}${contentType}`);
      }
    })
  );

  const launchContext = [
    `# Overlord Mission: ${displayId}: ${title}`,
    '',
    '## Instructions',
    'Use the Overlord skill. Follow the required protocol workflow.',
    EXECUTION_DIRECTIVE,
    '',
    '## Objectives',
    ...objectives.map((objective, index) => {
      const instruction = objective.instructionText ?? objective.instruction ?? '';
      return `${index + 1}. [${objective.state ?? 'unknown'}] ${instruction}`;
    }),
    '',
    ...(attachmentLines.length > 0
      ? [
          '## Attachments',
          'Files attached to the objective(s) below. Use `ovld protocol attachment-list` and `ovld protocol attachment-download-url` to retrieve them.',
          ...attachmentLines,
          ''
        ]
      : []),
    '## Recent Activity',
    ...events
      .filter(event => !AGENT_HISTORY_EXCLUDED_EVENT_TYPES.has(String(asRecord(event).type)))
      .slice(-20)
      .map(event => `- ${asRecord(event).summary ?? JSON.stringify(event)}`),
    '',
    '## Artifacts',
    ...artifacts.map(
      artifact => `- ${asRecord(artifact).label ?? asRecord(artifact).type ?? 'artifact'}`
    ),
    '',
    'Use `ovld protocol attach --mission-id <id>` before making changes, update during work, and ALWAYS deliver last.'
  ].join('\n');

  return { displayId, title, launchContext };
}

async function loadProjectResourcesForLaunch({
  runtime,
  missionId,
  executionTargetId
}: {
  runtime: CliRuntime;
  missionId: string;
  executionTargetId?: string | null;
}): Promise<unknown[] | null> {
  try {
    const context = await runtime.backend.post<unknown>({
      path: '/api/protocol/load-context',
      body: {
        flags: {
          '--mission-id': missionId,
          ...(executionTargetId ? { '--execution-target-id': executionTargetId } : {})
        }
      }
    });
    const record = asRecord(context);
    return Array.isArray(record.projectResources) ? record.projectResources : null;
  } catch {
    return null;
  }
}

function buildAgentCommand({
  agent,
  model,
  thinking,
  flags = [],
  prompt,
  contextFile,
  launchMessage
}: {
  agent: string;
  model?: string | null;
  thinking?: string | null;
  flags?: string[];
  prompt: string;
  contextFile: string;
  launchMessage: string;
}): { command: string; args: string[] } {
  if (agent === 'codex') {
    const args = [];
    if (model) args.push('--model', model);
    if (thinking) args.push('-c', `model_reasoning_effort="${thinking}"`);
    args.push(...flags, prompt);
    return { command: 'codex', args };
  }

  if (agent === 'claude') {
    const args = ['--append-system-prompt-file', contextFile];
    if (model) args.push('--model', model);
    if (thinking) args.push('--effort', thinking);
    args.push(...flags, launchMessage);
    return { command: 'claude', args };
  }

  if (agent === 'pi') {
    const args = [];
    if (model) args.push('--model', model);
    if (thinking) args.push('--thinking', thinking);
    args.push(...flags, `@${contextFile}`, launchMessage);
    return { command: 'pi', args };
  }

  const args = [];
  if (model) args.push('--model', model);
  args.push(...flags, prompt);
  return { command: resolveAgentBinary(agent), args };
}

function safeLaunchScriptPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'launch';
}

function launchScriptPath({
  tmpDir,
  displayId,
  executionRequestId
}: {
  tmpDir: string;
  displayId: string;
  executionRequestId?: string | null;
}): string {
  const requestPart = executionRequestId
    ? safeLaunchScriptPart(executionRequestId)
    : `${process.pid}`;
  return path.join(tmpDir, `launch-${safeLaunchScriptPart(displayId)}-${requestPart}.sh`);
}

export async function buildLaunchPlan({
  runtime,
  options
}: {
  runtime: CliRuntime;
  options: LaunchOptions;
}): Promise<LaunchPlan> {
  const context = await loadMissionContext({ runtime, missionId: options.missionId });
  pruneStaleProjectTmp({ workingDirectory: options.workingDirectory, create: true });
  const tmpDir = ensureProjectTmpDir(options.workingDirectory);
  const contextFile = path.join(
    tmpDir,
    `mission-${context.displayId.replace(/[^a-zA-Z0-9_-]/g, '-')}.md`
  );
  const launchContext = options.executionRequestId
    ? `${context.launchContext}\nExecution request: ${options.executionRequestId}`
    : context.launchContext;
  writeFileSync(contextFile, `${launchContext}\n`);
  const projectResources = await loadProjectResourcesForLaunch({
    runtime,
    missionId: options.missionId,
    executionTargetId: options.executionTargetId
  });
  const launchEnv = overlordLaunchEnv({
    backendUrl: runtime.backend.baseUrl,
    missionId: context.displayId,
    executionRequestId: options.executionRequestId,
    projectResources
  });

  const prompt =
    launchContext.length > 4000
      ? `Read the Overlord context file at ${contextFile}, attach to mission ${context.displayId}, then immediately execute its current objective. Do not wait for more instructions.`
      : launchContext;

  const command = buildAgentCommand({
    agent: options.agent,
    model: options.model,
    thinking: options.thinking,
    flags: options.flags,
    prompt,
    contextFile,
    launchMessage: `Attach to ovld mission ${context.displayId}, then immediately execute ${context.title}. Do not wait for more instructions.`
  });

  const terminalScriptPath = options.terminalLauncher?.trim()
    ? launchScriptPath({
        tmpDir,
        displayId: context.displayId,
        executionRequestId: options.executionRequestId
      })
    : null;
  if (terminalScriptPath) {
    writeFileSync(
      terminalScriptPath,
      terminalLaunchScriptContent({
        command: command.command,
        args: command.args,
        workingDirectory: options.workingDirectory,
        preCommand: options.preCommand,
        extraEnv: launchEnv
      })
    );
    chmodSync(terminalScriptPath, 0o700);
  }

  const execution = resolveLaunchExecution({
    command: command.command,
    args: command.args,
    workingDirectory: options.workingDirectory,
    preCommand: options.preCommand,
    terminalLauncher: options.terminalLauncher,
    terminalLaunchPlacement: options.terminalLaunchPlacement,
    terminalLaunchChord: options.terminalLaunchChord,
    terminalScriptPath,
    extraEnv: launchEnv
  });

  return {
    ...command,
    prompt,
    contextFile,
    workingDirectory: options.workingDirectory,
    execution,
    env: launchEnv
  };
}

export async function launchAgent({
  runtime,
  options
}: {
  runtime: CliRuntime;
  options: LaunchOptions;
}): Promise<{ plan: LaunchPlan; status: number | null; signal: NodeJS.Signals | null }> {
  const plan = await buildLaunchPlan({ runtime, options });
  if (options.dryRun) {
    return { plan, status: 0, signal: null };
  }

  const env = {
    ...process.env,
    ...tmpEnvFor(options.workingDirectory),
    ...plan.env
  };

  const { execution } = plan;
  const result = execution.useShell
    ? spawnSync(execution.command, {
        cwd: options.workingDirectory,
        env,
        shell: true,
        stdio: 'inherit'
      })
    : spawnSync(execution.command, execution.args, {
        cwd: options.workingDirectory,
        env,
        stdio: 'inherit'
      });

  return { plan, status: result.status, signal: result.signal };
}
