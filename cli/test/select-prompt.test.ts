import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseNumberedSelection,
  promptForProject,
  renderProjectSelection,
  type SelectableProject
} from '../src/select-prompt.ts';

const projects: SelectableProject[] = [
  { id: 'p1', name: 'Alpha', slug: 'alpha' },
  { id: 'p2', name: 'Beta', slug: 'beta' }
];

test('parseNumberedSelection returns a 0-based index for valid input', () => {
  assert.equal(parseNumberedSelection('1', 2), 0);
  assert.equal(parseNumberedSelection(' 2 ', 2), 1);
});

test('parseNumberedSelection rejects out-of-range, empty, and non-numeric input', () => {
  assert.equal(parseNumberedSelection('0', 2), null);
  assert.equal(parseNumberedSelection('3', 2), null);
  assert.equal(parseNumberedSelection('', 2), null);
  assert.equal(parseNumberedSelection('abc', 2), null);
  assert.equal(parseNumberedSelection('1.5', 2), null);
});

test('renderProjectSelection lists the directory and numbered projects', () => {
  const lines = renderProjectSelection(projects, '/tmp/repo');
  assert.deepEqual(lines, [
    'Current directory:',
    '  /tmp/repo',
    '',
    'Projects:',
    '  1. Alpha (alpha)',
    '  2. Beta (beta)'
  ]);
});

test('promptForProject rejects when there are no projects', async () => {
  await assert.rejects(
    () => promptForProject({ projects: [], directoryPath: '/tmp/repo' }),
    /No projects available/
  );
});
