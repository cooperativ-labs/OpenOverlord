import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseTerminalProfileJson,
  serializeTerminalProfile
} from '../src/terminal-profile-types.ts';

test('parseTerminalProfileJson defaults missing fields', () => {
  assert.deepEqual(parseTerminalProfileJson('{}'), {
    launcher: null,
    placement: 'window',
    chord: null
  });
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
    chord: null
  });
});

test('terminal profile round-trips through JSON', () => {
  const profile = {
    launcher: 'Terminal',
    placement: 'chord' as const,
    chord: 'cmd+d'
  };
  assert.deepEqual(parseTerminalProfileJson(serializeTerminalProfile(profile)), profile);
});
