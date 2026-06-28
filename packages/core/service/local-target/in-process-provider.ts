// The in-process provider transport: capabilities served by direct calls on a
// machine co-located with the checkout — the Local SQLite backend, or the local
// runner acting on its own machine (design §4 "Transport & Providers").
//
// Capability bodies accrue here as WS-D migrates each caller off its ad-hoc
// `existsSync`/`git` call. Capabilities not yet routed return a typed
// CAPABILITY_NOT_IMPLEMENTED failure (never throw), so a partially-migrated
// provider is still safe to hand to any caller.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import {
  readRepositoryTree as readGitRepositoryTree,
  RepositoryReadError
} from '../../repository/git-tree.ts';
import { writeProjectJson } from './project-metadata.ts';
import { fail, ok } from './result.ts';
import type {
  CapabilityFailure,
  CapabilityResult,
  GenerateCommitMessageInput,
  LaunchAgentInput,
  ListBranchesInput,
  LocalTargetCapabilities,
  ObserveResourceInput,
  PrepareBranchInput,
  ReadCurrentDiffInput,
  ReadRepositoryTreeInput,
  RemoveWorktreeInput,
  ResourceObservation,
  TargetMetadata,
  WriteProjectMetadataInput,
  WriteProjectMetadataResult
} from './types.ts';

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function normalizeBranchRef(ref: string): string {
  return ref
    .replace(/^origin\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
    .trim();
}

export class InProcessProvider implements LocalTargetCapabilities {
  constructor(readonly target: TargetMetadata) {}

  // ---- routed (WS-D 1) -------------------------------------------------

  /**
   * Observe whether the linked checkout exists on this machine. Byte-identical
   * to the prior host-side `existsSync(path)` check the resource-status
   * derivation used (available/missing); richer git-root/branch/commit
   * enrichment is an additive follow-up.
   */
  async observeResource(
    input: ObserveResourceInput
  ): Promise<CapabilityResult<ResourceObservation>> {
    const observedAt = new Date().toISOString();
    const state = existsSync(input.path) ? 'available' : 'missing';
    return ok(this.target, { state, observedAt });
  }

  /**
   * Write the linked checkout's `.overlord/project.json` on this machine (WS-D 2).
   * Only reachable when this provider was resolved (co-located backend / local
   * runner); a hosted backend resolves an unavailable provider instead and never
   * writes to its own filesystem.
   */
  async writeProjectMetadata(
    input: WriteProjectMetadataInput
  ): Promise<CapabilityResult<WriteProjectMetadataResult>> {
    try {
      const metadataPath = writeProjectJson(input);
      return ok(this.target, { path: metadataPath, written: true });
    } catch (error) {
      return fail(
        this.target,
        'TARGET_OPERATION_FAILED',
        `Failed to write project metadata: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ---- routed (WS-D 3) -------------------------------------------------

  async readRepositoryTree(input: ReadRepositoryTreeInput) {
    try {
      const tree = readGitRepositoryTree(input.repoPath);
      return ok(this.target, {
        rootPath: tree.rootPath,
        gitRoot: tree.gitRoot,
        branch: tree.branch,
        commit: tree.commit,
        entries: tree.entries,
        truncated: tree.truncated
      });
    } catch (error) {
      if (error instanceof RepositoryReadError && error.code === 'not_git_repository') {
        return fail(
          this.target,
          'NOT_GIT_REPOSITORY',
          error.message,
          { resourceId: input.resourceId }
        );
      }
      return fail(
        this.target,
        'TARGET_OPERATION_FAILED',
        error instanceof Error ? error.message : 'Could not read repository.',
        { resourceId: input.resourceId }
      );
    }
  }

  async listBranches(input: ListBranchesInput) {
    try {
      const local = runGit(input.repoPath, ['branch', '--format=%(refname:short)']);
      const remote = runGit(input.repoPath, ['branch', '-r', '--format=%(refname:short)']);
      const current = runGit(input.repoPath, ['branch', '--show-current']) || null;
      return ok(this.target, {
        local: local
          .split('\n')
          .map(normalizeBranchRef)
          .filter(name => name && !name.includes('->') && name !== 'HEAD'),
        remote: remote
          .split('\n')
          .map(normalizeBranchRef)
          .filter(name => name && !name.includes('->') && name !== 'HEAD'),
        current
      });
    } catch (error) {
      return fail(
        this.target,
        'GIT_COMMAND_FAILED',
        error instanceof Error ? error.message : 'Could not list repository branches.',
        { resourceId: input.resourceId }
      );
    }
  }

  // ---- not yet routed (filled in by later WS-D steps) ------------------

  #notImplemented(): Promise<CapabilityFailure> {
    return Promise.resolve(
      fail(
        this.target,
        'CAPABILITY_NOT_IMPLEMENTED',
        'This capability is not yet routed through the in-process provider.'
      )
    );
  }

  prepareBranch(_input: PrepareBranchInput) {
    return this.#notImplemented();
  }
  listWorktrees() {
    return this.#notImplemented();
  }
  removeWorktree(_input: RemoveWorktreeInput) {
    return this.#notImplemented();
  }
  purgeMergedWorktrees() {
    return this.#notImplemented();
  }
  readCurrentDiff(_input: ReadCurrentDiffInput) {
    return this.#notImplemented();
  }
  generateCommitMessageFromLocalDiff(_input: GenerateCommitMessageInput) {
    return this.#notImplemented();
  }
  launchAgent(_input: LaunchAgentInput) {
    return this.#notImplemented();
  }
  doctor() {
    return this.#notImplemented();
  }
}
