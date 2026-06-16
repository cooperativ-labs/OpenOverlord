import { execFileSync } from 'node:child_process';

function readGitFiles(rootPath: string): string[] {
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: rootPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: gitRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

/**
 * Tracked + untracked files under `rootPath`'s git repository, used as the
 * `@`-mention candidate list. Returns `[]` when the directory is missing or not
 * a git repository so the picker degrades to a plain prompt.
 */
export function listMentionableFiles(rootPath: string | null | undefined): string[] {
  if (!rootPath) return [];
  try {
    return readGitFiles(rootPath);
  } catch {
    return [];
  }
}
