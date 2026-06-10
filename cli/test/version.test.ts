import assert from 'node:assert/strict';
import test from 'node:test';

import { getCliVersion } from '../src/version.ts';

test('getCliVersion reads the cli package version', () => {
  assert.match(getCliVersion(), /^\d+\.\d+\.\d+$/);
});
