import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = path.join(repoRoot, 'cli', 'bin', 'ovld.mjs');

export type RunOvldResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export async function runOvld({
  args,
  cwd = repoRoot,
  env = {},
  stdin
}: {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}): Promise<RunOvldResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
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
      resolve({ exitCode, stdout, stderr });
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }

    child.stdin.end();
  });
}
