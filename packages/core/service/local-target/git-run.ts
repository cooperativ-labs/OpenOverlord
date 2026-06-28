import { execFileSync } from 'node:child_process';

export type GitRun = { ok: boolean; stdout: string; stderr: string };

export function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 2 * 1024 * 1024
    }).trim();
  } catch {
    return '';
  }
}

/** Surfaces failure (exit code + stderr) for mutations where the outcome drives typed errors. */
export function runGitResult(cwd: string, args: string[]): GitRun {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    const e = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      ok: false,
      stdout: (e.stdout ? String(e.stdout) : '').trim(),
      stderr: (e.stderr ? String(e.stderr) : '').trim()
    };
  }
}
