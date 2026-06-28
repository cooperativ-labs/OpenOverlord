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
export declare class RepositoryReadError extends Error {
    code: 'not_git_repository' | 'unreadable';
    constructor(code: 'not_git_repository' | 'unreadable', message: string);
}
export declare function readRepositoryTree(rootPath: string, options?: ReadRepositoryTreeOptions): RepositoryTree;
//# sourceMappingURL=git-tree.d.ts.map