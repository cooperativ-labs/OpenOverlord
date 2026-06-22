import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalTicketBranch,
  planTicketBranch,
  previewTicketBranch,
  slugifyBranchTitle
} from './index.ts';

const baseInput = {
  ticket: { title: 'Automate worktree branching', sequence: 16 },
  project: { slug: 'coo' },
  base: 'main',
  worktreeRoot: path.join('/tmp', 'ovld-worktrees')
};

test('renders canonical ticket branch and worktree path', () => {
  const decision = previewTicketBranch(baseInput);
  assert.equal(decision.action, 'create');
  assert.equal(decision.branch, 'overlord/automate-worktree-branching-16');
  assert.equal(
    decision.worktreePath,
    path.join('/tmp', 'ovld-worktrees', 'coo', 'overlord-automate-worktree-branching-16')
  );
});

test('slugifies unicode, punctuation, long and empty titles', () => {
  assert.equal(slugifyBranchTitle('Crème brûlée: ship it 🚀', 'ticket-9'), 'creme-brulee-ship-it');
  assert.equal(slugifyBranchTitle('!!!', 'ticket-9'), 'ticket-9');
  assert.equal(
    canonicalTicketBranch({
      title: 'This is a very long ticket title that should truncate at a useful boundary',
      sequence: 42
    }),
    'overlord/this-is-a-very-long-ticket-title-that-should-42'
  );
});

test('reuses recorded unmerged branch', () => {
  const decision = planTicketBranch({
    ...baseInput,
    recordedBranch: 'overlord/automate-worktree-branching-16',
    refs: {
      local: ['main', 'overlord/automate-worktree-branching-16'],
      remote: [],
      merged: []
    }
  });
  assert.equal(decision.action, 'reuse');
  assert.equal(decision.branch, 'overlord/automate-worktree-branching-16');
  assert.equal(decision.cycle, 1);
});

test('creates next numeric cycle when recorded branch is merged', () => {
  const decision = planTicketBranch({
    ...baseInput,
    recordedBranch: 'overlord/automate-worktree-branching-16',
    refs: {
      local: [
        'main',
        'overlord/automate-worktree-branching-16',
        'overlord/automate-worktree-branching-16-2'
      ],
      remote: ['origin/overlord/automate-worktree-branching-16-3'],
      merged: ['overlord/automate-worktree-branching-16'],
      checkedOut: ['overlord/automate-worktree-branching-16-4']
    }
  });
  assert.equal(decision.action, 'new_cycle');
  assert.equal(decision.branch, 'overlord/automate-worktree-branching-16-5');
  assert.equal(decision.cycle, 5);
});

test('overridden branch is reused when present and created when absent', () => {
  const reused = planTicketBranch({
    ...baseInput,
    recordedBranch: null,
    overrideBranch: 'feature/manual',
    refs: { local: ['feature/manual'], remote: [], merged: [] }
  });
  assert.equal(reused.action, 'reuse');

  const created = planTicketBranch({
    ...baseInput,
    recordedBranch: null,
    overrideBranch: 'feature/other',
    refs: { local: ['feature/manual'], remote: [], merged: [] }
  });
  assert.equal(created.action, 'create');
  assert.equal(created.branch, 'feature/other');
});
