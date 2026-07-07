import { flagBoolean, flagValue, parseArgs } from './args.js';
import {
  type AuthLoginResult,
  isBackendReachabilityError,
  type PasswordLoginCredentialTarget,
  probeBackendReachability,
  runInteractiveAuthLogin
} from './auth-login.js';
import { resolveAuthStatus } from './auth-status.js';
import {
  DEFAULT_LOCAL_BACKEND_URL,
  loadConfig,
  resolveConfigWritePath,
  writeConfig
} from './config.js';
import {
  listAvailableConnectors,
  setupAllConnectors,
  setupConnector,
  type SetupResult
} from './connectors.js';
import { CliError } from './errors.js';
import { printJson, printLine, printStepTitle } from './output.js';
import type { CliRuntime } from './runtime.js';
import { openCliRuntime } from './runtime.js';
import { parseTerminalLaunchChord, type TerminalLaunchPlacement } from './terminal-launch-chord.js';
import {
  fetchTerminalProfile,
  readLegacyTerminalProfileFromToml,
  saveTerminalProfile,
  type TerminalProfile
} from './terminal-profile.js';

const DESKTOP_DOWNLOAD_URL =
  'https://github.com/cooperativ-labs/OpenOverlord/releases/latest/download/';

const TERMINAL_OPTIONS = [
  { label: 'Terminal', launcher: 'Terminal' },
  { label: 'iTerm2', launcher: 'iTerm2' },
  { label: 'Ghostty', launcher: "open -a 'Ghostty' --args" },
  { label: 'Warp', launcher: "open -a 'Warp' --args" },
  { label: 'WezTerm', launcher: "open -a 'WezTerm' --args" },
  { label: 'Alacritty', launcher: "open -a 'Alacritty' --args" },
  { label: 'Kitty', launcher: "open -a 'kitty' --args" }
] as const;

function printHumanResult(result: SetupResult): void {
  const verb = result.dryRun ? 'Would install' : 'Installed';
  printLine(`${verb} connector "${result.agentKey}" → ${result.installPath}`);
  for (const file of result.files) {
    const marker = file.action === 'written' ? '+' : file.action === 'would-write' ? '~' : '=';
    printLine(`  ${marker} ${file.path}${file.executable ? ' (executable)' : ''}`);
  }
  for (const warning of result.warnings) {
    printLine(`  warn: ${warning}`);
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function launcherForApplicationName(appName: string): string {
  return `open -a ${shellQuote(appName.trim())} --args`;
}

async function promptLine({
  message,
  defaultValue
}: {
  message: string;
  defaultValue?: string;
}): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError({
      message:
        'Interactive setup requires a TTY. Use `ovld config set ...` and `ovld agent-setup ...` for non-interactive setup.'
    });
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await rl.question(`${message}${suffix}: `);
    return answer.trim() || defaultValue || '';
  } finally {
    rl.close();
  }
}

async function promptYesNo(message: string, defaultValue: boolean): Promise<boolean> {
  const answer = (
    await promptLine({ message, defaultValue: defaultValue ? 'Y' : 'N' })
  ).toLowerCase();
  if (['y', 'yes'].includes(answer)) return true;
  if (['n', 'no'].includes(answer)) return false;
  throw new CliError({ message: 'Answer yes or no.' });
}

async function configureBackendForSetup(): Promise<{
  mode: 'local' | 'cloud';
  url: string;
  path: string;
}> {
  const targetPath = resolveConfigWritePath();
  const current = loadConfig(targetPath);

  printStepTitle('Step 1: Choose the backend the CLI should use.');
  const type = (
    await promptLine({ message: 'Backend type (local/cloud)', defaultValue: current.backendMode })
  ).toLowerCase();

  if (type === 'cloud') {
    const cloudUrl = await promptLine({
      message: 'Cloud backend URL',
      defaultValue: current.backendMode === 'cloud' ? (current.backendUrl ?? undefined) : undefined
    });
    if (!cloudUrl) throw new CliError({ message: 'Cloud backend URL is required.' });
    if (!isHttpUrl(cloudUrl)) {
      throw new CliError({ message: 'Cloud backend must be an http:// or https:// URL.' });
    }
    writeConfig({
      targetPath,
      config: { ...current, backendMode: 'cloud', backendUrl: cloudUrl }
    });
    printLine(`Configured cloud backend at ${cloudUrl}.`);
    return { mode: 'cloud', url: cloudUrl, path: targetPath };
  }

  if (type !== 'local') {
    throw new CliError({ message: 'Backend type must be `local` or `cloud`.' });
  }

  const hasDesktop = await promptYesNo(
    'Have you installed the Overlord Desktop app on this machine?',
    true
  );
  if (!hasDesktop) {
    printLine(`Download Overlord Desktop: ${DESKTOP_DOWNLOAD_URL}`);
  }
  const localUrl = await promptLine({
    message: 'Local backend URL',
    defaultValue: current.backendUrl ?? DEFAULT_LOCAL_BACKEND_URL
  });
  if (!isHttpUrl(localUrl)) {
    throw new CliError({ message: 'Local backend must be an http:// or https:// URL.' });
  }
  writeConfig({
    targetPath,
    config: { ...current, backendMode: 'local', backendUrl: localUrl }
  });
  printLine(`Configured local backend at ${localUrl}.`);
  return { mode: 'local', url: localUrl, path: targetPath };
}

async function configureAuthForSetup({
  backendUrl,
  passwordCredentialTarget
}: {
  backendUrl: string;
  passwordCredentialTarget: PasswordLoginCredentialTarget;
}): Promise<AuthLoginResult> {
  printLine('');
  printStepTitle('Step 2: Authenticate with the backend.');

  const status = await resolveAuthStatus();
  if (status.loggedIn) {
    const methodLabel =
      status.credentialType === 'user_token' ? 'USER_TOKEN' : 'email and password';
    printLine(`Already authenticated with ${status.backendUrl} using ${methodLabel}.`);
    return {
      ok: true,
      authMethod: status.credentialType === 'user_token' ? 'user_token' : 'password',
      credentialType: status.credentialType ?? 'session_bearer',
      backendUrl: status.backendUrl,
      credentialsPath: status.credentialsPath ?? ''
    };
  }

  try {
    const login = await runInteractiveAuthLogin({ backendUrl, passwordCredentialTarget });
    const methodLabel = login.authMethod === 'user_token' ? 'USER_TOKEN' : 'email and password';
    printLine(`Authenticated with ${login.backendUrl} using ${methodLabel}.`);
    return login;
  } catch (error) {
    const reachability = await probeBackendReachability({ backendUrl });
    if (isBackendReachabilityError(error) || !reachability.reachable) {
      printLine('');
      printLine(
        `Warning: Could not reach the backend at ${backendUrl}. ` +
          'Check that `backend_url` in overlord.toml is correct and the backend is running.'
      );
      if (reachability.error) {
        printLine(`  ${reachability.error}`);
      }
    }
    throw error;
  }
}

function parseAgentSelection(input: string): string[] {
  const available = listAvailableConnectors();
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === 'all') return available;
  if (normalized === 'none' || normalized === 'skip') return [];

  const selected = normalized
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  const invalid = selected.filter(agent => !available.includes(agent));
  if (invalid.length > 0) {
    throw new CliError({
      message: `Unknown connector(s): ${invalid.join(', ')}. Available: ${available.join(', ')}.`
    });
  }
  return selected;
}

async function configureAgentsForSetup(): Promise<SetupResult[]> {
  const available = listAvailableConnectors();
  printLine('');
  printStepTitle('Step 3: Configure agent connectors.');
  printLine(`Available agents: ${available.join(', ')}`);
  const answer = await promptLine({
    message: 'Agents to configure (comma-separated, all, or none)',
    defaultValue: 'all'
  });
  const selected = parseAgentSelection(answer);
  const results = selected.map(agentKey => setupConnector({ agentKey }));
  for (const result of results) {
    printHumanResult(result);
  }
  if (results.length === 0) {
    printLine('Skipped agent connector setup.');
  }
  return results;
}

function isBuiltinTerminalLauncher(launcher: string): boolean {
  const normalized = launcher.trim().toLowerCase();
  return (
    normalized === 'iterm2' ||
    normalized === 'iterm' ||
    normalized === 'iterm.app' ||
    normalized === 'terminal' ||
    normalized === 'terminal.app' ||
    normalized === 'apple terminal'
  );
}

const CHORD_PRESETS = [
  { label: 'cmd+d (vertical split)', chord: 'cmd+d' },
  { label: 'cmd+shift+d (horizontal split)', chord: 'cmd+shift+d' },
  { label: 'Custom shortcut', chord: null }
] as const;

async function promptTerminalLaunchChord({
  defaultValue
}: {
  defaultValue?: string | null;
}): Promise<string> {
  printLine('');
  printLine('Choose a split-pane shortcut (type it — do not press the keys):');
  CHORD_PRESETS.forEach((preset, index) => {
    printLine(`  ${index + 1}. ${preset.label}`);
  });

  const answer = await promptLine({
    message: 'Split shortcut preset',
    defaultValue: defaultValue ? 'current' : '1'
  });
  const normalized = answer.trim().toLowerCase();

  if (normalized === 'current' && defaultValue) {
    return defaultValue;
  }

  const selectedIndex = Number.parseInt(answer, 10);
  const preset =
    Number.isNaN(selectedIndex) || selectedIndex < 1 || selectedIndex > CHORD_PRESETS.length
      ? CHORD_PRESETS.find(entry => entry.label.toLowerCase().includes(normalized))
      : CHORD_PRESETS[selectedIndex - 1];

  if (preset?.chord) {
    return preset.chord;
  }

  const typed = await promptLine({
    message: 'Split shortcut (type, e.g. cmd+d)',
    defaultValue: defaultValue ?? undefined
  });
  if (!typed.trim()) {
    throw new CliError({ message: 'Split shortcut is required for split-pane launches.' });
  }
  if (!parseTerminalLaunchChord(typed)) {
    throw new CliError({
      message: 'Invalid shortcut. Use forms like cmd+d, ctrl+shift+d, or alt+enter.'
    });
  }
  return typed.trim();
}

async function configureTerminalPlacementForSetup({
  terminalLauncher,
  current
}: {
  terminalLauncher: string;
  current: TerminalProfile;
}): Promise<{ placement: TerminalLaunchPlacement; chord: string | null }> {
  printLine('');
  printLine('How should launched agents open?');
  printLine('  1. New window (default)');
  printLine('  2. New tab');
  printLine('  3. Split pane (keyboard shortcut)');

  const defaultPlacement = current.placement !== 'window' || current.chord ? 'current' : '1';
  const answer = await promptLine({
    message: 'Launch placement',
    defaultValue: defaultPlacement
  });
  const normalized = answer.trim().toLowerCase();

  let placement: TerminalLaunchPlacement;
  let chord: string | null = null;

  if (normalized === 'current') {
    placement = current.placement;
    chord = current.chord;
  } else if (normalized === 'window' || normalized === '1') {
    placement = 'window';
  } else if (normalized === 'tab' || normalized === '2') {
    placement = 'tab';
  } else if (
    normalized === 'chord' ||
    normalized === 'split' ||
    normalized === 'shortcut' ||
    normalized === '3'
  ) {
    placement = 'chord';
    chord = await promptTerminalLaunchChord({ defaultValue: current.chord });
  } else {
    throw new CliError({ message: 'Choose new window, new tab, or split pane.' });
  }

  if (placement === 'chord' && !chord) {
    chord = await promptTerminalLaunchChord({ defaultValue: current.chord });
  }

  if (!isBuiltinTerminalLauncher(terminalLauncher) && placement === 'tab') {
    printLine('Note: new-tab placement uses Cmd+T via System Events for non-iTerm/Terminal apps.');
  }
  if (!isBuiltinTerminalLauncher(terminalLauncher) && placement === 'chord') {
    printLine(
      'Note: split-pane placement sends your shortcut via System Events, then launches the agent.'
    );
  }

  if (placement === 'window') {
    printLine('Will open launched agents in a new window.');
  } else if (placement === 'tab') {
    printLine('Will open launched agents in a new tab.');
  } else {
    printLine(`Will split with shortcut ${chord}.`);
  }

  return { placement, chord };
}

async function resolveCurrentTerminalProfile({
  runtime
}: {
  runtime: CliRuntime;
}): Promise<TerminalProfile> {
  try {
    const stored = await fetchTerminalProfile({ backend: runtime.backend });
    if (stored.launcher) return stored;
    const legacy = readLegacyTerminalProfileFromToml();
    return legacy ?? stored;
  } catch {
    return (
      readLegacyTerminalProfileFromToml() ?? {
        launcher: 'Terminal',
        placement: 'window',
        chord: null
      }
    );
  }
}

async function configureTerminalForSetup({ runtime }: { runtime: CliRuntime }): Promise<{
  executionTargetId: string;
  deviceLabel: string;
  launcher: string | null;
  placement: TerminalLaunchPlacement | null;
  chord: string | null;
}> {
  const current = await resolveCurrentTerminalProfile({ runtime });

  printLine('');
  printStepTitle('Step 4: Choose the default terminal for launched agents.');
  TERMINAL_OPTIONS.forEach((option, index) => {
    printLine(`  ${index + 1}. ${option.label}`);
  });
  printLine(`  ${TERMINAL_OPTIONS.length + 1}. Custom application name`);
  printLine(`  ${TERMINAL_OPTIONS.length + 2}. Inline in the current terminal`);

  const answer = await promptLine({
    message: 'Default terminal',
    defaultValue: current.launcher ? 'current' : '1'
  });
  const normalized = answer.trim().toLowerCase();
  let terminalLauncher: string | null;

  if (normalized === 'current') {
    terminalLauncher = current.launcher;
  } else if (normalized === 'inline' || normalized === String(TERMINAL_OPTIONS.length + 2)) {
    terminalLauncher = null;
  } else if (normalized === 'custom' || normalized === String(TERMINAL_OPTIONS.length + 1)) {
    const appName = await promptLine({ message: 'Terminal application name' });
    if (!appName) throw new CliError({ message: 'Terminal application name is required.' });
    terminalLauncher = launcherForApplicationName(appName);
  } else {
    const selectedIndex = Number.parseInt(answer, 10);
    const selected =
      Number.isNaN(selectedIndex) || selectedIndex < 1 || selectedIndex > TERMINAL_OPTIONS.length
        ? TERMINAL_OPTIONS.find(option => option.label.toLowerCase() === normalized)
        : TERMINAL_OPTIONS[selectedIndex - 1];
    if (!selected) {
      throw new CliError({ message: 'Choose a listed terminal, custom, or inline.' });
    }
    terminalLauncher = selected.launcher;
  }

  let placement: TerminalLaunchPlacement = 'window';
  let chord: string | null = null;

  if (terminalLauncher) {
    const selectedPlacement = await configureTerminalPlacementForSetup({
      terminalLauncher,
      current: { ...current, launcher: terminalLauncher }
    });
    placement = selectedPlacement.placement;
    chord = selectedPlacement.chord;
  }

  const saved = await saveTerminalProfile({
    backend: runtime.backend,
    profile: {
      launcher: terminalLauncher,
      placement: terminalLauncher ? placement : 'window',
      chord: terminalLauncher && placement === 'chord' ? chord : null
    }
  });

  printLine(
    terminalLauncher
      ? `Saved terminal profile for local target ${saved.executionTargetId} (${saved.deviceLabel}).`
      : 'Saved terminal profile: launched agents will run inline.'
  );

  return {
    executionTargetId: saved.executionTargetId,
    deviceLabel: saved.deviceLabel,
    launcher: terminalLauncher,
    placement: terminalLauncher ? placement : null,
    chord: terminalLauncher && placement === 'chord' ? chord : null
  };
}

async function runFullSetupCommand({ json }: { json: boolean }): Promise<void> {
  const backend = await configureBackendForSetup();
  const auth = await configureAuthForSetup({
    backendUrl: backend.url,
    passwordCredentialTarget: backend.mode === 'cloud' ? 'full_user_token' : 'session_bearer'
  });
  const agents = await configureAgentsForSetup();
  const runtime = openCliRuntime();
  try {
    const terminal = await configureTerminalForSetup({ runtime });

    if (json) {
      printJson({
        ok: true,
        backend,
        auth: {
          authMethod: auth.authMethod,
          credentialType: auth.credentialType,
          backendUrl: auth.backendUrl,
          credentialsPath: auth.credentialsPath
        },
        agents: agents.map(result => result.agentKey),
        terminal
      });
    } else {
      printLine('');
      printLine(`Setup complete. Wrote ${backend.path}.`);
    }
  } finally {
    runtime.close();
  }
}

export async function runAgentSetupCommand({
  rest,
  json
}: {
  rest: string[];
  json: boolean;
}): Promise<void> {
  const parsed = parseArgs(rest);
  const target = parsed.positional[0];
  const dryRun = flagBoolean(parsed.flags, '--dry-run');
  const home = flagValue(parsed.flags, '--home');

  if (!target) {
    const available = listAvailableConnectors();
    if (json) {
      printJson({ available, usage: 'ovld agent-setup <agent>|all [--dry-run] [--json]' });
    } else {
      printLine('Available connectors:');
      for (const agent of available) {
        printLine(`  ${agent}`);
      }
      printLine('');
      printLine('Install one with `ovld agent-setup <agent>` or all with `ovld agent-setup all`.');
    }
    return;
  }

  const results =
    target === 'all'
      ? setupAllConnectors({ home, dryRun })
      : [setupConnector({ agentKey: target, home, dryRun })];

  if (json) {
    printJson({ ok: true, dryRun, results });
  } else {
    for (const result of results) {
      printHumanResult(result);
    }
  }
}

export async function runSetupCommand({
  rest,
  json
}: {
  rest: string[];
  json: boolean;
}): Promise<void> {
  const parsed = parseArgs(rest);
  if (parsed.positional.length > 0) {
    throw new CliError({
      message:
        'Connector setup moved to `ovld agent-setup`. Run `ovld setup` for full configuration or `ovld agent-setup <agent>|all` for connectors.'
    });
  }
  await runFullSetupCommand({ json });
}
