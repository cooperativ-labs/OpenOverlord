import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../cli/src/config.ts';

const VITE_DEV_PORT = 5173;

export function stopLocalDev(): void {
  const config = loadConfig();
  const ports = [...new Set([config.webPort, VITE_DEV_PORT])];

  for (const port of ports) {
    stopListenersOnPort(port);
  }
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
