import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runLocalTargetDoctorChecks } from './doctor-checks.ts';

describe('doctor-checks', () => {
  it('reports git and node availability', () => {
    const checks = runLocalTargetDoctorChecks();
    assert.equal(checks.length, 2);
    assert.ok(checks.some(c => c.name === 'git'));
    assert.ok(checks.some(c => c.name === 'node'));
    assert.ok(checks.every(c => typeof c.ok === 'boolean'));
  });
});
