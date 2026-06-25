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
 * missions run against the same repo at once, a file another mission edits *after*
 * this session attached has no baseline entry, so the worktree delta alone would
 * wrongly attribute it here. To stay accurate the CLI also consumes a per-session
 * "touched files" log written by the agent's PostToolUse edit hook (the exact set
 * of files this agent edited). When that log exists, the run-attributable set is
 * the worktree delta INTERSECT the agent-edited paths — so files this agent never
 * touched are never reported, even if they are dirty for unrelated reasons.
 *
 * Finally, a repo may carry an optional `.overlordignore` file at its root listing
 * gitignore-style patterns (e.g. generated artifacts like `install-state.gz`). Any
 * run-attributable path matching those patterns is dropped before reporting, so
 * Overlord never records churn the user has explicitly opted out of tracking.
 *
 * VCS is read on the client only — we never send diffs or file contents, just
 * normalized paths and short status codes. Everything here is best-effort: outside
 * a git repository (or when git is unavailable) we infer nothing.
 */

export type ChangedFile = { filePath: string; vcsStatus: string };

export type RationaleNoteInput = {
  filePath: string;
  toolName?: string | null;
  intent?: string | null;
  transcriptContext?: string | null;
};

type RationaleNote = {
  filePath: string;
  toolName: string | null;
  intent: string | null;
  transcriptContext: string | null;
  contentHash: string | null;
  recordedAt: string;
};

export type DraftChangeRationale = {
  file_path: string;
  label: string;
  summary: string;
  why: string;
  impact: string;
};

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
 * Stable per-session key for the working dir + mission. MUST stay in sync with the
 * key the agents' PostToolUse edit hooks compute, so the touched-files log written
 * by the hook resolves to the same file the CLI reads at deliver. The hook mirror
 * is `sha256(abspath(cwd) + "\0" + MISSION_ID)`.
 */
function sessionKeyHash({
  workingDirectory,
  missionId
}: {
  workingDirectory: string;
  missionId: string;
}): string {
  return createHash('sha256')
    .update(`${path.resolve(workingDirectory)}\0${missionId}`)
    .digest('hex');
}

function baselineFilePath({
  workingDirectory,
  missionId
}: {
  workingDirectory: string;
  missionId: string;
}): string {
  return path.join(
    resolveGlobalDataDir(),
    'vcs-baselines',
    `${sessionKeyHash({ workingDirectory, missionId })}.json`
  );
}

function touchedFilesPath({
  workingDirectory,
  missionId
}: {
  workingDirectory: string;
  missionId: string;
}): string {
  return path.join(
    resolveGlobalDataDir(),
    'vcs-touched',
    `${sessionKeyHash({ workingDirectory, missionId })}.json`
  );
}

function rationaleNotesPath({
  workingDirectory,
  missionId
}: {
  workingDirectory: string;
  missionId: string;
}): string {
  return path.join(
    resolveGlobalDataDir(),
    'vcs-rationale-notes',
    `${sessionKeyHash({ workingDirectory, missionId })}.json`
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
  missionId
}: {
  workingDirectory: string;
  missionId: string;
}): void {
  try {
    const target = touchedFilesPath({ workingDirectory, missionId });
    if (existsSync(target)) rmSync(target);
  } catch {
    // Best-effort: a stale log at worst keeps prior edits in scope; the worktree
    // delta still gates what is reported.
  }
}

/** Clear any rationale-note log for this session. */
export function resetRationaleNotes({
  workingDirectory,
  missionId
}: {
  workingDirectory: string;
  missionId: string;
}): void {
  try {
    const target = rationaleNotesPath({ workingDirectory, missionId });
    if (existsSync(target)) rmSync(target);
  } catch {
    // Best-effort: stale notes only create reviewable drafts; they do not expand
    // changed-file attribution because the VCS delta still decides coverage.
  }
}

function truncateNoteText(value: string | null | undefined, max = 500): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}...` : trimmed;
}

function readRationaleNotes({
  workingDirectory,
  missionId
}: {
  workingDirectory: string;
  missionId: string;
}): RationaleNote[] {
  try {
    const target = rationaleNotesPath({ workingDirectory, missionId });
    if (!existsSync(target)) return [];
    const raw = JSON.parse(readFileSync(target, 'utf8')) as { notes?: unknown };
    if (!Array.isArray(raw.notes)) return [];
    return raw.notes.flatMap(note => {
      if (
        typeof note !== 'object' ||
        note === null ||
        typeof (note as RationaleNote).filePath !== 'string'
      ) {
        return [];
      }
      const candidate = note as Partial<RationaleNote> & { filePath: string };
      return [
        {
          filePath: normalizeAbsolute(candidate.filePath),
          toolName: truncateNoteText(candidate.toolName),
          intent: truncateNoteText(candidate.intent),
          transcriptContext: truncateNoteText(candidate.transcriptContext),
          contentHash:
            typeof candidate.contentHash === 'string' && candidate.contentHash.trim()
              ? candidate.contentHash
              : null,
          recordedAt:
            typeof candidate.recordedAt === 'string' && candidate.recordedAt.trim()
              ? candidate.recordedAt
              : new Date(0).toISOString()
        }
      ];
    });
  } catch {
    return [];
  }
}

/**
 * Record lightweight edit context that can later become draft change
 * rationales. Notes are local-only session state, stored next to touched-file
 * logs, and are keyed by the same working directory + mission hash.
 */
export function recordRationaleNotes({
  workingDirectory,
  missionId,
  notes
}: {
  workingDirectory: string;
  missionId: string;
  notes: RationaleNoteInput[];
}): void {
  try {
    const additions = notes
      .map(note => ({
        filePath: (note.filePath ?? '').trim(),
        toolName: truncateNoteText(note.toolName, 80),
        intent: truncateNoteText(note.intent),
        transcriptContext: truncateNoteText(note.transcriptContext)
      }))
      .filter(note => note.filePath)
      .map(note => {
        const absolute = normalizeAbsolute(path.resolve(workingDirectory, note.filePath));
        return {
          filePath: absolute,
          toolName: note.toolName,
          intent: note.intent,
          transcriptContext: note.transcriptContext,
          contentHash: hashWorktreeFile({
            workingDirectory,
            filePath: path.relative(workingDirectory, absolute)
          }),
          recordedAt: new Date().toISOString()
        };
      });
    if (additions.length === 0) return;

    const target = rationaleNotesPath({ workingDirectory, missionId });
    mkdirSync(path.dirname(target), { recursive: true });
    const prior = readRationaleNotes({ workingDirectory, missionId });
    const notesToKeep = [...prior, ...additions].slice(-200);
    writeFileSync(
      target,
      JSON.stringify({ updatedAt: new Date().toISOString(), notes: notesToKeep })
    );
  } catch {
    // Best-effort: deliver can still proceed with explicit rationales.
  }
}

/**
 * Append the files an agent just edited to this session's touched-files log. Used
 * by edit hooks (and tests); paths are stored absolute and slash-normalized.
 */
export function recordTouchedFiles({
  workingDirectory,
  missionId,
  files
}: {
  workingDirectory: string;
  missionId: string;
  files: string[];
}): void {
  try {
    const additions = files
      .map(filePath => (filePath ?? '').trim())
      .filter(Boolean)
      .map(filePath => normalizeAbsolute(path.resolve(workingDirectory, filePath)));
    if (additions.length === 0) return;
    const target = touchedFilesPath({ workingDirectory, missionId });
    mkdirSync(path.dirname(target), { recursive: true });
    const existing = readTouchedPaths({ workingDirectory, missionId }) ?? new Set<string>();
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
  missionId
}: {
  workingDirectory: string;
  missionId: string;
}): Set<string> | null {
  try {
    const target = touchedFilesPath({ workingDirectory, missionId });
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
  missionId,
  files
}: {
  workingDirectory: string;
  missionId: string;
  files: ChangedFile[];
}): void {
  try {
    const target = baselineFilePath({ workingDirectory, missionId });
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
  missionId
}: {
  workingDirectory: string;
  missionId: string;
}): Map<string, BaselineFile> {
  try {
    const target = baselineFilePath({ workingDirectory, missionId });
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

type IgnoreRule = {
  /** A `!`-prefixed pattern re-includes a path an earlier rule ignored. */
  negated: boolean;
  regex: RegExp;
};

/** Name of the per-repo ignore file, resolved at the git repo root. */
export const OVERLORD_IGNORE_FILENAME = '.overlordignore';

/** Translate one gitignore-style glob body into a regex fragment (no anchors). */
function ignoreGlobToRegExp(glob: string): string {
  let out = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? '';
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          // `**/` matches any number of leading path segments, including none.
          index += 1;
          out += '(.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

/** Compile a single `.overlordignore` line into a rule, or `null` to skip it. */
function compileIgnorePattern(rawPattern: string): IgnoreRule | null {
  let pattern = rawPattern;
  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  }
  // Allow escaping a literal leading '#' or '!' the same way gitignore does.
  if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
    pattern = pattern.slice(1);
  }
  let directoryOnly = false;
  if (pattern.endsWith('/')) {
    directoryOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (!pattern) return null;

  // A slash anywhere but a trailing one anchors the pattern to the repo root;
  // an unanchored pattern matches its basename at any depth.
  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  if (!pattern) return null;

  const prefix = anchored ? '^' : '(^|/)';
  const body = ignoreGlobToRegExp(pattern);
  // A directory pattern only matches files *under* it (changed paths are files);
  // a file pattern matches the path itself or, if it names a directory, its
  // contents.
  const suffix = directoryOnly ? '/.*$' : '(/.*)?$';
  try {
    return { negated, regex: new RegExp(`${prefix}${body}${suffix}`) };
  } catch {
    return null;
  }
}

/** Parse the repo's `.overlordignore` into ordered rules; `[]` when absent. */
function loadIgnoreRules(repoRoot: string): IgnoreRule[] {
  try {
    const target = path.join(repoRoot, OVERLORD_IGNORE_FILENAME);
    if (!existsSync(target)) return [];
    const rules: IgnoreRule[] = [];
    for (const rawLine of readFileSync(target, 'utf8').split('\n')) {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const rule = compileIgnorePattern(line);
      if (rule) rules.push(rule);
    }
    return rules;
  } catch {
    return [];
  }
}

/**
 * Whether a repo-root-relative path is ignored. Rules apply in order and the
 * last matching rule wins, so a later `!pattern` can re-include a path an earlier
 * pattern excluded (gitignore semantics).
 */
function isIgnoredPath(rules: IgnoreRule[], relativePath: string): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(relativePath)) ignored = !rule.negated;
  }
  return ignored;
}

/**
 * Keep only paths this run is responsible for.
 *
 * A path qualifies when its worktree state differs from the session baseline AND
 * — when the connector's edit hook recorded a touched-files log — this agent
 * actually edited it. The intersection is what makes attribution exact under
 * concurrency: a file dirtied by another mission *after* this session attached has
 * no baseline entry (so it passes the `!base` check) but is absent from the
 * touched-files log, so it is excluded here. Hookless connectors get `null` from
 * `readTouchedPaths` and fall back to the baseline-only behavior.
 *
 * `git status --porcelain` paths are repo-root-relative, so we resolve them
 * against the repo root before comparing with the absolute touched paths.
 *
 * Finally, any path matching the repo's optional `.overlordignore` is dropped,
 * letting users opt specific files (e.g. generated artifacts) out of tracking.
 */
export function filterRunAttributableChanges({
  workingDirectory,
  missionId,
  files
}: {
  workingDirectory: string;
  missionId: string;
  files: ChangedFile[];
}): ChangedFile[] {
  const baseline = readBaselineSnapshot({ workingDirectory, missionId });
  const touched = readTouchedPaths({ workingDirectory, missionId });
  const repoRoot = gitRepoRoot(workingDirectory) ?? workingDirectory;
  const ignoreRules = loadIgnoreRules(repoRoot);
  return files.filter(entry => {
    if (!isRunAttributableChange({ workingDirectory, entry, baseline })) return false;
    if (touched) {
      const absolute = normalizeAbsolute(path.resolve(repoRoot, entry.filePath));
      if (!touched.has(absolute)) return false;
    }
    if (ignoreRules.length > 0 && isIgnoredPath(ignoreRules, normalizePath(entry.filePath))) {
      return false;
    }
    return true;
  });
}

function titleFromPath(filePath: string): string {
  const base = path.basename(filePath).replace(/\.[^.]+$/, '');
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!words) return `Update ${filePath}`;
  return `Update ${words.replace(/\b\w/g, char => char.toUpperCase())}`;
}

function latestRelevantNote({
  notes,
  filePath,
  currentHash
}: {
  notes: RationaleNote[];
  filePath: string;
  currentHash: string | null;
}): RationaleNote | null {
  const candidates = notes
    .filter(note => note.filePath === filePath)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
  if (candidates.length === 0) return null;
  return (
    candidates.find(note => currentHash && note.contentHash && note.contentHash === currentHash) ??
    candidates[0] ??
    null
  );
}

/**
 * Build reviewable draft rationales for the current run-attributable files from
 * local edit notes. This preserves the server-side coverage contract: the caller
 * can merge drafts for files that do not already have explicit rationales.
 */
export function draftChangeRationalesFromNotes({
  workingDirectory,
  missionId,
  files
}: {
  workingDirectory: string;
  missionId: string;
  files: ChangedFile[];
}): DraftChangeRationale[] {
  const notes = readRationaleNotes({ workingDirectory, missionId });
  if (notes.length === 0 || files.length === 0) return [];
  const repoRoot = gitRepoRoot(workingDirectory) ?? workingDirectory;
  return files.flatMap(file => {
    const absolute = normalizeAbsolute(path.resolve(repoRoot, file.filePath));
    const currentHash = hashWorktreeFile({ workingDirectory, filePath: file.filePath });
    const note = latestRelevantNote({ notes, filePath: absolute, currentHash });
    if (!note) return [];

    const action = note.intent ?? `edited with ${note.toolName ?? 'a file-editing tool'}`;
    const context = note.transcriptContext ? ` Session context: ${note.transcriptContext}` : '';
    return [
      {
        file_path: normalizePath(file.filePath),
        label: titleFromPath(file.filePath),
        summary: `Draft from local edit notes: ${action}.${context}`.slice(0, 700),
        why: `This file was changed for the active objective; the draft was generated from the edit note captured when the change was made.`,
        impact: `Preserves review coverage for ${normalizePath(
          file.filePath
        )}; review the final diff before delivery if a more specific product impact is needed.`
      }
    ];
  });
}

/** Files whose worktree state changed since the session began. */
export function computeRunDelta({
  workingDirectory,
  missionId
}: {
  workingDirectory: string;
  missionId: string;
}): ChangedFile[] {
  return filterRunAttributableChanges({
    workingDirectory,
    missionId,
    files: readChangedFiles(workingDirectory)
  });
}
