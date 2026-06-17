import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appleScriptKeystrokeClause,
  formatTerminalLaunchChord,
  normalizeTerminalLaunchPlacement,
  parseTerminalLaunchChord
} from '../src/terminal-launch-chord.ts';

test('parseTerminalLaunchChord accepts common modifier aliases', () => {
  const parsed = parseTerminalLaunchChord('cmd+shift+d');
  assert.ok(parsed);
  assert.deepEqual(parsed.modifiers, ['command', 'shift']);
  assert.equal(parsed.key, 'd');
  assert.equal(formatTerminalLaunchChord(parsed), 'cmd+shift+d');
});

test('parseTerminalLaunchChord rejects empty and malformed input', () => {
  assert.equal(parseTerminalLaunchChord(''), null);
  assert.equal(parseTerminalLaunchChord('cmd+shift'), null);
  assert.equal(parseTerminalLaunchChord('++d'), null);
});

test('appleScriptKeystrokeClause renders System Events syntax', () => {
  const parsed = parseTerminalLaunchChord('cmd+d');
  assert.ok(parsed);
  assert.equal(appleScriptKeystrokeClause(parsed), 'keystroke "d" using {command down}');
});

test('normalizeTerminalLaunchPlacement accepts aliases', () => {
  assert.equal(normalizeTerminalLaunchPlacement('tab'), 'tab');
  assert.equal(normalizeTerminalLaunchPlacement('split'), 'chord');
  assert.equal(normalizeTerminalLaunchPlacement(undefined), 'window');
});
