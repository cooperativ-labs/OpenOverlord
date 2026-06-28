import path from 'node:path';

import type { LocalTargetBridgeCall } from '../../packages/core/service/local-target/desktop-bridge.ts';

export class PathAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathAllowlistError';
  }
}

const allowedRoots = new Set<string>();

/** Clears registered roots — test-only. */
export function resetAllowedPathsForTests(): void {
  allowedRoots.clear();
}

function normalizeAbsolutePath(value: string): string {
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new PathAllowlistError('An absolute path is required.');
  }
  return path.resolve(trimmed);
}

function isPathUnderRoot({ filePath, rootPath }: { filePath: string; rootPath: string }): boolean {
  return filePath === rootPath || filePath.startsWith(`${rootPath}${path.sep}`);
}

function registerRoot(rootPath: string): void {
  allowedRoots.add(normalizeAbsolutePath(rootPath));
}

function assertPathUnderSomeRoot(filePath: string, roots: string[]): string {
  const normalized = normalizeAbsolutePath(filePath);
  const searchRoots = [
    ...new Set([...roots.map(root => normalizeAbsolutePath(root)), ...allowedRoots])
  ];
  for (const root of searchRoots) {
    if (isPathUnderRoot({ filePath: normalized, rootPath: root })) {
      return normalized;
    }
  }
  throw new PathAllowlistError(`Path is outside linked checkout roots: ${filePath}`);
}

function collectCallPaths(call: LocalTargetBridgeCall): string[] {
  switch (call.capability) {
    case 'readRepositoryTree': {
      const paths = [call.input.repoPath];
      if (call.input.subPath?.trim()) {
        paths.push(path.join(call.input.repoPath, call.input.subPath));
      }
      return paths;
    }
    case 'listBranches':
      return [call.input.repoPath];
    case 'observeResource':
      return [call.input.path];
    case 'readCurrentDiff':
      return call.input.filePath?.trim() ? [call.input.filePath] : [];
    case 'listWorktrees':
      return [
        call.input.worktreeRoot,
        ...call.input.projects.map(project => project.primaryRepoPath)
      ];
    case 'deriveBranchStatus':
      return [call.input.repoPath];
    case 'performBranchAction':
      return [call.input.worktreePath, call.input.primaryRepoPath];
    case 'generateCommitMessageFromLocalDiff':
      return [call.input.worktreePath];
    case 'writeProjectMetadata':
      return [call.input.directoryPath];
    default:
      return [];
  }
}

function collectCallRoots(call: LocalTargetBridgeCall): string[] {
  switch (call.capability) {
    case 'readRepositoryTree':
    case 'listBranches':
    case 'deriveBranchStatus':
      return [call.input.repoPath];
    case 'observeResource':
      return [call.input.path];
    case 'listWorktrees':
      return [
        call.input.worktreeRoot,
        ...call.input.projects.map(project => project.primaryRepoPath)
      ];
    case 'performBranchAction':
      return [call.input.primaryRepoPath, call.input.worktreePath];
    case 'generateCommitMessageFromLocalDiff':
      return [call.input.worktreePath];
    case 'writeProjectMetadata':
      return [call.input.directoryPath];
    case 'readCurrentDiff':
      return call.input.filePath?.trim() ? [call.input.filePath] : [];
    default:
      return [];
  }
}

/**
 * Registers checkout roots from the call and rejects paths outside them.
 * Roots accumulate across the session so multiple linked repos can be used.
 */
export function validateLocalTargetCallPaths(call: LocalTargetBridgeCall): void {
  const roots = collectCallRoots(call).filter(root => root.trim().length > 0);
  const paths = collectCallPaths(call).filter(value => value.trim().length > 0);

  for (const root of roots) {
    registerRoot(root);
  }

  for (const filePath of paths) {
    assertPathUnderSomeRoot(filePath, roots);
  }
}
