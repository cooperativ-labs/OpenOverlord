// Typed call envelope for the desktop local-target IPC bridge (WS-F1 / R2).
// Shared by the Desktop Shell, web SPA transport helper, and optional dev REST
// proxy so every surface dispatches the same capability names and payloads.

import type { BranchObservationResult } from './branch-observe-git.ts';
import { observeMissionBranchGit } from './branch-observe-git.ts';
import { fail, ok } from './result.ts';
import type {
  CapabilityResult,
  GenerateCommitMessageInput,
  ListBranchesInput,
  ListWorktreesInput,
  LocalTargetCapabilities,
  ObserveResourceInput,
  PerformBranchActionInput,
  ReadCurrentDiffInput,
  ReadRepositoryTreeInput,
  WriteProjectMetadataInput
} from './types.ts';

export interface BranchStatusInput {
  repoPath: string;
  branchName: string;
  baseBranch: string | null;
  worktreePathHint?: string | null;
}

export type { BranchObservationResult };

export type LocalTargetBridgeCall =
  | { capability: 'readRepositoryTree'; input: ReadRepositoryTreeInput }
  | { capability: 'listBranches'; input: ListBranchesInput }
  | { capability: 'observeResource'; input: ObserveResourceInput }
  | { capability: 'readCurrentDiff'; input: ReadCurrentDiffInput }
  | { capability: 'listWorktrees'; input: ListWorktreesInput }
  | { capability: 'deriveBranchStatus'; input: BranchStatusInput }
  | { capability: 'performBranchAction'; input: PerformBranchActionInput }
  | { capability: 'generateCommitMessageFromLocalDiff'; input: GenerateCommitMessageInput }
  | { capability: 'writeProjectMetadata'; input: WriteProjectMetadataInput };

/** Capability names exposed on the unified desktop bridge. */
export type LocalTargetBridgeCapability = LocalTargetBridgeCall['capability'];

/**
 * Dispatch a bridge call through any {@link LocalTargetCapabilities} provider.
 * Desktop IPC and the optional loopback REST proxy both delegate here.
 */
export async function invokeLocalTargetCapability({
  provider,
  call
}: {
  provider: LocalTargetCapabilities;
  call: LocalTargetBridgeCall;
}): Promise<CapabilityResult<unknown>> {
  switch (call.capability) {
    case 'readRepositoryTree':
      return provider.readRepositoryTree(call.input);
    case 'listBranches':
      return provider.listBranches(call.input);
    case 'observeResource':
      return provider.observeResource(call.input);
    case 'readCurrentDiff':
      return provider.readCurrentDiff(call.input);
    case 'listWorktrees':
      return provider.listWorktrees(call.input);
    case 'deriveBranchStatus':
      return ok(provider.target, observeMissionBranchGit(call.input));
    case 'performBranchAction':
      return provider.performBranchAction(call.input);
    case 'generateCommitMessageFromLocalDiff':
      return provider.generateCommitMessageFromLocalDiff(call.input);
    case 'writeProjectMetadata':
      return provider.writeProjectMetadata(call.input);
    default:
      return fail(
        provider.target,
        'CAPABILITY_NOT_IMPLEMENTED',
        'Unknown local-target capability.'
      );
  }
}
