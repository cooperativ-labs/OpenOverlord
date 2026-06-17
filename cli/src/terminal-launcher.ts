import path from 'node:path';

import {
  appleScriptKeystrokeClause,
  parseTerminalLaunchChord,
  type TerminalLaunchPlacement
} from './terminal-launch-chord.js';

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

export type TerminalLaunchSettings = {
  terminalLauncher?: string | null;
  terminalLaunchPlacement?: TerminalLaunchPlacement;
  terminalLaunchChord?: string | null;
};

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Build an AppleScript string expression, escaping content and preserving line breaks. */
function appleScriptString(value: string): string {
  const literal = (segment: string): string =>
    `"${segment.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const segments = value.split(/\r\n|\r|\n/);
  if (segments.length === 1) return literal(value);
  return segments.map(literal).join(' & linefeed & ');
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

/** Extract a macOS app name from an `open -a … --args` launcher prefix. */
export function extractAppNameFromLauncher(launcher: string): string | null {
  const match = launcher.match(/open\s+-a\s+(?:'([^']+)'|"([^"]+)"|(\S+))/i);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
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

function resolveItermSplitKind(
  chord: string | null | undefined
): 'vertical' | 'horizontal' | 'keystroke' {
  const parsed = chord ? parseTerminalLaunchChord(chord) : null;
  if (!parsed) return 'vertical';
  if (
    parsed.modifiers.includes('command') &&
    parsed.modifiers.includes('shift') &&
    parsed.key === 'd'
  ) {
    return 'horizontal';
  }
  if (parsed.modifiers.includes('command') && parsed.key === 'd' && parsed.modifiers.length === 1) {
    return 'vertical';
  }
  return 'keystroke';
}

function buildItermAppleScript({
  inner,
  placement,
  chordClause,
  chord
}: {
  inner: string;
  placement: TerminalLaunchPlacement;
  chordClause?: string | null;
  chord?: string | null;
}): string {
  const lines = ['tell application "iTerm"', 'activate'];

  if (placement === 'window') {
    lines.push(
      'set newWindow to (create window with default profile)',
      `tell current session of newWindow to write text ${appleScriptString(inner)}`
    );
    lines.push('end tell');
    return lines.join('\n');
  }

  lines.push(
    'if (count of windows) = 0 then',
    'set newWindow to (create window with default profile)',
    `tell current session of newWindow to write text ${appleScriptString(inner)}`,
    'else',
    'tell current window'
  );

  if (placement === 'tab') {
    lines.push(
      'create tab with default profile',
      `tell current session to write text ${appleScriptString(inner)}`
    );
  } else {
    const splitKind = resolveItermSplitKind(chord);
    if (splitKind === 'keystroke' && chordClause) {
      lines.push(
        'tell application "System Events"',
        chordClause,
        'end tell',
        'delay 0.2',
        `tell current session to write text ${appleScriptString(inner)}`
      );
    } else {
      const splitVerb = splitKind === 'horizontal' ? 'horizontally' : 'vertically';
      lines.push(
        'tell current session',
        `split ${splitVerb} with default profile`,
        'end tell',
        'tell second session of current tab',
        `write text ${appleScriptString(inner)}`
      );
    }
  }

  lines.push('end tell', 'end if', 'end tell');
  return lines.join('\n');
}

function buildTerminalAppleScript({
  inner,
  placement,
  chordClause
}: {
  inner: string;
  placement: TerminalLaunchPlacement;
  chordClause?: string | null;
}): string {
  const lines = ['tell application "Terminal"', 'activate'];

  if (placement === 'window') {
    lines.push(`do script ${appleScriptString(inner)}`);
  } else if (placement === 'tab') {
    lines.push(
      'if (count of windows) = 0 then',
      `do script ${appleScriptString(inner)}`,
      'else',
      `do script ${appleScriptString(inner)} in front window`,
      'end if'
    );
  } else {
    lines.push(
      'if (count of windows) = 0 then',
      `do script ${appleScriptString(inner)}`,
      'else',
      'tell application "System Events"',
      chordClause ?? 'keystroke "d" using command down',
      'end tell',
      'delay 0.2',
      `do script ${appleScriptString(inner)} in front window`,
      'end if'
    );
  }

  lines.push('end tell');
  return lines.join('\n');
}

function buildGenericPlacementShell({
  launcher,
  inner,
  placement,
  chordClause
}: {
  launcher: string;
  inner: string;
  placement: TerminalLaunchPlacement;
  chordClause?: string | null;
}): string {
  const appName = extractAppNameFromLauncher(launcher);
  const launch = `${launcher} ${inner}`;

  if (placement === 'window' || !appName) {
    return launch;
  }

  const activate = `osascript -e ${shellQuote(`tell application ${JSON.stringify(appName)} to activate`)}`;
  const chord =
    chordClause &&
    `osascript -e ${shellQuote(
      ['tell application "System Events"', chordClause, 'end tell'].join('\n')
    )}`;

  if (placement === 'tab') {
    const newTab = `osascript -e ${shellQuote(
      [
        'tell application "System Events"',
        `tell process ${JSON.stringify(appName)}`,
        'keystroke "t" using command down',
        'end tell',
        'end tell'
      ].join('\n')
    )}`;
    return [activate, newTab, 'sleep 0.2', launch].join(' && ');
  }

  return [activate, chord ?? '', 'sleep 0.2', launch].filter(Boolean).join(' && ');
}

function resolveChordClause(chord: string | null | undefined): string | null {
  if (!chord?.trim()) return null;
  const parsed = parseTerminalLaunchChord(chord);
  if (!parsed) return null;
  return appleScriptKeystrokeClause(parsed);
}

/**
 * Resolve how the agent should actually be spawned given the configured
 * pre-command and terminal launcher. Pure (no side effects) so it can be
 * inspected via `--dry-run` and unit-tested without launching anything.
 */
export function resolveLaunchExecution({
  command,
  args,
  workingDirectory,
  preCommand,
  terminalLauncher,
  terminalLaunchPlacement = 'window',
  terminalLaunchChord
}: {
  command: string;
  args: string[];
  workingDirectory: string;
  preCommand?: string | null;
} & TerminalLaunchSettings): LaunchExecution {
  const agentCommand = agentShellCommand({ command, args, preCommand });
  const launcher = terminalLauncher?.trim();
  const placement = terminalLaunchPlacement ?? 'window';
  const chordClause = resolveChordClause(terminalLaunchChord);

  if (!launcher) {
    return preCommand?.trim()
      ? { command: agentCommand, args: [], useShell: true, terminal: null, display: agentCommand }
      : { command, args, useShell: false, terminal: null, display: agentCommand };
  }

  const inner = terminalInnerCommand({ workingDirectory, agentCommand });
  const builtin = resolveBuiltinTerminal(launcher);

  if (builtin === 'terminal') {
    const script = buildTerminalAppleScript({
      inner,
      placement,
      chordClause
    });
    return {
      command: 'osascript',
      args: ['-e', script],
      useShell: false,
      terminal: 'Terminal',
      display: `Terminal.app (${placement}) › ${inner}`
    };
  }

  if (builtin === 'iterm') {
    const script = buildItermAppleScript({
      inner,
      placement,
      chordClause,
      chord: terminalLaunchChord
    });
    return {
      command: 'osascript',
      args: ['-e', script],
      useShell: false,
      terminal: 'iTerm2',
      display: `iTerm2 (${placement}) › ${inner}`
    };
  }

  const full =
    placement === 'window'
      ? `${launcher} ${agentCommand}`
      : buildGenericPlacementShell({ launcher, inner: agentCommand, placement, chordClause });
  return { command: full, args: [], useShell: true, terminal: launcher, display: full };
}
