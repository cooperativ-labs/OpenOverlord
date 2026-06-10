import assert from 'node:assert/strict';
import test from 'node:test';

import { runOvld } from '../../../test/support/cli.ts';

test('ovld version prints the packaged CLI version', async () => {
  const result = await runOvld({ args: ['version'] });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^Overlord CLI \d+\.\d+\.\d+\n$/);
});

test('ovld help exits zero without requiring a database', async () => {
  const result = await runOvld({ args: ['help'] });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Overlord CLI/);
  assert.match(result.stdout, /ovld version/);
});

test('ovld rejects unknown commands with a non-zero exit', async () => {
  const result = await runOvld({ args: ['not-a-command'] });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Unknown command: not-a-command/);
});
