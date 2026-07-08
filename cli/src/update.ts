import { spawn } from 'node:child_process';

import { flagBoolean, parseArgs } from './args.js';
import { CliError } from './errors.js';
import { printJson } from './output.js';
import { getCliVersion } from './version.js';

const PACKAGE_NAME = 'overlord-cli';

export const DEFAULT_UPDATE_INSTALL_ARGS = [
  'install',
  '-g',
  '--no-fund',
  `${PACKAGE_NAME}@latest`
] as const;

type SpawnResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type UpdateStatus = {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  installed: boolean;
  packageManager: string;
};

function resolvePackageManager(): string {
  if (process.env.OVLD_UPDATE_BIN) return process.env.OVLD_UPDATE_BIN;
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function resolveSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NPM_CONFIG_FUND: 'false'
  };
}

function resolveCommandArgs({
  envName,
  fallback
}: {
  envName: string;
  fallback: string[];
}): string[] {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(value => typeof value === 'string')) {
    throw new CliError({
      message: `${envName} must be a JSON array of strings.`
    });
  }
  return parsed;
}

function normalizeVersion(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CliError({ message: 'Received an empty version from npm.' });
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
  } catch {
    // Fall back to raw output below.
  }

  return trimmed.replace(/^"+|"+$/g, '');
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(part => Number.parseInt(part, 10));
  const rightParts = right.split('.').map(part => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = Number.isFinite(leftParts[index]) ? leftParts[index]! : 0;
    const rightPart = Number.isFinite(rightParts[index]) ? rightParts[index]! : 0;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }

  return 0;
}

async function runCapturedCommand({
  command,
  args
}: {
  command: string;
  args: string[];
}): Promise<SpawnResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: resolveSpawnEnv(),
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

async function runStreamingCommand({
  command,
  args
}: {
  command: string;
  args: string[];
}): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: resolveSpawnEnv(),
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('close', exitCode => {
      resolve(exitCode ?? 1);
    });
  });
}

async function readLatestVersion(packageManager: string): Promise<string> {
  const args = resolveCommandArgs({
    envName: 'OVLD_UPDATE_VIEW_ARGS_JSON',
    fallback: ['view', PACKAGE_NAME, 'version', '--json']
  });
  const result = await runCapturedCommand({ command: packageManager, args });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new CliError({
      message: `Unable to check the latest ${PACKAGE_NAME} version via ${packageManager}: ${detail}`
    });
  }
  return normalizeVersion(result.stdout);
}

function printStatus(status: UpdateStatus, json: boolean): void {
  if (json) {
    printJson(status);
    return;
  }

  if (!status.updateAvailable) {
    console.log(`Overlord CLI ${status.currentVersion} is already up to date.`);
    return;
  }

  if (!status.installed) {
    console.log(`Overlord CLI ${status.currentVersion} can be updated to ${status.latestVersion}.`);
    return;
  }

  console.log(`Updated Overlord CLI from ${status.currentVersion} to ${status.latestVersion}.`);
}

export async function runUpdateCommand({ rest }: { rest: string[] }): Promise<void> {
  const parsed = parseArgs(rest);
  const json = flagBoolean(parsed.flags, '--json');
  const check = flagBoolean(parsed.flags, '--check');
  const force = flagBoolean(parsed.flags, '--force');

  const currentVersion = getCliVersion();
  const packageManager = resolvePackageManager();
  const latestVersion = await readLatestVersion(packageManager);
  const updateAvailable = compareVersions(currentVersion, latestVersion) < 0;

  if (check || (!updateAvailable && !force)) {
    printStatus(
      {
        packageName: PACKAGE_NAME,
        currentVersion,
        latestVersion,
        updateAvailable,
        installed: false,
        packageManager
      },
      json
    );
    return;
  }

  const installArgs = resolveCommandArgs({
    envName: 'OVLD_UPDATE_INSTALL_ARGS_JSON',
    fallback: [...DEFAULT_UPDATE_INSTALL_ARGS]
  });

  if (!json) {
    console.log(`Updating Overlord CLI via ${packageManager}...`);
  }

  const exitCode = await runStreamingCommand({ command: packageManager, args: installArgs }).catch(
    error => {
      throw new CliError({
        message:
          error instanceof Error
            ? `Failed to start ${packageManager}: ${error.message}`
            : `Failed to start ${packageManager}: ${String(error)}`
      });
    }
  );

  if (exitCode !== 0) {
    throw new CliError({
      message: `${packageManager} exited with status ${exitCode} while updating ${PACKAGE_NAME}.`
    });
  }

  printStatus(
    {
      packageName: PACKAGE_NAME,
      currentVersion,
      latestVersion,
      updateAvailable: true,
      installed: true,
      packageManager
    },
    json
  );
}
