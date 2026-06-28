import { execFileSync } from 'node:child_process';

import type { DoctorCheck } from './types.ts';

function commandOnPath(command: string, args: string[]): DoctorCheck {
  try {
    const detail = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return { name: command, ok: true, detail: detail || 'found on PATH' };
  } catch {
    return { name: command, ok: false, detail: `${command} not found on PATH` };
  }
}

/** Portable local-target health checks that do not require CLI connector state. */
export function runLocalTargetDoctorChecks(): DoctorCheck[] {
  return [commandOnPath('git', ['--version']), commandOnPath('node', ['--version'])];
}
