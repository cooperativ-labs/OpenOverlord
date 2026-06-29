import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EligibleExecutionTargetDto } from '../../shared/contract.ts';

import { executionTargetAvailability } from './project-resources.ts';

function target(overrides: Partial<EligibleExecutionTargetDto> = {}): EligibleExecutionTargetDto {
  return {
    executionTargetId: 'et-1',
    type: 'local',
    label: 'Workstation',
    deviceLabel: 'Workstation',
    reachable: true,
    primaryResourceConnected: true,
    ...overrides
  };
}

test('stays quiet while the primary resource is not connected', () => {
  // The missing-resource warning takes precedence; we must not double-warn.
  const state = executionTargetAvailability({
    primaryConnected: false,
    eligibleTargets: []
  });
  assert.equal(state.available, true);
  assert.equal(state.message, null);
});

test('stays quiet until the eligible-target list has loaded', () => {
  const state = executionTargetAvailability({
    primaryConnected: true,
    eligibleTargets: undefined
  });
  assert.equal(state.available, true);
  assert.equal(state.message, null);
});

test('warns when a resource is linked but no execution target remains', () => {
  const state = executionTargetAvailability({
    primaryConnected: true,
    eligibleTargets: []
  });
  assert.equal(state.available, false);
  assert.match(state.message ?? '', /disconnecting and reconnecting/);
});

test('available when the linked resource still has a matching execution target', () => {
  const state = executionTargetAvailability({
    primaryConnected: true,
    eligibleTargets: [target()]
  });
  assert.equal(state.available, true);
  assert.equal(state.message, null);
});
