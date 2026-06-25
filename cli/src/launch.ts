import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveAgentBinary } from './agent-binaries.js';
import { ensureProjectTmpDir, pruneStaleProjectTmp } from './project-tmp.js';
import type { CliRuntime } from './runtime.js';
import {
  type LaunchExecution,
  resolveLaunchExecution,
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
};

type MissionContext = {
  displayId: string;
  title: string;
  promptContext: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

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

  const promptContext = [
    `# Overlord Mission: ${displayId}: ${title}`,
    '',
    '## Instructions',
    'Use the Overlord skill. Follow the required protocol workflow.',
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
    ...events.slice(-20).map(event => `- ${asRecord(event).summary ?? JSON.stringify(event)}`),
    '',
    '## Artifacts',
    ...artifacts.map(
      artifact => `- ${asRecord(artifact).label ?? asRecord(artifact).type ?? 'artifact'}`
    ),
    '',
    'Use `ovld protocol attach --mission-id <id>` before making changes, update during work, and ALWAYS deliver last.'
  ].join('\n');

  return { displayId, title, promptContext };
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

  const args = [];
  if (model) args.push('--model', model);
  args.push(...flags, prompt);
  return { command: resolveAgentBinary(agent), args };
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
  const promptContext = options.executionRequestId
    ? `${context.promptContext}\nExecution request: ${options.executionRequestId}`
    : context.promptContext;
  writeFileSync(contextFile, `${promptContext}\n`);

  const prompt =
    promptContext.length > 4000
      ? `Use the Overlord context file at ${contextFile} and attach to mission ${context.displayId}.`
      : promptContext;

  const command = buildAgentCommand({
    agent: options.agent,
    model: options.model,
    thinking: options.thinking,
    flags: options.flags,
    prompt,
    contextFile,
    launchMessage: `Start work on ${context.title} (ovld mission ${context.displayId})`
  });

  const execution = resolveLaunchExecution({
    command: command.command,
    args: command.args,
    workingDirectory: options.workingDirectory,
    preCommand: options.preCommand,
    terminalLauncher: options.terminalLauncher,
    terminalLaunchPlacement: options.terminalLaunchPlacement,
    terminalLaunchChord: options.terminalLaunchChord,
    extraEnv: options.executionRequestId
      ? { OVERLORD_EXECUTION_REQUEST_ID: options.executionRequestId }
      : {}
  });

  return {
    ...command,
    prompt,
    contextFile,
    workingDirectory: options.workingDirectory,
    execution
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
    ...(options.executionRequestId
      ? { OVERLORD_EXECUTION_REQUEST_ID: options.executionRequestId }
      : {})
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
