import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadTicketContext } from '../../src/service/protocol.js';

import type { CliRuntime } from './runtime.js';

export type LaunchOptions = {
  agent: string;
  ticketId: string;
  workingDirectory: string;
  model?: string | null;
  thinking?: string | null;
  flags?: string[];
  preCommand?: string | null;
  dryRun?: boolean;
};

type LaunchPlan = {
  command: string;
  args: string[];
  prompt: string;
  contextFile: string;
  workingDirectory: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

  return {
    ...command,
    prompt,
    contextFile,
    workingDirectory: options.workingDirectory
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
    TMPDIR: path.join(options.workingDirectory, '.overlord', 'tmp'),
    TMP: path.join(options.workingDirectory, '.overlord', 'tmp'),
    TEMP: path.join(options.workingDirectory, '.overlord', 'tmp'),
    OVERLORD_TMPDIR: path.join(options.workingDirectory, '.overlord', 'tmp')
  };

  const command = options.preCommand
    ? `${options.preCommand} ${shellQuote(plan.command)} ${plan.args.map(shellQuote).join(' ')}`
    : null;

  const result = command
    ? spawnSync(command, {
        cwd: options.workingDirectory,
        env,
        shell: true,
        stdio: 'inherit'
      })
    : spawnSync(plan.command, plan.args, {
        cwd: options.workingDirectory,
        env,
        stdio: 'inherit'
      });

  return { plan, status: result.status, signal: result.signal };
}
