import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveGlobalDataDir } from './config.js';

/**
 * Client-side VCS change capture.
 *
 * Changed-file reporting must not depend on the agent remembering to enumerate
 * what it changed. Instead the CLI records a baseline snapshot of dirty paths
 * (path, status, worktree content hash) when a work session begins (`attach` /
 * `resume-follow-up`) and, at `deliver`, computes the run-attributable delta:
 * paths whose worktree state differs from that baseline.
 *
 * VCS is read on the client only — we never send diffs or file contents, just
 * normalized paths and short status codes. Everything here is best-effort: outside
 * a git repository (or when git is unavailable) we infer nothing.
 */

export type ChangedFile = { filePath: string; vcsStatus: string };

type BaselineFile = {
  filePath: string;
  vcsStatus: string;
  /** `null` means this row came from a legacy path-only baseline. */
  contentHash: string | null;
};

type BaselineSnapshot = {
  capturedAt: string;
  files: BaselineFile[];
};

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').trim();
}

/** Parse one `git status --porcelain` line into a changed-file record. */
function parsePorcelainLine(line: string): ChangedFile | null {
  const trimmedEnd = line.replace(/\s+$/, '');
  if (!trimmedEnd) return null;
  const vcsStatus = trimmedEnd.slice(0, 2).trim() || 'changed';
  let pathPart = trimmedEnd.slice(3).trim();
  // Renames/copies render as "old -> new"; the new path is what currently exists.
  const arrow = pathPart.indexOf(' -> ');
  if (arrow !== -1) pathPart = pathPart.slice(arrow + 4).trim();
  // git quotes paths containing special chars; strip the surrounding quotes.
  if (pathPart.startsWith('"') && pathPart.endsWith('"') && pathPart.length >= 2) {
    pathPart = pathPart.slice(1, -1);
  }
  const filePath = normalizePath(pathPart);
  return filePath ? { filePath, vcsStatus } : null;
}

function hashWorktreeFile({
  workingDirectory,
  filePath
}: {
  workingDirectory: string;
  filePath: string;
}): string | null {
  try {
    return execFileSync('git', ['hash-object', filePath], {
      cwd: workingDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

/** Current changed files from `git status --porcelain`; `[]` when not a git repo. */
export function readChangedFiles(workingDirectory: string): ChangedFile[] {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      cwd: workingDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 10 * 1024 * 1024
    });
    const byPath = new Map<string, ChangedFile>();
    for (const line of output.split('\n')) {
      const entry = parsePorcelainLine(line);
      if (entry) byPath.set(entry.filePath, entry);
    }
    return Array.from(byPath.values());
  } catch {
    return [];
  }
}

function baselineFilePath({
  workingDirectory,
  ticketId
}: {
  workingDirectory: string;
  ticketId: string;
}): string {
  const key = createHash('sha256')
    .update(`${path.resolve(workingDirectory)}\0${ticketId}`)
    .digest('hex');
  return path.join(resolveGlobalDataDir(), 'vcs-baselines', `${key}.json`);
}

function snapshotBaselineFiles({
  workingDirectory,
  files
}: {
  workingDirectory: string;
  files: ChangedFile[];
}): BaselineFile[] {
  return files.map(entry => ({
    filePath: entry.filePath,
    vcsStatus: entry.vcsStatus,
    contentHash: hashWorktreeFile({ workingDirectory, filePath: entry.filePath })
  }));
}

/** Record the baseline snapshot for a session's working dir. */
export function writeBaseline({
  workingDirectory,
  ticketId,
  files
}: {
  workingDirectory: string;
  ticketId: string;
  files: ChangedFile[];
}): void {
  try {
    const target = baselineFilePath({ workingDirectory, ticketId });
    mkdirSync(path.dirname(target), { recursive: true });
    const snapshot: BaselineSnapshot = {
      capturedAt: new Date().toISOString(),
      files: snapshotBaselineFiles({ workingDirectory, files })
    };
    writeFileSync(target, JSON.stringify(snapshot));
  } catch {
    // Best-effort: a missing baseline just means deliver treats every dirty path
    // as run-attributable, which is safe (errs toward completeness).
  }
}

function readBaselineSnapshot({
  workingDirectory,
  ticketId
}: {
  workingDirectory: string;
  ticketId: string;
}): Map<string, BaselineFile> {
  try {
    const target = baselineFilePath({ workingDirectory, ticketId });
    if (!existsSync(target)) return new Map();
    const raw = JSON.parse(readFileSync(target, 'utf8')) as {
      files?: unknown;
      paths?: unknown;
    };
    if (Array.isArray(raw.files)) {
      const byPath = new Map<string, BaselineFile>();
      for (const entry of raw.files) {
        if (
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as BaselineFile).filePath === 'string'
        ) {
          const file = entry as BaselineFile;
          byPath.set(file.filePath, {
            filePath: file.filePath,
            vcsStatus: typeof file.vcsStatus === 'string' ? file.vcsStatus : 'changed',
            contentHash: typeof file.contentHash === 'string' ? file.contentHash : null
          });
        }
      }
      return byPath;
    }
    // Legacy path-only baselines cannot detect further edits within the same path.
    if (Array.isArray(raw.paths)) {
      const byPath = new Map<string, BaselineFile>();
      for (const filePath of raw.paths) {
        if (typeof filePath === 'string') {
          byPath.set(filePath, { filePath, vcsStatus: 'changed', contentHash: null });
        }
      }
      return byPath;
    }
    return new Map();
  } catch {
    return new Map();
  }
}

function isRunAttributableChange({
  workingDirectory,
  entry,
  baseline
}: {
  workingDirectory: string;
  entry: ChangedFile;
  baseline: Map<string, BaselineFile>;
}): boolean {
  const base = baseline.get(entry.filePath);
  if (!base) return true;
  if (base.contentHash === null) return false;
  const currentHash = hashWorktreeFile({ workingDirectory, filePath: entry.filePath });
  return currentHash !== base.contentHash;
}

/** Keep only paths whose worktree state differs from the session baseline. */
export function filterRunAttributableChanges({
  workingDirectory,
  ticketId,
  files
}: {
  workingDirectory: string;
  ticketId: string;
  files: ChangedFile[];
}): ChangedFile[] {
  const baseline = readBaselineSnapshot({ workingDirectory, ticketId });
  return files.filter(entry => isRunAttributableChange({ workingDirectory, entry, baseline }));
}

/** Files whose worktree state changed since the session began. */
export function computeRunDelta({
  workingDirectory,
  ticketId
}: {
  workingDirectory: string;
  ticketId: string;
}): ChangedFile[] {
  return filterRunAttributableChanges({
    workingDirectory,
    ticketId,
    files: readChangedFiles(workingDirectory)
  });
}
