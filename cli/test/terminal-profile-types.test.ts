import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseTerminalProfileJson,
  serializeTerminalProfile
} from '../src/terminal-profile-types.ts';

test('parseTerminalProfileJson defaults missing fields', () => {
  assert.deepEqual(parseTerminalProfileJson('{}'), {
    launcher: 'Terminal',
    placement: 'window',
    chord: null,
    background: false
  });
});

test('parseTerminalProfileJson preserves explicit inline launcher', () => {
  assert.deepEqual(parseTerminalProfileJson('{"launcher":null}'), {
    launcher: null,
    placement: 'window',
    chord: null,
    background: false
  });
});

test('parseTerminalProfileJson reads background flag', () => {
  assert.equal(parseTerminalProfileJson('{"background":true}').background, true);
  assert.equal(parseTerminalProfileJson('{"background":false}').background, false);
});

test('serializeTerminalProfile omits chord unless placement is chord', () => {
  const serialized = serializeTerminalProfile({
    launcher: 'iTerm2',
    placement: 'tab',
    chord: 'cmd+d'
  });
  assert.deepEqual(JSON.parse(serialized), {
    launcher: 'iTerm2',
    placement: 'tab',
    chord: null,
    background: false
  });
});

test('serializeTerminalProfile preserves background flag', () => {
  const serialized = serializeTerminalProfile({
    launcher: 'Terminal',
    placement: 'window',
    chord: null,
    background: true
  });
  assert.equal(JSON.parse(serialized).background, true);
});

test('terminal profile round-trips through JSON', () => {
  const profile = {
    launcher: 'Terminal',
    placement: 'chord' as const,
    chord: 'cmd+d',
    background: false
  };
  assert.deepEqual(parseTerminalProfileJson(serializeTerminalProfile(profile)), profile);
});
