import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
 * The worktree baseline cannot tell concurrent sessions apart: when several
 * tickets run against the same repo at once, a file another ticket edits *after*
 * this session attached has no baseline entry, so the worktree delta alone would
 * wrongly attribute it here. To stay accurate the CLI also consumes a per-session
 * "touched files" log written by the agent's PostToolUse edit hook (the exact set
 * of files this agent edited). When that log exists, the run-attributable set is
 * the worktree delta INTERSECT the agent-edited paths — so files this agent never
 * touched are never reported, even if they are dirty for unrelated reasons.
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

/**
 * Stable per-session key for the working dir + ticket. MUST stay in sync with the
 * key the agents' PostToolUse edit hooks compute, so the touched-files log written
 * by the hook resolves to the same file the CLI reads at deliver. The hook mirror
 * is `sha256(abspath(cwd) + "\0" + TICKET_ID)`.
 */
function sessionKeyHash({
  workingDirectory,
  ticketId
}: {
  workingDirectory: string;
  ticketId: string;
}): string {
  return createHash('sha256')
    .update(`${path.resolve(workingDirectory)}\0${ticketId}`)
    .digest('hex');
}

function baselineFilePath({
  workingDirectory,
  ticketId
}: {
  workingDirectory: string;
  ticketId: string;
}): string {
  return path.join(
    resolveGlobalDataDir(),
    'vcs-baselines',
    `${sessionKeyHash({ workingDirectory, ticketId })}.json`
  );
}

function touchedFilesPath({
  workingDirectory,
  ticketId
}: {
  workingDirectory: string;
  ticketId: string;
}): string {
  return path.join(
    resolveGlobalDataDir(),
    'vcs-touched',
    `${sessionKeyHash({ workingDirectory, ticketId })}.json`
  );
}

/**
 * Absolute, symlink-resolved, slash-normalized path for cross-checking VCS and
 * touched entries. Resolving symlinks is what keeps both sides comparable: the
 * touched log records paths against the agent's working directory, while the
 * deliver-time intersection resolves them against `git rev-parse --show-toplevel`,
 * which git already canonicalizes (e.g. macOS `/var` → `/private/var`). Without
 * realpath here the two forms never match and every touched file is dropped.
 *
 * `realpathSync` needs the path to exist; for deleted files we resolve the
 * nearest existing ancestor and re-append the basename, falling back to a plain
 * resolve when even that is unavailable.
 */
function normalizeAbsolute(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return realpathSync(resolved).replace(/\\/g, '/');
  } catch {
    try {
      return path
        .join(realpathSync(path.dirname(resolved)), path.basename(resolved))
        .replace(/\\/g, '/');
    } catch {
      return resolved.replace(/\\/g, '/');
    }
  }
}

/** Repo root for the working dir, or `null` outside a git repo. */
function gitRepoRoot(workingDirectory: string): string | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workingDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Clear any touched-files log for this session so a freshly (re)started session
 * starts from an empty edit set. Called alongside `writeBaseline`.
 */
export function resetTouchedFiles({
  workingDirectory,
  ticketId
}: {
  workingDirectory: string;
  ticketId: string;
}): void {
  try {
    const target = touchedFilesPath({ workingDirectory, ticketId });
    if (existsSync(target)) rmSync(target);
  } catch {
    // Best-effort: a stale log at worst keeps prior edits in scope; the worktree
    // delta still gates what is reported.
  }
}

/**
 * Append the files an agent just edited to this session's touched-files log. Used
 * by edit hooks (and tests); paths are stored absolute and slash-normalized.
 */
export function recordTouchedFiles({
  workingDirectory,
  ticketId,
  files
}: {
  workingDirectory: string;
  ticketId: string;
  files: string[];
}): void {
  try {
    const additions = files
      .map(filePath => (filePath ?? '').trim())
      .filter(Boolean)
      .map(filePath => normalizeAbsolute(path.resolve(workingDirectory, filePath)));
    if (additions.length === 0) return;
    const target = touchedFilesPath({ workingDirectory, ticketId });
    mkdirSync(path.dirname(target), { recursive: true });
    const existing = readTouchedPaths({ workingDirectory, ticketId }) ?? new Set<string>();
    for (const filePath of additions) existing.add(filePath);
    writeFileSync(
      target,
      JSON.stringify({ updatedAt: new Date().toISOString(), paths: Array.from(existing) })
    );
  } catch {
    // Best-effort: a failed write just means deliver falls back to the worktree
    // baseline for this session.
  }
}

/**
 * Absolute paths this agent edited this session, or `null` when no log exists
 * (i.e. the connector has no edit hook). `null` disables the intersection so
 * hookless agents keep the legacy worktree-baseline behavior.
 */
function readTouchedPaths({
  workingDirectory,
  ticketId
}: {
  workingDirectory: string;
  ticketId: string;
}): Set<string> | null {
  try {
    const target = touchedFilesPath({ workingDirectory, ticketId });
    if (!existsSync(target)) return null;
    const raw = JSON.parse(readFileSync(target, 'utf8')) as { paths?: unknown };
    const result = new Set<string>();
    if (Array.isArray(raw.paths)) {
      for (const entry of raw.paths) {
        if (typeof entry === 'string' && entry.trim()) result.add(normalizeAbsolute(entry));
      }
    }
    return result;
  } catch {
    return null;
  }
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

/**
 * Keep only paths this run is responsible for.
 *
 * A path qualifies when its worktree state differs from the session baseline AND
 * — when the connector's edit hook recorded a touched-files log — this agent
 * actually edited it. The intersection is what makes attribution exact under
 * concurrency: a file dirtied by another ticket *after* this session attached has
 * no baseline entry (so it passes the `!base` check) but is absent from the
 * touched-files log, so it is excluded here. Hookless connectors get `null` from
 * `readTouchedPaths` and fall back to the baseline-only behavior.
 *
 * `git status --porcelain` paths are repo-root-relative, so we resolve them
 * against the repo root before comparing with the absolute touched paths.
 */
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
  const touched = readTouchedPaths({ workingDirectory, ticketId });
  const repoRoot = gitRepoRoot(workingDirectory) ?? workingDirectory;
  return files.filter(entry => {
    if (!isRunAttributableChange({ workingDirectory, entry, baseline })) return false;
    if (touched) {
      const absolute = normalizeAbsolute(path.resolve(repoRoot, entry.filePath));
      if (!touched.has(absolute)) return false;
    }
    return true;
  });
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
