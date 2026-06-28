import { InProcessProvider } from './local-target/in-process-provider.ts';
import { targetMetadata } from './local-target/registry.ts';
import type {
  LocalTargetCapabilities,
  PerformBranchActionInput,
  PurgeMergedWorktreesInput,
  RemoveWorktreeInput
} from './local-target/types.ts';
import type { CapabilityResult } from './local-target/types.ts';
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
    case 'performBranchAction':
      return provider.performBranchAction(mutation.input as unknown as PerformBranchActionInput);
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
