import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalMissionBranch,
  planMissionBranch,
  previewMissionBranch,
  slugifyBranchTitle
} from './branch-planning.ts';

// The service layer's branch-planning algorithm is duplicated in the Runner
// Layer (cli/src/branch-planning.ts). Both implementations are pinned to the
// shared conformance fixture so they can never drift apart — see CONTRACT.md
// "Shared Deterministic Algorithms".
const fixturePath = fileURLToPath(
  new URL('../contract/branch-planning-vectors.json', import.meta.url)
);
const vectors = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  slugifyBranchTitle: { name: string; title: string; fallback: string; expected: string }[];
  canonicalMissionBranch: {
    name: string;
    mission: { title: string; sequence: number };
    expected: string;
  }[];
  previewMissionBranch: { name: string; input: any; expected: any }[];
  planMissionBranch: { name: string; input: any; expected: any }[];
};

test('slugifyBranchTitle matches conformance vectors', () => {
  for (const v of vectors.slugifyBranchTitle) {
    assert.equal(slugifyBranchTitle(v.title, v.fallback), v.expected, v.name);
  }
});

test('canonicalMissionBranch matches conformance vectors', () => {
  for (const v of vectors.canonicalMissionBranch) {
    assert.equal(canonicalMissionBranch(v.mission), v.expected, v.name);
  }
});

test('previewMissionBranch matches conformance vectors', () => {
  for (const v of vectors.previewMissionBranch) {
    assert.deepEqual(previewMissionBranch(v.input), v.expected, v.name);
  }
});

test('planMissionBranch matches conformance vectors', () => {
  for (const v of vectors.planMissionBranch) {
    assert.deepEqual(planMissionBranch(v.input), v.expected, v.name);
  }
});

test('worktree path nests under the worktree root, project slug, and resource key', () => {
  const decision = previewMissionBranch({
    mission: { title: 'Automate worktree branching', sequence: 16 },
    project: { slug: 'coo' },
    resourceKey: 'overlord',
    base: 'main',
    worktreeRoot: path.join('/tmp', 'ovld-worktrees')
  });
  assert.equal(
    decision.worktreePath,
    path.join('/tmp', 'ovld-worktrees', 'coo', 'overlord', 'automate-worktree-branching-16')
  );
});
