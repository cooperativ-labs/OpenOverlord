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
  ticketId: string;
  workingDirectory: string;
  model?: string | null;
  thinking?: string | null;
  flags?: string[];
  preCommand?: string | null;
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

type TicketContext = {
  displayId: string;
  promptContext: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

async function loadTicketContext({
  runtime,
  ticketId
}: {
  runtime: CliRuntime;
  ticketId: string;
}): Promise<TicketContext> {
  const ticket = asRecord(
    await runtime.backend.get(`/api/tickets/${encodeURIComponent(ticketId)}`)
  );
  const events = await runtime.backend
    .get<unknown[]>(`/api/tickets/${encodeURIComponent(ticketId)}/events`)
    .catch(() => []);
  const artifacts = await runtime.backend
    .get<unknown[]>(`/api/tickets/${encodeURIComponent(ticketId)}/artifacts`)
    .catch(() => []);
  const displayId = String(ticket.displayId ?? ticket.id ?? ticketId);
  const objectives = Array.isArray(ticket.objectives) ? ticket.objectives.map(asRecord) : [];
  const promptContext = [
    '# Overlord Ticket Context',
    '',
    `Ticket: ${displayId}`,
    `Title: ${ticket.title ?? '(untitled)'}`,
    '',
    '## Objectives',
    ...objectives.map((objective, index) => {
      const instruction = objective.instructionText ?? objective.instruction ?? '';
      return `${index + 1}. [${objective.state ?? 'unknown'}] ${instruction}`;
    }),
    '',
    '## Recent Activity',
    ...events.slice(-20).map(event => `- ${asRecord(event).summary ?? JSON.stringify(event)}`),
    '',
    '## Artifacts',
    ...artifacts.map(
      artifact => `- ${asRecord(artifact).label ?? asRecord(artifact).type ?? 'artifact'}`
    ),
    '',
    'Use `ovld protocol attach --ticket-id <id>` before making changes, update during work, and deliver last.'
  ].join('\n');

  return { displayId, promptContext };
}

function buildAgentCommand({
  agent,
  model,
  thinking,
  flags = [],
  prompt,
  contextFile
}: {
  agent: string;
  model?: string | null;
  thinking?: string | null;
  flags?: string[];
  prompt: string;
  contextFile: string;
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
    args.push(...flags, 'Start work on the attached Overlord ticket.');
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
  const context = await loadTicketContext({ runtime, ticketId: options.ticketId });
  pruneStaleProjectTmp({ workingDirectory: options.workingDirectory, create: true });
  const tmpDir = ensureProjectTmpDir(options.workingDirectory);
  const contextFile = path.join(
    tmpDir,
    `ticket-${context.displayId.replace(/[^a-zA-Z0-9_-]/g, '-')}.md`
  );
  writeFileSync(contextFile, `${context.promptContext}\n`);

  const prompt =
    context.promptContext.length > 4000
      ? `Use the Overlord context file at ${contextFile} and attach to ticket ${context.displayId}.`
      : context.promptContext;

  const command = buildAgentCommand({
    agent: options.agent,
    model: options.model,
    thinking: options.thinking,
    flags: options.flags,
    prompt,
    contextFile
  });

  const execution = resolveLaunchExecution({
    command: command.command,
    args: command.args,
    workingDirectory: options.workingDirectory,
    preCommand: options.preCommand,
    terminalLauncher: options.terminalLauncher,
    terminalLaunchPlacement: options.terminalLaunchPlacement,
    terminalLaunchChord: options.terminalLaunchChord
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
    ...tmpEnvFor(options.workingDirectory)
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
