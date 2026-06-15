import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAgentBinary } from '../src/agent-binaries.ts';

test('resolveAgentBinary maps built-in connector keys to native binaries', () => {
  assert.equal(resolveAgentBinary('claude'), 'claude');
  assert.equal(resolveAgentBinary('codex'), 'codex');
  assert.equal(resolveAgentBinary('cursor'), 'agent');
});

test('resolveAgentBinary falls back to the connector key for unknown agents', () => {
  assert.equal(resolveAgentBinary('custom-agent'), 'custom-agent');
});
