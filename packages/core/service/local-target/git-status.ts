import { execFileSync } from 'node:child_process';

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/** Read `git status --short` entries from a checkout (WS-D cleanup). */
export function readGitStatusPorcelain(
  workingDirectory: string
): Array<{ filePath: string; vcsStatus: string }> {
  try {
    const output = execFileSync('git', ['status', '--short'], {
      cwd: workingDirectory,
      encoding: 'utf8'
    });
    return output
      .split('\n')
      .map(line => line.trimEnd())
      .filter(Boolean)
      .map(line => ({
        vcsStatus: line.slice(0, 2).trim() || 'changed',
        filePath: normalizePath(line.slice(3).trim())
      }))
      .filter(entry => entry.filePath.length > 0);
  } catch {
    return [];
  }
}
