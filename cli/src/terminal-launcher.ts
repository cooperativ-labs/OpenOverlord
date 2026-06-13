import path from 'node:path';

/** Resolved process invocation describing exactly how the agent is spawned. */
export type LaunchExecution = {
  /** The program (or full shell string when `useShell` is true) to spawn. */
  command: string;
  /** Argument vector; empty when `useShell` is true. */
  args: string[];
  /** When true, spawn through a shell so `command` is parsed as a shell line. */
  useShell: boolean;
  /** The resolved terminal launcher, or null when launching inline. */
  terminal: string | null;
  /** Human-readable description of what runs (for dry-run / JSON output). */
  display: string;
};

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Build an AppleScript string literal, escaping backslashes and quotes. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Map a configured launcher value to a built-in launcher, or null for a raw prefix. */
function resolveBuiltinTerminal(value: string): 'iterm' | 'terminal' | null {
  switch (value.trim().toLowerCase()) {
    case 'iterm':
    case 'iterm2':
    case 'iterm.app':
      return 'iterm';
    case 'terminal':
    case 'terminal.app':
    case 'apple terminal':
      return 'terminal';
    default:
      return null;
  }
}

/** The TMPDIR-family environment Overlord pins to the project `.overlord/tmp/`. */
export function tmpEnvFor(workingDirectory: string): Record<string, string> {
  const tmpDir = path.join(workingDirectory, '.overlord', 'tmp');
  return { TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir, OVERLORD_TMPDIR: tmpDir };
}

/** The agent invocation as a single shell line, optionally wrapped by a pre-command. */
function agentShellCommand({
  command,
  args,
  preCommand
}: {
  command: string;
  args: string[];
  preCommand?: string | null;
}): string {
  const base = [shellQuote(command), ...args.map(shellQuote)].join(' ');
  return preCommand?.trim() ? `${preCommand.trim()} ${base}` : base;
}

/**
 * The command run *inside* a freshly opened terminal window. A new window does
 * not inherit our process cwd/env, so we cd into the project and re-export the
 * TMPDIR family before invoking the agent.
 */
function terminalInnerCommand({
  workingDirectory,
  agentCommand
}: {
  workingDirectory: string;
  agentCommand: string;
}): string {
  const exports = Object.entries(tmpEnvFor(workingDirectory))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('; ');
  return `cd ${shellQuote(workingDirectory)} && ${exports}; ${agentCommand}`;
}

/**
 * Resolve how the agent should actually be spawned given the configured
 * pre-command and terminal launcher. Pure (no side effects) so it can be
 * inspected via `--dry-run` and unit-tested without launching anything.
 *
 * - No launcher → run inline (current terminal), matching the legacy behaviour.
 * - Built-in `iTerm2` / `Terminal` → drive AppleScript via `osascript` to open a
 *   new window in the working directory.
 * - Any other launcher value → a prefix command with the agent appended.
 */
export function resolveLaunchExecution({
  command,
  args,
  workingDirectory,
  preCommand,
  terminalLauncher
}: {
  command: string;
  args: string[];
  workingDirectory: string;
  preCommand?: string | null;
  terminalLauncher?: string | null;
}): LaunchExecution {
  const agentCommand = agentShellCommand({ command, args, preCommand });
  const launcher = terminalLauncher?.trim();

  if (!launcher) {
    // Inline launch (current terminal). Only go through a shell when a
    // pre-command wrapper is present, preserving the legacy spawn shape.
    return preCommand?.trim()
      ? { command: agentCommand, args: [], useShell: true, terminal: null, display: agentCommand }
      : { command, args, useShell: false, terminal: null, display: agentCommand };
  }

  const builtin = resolveBuiltinTerminal(launcher);

  if (builtin === 'terminal') {
    const inner = terminalInnerCommand({ workingDirectory, agentCommand });
    const script = [
      'tell application "Terminal"',
      'activate',
      `do script ${appleScriptString(inner)}`,
      'end tell'
    ].join('\n');
    return {
      command: 'osascript',
      args: ['-e', script],
      useShell: false,
      terminal: 'Terminal',
      display: `Terminal.app › ${inner}`
    };
  }

  if (builtin === 'iterm') {
    const inner = terminalInnerCommand({ workingDirectory, agentCommand });
    const script = [
      'tell application "iTerm"',
      'activate',
      'set newWindow to (create window with default profile)',
      `tell current session of newWindow to write text ${appleScriptString(inner)}`,
      'end tell'
    ].join('\n');
    return {
      command: 'osascript',
      args: ['-e', script],
      useShell: false,
      terminal: 'iTerm2',
      display: `iTerm2 › ${inner}`
    };
  }

  // Raw prefix launcher (e.g. `open -a Ghostty --args`, `wezterm start`): the
  // launcher inherits our spawn cwd/env and we append the agent invocation.
  const full = `${launcher} ${agentCommand}`;
  return { command: full, args: [], useShell: true, terminal: launcher, display: full };
}
