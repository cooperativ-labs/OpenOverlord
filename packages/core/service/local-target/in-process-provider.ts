// The in-process provider transport: capabilities served by direct calls on a
// machine co-located with the checkout — the Local SQLite backend, or the local
// runner acting on its own machine (design §4 "Transport & Providers").
//
// Capability bodies accrue here as WS-D migrates each caller off its ad-hoc
// `existsSync`/`git` call. Capabilities not yet routed return a typed
// CAPABILITY_NOT_IMPLEMENTED failure (never throw), so a partially-migrated
// provider is still safe to hand to any caller.

import { existsSync } from 'node:fs';

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
  WriteProjectMetadataInput
} from './types.ts';

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

  writeProjectMetadata(_input: WriteProjectMetadataInput) {
    return this.#notImplemented();
  }
  readRepositoryTree(_input: ReadRepositoryTreeInput) {
    return this.#notImplemented();
  }
  listBranches(_input: ListBranchesInput) {
    return this.#notImplemented();
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
