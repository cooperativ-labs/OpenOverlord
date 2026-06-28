// A configurable fake provider for tests. It lets the local-and-cloud test
// matrices (design doc §9) swap in a target that reports canned
// observations/results without touching a real filesystem or Git. Every
// capability has a sensible default success; tests override individual
// capabilities through `handlers` and assert against the recorded `calls`.

import { ok } from './result.ts';
import type {
  BranchListResult,
  CapabilityResult,
  CurrentDiffResult,
  DoctorResult,
  GenerateCommitMessageInput,
  GenerateCommitMessageResult,
  LaunchAgentInput,
  LaunchAgentResult,
  ListBranchesInput,
  ListWorktreesInput,
  LocalTargetCapabilities,
  ObserveResourceInput,
  PerformBranchActionInput,
  PrepareBranchInput,
  PrepareBranchResult,
  PurgeMergedWorktreesInput,
  PurgeWorktreesResult,
  ReadCurrentDiffInput,
  ReadRepositoryTreeInput,
  RemoveWorktreeInput,
  RepositoryTreeResult,
  ResourceObservation,
  TargetMetadata,
  WriteProjectMetadataInput,
  WriteProjectMetadataResult,
  ListWorktreesResult,
  PerformBranchActionResult
} from './types.ts';

/** Partial override map: any capability not provided uses the default. */
export type FakeHandlers = Partial<{
  [K in keyof Omit<LocalTargetCapabilities, 'target'>]: LocalTargetCapabilities[K];
}>;

export interface FakeProviderOptions {
  target?: Partial<TargetMetadata>;
  handlers?: FakeHandlers;
}

const DEFAULT_TARGET: TargetMetadata = {
  executionTargetId: 'fake-target',
  deviceLabel: 'Fake Target',
  transport: 'fake'
};

export class FakeLocalTargetProvider implements LocalTargetCapabilities {
  readonly target: TargetMetadata;
  readonly #handlers: FakeHandlers;
  /** Every capability call, in order, for assertions. */
  readonly calls: Array<{ capability: string; args: unknown[] }> = [];

  constructor(options: FakeProviderOptions = {}) {
    this.target = { ...DEFAULT_TARGET, ...options.target };
    this.#handlers = options.handlers ?? {};
  }

  #record(capability: string, args: unknown[]): void {
    this.calls.push({ capability, args });
  }

  async writeProjectMetadata(
    input: WriteProjectMetadataInput
  ): Promise<CapabilityResult<WriteProjectMetadataResult>> {
    this.#record('writeProjectMetadata', [input]);
    if (this.#handlers.writeProjectMetadata) return this.#handlers.writeProjectMetadata(input);
    return ok(this.target, { path: `${input.directoryPath}/.overlord/project.json`, written: true });
  }

  async observeResource(
    input: ObserveResourceInput
  ): Promise<CapabilityResult<ResourceObservation>> {
    this.#record('observeResource', [input]);
    if (this.#handlers.observeResource) return this.#handlers.observeResource(input);
    return ok(this.target, { state: 'available', observedAt: new Date(0).toISOString() });
  }

  async readRepositoryTree(
    input: ReadRepositoryTreeInput
  ): Promise<CapabilityResult<RepositoryTreeResult>> {
    this.#record('readRepositoryTree', [input]);
    if (this.#handlers.readRepositoryTree) return this.#handlers.readRepositoryTree(input);
    return ok(this.target, {
      rootPath: input.repoPath,
      gitRoot: input.repoPath,
      branch: 'main',
      commit: '0000000',
      entries: [],
      truncated: false
    });
  }

  async listBranches(input: ListBranchesInput): Promise<CapabilityResult<BranchListResult>> {
    this.#record('listBranches', [input]);
    if (this.#handlers.listBranches) return this.#handlers.listBranches(input);
    return ok(this.target, { local: ['main'], remote: [], current: 'main' });
  }

  async prepareBranch(input: PrepareBranchInput): Promise<CapabilityResult<PrepareBranchResult>> {
    this.#record('prepareBranch', [input]);
    if (this.#handlers.prepareBranch) return this.#handlers.prepareBranch(input);
    return ok(this.target, {
      branch: input.branch ?? 'fake-branch',
      baseBranch: 'main',
      worktreePath: input.useWorktree ? '/fake/worktrees/fake-branch' : null
    });
  }

  async listWorktrees(input: ListWorktreesInput): Promise<CapabilityResult<ListWorktreesResult>> {
    this.#record('listWorktrees', [input]);
    if (this.#handlers.listWorktrees) return this.#handlers.listWorktrees(input);
    return ok(this.target, { worktrees: [] });
  }

  async removeWorktree(
    input: RemoveWorktreeInput
  ): Promise<CapabilityResult<PurgeWorktreesResult>> {
    this.#record('removeWorktree', [input]);
    if (this.#handlers.removeWorktree) return this.#handlers.removeWorktree(input);
    return ok(this.target, { removed: [input.path], skipped: [] });
  }

  async purgeMergedWorktrees(
    input: PurgeMergedWorktreesInput
  ): Promise<CapabilityResult<PurgeWorktreesResult>> {
    this.#record('purgeMergedWorktrees', [input]);
    if (this.#handlers.purgeMergedWorktrees) return this.#handlers.purgeMergedWorktrees(input);
    return ok(this.target, { removed: [], skipped: [] });
  }

  async performBranchAction(
    input: PerformBranchActionInput
  ): Promise<CapabilityResult<PerformBranchActionResult>> {
    this.#record('performBranchAction', [input]);
    if (this.#handlers.performBranchAction) return this.#handlers.performBranchAction(input);
    return ok(this.target, { summary: `Performed ${input.action}` });
  }

  async readCurrentDiff(input: ReadCurrentDiffInput): Promise<CapabilityResult<CurrentDiffResult>> {
    this.#record('readCurrentDiff', [input]);
    if (this.#handlers.readCurrentDiff) return this.#handlers.readCurrentDiff(input);
    return ok(this.target, { workingDirectory: '/fake/repo', diff: '' });
  }

  async generateCommitMessageFromLocalDiff(
    input: GenerateCommitMessageInput
  ): Promise<CapabilityResult<GenerateCommitMessageResult>> {
    this.#record('generateCommitMessageFromLocalDiff', [input]);
    if (this.#handlers.generateCommitMessageFromLocalDiff)
      return this.#handlers.generateCommitMessageFromLocalDiff(input);
    return ok(this.target, { diff: 'fake diff' });
  }

  async launchAgent(input: LaunchAgentInput): Promise<CapabilityResult<LaunchAgentResult>> {
    this.#record('launchAgent', [input]);
    if (this.#handlers.launchAgent) return this.#handlers.launchAgent(input);
    return ok(this.target, { launched: true, sessionId: null });
  }

  async doctor(): Promise<CapabilityResult<DoctorResult>> {
    this.#record('doctor', []);
    if (this.#handlers.doctor) return this.#handlers.doctor();
    return ok(this.target, { checks: [] });
  }
}
