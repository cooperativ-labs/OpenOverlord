import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalTicketBranch,
  planTicketBranch,
  previewTicketBranch,
  slugifyBranchTitle
} from '../src/branch-planning.ts';

// The Runner Layer's branch-planning algorithm is duplicated in the service
// layer (webapp/server/branch-planning.ts). Both implementations are pinned to
// the shared conformance fixture so they can never drift apart — see CONTRACT.md
// "Shared Deterministic Algorithms".
const fixturePath = fileURLToPath(
  new URL('../../contract/branch-planning-vectors.json', import.meta.url)
);
const vectors = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  slugifyBranchTitle: { name: string; title: string; fallback: string; expected: string }[];
  canonicalTicketBranch: {
    name: string;
    ticket: { title: string; sequence: number };
    expected: string;
  }[];
  previewTicketBranch: { name: string; input: any; expected: any }[];
  planTicketBranch: { name: string; input: any; expected: any }[];
};

test('slugifyBranchTitle matches conformance vectors', () => {
  for (const v of vectors.slugifyBranchTitle) {
    assert.equal(slugifyBranchTitle(v.title, v.fallback), v.expected, v.name);
  }
});

test('canonicalTicketBranch matches conformance vectors', () => {
  for (const v of vectors.canonicalTicketBranch) {
    assert.equal(canonicalTicketBranch(v.ticket), v.expected, v.name);
  }
});

test('previewTicketBranch matches conformance vectors', () => {
  for (const v of vectors.previewTicketBranch) {
    assert.deepEqual(previewTicketBranch(v.input), v.expected, v.name);
  }
});

test('planTicketBranch matches conformance vectors', () => {
  for (const v of vectors.planTicketBranch) {
    assert.deepEqual(planTicketBranch(v.input), v.expected, v.name);
  }
});

// Sanity check that worktree paths are derived under the configured root.
test('worktree path nests under the worktree root and project slug', () => {
  const decision = previewTicketBranch({
    ticket: { title: 'Automate worktree branching', sequence: 16 },
    project: { slug: 'coo' },
    base: 'main',
    worktreeRoot: path.join('/tmp', 'ovld-worktrees')
  });
  assert.equal(
    decision.worktreePath,
    path.join('/tmp', 'ovld-worktrees', 'coo', 'automate-worktree-branching-16')
  );
});
