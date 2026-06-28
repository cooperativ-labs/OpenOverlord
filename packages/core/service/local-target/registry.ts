// Provider registry/resolver: maps a selected execution *target* to a capability
// *provider transport*. Callers select a target, never a transport — the
// resolver picks in-process / desktop-bridge / runner-queue from the target's
// type and reachability (R2). This keeps the same product code working whether
// the chosen target is co-located, across an IPC bridge, or a CLI-only VM on the
// far side of the runner queue.

import { fail } from './result.ts';
import type {
  CapabilityFailure,
  GenerateCommitMessageInput,
  LaunchAgentInput,
  ListBranchesInput,
  LocalTargetCapabilities,
  LocalTargetErrorCode,
  ObserveResourceInput,
  PrepareBranchInput,
  ReadCurrentDiffInput,
  ReadRepositoryTreeInput,
  RemoveWorktreeInput,
  TargetMetadata,
  WriteProjectMetadataInput
} from './types.ts';

/**
 * The minimal view of an execution target the resolver needs. Built from
 * `execution_targets` rows plus reachability joined from §5 observations; kept
 * structural so this module stays dependency-free.
 */
export interface ExecutionTargetRef {
  executionTargetId: string | null;
  /** `execution_targets.type`: 'local' | 'cloud_persistent' | 'cloud_sandbox' | 'ssh' | … */
  type: string;
  deviceLabel?: string | null;
  /** Whether the target is currently reachable (from heartbeat/observations). */
  reachable?: boolean;
}

/**
 * A factory inspects a target and returns a provider that can serve it, or
 * `null` to defer to the next factory. Registration order is priority order.
 */
export type LocalTargetProviderFactory = (
  target: ExecutionTargetRef
) => LocalTargetCapabilities | null;

export class LocalTargetProviderRegistry {
  readonly #factories: LocalTargetProviderFactory[] = [];

  /** Register a factory. Earlier registrations win. */
  register(factory: LocalTargetProviderFactory): this {
    this.#factories.push(factory);
    return this;
  }

  /** Resolve a provider for the target, or `null` when none can serve it. */
  resolve(target: ExecutionTargetRef): LocalTargetCapabilities | null {
    for (const factory of this.#factories) {
      const provider = factory(target);
      if (provider) return provider;
    }
    return null;
  }

  /**
   * Resolve a provider, falling back to an {@link UnavailableProvider} that
   * returns `LOCAL_TARGET_REQUIRED` from every capability. Callers then always
   * get a typed {@link CapabilityResult} and never have to null-check.
   */
  resolveOrUnavailable(target: ExecutionTargetRef): LocalTargetCapabilities {
    return (
      this.resolve(target) ??
      new UnavailableProvider(
        targetMetadata(target, 'fake'),
        'LOCAL_TARGET_REQUIRED',
        'No local execution target is available to serve this operation. Select a logged-in target with access to this checkout.'
      )
    );
  }
}

/** Derive {@link TargetMetadata} for a target ref under a given transport. */
export function targetMetadata(
  target: ExecutionTargetRef,
  transport: TargetMetadata['transport']
): TargetMetadata {
  return {
    executionTargetId: target.executionTargetId,
    deviceLabel: target.deviceLabel ?? null,
    transport
  };
}

/**
 * A provider whose every capability returns the same typed failure. Used when no
 * transport can serve a target (the generalized successor to the host-side
 * `LOCAL_FILESYSTEM_UNAVAILABLE` guard) and as a base for partial providers.
 */
export class UnavailableProvider implements LocalTargetCapabilities {
  constructor(
    readonly target: TargetMetadata,
    private readonly code: LocalTargetErrorCode,
    private readonly message: string
  ) {}

  // A CapabilityFailure is assignable to CapabilityResult<T> for any T (the
  // failure branch is generic-independent), so one helper serves every method.
  #fail(): Promise<CapabilityFailure> {
    return Promise.resolve(fail(this.target, this.code, this.message));
  }

  writeProjectMetadata(_input: WriteProjectMetadataInput) {
    return this.#fail();
  }
  observeResource(_input: ObserveResourceInput) {
    return this.#fail();
  }
  readRepositoryTree(_input: ReadRepositoryTreeInput) {
    return this.#fail();
  }
  listBranches(_input: ListBranchesInput) {
    return this.#fail();
  }
  prepareBranch(_input: PrepareBranchInput) {
    return this.#fail();
  }
  listWorktrees() {
    return this.#fail();
  }
  removeWorktree(_input: RemoveWorktreeInput) {
    return this.#fail();
  }
  purgeMergedWorktrees() {
    return this.#fail();
  }
  readCurrentDiff(_input: ReadCurrentDiffInput) {
    return this.#fail();
  }
  generateCommitMessageFromLocalDiff(_input: GenerateCommitMessageInput) {
    return this.#fail();
  }
  launchAgent(_input: LaunchAgentInput) {
    return this.#fail();
  }
  doctor() {
    return this.#fail();
  }
}
