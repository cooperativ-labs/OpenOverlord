// Persistent runner service (Runner Layer).
//
// A host-managed supervisor around the existing one-shot claim-and-launch path.
// The CLI owns install/start/stop/status/uninstall of an OS-level user service
// (macOS launchd LaunchAgent, Linux `systemd --user` unit) whose only job is to
// run `ovld runner supervise` — the adaptive long-running loop that delegates
// each poll to the same code used by `ovld runner once`.
//
// This module keeps all pure, testable logic — adaptive interval selection,
// service-file rendering, and local state I/O — separate from the thin process
// exec wiring so the behavior can be unit-tested without touching the host OS.

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveGlobalDataDir } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * The rendered service definition embeds a user token in its environment, so the
 * file must never be world-readable. Owner read/write only.
 */
function writeServiceFile(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, { mode: 0o600 });
  // `mode` on writeFileSync is ignored when the file already exists, so enforce
  // it explicitly for the overwrite-an-existing-unit case.
  chmodSync(filePath, 0o600);
}

// ---- Constants --------------------------------------------------------------

export const RUNNER_SERVICE_STATE_FILENAME = 'runner-service.json';
/** macOS launchd LaunchAgent label. */
export const LAUNCHD_LABEL = 'io.overlord.runner';
/** Linux systemd --user unit name (without the `.service` suffix). */
export const SYSTEMD_UNIT_NAME = 'overlord-runner';

/** Fast cadence used while a job launched recently. */
export const FAST_POLL_INTERVAL_MS = 3000;
/** Slow cadence used after a long idle stretch. */
export const SLOW_POLL_INTERVAL_MS = 10000;
/** Idle window (2h) after which polling backs off to the slow cadence. */
export const IDLE_BACKOFF_MS = 2 * 60 * 60 * 1000;

export type RunnerServiceKind = 'launchd' | 'systemd';

// ---- Local state ------------------------------------------------------------

export interface RunnerServiceState {
  serviceKind: RunnerServiceKind | null;
  serviceIdentifier: string | null;
  execProgram: string | null;
  execArgs: string[];
  backendUrl: string | null;
  installedAt: string | null;
  lastHeartbeatAt: string | null;
  lastClaimedAt: string | null;
  lastLaunchedAt: string | null;
  lastError: string | null;
  currentPollIntervalMs: number | null;
}

export function emptyRunnerServiceState(): RunnerServiceState {
  return {
    serviceKind: null,
    serviceIdentifier: null,
    execProgram: null,
    execArgs: [],
    backendUrl: null,
    installedAt: null,
    lastHeartbeatAt: null,
    lastClaimedAt: null,
    lastLaunchedAt: null,
    lastError: null,
    currentPollIntervalMs: null
  };
}

export function runnerServiceStatePath(dataDir: string = resolveGlobalDataDir()): string {
  return path.join(dataDir, RUNNER_SERVICE_STATE_FILENAME);
}

export function readRunnerServiceState(
  dataDir: string = resolveGlobalDataDir()
): RunnerServiceState {
  const filePath = runnerServiceStatePath(dataDir);
  if (!existsSync(filePath)) return emptyRunnerServiceState();
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<RunnerServiceState>;
    return { ...emptyRunnerServiceState(), ...parsed };
  } catch {
    // A corrupt state file is local diagnostic data only; never fail a poll or a
    // status read because of it — start from a clean slate.
    return emptyRunnerServiceState();
  }
}

export function writeRunnerServiceState(
  state: RunnerServiceState,
  dataDir: string = resolveGlobalDataDir()
): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(runnerServiceStatePath(dataDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Merge a partial patch into the persisted state and write it back. */
export function patchRunnerServiceState(
  patch: Partial<RunnerServiceState>,
  dataDir: string = resolveGlobalDataDir()
): RunnerServiceState {
  const next = { ...readRunnerServiceState(dataDir), ...patch };
  writeRunnerServiceState(next, dataDir);
  return next;
}

// ---- Adaptive polling -------------------------------------------------------

/**
 * Base poll interval by the "last launched job" clock (not "last poll with
 * work"): fast while a job launched within the idle window, slow afterwards.
 * Pure and deterministic so the cadence is unit-testable.
 */
export function selectBasePollIntervalMs({
  lastLaunchedAt,
  now
}: {
  lastLaunchedAt: string | null;
  now: number;
}): number {
  if (!lastLaunchedAt) return SLOW_POLL_INTERVAL_MS;
  const launchedMs = Date.parse(lastLaunchedAt);
  if (Number.isNaN(launchedMs)) return SLOW_POLL_INTERVAL_MS;
  return now - launchedMs <= IDLE_BACKOFF_MS ? FAST_POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS;
}

/**
 * Add ~10% jitter so many local runners polling a shared backend do not wake in
 * lockstep. `random` is injectable for deterministic tests.
 */
export function applyPollJitter(intervalMs: number, random: () => number = Math.random): number {
  const spread = intervalMs * 0.1;
  return Math.round(intervalMs + (random() * 2 - 1) * spread);
}

// ---- Service invocation resolution -----------------------------------------

export interface RunnerServiceInvocation {
  program: string;
  args: string[];
  /**
   * True when `program` is the Electron/Overlord app binary and must be run as
   * Node (`ELECTRON_RUN_AS_NODE=1`) instead of booting the GUI. Recording the
   * Overlord binary also makes macOS register the background item, login item,
   * and automation prompt under "Overlord" rather than the plain `node`
   * binary's "Node.js Foundation" signature.
   */
  runAsElectronNode?: boolean;
}

/**
 * If the Overlord desktop app is installed, resolve an invocation that runs the
 * persistent service through the app's own bundled binary and CLI (as Node).
 * macOS attributes a LaunchAgent's background item / automation prompt to the
 * code-signing identity of `ProgramArguments[0]`; using the signed Overlord
 * binary registers the service under "Overlord" instead of "Node.js Foundation".
 * Both the binary and the app-bundled CLI script are used so the runtime and its
 * native modules match the app's Electron ABI. Returns null when the app is not
 * found (e.g. a CLI-only install with no desktop app present).
 */
export function resolveOverlordAppInvocation({
  platform = process.platform,
  homedir = os.homedir(),
  exists = existsSync
}: {
  platform?: NodeJS.Platform;
  homedir?: string;
  exists?: (candidate: string) => boolean;
} = {}): RunnerServiceInvocation | null {
  if (platform !== 'darwin') return null;
  const appDirs = [
    '/Applications/Overlord.app',
    path.join(homedir, 'Applications', 'Overlord.app')
  ];
  for (const appDir of appDirs) {
    const program = path.join(appDir, 'Contents', 'MacOS', 'Overlord');
    const script = path.join(appDir, 'Contents', 'Resources', 'cli', 'bin', 'ovld.mjs');
    if (exists(program) && exists(script)) {
      return { program, args: [script, 'runner', 'supervise'], runAsElectronNode: true };
    }
  }
  return null;
}

/**
 * Resolve how the installed service should invoke `ovld runner supervise`.
 * Prefer an explicit override (`OVLD_RUNNER_EXEC`, space-free path), otherwise
 * re-run the current CLI entrypoint under the same Node runtime. Persistent
 * services start with a sparse environment, so we always record an absolute
 * program path rather than relying on `PATH` resolution of a bare `ovld`.
 *
 * When the installer already runs under Electron-as-Node (the desktop app path),
 * `process.execPath` is the Overlord binary — keep using it. Otherwise, for a
 * plain terminal install, prefer the installed Overlord app binary when present
 * so the service registers under "Overlord" rather than "Node.js Foundation".
 */
export function resolveOvldInvocation(
  argv: string[] = process.argv,
  execPath: string = process.execPath
): RunnerServiceInvocation {
  const override = process.env.OVLD_RUNNER_EXEC?.trim();
  if (override) {
    return { program: override, args: ['runner', 'supervise'] };
  }
  const scriptPath = argv[1] ? path.resolve(argv[1]) : '';
  if (process.env.ELECTRON_RUN_AS_NODE) {
    return scriptPath
      ? { program: execPath, args: [scriptPath, 'runner', 'supervise'], runAsElectronNode: true }
      : { program: execPath, args: ['runner', 'supervise'], runAsElectronNode: true };
  }
  const appInvocation = resolveOverlordAppInvocation();
  if (appInvocation) return appInvocation;
  if (scriptPath) {
    return { program: execPath, args: [scriptPath, 'runner', 'supervise'] };
  }
  return { program: execPath, args: ['runner', 'supervise'] };
}

/**
 * Describe which code-signing identity macOS will attribute the installed
 * service to, based on the recorded exec program. Terminal installs that predate
 * app-binary resolution still run the plain `node` binary and register under
 * "Node.js Foundation"; reinstalling from a machine with the desktop app present
 * re-registers them under "Overlord". A no-op on non-macOS hosts.
 */
export function describeServicePublisher({
  execProgram,
  platform = process.platform
}: {
  execProgram: string | null;
  platform?: NodeJS.Platform;
}): { publisher: 'overlord' | 'node' | 'unknown'; needsReinstallForOverlord: boolean } {
  if (platform !== 'darwin' || !execProgram) {
    return { publisher: 'unknown', needsReinstallForOverlord: false };
  }
  if (execProgram.includes('.app/Contents/MacOS/')) {
    return { publisher: 'overlord', needsReinstallForOverlord: false };
  }
  return { publisher: 'node', needsReinstallForOverlord: true };
}

/**
 * Environment snapshot injected into the service definition. Persistent services
 * do not source interactive shell startup files, so the backend URL, Overlord
 * home, and a minimal PATH must be captured explicitly at install time.
 */
export function buildRunnerServiceEnv({
  backendUrl,
  overlordHome,
  runAsElectronNode
}: {
  backendUrl: string;
  overlordHome?: string | null;
  runAsElectronNode?: boolean;
}): Record<string, string> {
  const env: Record<string, string> = {
    OVERLORD_BACKEND_URL: backendUrl,
    PATH: process.env.PATH?.trim() || '/usr/local/bin:/usr/bin:/bin'
  };
  const home = overlordHome?.trim() || process.env.OVLD_HOME?.trim();
  if (home) env.OVLD_HOME = path.resolve(home);
  const token = process.env.OVERLORD_USER_TOKEN?.trim() || process.env.OVLD_USER_TOKEN?.trim();
  if (token) env.OVERLORD_USER_TOKEN = token;
  // When the service program is the Overlord/Electron binary — either because the
  // install ran inside the desktop shell (Electron executing this script as Node)
  // or because a terminal install resolved the installed app binary — the unit
  // must carry this flag or launchd/systemd would boot GUI app instances on a
  // KeepAlive loop instead of the supervisor. It also makes macOS register the
  // background item and automation prompt under "Overlord" rather than "Node".
  if (runAsElectronNode || process.env.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

// ---- Service file rendering (pure) -----------------------------------------

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderLaunchdPlist({
  label,
  invocation,
  env,
  logDir
}: {
  label: string;
  invocation: RunnerServiceInvocation;
  env: Record<string, string>;
  logDir: string;
}): string {
  const programArgs = [invocation.program, ...invocation.args]
    .map(arg => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n');
  const envEntries = Object.entries(env)
    .map(
      ([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'runner-service.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'runner-service.err.log'))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit({
  invocation,
  env
}: {
  invocation: RunnerServiceInvocation;
  env: Record<string, string>;
}): string {
  // systemd ExecStart requires an absolute program; arguments are space-joined.
  // None of our arguments contain spaces (resolved script path aside, which we
  // quote defensively).
  const quote = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);
  const execStart = [invocation.program, ...invocation.args].map(quote).join(' ');
  const envLines = Object.entries(env)
    .map(([key, value]) => `Environment=${key}=${value}`)
    .join('\n');
  return `[Unit]
Description=Overlord persistent runner supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
${envLines}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// ---- Service manager abstraction -------------------------------------------

export interface RunnerServiceRunState {
  installed: boolean;
  running: 'running' | 'stopped' | 'unknown';
}

export interface RunnerServiceManager {
  kind: RunnerServiceKind;
  identifier: string;
  unitPath(): string;
  render(opts: { invocation: RunnerServiceInvocation; env: Record<string, string> }): string;
  install(opts: {
    invocation: RunnerServiceInvocation;
    env: Record<string, string>;
    autoStart: boolean;
  }): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<RunnerServiceRunState>;
}

function launchAgentsDir(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function systemdUserDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), '.config');
  return path.join(base, 'systemd', 'user');
}

async function runCommand(program: string, args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(program, args);
  return { stdout: stdout.toString() };
}

class LaunchdManager implements RunnerServiceManager {
  readonly kind = 'launchd' as const;
  readonly identifier = LAUNCHD_LABEL;

  unitPath(): string {
    return path.join(launchAgentsDir(), `${LAUNCHD_LABEL}.plist`);
  }

  render(opts: { invocation: RunnerServiceInvocation; env: Record<string, string> }): string {
    return renderLaunchdPlist({
      label: LAUNCHD_LABEL,
      invocation: opts.invocation,
      env: opts.env,
      logDir: path.join(resolveGlobalDataDir(), 'logs')
    });
  }

  async install(opts: {
    invocation: RunnerServiceInvocation;
    env: Record<string, string>;
    autoStart: boolean;
  }): Promise<void> {
    mkdirSync(launchAgentsDir(), { recursive: true });
    mkdirSync(path.join(resolveGlobalDataDir(), 'logs'), { recursive: true });
    writeServiceFile(this.unitPath(), this.render(opts));
    if (opts.autoStart) await this.start();
  }

  async start(): Promise<void> {
    // `load -w` is idempotent and enables the agent; ignore an already-loaded error.
    try {
      await runCommand('launchctl', ['load', '-w', this.unitPath()]);
    } catch {
      await runCommand('launchctl', [
        'kickstart',
        '-k',
        `gui/${process.getuid?.() ?? ''}/${LAUNCHD_LABEL}`
      ]);
    }
  }

  async stop(): Promise<void> {
    await runCommand('launchctl', ['unload', '-w', this.unitPath()]);
  }

  async restart(): Promise<void> {
    try {
      await this.stop();
    } catch {
      // May not be loaded yet; proceed to start.
    }
    await this.start();
  }

  async uninstall(): Promise<void> {
    try {
      await this.stop();
    } catch {
      // Not loaded; still remove the plist below.
    }
    if (existsSync(this.unitPath())) rmSync(this.unitPath());
  }

  async status(): Promise<RunnerServiceRunState> {
    const installed = existsSync(this.unitPath());
    try {
      const { stdout } = await runCommand('launchctl', ['list']);
      const line = stdout.split('\n').find(row => row.includes(LAUNCHD_LABEL));
      if (!line) return { installed, running: installed ? 'stopped' : 'unknown' };
      // launchctl list columns: PID  Status  Label. A numeric PID => running.
      const pid = line.trim().split(/\s+/)[0];
      return { installed, running: pid && pid !== '-' ? 'running' : 'stopped' };
    } catch {
      return { installed, running: 'unknown' };
    }
  }
}

class SystemdUserManager implements RunnerServiceManager {
  readonly kind = 'systemd' as const;
  readonly identifier = `${SYSTEMD_UNIT_NAME}.service`;

  unitPath(): string {
    return path.join(systemdUserDir(), `${SYSTEMD_UNIT_NAME}.service`);
  }

  render(opts: { invocation: RunnerServiceInvocation; env: Record<string, string> }): string {
    return renderSystemdUnit(opts);
  }

  async install(opts: {
    invocation: RunnerServiceInvocation;
    env: Record<string, string>;
    autoStart: boolean;
  }): Promise<void> {
    mkdirSync(systemdUserDir(), { recursive: true });
    writeServiceFile(this.unitPath(), this.render(opts));
    await runCommand('systemctl', ['--user', 'daemon-reload']);
    await runCommand('systemctl', ['--user', 'enable', this.identifier]);
    if (opts.autoStart) await this.start();
  }

  async start(): Promise<void> {
    await runCommand('systemctl', ['--user', 'start', this.identifier]);
  }

  async stop(): Promise<void> {
    await runCommand('systemctl', ['--user', 'stop', this.identifier]);
  }

  async restart(): Promise<void> {
    await runCommand('systemctl', ['--user', 'restart', this.identifier]);
  }

  async uninstall(): Promise<void> {
    try {
      await this.stop();
      await runCommand('systemctl', ['--user', 'disable', this.identifier]);
    } catch {
      // Unit may not be active/enabled; still remove the file below.
    }
    if (existsSync(this.unitPath())) rmSync(this.unitPath());
    try {
      await runCommand('systemctl', ['--user', 'daemon-reload']);
    } catch {
      // Best effort.
    }
  }

  async status(): Promise<RunnerServiceRunState> {
    const installed = existsSync(this.unitPath());
    try {
      const { stdout } = await runCommand('systemctl', ['--user', 'is-active', this.identifier]);
      return { installed, running: stdout.trim() === 'active' ? 'running' : 'stopped' };
    } catch {
      // `is-active` exits non-zero when inactive/failed.
      return { installed, running: installed ? 'stopped' : 'unknown' };
    }
  }
}

/**
 * Resolve the host service manager for the current platform. Windows is not yet
 * supported (Task Scheduler is a documented follow-up), so it returns null.
 */
export function resolveServiceManager(
  platform: NodeJS.Platform = process.platform
): RunnerServiceManager | null {
  if (platform === 'darwin') return new LaunchdManager();
  if (platform === 'linux') return new SystemdUserManager();
  return null;
}
