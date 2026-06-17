import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveGlobalDataDir } from './config.js';

/**
 * Client-side VCS change capture.
 *
 * Changed-file reporting must not depend on the agent remembering to enumerate
 * what it changed. Instead the CLI records a baseline of already-dirty paths when
 * a work session begins (`attach` / `resume-follow-up`) and, at `deliver`,
 * computes the run-attributable delta (current changed paths minus baseline).
 *
 * VCS is read on the client only — we never send diffs or file contents, just
 * normalized paths and short status codes. Everything here is best-effort: outside
 * a git repository (or when git is unavailable) we infer nothing.
 */

export type ChangedFile = { filePath: string; vcsStatus: string };

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

/** Record the baseline set of already-dirty paths for a session's working dir. */
export function writeBaseline({
  workingDirectory,
  ticketId,
  paths
}: {
  workingDirectory: string;
  ticketId: string;
  paths: string[];
}): void {
  try {
    const target = baselineFilePath({ workingDirectory, ticketId });
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ capturedAt: new Date().toISOString(), paths }));
  } catch {
    // Best-effort: a missing baseline just means deliver treats every dirty path
    // as run-attributable, which is safe (errs toward completeness).
  }
}

/** Read a previously recorded baseline; `[]` when none exists. */
export function readBaseline({
  workingDirectory,
  ticketId
}: {
  workingDirectory: string;
  ticketId: string;
}): string[] {
  try {
    const target = baselineFilePath({ workingDirectory, ticketId });
    if (!existsSync(target)) return [];
    const raw = JSON.parse(readFileSync(target, 'utf8')) as { paths?: unknown };
    return Array.isArray(raw.paths)
      ? raw.paths.filter((p): p is string => typeof p === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Files changed now that were not already dirty when the session began. */
export function computeRunDelta({
  workingDirectory,
  ticketId
}: {
  workingDirectory: string;
  ticketId: string;
}): ChangedFile[] {
  const current = readChangedFiles(workingDirectory);
  const baseline = new Set(readBaseline({ workingDirectory, ticketId }));
  return current.filter(entry => !baseline.has(entry.filePath));
}
