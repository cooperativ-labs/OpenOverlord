import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentLaunchFlagsToArgv,
  formatAgentLaunchFlagText,
  normalizeAgentLaunchFlags,
  parseAgentLaunchFlagText
} from '@overlord/contract';

test('parseAgentLaunchFlagText accepts boolean and positional flags', () => {
  assert.deepEqual(parseAgentLaunchFlagText('--verbose'), { name: '--verbose' });
  assert.deepEqual(parseAgentLaunchFlagText('--permission-mode auto'), {
    name: '--permission-mode',
    value: 'auto'
  });
  assert.deepEqual(parseAgentLaunchFlagText('--permission-mode=auto'), {
    name: '--permission-mode',
    value: 'auto'
  });
});

test('normalizeAgentLaunchFlags coerces legacy string arrays and structured objects', () => {
  assert.deepEqual(normalizeAgentLaunchFlags(['--verbose', '--permission-mode auto']), [
    { name: '--verbose' },
    { name: '--permission-mode', value: 'auto' }
  ]);
  assert.deepEqual(
    normalizeAgentLaunchFlags([{ name: '--permission-mode', value: 'auto' }, { name: '--verbose' }]),
    [
      { name: '--permission-mode', value: 'auto' },
      { name: '--verbose', value: null }
    ]
  );
});

test('agentLaunchFlagsToArgv emits separate argv tokens for positional values', () => {
  assert.deepEqual(
    agentLaunchFlagsToArgv([
      { name: '--permission-mode', value: 'auto' },
      { name: '--verbose' }
    ]),
    ['--permission-mode', 'auto', '--verbose']
  );
});

test('formatAgentLaunchFlagText renders boolean and positional flags', () => {
  assert.equal(formatAgentLaunchFlagText({ name: '--verbose' }), '--verbose');
  assert.equal(
    formatAgentLaunchFlagText({ name: '--permission-mode', value: 'auto' }),
    '--permission-mode auto'
  );
});
