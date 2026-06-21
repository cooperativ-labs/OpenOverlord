import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_UPDATE_INSTALL_ARGS } from '../src/update.ts';

test('default update install args suppress npm fund notices', () => {
  assert.deepEqual(DEFAULT_UPDATE_INSTALL_ARGS, [
    'install',
    '-g',
    '--no-fund',
    'open-overlord@latest'
  ]);
});
