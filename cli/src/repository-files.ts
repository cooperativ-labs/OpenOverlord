import { readRepositoryTree, RepositoryReadError } from '../../src/repository/git-tree.js';

/**
 * Tracked + untracked files under `rootPath`'s git repository, used as the
 * `@`-mention candidate list. Returns `[]` when the directory is missing or not
 * a git repository so the picker degrades to a plain prompt.
 */
export function listMentionableFiles(rootPath: string | null | undefined): string[] {
  if (!rootPath) return [];
  try {
    return readRepositoryTree(rootPath).entries
      .filter(entry => entry.type === 'file')
      .map(entry => entry.path);
  } catch (error) {
    if (error instanceof RepositoryReadError) return [];
    throw error;
  }
}
