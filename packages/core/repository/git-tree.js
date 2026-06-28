import { execFileSync } from 'node:child_process';
import path from 'node:path';
export class RepositoryReadError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const DEFAULT_MAX_ENTRIES = 5_000;
function runGit(cwd, args) {
    try {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe']
        }).trim();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new RepositoryReadError('unreadable', message);
    }
}
function gitPath(cwd, args) {
    try {
        const value = runGit(cwd, args);
        return value.length > 0 ? value : null;
    }
    catch {
        return null;
    }
}
function addDirectoryAncestors(paths, filePath) {
    let parent = path.posix.dirname(filePath);
    while (parent !== '.' && parent !== '/') {
        paths.add(parent);
        parent = path.posix.dirname(parent);
    }
}
function toEntry(entryPath, type) {
    const parentPath = path.posix.dirname(entryPath);
    return {
        path: entryPath,
        name: path.posix.basename(entryPath),
        type,
        parentPath: parentPath === '.' ? null : parentPath,
        depth: entryPath.split('/').length - 1
    };
}
function compareEntries(a, b) {
    if (a.path === b.path)
        return 0;
    return a.path < b.path ? -1 : 1;
}
export function readRepositoryTree(rootPath, options = {}) {
    const resolvedRoot = path.resolve(rootPath);
    const gitRoot = gitPath(resolvedRoot, ['rev-parse', '--show-toplevel']);
    if (!gitRoot) {
        throw new RepositoryReadError('not_git_repository', `${resolvedRoot} is not inside a git repository.`);
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
    const directoryPaths = new Set();
    for (const filePath of filePaths)
        addDirectoryAncestors(directoryPaths, filePath);
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
//# sourceMappingURL=git-tree.js.map