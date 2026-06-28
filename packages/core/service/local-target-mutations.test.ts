import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildLocalTargetMutationMetadata,
  parseLocalTargetMutation
} from './local-target-mutations.ts';

describe('local-target-mutations', () => {
  it('round-trips mutation metadata', () => {
    const metadata = buildLocalTargetMutationMetadata({
      kind: 'branch_action',
      capability: 'performBranchAction',
      input: { action: 'integrate', branchName: 'feat-1' }
    });
    const parsed = parseLocalTargetMutation(metadata);
    assert.ok(parsed);
    assert.equal(parsed?.kind, 'branch_action');
    assert.equal(parsed?.capability, 'performBranchAction');
    assert.equal(parsed?.input.action, 'integrate');
  });

  it('returns null for unrelated metadata', () => {
    assert.equal(parseLocalTargetMutation('{}'), null);
    assert.equal(parseLocalTargetMutation({ other: true }), null);
  });
});
