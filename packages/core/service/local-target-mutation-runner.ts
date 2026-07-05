import { InProcessProvider } from './local-target/in-process-provider.ts';
import { targetMetadata } from './local-target/registry.ts';
import type {
  LocalTargetCapabilities,
  PerformBranchActionInput,
  PurgeMergedWorktreesInput,
  RemoveWorktreeInput
} from './local-target/types.ts';
import type { CapabilityResult } from './local-target/types.ts';
import { worktreePathForBranch } from './local-target/worktree-git.ts';
import {
  type LocalTargetMutationPayload,
  parseLocalTargetMutation
} from './local-target-mutations.ts';

function inProcessProvider(): LocalTargetCapabilities {
  return new InProcessProvider(
    targetMetadata({ executionTargetId: 'runner', type: 'local', reachable: true }, 'in_process')
  );
}

export async function executeLocalTargetMutation({
  mutation
}: {
  mutation: LocalTargetMutationPayload;
}): Promise<CapabilityResult<unknown>> {
  const provider = inProcessProvider();

  switch (mutation.capability) {
    case 'performBranchAction': {
      // The control plane predicts `worktreePath` without filesystem access (it may
      // not be co-located with the checkout), so it always resolves to the canonical
      // worktree-mode path even for a branch-only mission checked out directly in the
      // primary repo. This runner *is* on the execution target with real git access,
      // so re-derive the actual checkout location the same way the desktop bridge does
      // for local execution, falling back to the queued path when the branch isn't
      // checked out anywhere yet.
      const input = mutation.input as unknown as PerformBranchActionInput;
      const resolvedWorktreePath =
        worktreePathForBranch(input.primaryRepoPath, input.branchName) ?? input.worktreePath;
      return provider.performBranchAction({ ...input, worktreePath: resolvedWorktreePath });
    }
    case 'removeWorktree':
      return provider.removeWorktree(mutation.input as unknown as RemoveWorktreeInput);
    case 'purgeMergedWorktrees':
      return provider.purgeMergedWorktrees(mutation.input as unknown as PurgeMergedWorktreesInput);
    default:
      return {
        ok: false,
        code: 'CAPABILITY_NOT_IMPLEMENTED',
        message: `Unsupported local-target mutation capability.`,
        target: targetMetadata(
          { executionTargetId: 'runner', type: 'local', reachable: true },
          'in_process'
        )
      };
  }
}

export function parseMutationFromMetadata(metadata: unknown): LocalTargetMutationPayload | null {
  if (!metadata || typeof metadata !== 'object') return null;
  return parseLocalTargetMutation(metadata as Record<string, unknown>);
}
