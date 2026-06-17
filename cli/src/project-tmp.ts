import { type Dirent, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

export const PROJECT_TMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function projectTmpDir(workingDirectory: string): string {
  return path.join(workingDirectory, '.overlord', 'tmp');
}

export function ensureProjectTmpDir(workingDirectory: string): string {
  const tmpDir = projectTmpDir(workingDirectory);
  mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

export function pruneStaleProjectTmp({
  workingDirectory,
  create = false,
  now = Date.now(),
  retentionMs = PROJECT_TMP_RETENTION_MS
}: {
  workingDirectory: string;
  create?: boolean;
  now?: number;
  retentionMs?: number;
}): void {
  const tmpDir = projectTmpDir(workingDirectory);
  if (!create && !existsSync(tmpDir)) return;
  if (create) ensureProjectTmpDir(workingDirectory);
  const cutoff = now - retentionMs;
  pruneChildren(tmpDir, cutoff);
}

function pruneChildren(directory: string, cutoff: number): void {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }

  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      pruneDirectory(target, cutoff);
      continue;
    }
    pruneLeaf(target, cutoff);
  }
}

function pruneDirectory(directory: string, cutoff: number): void {
  pruneChildren(directory, cutoff);

  try {
    const stats = statSync(directory);
    if (stats.mtimeMs > cutoff) return;
  } catch {
    return;
  }

  try {
    if (readdirSync(directory).length === 0) {
      rmSync(directory, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function pruneLeaf(target: string, cutoff: number): void {
  try {
    const stats = statSync(target);
    if (stats.mtimeMs > cutoff) return;
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}
