import { execFileSync } from 'node:child_process';
import path from 'node:path';

export type RepositoryTreeEntryType = 'file' | 'directory';

export interface RepositoryTreeEntry {
  path: string;
  name: string;
  type: RepositoryTreeEntryType;
  parentPath: string | null;
  depth: number;
}

export interface RepositoryTree {
  rootPath: string;
  gitRoot: string;
  branch: string | null;
  commit: string | null;
  entries: RepositoryTreeEntry[];
  truncated: boolean;
}

export interface ReadRepositoryTreeOptions {
  maxEntries?: number;
}

export class RepositoryReadError extends Error {
  code: 'not_git_repository' | 'unreadable';

  constructor(code: 'not_git_repository' | 'unreadable', message: string) {
    super(message);
    this.code = code;
  }
}

const DEFAULT_MAX_ENTRIES = 5_000;

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RepositoryReadError('unreadable', message);
  }
}

function gitPath(cwd: string, args: string[]): string | null {
  try {
    const value = runGit(cwd, args);
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function addDirectoryAncestors(paths: Set<string>, filePath: string): void {
  let parent = path.posix.dirname(filePath);
  while (parent !== '.' && parent !== '/') {
    paths.add(parent);
    parent = path.posix.dirname(parent);
  }
}

function toEntry(entryPath: string, type: RepositoryTreeEntryType): RepositoryTreeEntry {
  const parentPath = path.posix.dirname(entryPath);
  return {
    path: entryPath,
    name: path.posix.basename(entryPath),
    type,
    parentPath: parentPath === '.' ? null : parentPath,
    depth: entryPath.split('/').length - 1
  };
}

function compareEntries(a: RepositoryTreeEntry, b: RepositoryTreeEntry): number {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

export function readRepositoryTree(
  rootPath: string,
  options: ReadRepositoryTreeOptions = {}
): RepositoryTree {
  const resolvedRoot = path.resolve(rootPath);
  const gitRoot = gitPath(resolvedRoot, ['rev-parse', '--show-toplevel']);
  if (!gitRoot) {
    throw new RepositoryReadError(
      'not_git_repository',
      `${resolvedRoot} is not inside a git repository.`
    );
  }

  const trackedAndUntracked = runGit(gitRoot, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard'
  ]);
  const filePaths = trackedAndUntracked
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const directoryPaths = new Set<string>();
  for (const filePath of filePaths) addDirectoryAncestors(directoryPaths, filePath);

  const entries = [
    ...Array.from(directoryPaths, directoryPath => toEntry(directoryPath, 'directory')),
    ...filePaths.map(filePath => toEntry(filePath, 'file'))
  ].sort(compareEntries);

  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const truncated = entries.length > maxEntries;

  return {
    rootPath: resolvedRoot,
    gitRoot: path.resolve(gitRoot),
    branch: gitPath(gitRoot, ['branch', '--show-current']),
    commit: gitPath(gitRoot, ['rev-parse', '--short', 'HEAD']),
    entries: truncated ? entries.slice(0, maxEntries) : entries,
    truncated
  };
}
