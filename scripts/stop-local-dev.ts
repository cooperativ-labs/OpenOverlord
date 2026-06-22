import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveProjectRoot } from '../cli/src/config.ts';
import { loadEnvDefaults, resolveLayeredEnv } from '../cli/src/env.ts';

export function stopLocalDev(): void {
  const repoRoot = resolveProjectRoot();
  loadEnvDefaults(repoRoot, 'development');
  const config = loadConfig(path.join(repoRoot, 'overlord.toml'), 'development');

  const webPort = Number(
    resolveLayeredEnv({
      envKey: 'OVERLORD_WEB_PORT',
      configValue: String(config.webPort),
      envProfile: 'development'
    })
  );
  const sqlStudioPort = Number(
    resolveLayeredEnv({
      envKey: 'OVERLORD_SQL_STUDIO_PORT',
      configValue: String(config.sqlStudioPort),
      envProfile: 'development'
    })
  );
  const viteDevPort = Number(process.env.OVERLORD_WEB_DEV_PORT?.trim() || '5173');

  const ports = [
    ...new Set([webPort, config.sqlStudioEnabled ? sqlStudioPort : null, viteDevPort])
  ].filter((port): port is number => port !== null);

  for (const port of ports) {
    stopListenersOnPort(port);
  }

  stopRepoDevProcesses(repoRoot);
}

function stopListenersOnPort(port: number): void {
  const localPids = findListeningPids(port);

  // OrbStack forwards VM ports to macOS localhost; kill the VM process, not OrbStack.
  if (localPids.some(isOrbStackPid)) {
    stopPortOnOrbMachines(port);
    return;
  }

  if (localPids.length > 0) {
    killPids({ pids: localPids, port, via: 'local' });
    return;
  }

  if (process.platform === 'darwin' && commandExists('orb')) {
    stopPortOnOrbMachines(port);
  }
}

function stopPortOnOrbMachines(port: number): void {
  for (const machine of listRunningOrbMachines()) {
    const pids = findOrbMachinePids({ machine, port });
    if (pids.length === 0) continue;
    killPids({ pids, port, via: machine });
  }
}

function findOrbMachinePids({ machine, port }: { machine: string; port: number }): number[] {
  try {
    const output = execSync(`orb run -m ${machine} bash -lc ${shellQuote(`ss -tlnp`)}`, {
      encoding: 'utf8'
    });
    return extractPidsForPort({ output, port });
  } catch {
    return [];
  }
}

function findListeningPids(port: number): number[] {
  if (commandExists('ss')) {
    try {
      const output = execSync('ss -tlnp', { encoding: 'utf8' });
      const pids = extractPidsForPort({ output, port });
      if (pids.length > 0) return pids;
    } catch {
      // fall through to lsof
    }
  }

  if (!commandExists('lsof')) return [];

  try {
    const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: 'utf8' }).trim();
    if (!output) return [];
    return output
      .split('\n')
      .map(line => Number(line.trim()))
      .filter(pid => Number.isFinite(pid));
  } catch {
    return [];
  }
}

function extractPidsForPort({ output, port }: { output: string; port: number }): number[] {
  const portToken = `:${port}`;
  const pids = new Set<number>();

  for (const line of output.split('\n')) {
    if (!line.includes(portToken)) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      pids.add(Number(match[1]));
    }
  }

  return [...pids];
}

function killPids({ pids, port, via }: { pids: number[]; port: number; via: string }): void {
  for (const pid of pids) {
    try {
      if (via === 'local') {
        process.kill(pid, 'SIGTERM');
      } else {
        execSync(`orb run -m ${via} kill -TERM ${pid}`);
      }
      console.log(`stopped pid ${pid} on port ${port}${via === 'local' ? '' : ` (${via})`}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`could not stop pid ${pid} on port ${port}: ${message}`);
    }
  }
}

type ProcessRow = {
  pid: number;
  ppid: number;
  command: string;
};

function stopRepoDevProcesses(repoRoot: string): void {
  const processes = listProcesses();
  if (processes.length === 0) return;

  const byPid = new Map(processes.map(row => [row.pid, row]));
  const targetPids = new Set<number>();

  for (const row of processes) {
    if (!isRepoDevProcess(row, repoRoot)) continue;
    for (let current: ProcessRow | undefined = row; current; current = byPid.get(current.ppid)) {
      if (current.pid === process.pid || current.pid === 1) break;
      if (!isRepoDevProcess(current, repoRoot) && !isDevWrapperProcess(current)) break;
      targetPids.add(current.pid);
    }
  }

  const targets = [...targetPids]
    .map(pid => byPid.get(pid))
    .filter((row): row is ProcessRow => Boolean(row))
    .sort((left, right) => processDepth(left, byPid) - processDepth(right, byPid));

  for (const target of targets) {
    try {
      process.kill(target.pid, 'SIGTERM');
      console.log(`stopped dev process ${target.pid}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`could not stop dev process ${target.pid}: ${message}`);
    }
  }
}

function listProcesses(): ProcessRow[] {
  try {
    const output = execSync('ps -axo pid=,ppid=,command=', { encoding: 'utf8' });
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          command: match[3]
        };
      })
      .filter((row): row is ProcessRow => Boolean(row));
  } catch {
    return [];
  }
}

function isRepoDevProcess(row: ProcessRow, repoRoot: string): boolean {
  const command = row.command;
  if (!command.includes(repoRoot)) return false;

  return (
    command.includes('/node_modules/concurrently/dist/bin/concurrently.js') ||
    (command.includes('/node_modules/tsx/dist/cli.mjs') &&
      command.includes('watch server/index.ts')) ||
    command.includes('/node_modules/vite/bin/vite.js')
  );
}

function isDevWrapperProcess(row: ProcessRow): boolean {
  const command = row.command;
  return (
    command.endsWith('/bin/yarn dev') ||
    command.includes('corepack/dist/yarn.js dev:webapp') ||
    command.includes('corepack/dist/yarn.js webapp:dev') ||
    command.includes('corepack/dist/yarn.js workspace @overlord/webapp dev') ||
    command.includes('corepack/dist/yarn.js dev:server') ||
    command.includes('corepack/dist/yarn.js server:dev') ||
    command.includes('corepack/dist/yarn.js workspace @overlord/webapp dev:server') ||
    command.includes('corepack/dist/yarn.js dev:web') ||
    command.includes('scripts/with-dev-env.mjs yarn dev:webapp') ||
    command.includes('scripts/with-dev-env.mjs yarn webapp:dev') ||
    command.includes('scripts/with-dev-env.mjs yarn dev:server') ||
    command.includes('scripts/with-dev-env.mjs yarn server:dev') ||
    command.includes('scripts/with-dev-env.mjs yarn workspace @overlord/webapp dev') ||
    command.includes('scripts/with-dev-env.mjs yarn workspace @overlord/webapp dev:server')
  );
}

function processDepth(row: ProcessRow, byPid: Map<number, ProcessRow>): number {
  let depth = 0;
  for (let current: ProcessRow | undefined = row; current; current = byPid.get(current.ppid)) {
    depth += 1;
    if (current.ppid === 1) break;
  }
  return depth;
}

function isOrbStackPid(pid: number): boolean {
  try {
    const name = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8' }).trim();
    return name.includes('OrbStack');
  } catch {
    return false;
  }
}

function listRunningOrbMachines(): string[] {
  try {
    const output = execSync('orb list', { encoding: 'utf8' });
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('NAME'))
      .map(line => line.split(/\s+/)[0])
      .filter((machine): machine is string => Boolean(machine))
      .filter(machine => {
        const status = output
          .split('\n')
          .find(line => line.startsWith(`${machine} `))
          ?.split(/\s+/)[1];
        return status === 'running';
      });
  } catch {
    return [];
  }
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const isDirectRun =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectRun) {
  stopLocalDev();
}
