import { app, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { bundledCliEntry } from './paths.js';

export type CliUpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'updating'
  | 'error'
  | 'unsupported';

export type CliUpdateStatus = {
  state: CliUpdateState;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  message: string | null;
  updateCommand: string;
};

type GetWindow = () => BrowserWindow | null;

type OvldCheckPayload = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
};

const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const UPDATE_COMMAND = 'ovld update';

export class CliUpdater {
  private status: CliUpdateStatus = {
    state: 'idle',
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    message: null,
    updateCommand: UPDATE_COMMAND
  };

  private autoCheckTimer: NodeJS.Timeout | null = null;

  constructor(private readonly getWindow: GetWindow) {}

  getStatus(): CliUpdateStatus {
    return { ...this.status };
  }

  startAutomaticChecks(): void {
    void this.checkForUpdates();
    this.autoCheckTimer = setInterval(() => {
      void this.checkForUpdates();
    }, AUTO_CHECK_INTERVAL_MS);
  }

  stopAutomaticChecks(): void {
    if (!this.autoCheckTimer) return;
    clearInterval(this.autoCheckTimer);
    this.autoCheckTimer = null;
  }

  async checkForUpdates(): Promise<CliUpdateStatus> {
    this.setStatus({
      state: 'checking',
      message: 'Checking for CLI updates.'
    });

    try {
      const invocation = resolveCliInvocation();
      if (!invocation) {
        this.setStatus({
          state: 'unsupported',
          currentVersion: null,
          latestVersion: null,
          updateAvailable: false,
          message: 'No Overlord CLI was found on this device.'
        });
        return this.getStatus();
      }

      const payload = await runOvldJson<OvldCheckPayload>({
        invocation,
        args: ['update', '--check', '--json']
      });

      if (payload.updateAvailable) {
        this.setStatus({
          state: 'available',
          currentVersion: payload.currentVersion,
          latestVersion: payload.latestVersion,
          updateAvailable: true,
          message: `CLI ${payload.currentVersion} can be updated to ${payload.latestVersion}.`
        });
      } else {
        this.setStatus({
          state: 'not-available',
          currentVersion: payload.currentVersion,
          latestVersion: payload.latestVersion,
          updateAvailable: false,
          message: `CLI ${payload.currentVersion} is up to date.`
        });
      }
    } catch (error) {
      this.setStatus({
        state: 'error',
        updateAvailable: false,
        message: describe(error)
      });
    }

    return this.getStatus();
  }

  async runUpdate(): Promise<CliUpdateStatus> {
    if (!this.status.updateAvailable) return this.getStatus();

    const invocation = resolveCliInvocation();
    if (!invocation) {
      this.setStatus({
        state: 'unsupported',
        message: 'No Overlord CLI was found on this device.'
      });
      return this.getStatus();
    }

    this.setStatus({
      state: 'updating',
      message: 'Updating the Overlord CLI.'
    });

    try {
      await runOvldCommand({
        invocation,
        args: ['update', '--json']
      });
      return await this.checkForUpdates();
    } catch (error) {
      this.setStatus({
        state: 'error',
        updateAvailable: true,
        message: describe(error)
      });
      return this.getStatus();
    }
  }

  private setStatus(next: Partial<CliUpdateStatus>): void {
    this.status = { ...this.status, ...next, updateCommand: UPDATE_COMMAND };
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send('overlord:cli-updates:status', this.getStatus());
  }
}

type CliInvocation = {
  command: string;
  argsPrefix: string[];
};

function resolveCliInvocation(): CliInvocation | null {
  const pathOvld = resolveOvldOnPath();
  if (pathOvld) {
    return { command: pathOvld, argsPrefix: [] };
  }

  const bundled = bundledCliEntry();
  if (bundled) {
    return { command: process.execPath, argsPrefix: [bundled] };
  }

  return null;
}

function resolveOvldOnPath(): string | null {
  const pathEnv = process.env.PATH ?? '';
  const segments = pathEnv.split(pathSeparator());
  const candidates = process.platform === 'win32' ? ['ovld.cmd', 'ovld.exe', 'ovld'] : ['ovld'];

  for (const segment of segments) {
    for (const name of candidates) {
      const candidate = joinPath(segment, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function pathSeparator(): string {
  return process.platform === 'win32' ? ';' : ':';
}

function joinPath(segment: string, name: string): string {
  return path.join(segment, name);
}

async function runOvldJson<T>({
  invocation,
  args
}: {
  invocation: CliInvocation;
  args: string[];
}): Promise<T> {
  const { stdout, exitCode, stderr } = await runOvldCommand({ invocation, args });
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    throw new Error(`Overlord CLI check failed: ${detail}`);
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error('Overlord CLI returned invalid JSON.');
  }
}

function runOvldCommand({
  invocation,
  args
}: {
  invocation: CliInvocation;
  args: string[];
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.argsPrefix, ...args], {
      env: {
        ...process.env,
        OVERLORD_DESKTOP_VERSION: app.getVersion()
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', exitCode => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
