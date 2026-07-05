import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { commandOnPath, runLocalTargetDoctorChecks } from './doctor-checks.ts';

describe('doctor-checks', () => {
  it('reports git and node as available in the test environment', () => {
    const checks = runLocalTargetDoctorChecks();
    assert.equal(checks.length, 2);

    const node = checks.find(c => c.name === 'node');
    const git = checks.find(c => c.name === 'git');
    assert.ok(node, 'node check should be present');
    assert.ok(git, 'git check should be present');

    // The suite runs under Node with git on PATH, so the happy path must be ok.
    assert.equal(node!.ok, true, 'node must resolve on PATH');
    assert.equal(git!.ok, true, 'git must resolve on PATH');
    assert.ok(node!.detail.length > 0);
  });

  it('reports ok === false when the binary is missing from PATH', () => {
    const check = commandOnPath('overlord-nonexistent-binary-xyz', ['--version']);
    assert.equal(check.ok, false);
    assert.match(check.detail, /not found on PATH/);
  });
});
