import assert from 'node:assert/strict';
import test from 'node:test';

import type { EligibleExecutionTargetDto } from '../../shared/contract.ts';

import {
  ANY_ELIGIBLE_EXECUTION_TARGET_VALUE,
  executionTargetOptionLabel,
  executionTargetOptionStatusSuffix,
  executionTargetSelectorDisplayLabel,
  parseExecutionTargetSelectorValue,
  resolveExecutionTargetSelectorValue
} from './execution-target-selection.ts';

function target(partial: Partial<EligibleExecutionTargetDto> = {}): EligibleExecutionTargetDto {
  return {
    executionTargetId: 'et-1',
    type: 'local',
    label: 'JCL-MBP.local',
    deviceLabel: 'JCL-MBP.local',
    reachable: true,
    primaryResourceConnected: true,
    ...partial
  };
}

test('executionTargetOptionLabel prefers label with device in parentheses', () => {
  assert.equal(executionTargetOptionLabel(target()), 'JCL-MBP.local');
  assert.equal(
    executionTargetOptionLabel(target({ label: 'MacBook', deviceLabel: 'JCL-MBP.local' })),
    'MacBook (JCL-MBP.local)'
  );
});

test('executionTargetOptionStatusSuffix reflects reachability and primary resource', () => {
  assert.equal(executionTargetOptionStatusSuffix(target()), '');
  assert.equal(executionTargetOptionStatusSuffix(target({ reachable: false })), ' (offline)');
  assert.equal(
    executionTargetOptionStatusSuffix(target({ primaryResourceConnected: false })),
    ' (no primary)'
  );
});

test('resolveExecutionTargetSelectorValue handles unset and single-target cases', () => {
  assert.equal(
    resolveExecutionTargetSelectorValue({
      selectedExecutionTargetId: 'et-2',
      eligibleTargets: [target(), target({ executionTargetId: 'et-2' })]
    }),
    'et-2'
  );
  assert.equal(
    resolveExecutionTargetSelectorValue({
      selectedExecutionTargetId: null,
      eligibleTargets: [target(), target({ executionTargetId: 'et-2' })]
    }),
    ANY_ELIGIBLE_EXECUTION_TARGET_VALUE
  );
  assert.equal(
    resolveExecutionTargetSelectorValue({
      selectedExecutionTargetId: null,
      eligibleTargets: [target()]
    }),
    'et-1'
  );
});

test('parseExecutionTargetSelectorValue maps any-target sentinel to null', () => {
  assert.equal(parseExecutionTargetSelectorValue(ANY_ELIGIBLE_EXECUTION_TARGET_VALUE), null);
  assert.equal(parseExecutionTargetSelectorValue('et-1'), 'et-1');
});

test('executionTargetSelectorDisplayLabel resolves selector values to human labels', () => {
  assert.equal(
    executionTargetSelectorDisplayLabel({
      selectorValue: ANY_ELIGIBLE_EXECUTION_TARGET_VALUE,
      eligibleTargets: [target()]
    }),
    'Any eligible target'
  );
  assert.equal(
    executionTargetSelectorDisplayLabel({
      selectorValue: ANY_ELIGIBLE_EXECUTION_TARGET_VALUE,
      eligibleTargets: [target()],
      anyLabel: 'Any target'
    }),
    'Any target'
  );
  assert.equal(
    executionTargetSelectorDisplayLabel({
      selectorValue: 'et-1',
      eligibleTargets: [target()]
    }),
    'JCL-MBP.local'
  );
  assert.equal(
    executionTargetSelectorDisplayLabel({
      selectorValue: 'et-1',
      eligibleTargets: [target({ reachable: false })]
    }),
    'JCL-MBP.local (offline)'
  );
  assert.equal(
    executionTargetSelectorDisplayLabel({
      selectorValue: 'missing',
      eligibleTargets: [target()]
    }),
    'Execution target'
  );
});
