import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(cliRoot, '..');
const sourceDir = path.join(repoRoot, 'database', 'sqlite', 'migrations');
const targetDir = path.join(cliRoot, 'database', 'sqlite', 'migrations');

if (!existsSync(sourceDir)) {
  throw new Error(`Missing migration source directory: ${sourceDir}`);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });
