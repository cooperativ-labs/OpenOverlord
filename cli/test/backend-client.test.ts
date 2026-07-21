import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  authCredentialsPath,
  clearStoredAuthCredentials,
  writeStoredAuthCredentials
} from '../src/auth-credentials.ts';
import { createBackendClient } from '../src/backend-client.ts';
import { clientDeviceIdentity } from '../src/device-identity.ts';
import { CliError } from '../src/errors.ts';

const ISOLATED_ENV_KEYS = [
  'OVERLORD_BACKEND_URL',
  'OVERLORD_BACKEND_URL_DEV',
  'OVERLORD_USER_TOKEN',
  'OVLD_USER_TOKEN',
  'USER_TOKEN'
] as const;

function isolateBackendClientEnv(): Record<(typeof ISOLATED_ENV_KEYS)[number], string | undefined> {
  const previous = {} as Record<(typeof ISOLATED_ENV_KEYS)[number], string | undefined>;
  for (const key of ISOLATED_ENV_KEYS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  return previous;
}

function restoreBackendClientEnv(
  previous: Record<(typeof ISOLATED_ENV_KEYS)[number], string | undefined>
): void {
  for (const key of ISOLATED_ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

test('clearStoredAuthCredentials removes auth.json', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-auth-clear-'));
  const previousHome = process.env.OVLD_HOME;
  process.env.OVLD_HOME = home;

  try {
    writeStoredAuthCredentials({
      type: 'session_bearer',
      token: 'session-token',
      backendUrl: 'http://127.0.0.1:4310'
    });
    assert.ok(existsSync(authCredentialsPath()));
    clearStoredAuthCredentials();
    assert.equal(existsSync(authCredentialsPath()), false);
  } finally {
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
  }
});

test('createBackendClient preserves stored credentials and guides re-login on 401', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-backend-client-'));
  const previousHome = process.env.OVLD_HOME;
  const previousEnv = isolateBackendClientEnv();
  process.env.OVLD_HOME = home;

  writeFileSync(
    path.join(home, 'overlord.toml'),
    `instance_name = "Local Overlord"
backend_mode = "local"
backend_url = "http://127.0.0.1:4310"
web_host = "127.0.0.1"
web_port = 4310
default_agent = "claude"
`
  );

  writeStoredAuthCredentials({
    type: 'session_bearer',
    token: 'stale-session-token',
    backendUrl: 'http://127.0.0.1:4310'
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    })) as typeof fetch;

  try {
    const backend = createBackendClient();
    await assert.rejects(
      () => backend.get('/api/meta'),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.match(error.message, /ovld auth login/i);
        assert.match(error.message, /credentials were rejected/i);
        return true;
      }
    );
    // A 401 must NOT delete the stored credential — it may be transient, and
    // wiping it forced an avoidable full re-login.
    assert.equal(existsSync(authCredentialsPath()), true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreBackendClientEnv(previousEnv);
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
  }
});

test('createBackendClient sends local device identity headers', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-backend-client-device-'));
  const previousHome = process.env.OVLD_HOME;
  const previousEnv = isolateBackendClientEnv();
  process.env.OVLD_HOME = home;

  writeFileSync(
    path.join(home, 'overlord.toml'),
    `instance_name = "Local Overlord"
backend_mode = "cloud"
backend_url = "https://cloud.overlord.test"
web_host = "127.0.0.1"
web_port = 4310
default_agent = "claude"
`
  );

  const originalFetch = globalThis.fetch;
  let capturedHeaders: Headers | null = null;
  globalThis.fetch = (async (_url, init) => {
    capturedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const backend = createBackendClient();
    await backend.get('/api/launch-settings');

    const identity = clientDeviceIdentity();
    assert.equal(capturedHeaders?.get('x-overlord-device-fingerprint'), identity.deviceFingerprint);
    assert.equal(capturedHeaders?.get('x-overlord-device-label'), identity.deviceLabel);
    assert.equal(capturedHeaders?.get('x-overlord-device-platform'), identity.devicePlatform);
  } finally {
    globalThis.fetch = originalFetch;
    restoreBackendClientEnv(previousEnv);
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
  }
});

test('backend requests do not send workspace-selection headers', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-backend-client-workspace-'));
  const previousHome = process.env.OVLD_HOME;
  const previousEnv = isolateBackendClientEnv();
  process.env.OVLD_HOME = home;
  writeFileSync(
    path.join(home, 'overlord.toml'),
    `backend_mode = "cloud"
backend_url = "https://cloud.overlord.test"
`
  );

  const originalFetch = globalThis.fetch;
  let capturedHeaders: Headers | null = null;
  globalThis.fetch = (async (_url, init) => {
    capturedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    await createBackendClient().get('/api/meta');
    assert.equal(capturedHeaders?.has('x-overlord-active-workspace'), false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreBackendClientEnv(previousEnv);
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
  }
});
