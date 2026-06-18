import assert from 'node:assert/strict';
import test from 'node:test';

import { isBackendReachabilityError, probeBackendReachability } from '../src/auth-login.ts';
import { CliError } from '../src/errors.ts';
import { printStepTitle } from '../src/output.ts';

test('printStepTitle uses blue ANSI styling on a TTY', () => {
  const originalIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

  try {
    let written = '';
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written += String(chunk);
      return true;
    }) as typeof process.stdout.write;

    printStepTitle('Step 2: Authenticate with the backend.');

    process.stdout.write = originalWrite;
    assert.equal(written, `\x1b[34mStep 2: Authenticate with the backend.\x1b[0m\n`);
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  }
});

test('isBackendReachabilityError detects backend connection failures', () => {
  assert.equal(
    isBackendReachabilityError(
      new CliError({
        message: 'Could not reach Overlord backend at http://127.0.0.1:4310.\nECONNREFUSED'
      })
    ),
    true
  );
  assert.equal(
    isBackendReachabilityError(new CliError({ message: 'Authentication failed (401).' })),
    false
  );
});

test('probeBackendReachability reports unreachable backends', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;

  try {
    const result = await probeBackendReachability({ backendUrl: 'http://127.0.0.1:59999' });
    assert.equal(result.reachable, false);
    assert.match(result.error ?? '', /ECONNREFUSED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('probeBackendReachability reports healthy backends', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

  try {
    const result = await probeBackendReachability({ backendUrl: 'http://127.0.0.1:4310/' });
    assert.equal(result.reachable, true);
    assert.equal(result.error, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
