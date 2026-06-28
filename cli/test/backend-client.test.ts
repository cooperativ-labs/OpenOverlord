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
import { CliError } from '../src/errors.ts';

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

test('createBackendClient clears stored credentials and guides re-login on 401', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-backend-client-'));
  const previousHome = process.env.OVLD_HOME;
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
        assert.match(error.message, /Saved credentials were cleared/i);
        return true;
      }
    );
    assert.equal(existsSync(authCredentialsPath()), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
  }
});
