import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadTicketContext } from '../../src/service/protocol.js';

import type { CliRuntime } from './runtime.js';
import { type LaunchExecution, resolveLaunchExecution, tmpEnvFor } from './terminal-launcher.js';

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
  return { command: agent, args };
}

export function buildLaunchPlan({
  runtime,
  options
}: {
  runtime: CliRuntime;
  options: LaunchOptions;
}): LaunchPlan {
  const context = loadTicketContext({ ctx: runtime.ctx, ticketId: options.ticketId });
  const tmpDir = path.join(options.workingDirectory, '.overlord', 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const contextFile = path.join(
    tmpDir,
    `ticket-${context.ticket.displayId.replace(/[^a-zA-Z0-9_-]/g, '-')}.md`
  );
  writeFileSync(contextFile, `${context.promptContext}\n`);

  const prompt =
    context.promptContext.length > 4000
      ? `Use the Overlord context file at ${contextFile} and attach to ticket ${context.ticket.displayId}.`
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
    terminalLauncher: options.terminalLauncher
  });

  return {
    ...command,
    prompt,
    contextFile,
    workingDirectory: options.workingDirectory,
    execution
  };
}

export function launchAgent({
  runtime,
  options
}: {
  runtime: CliRuntime;
  options: LaunchOptions;
}): { plan: LaunchPlan; status: number | null; signal: NodeJS.Signals | null } {
  const plan = buildLaunchPlan({ runtime, options });
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
