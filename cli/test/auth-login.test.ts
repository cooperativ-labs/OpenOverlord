import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  authCredentialsPath,
  readStoredAuthCredentials,
  resolveAuthBearerToken,
  writeStoredAuthCredentials
} from '../src/auth-credentials.ts';
import {
  formatUserTokenLoginCommand,
  normalizeLocalUsername,
  signInWithUsernamePassword,
  usernameToLocalEmail,
  validateLocalUsername
} from '../src/auth-login.ts';

test('formatUserTokenLoginCommand builds the non-interactive login command', () => {
  assert.equal(formatUserTokenLoginCommand('out_abc123'), 'ovld auth login --token out_abc123');
});

test('normalizeLocalUsername lowercases and trims', () => {
  assert.equal(normalizeLocalUsername('  Jake.Smith  '), 'jake.smith');
});

test('usernameToLocalEmail maps to the local auth domain', () => {
  assert.equal(usernameToLocalEmail('jake'), 'jake@overlord.local');
});

test('validateLocalUsername enforces local username rules', () => {
  assert.equal(validateLocalUsername('ab'), 'Username must be at least 3 characters.');
  assert.equal(validateLocalUsername('valid-user'), null);
});

test('writeStoredAuthCredentials persists token metadata under OVLD_HOME', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-auth-'));
  const previousHome = process.env.OVLD_HOME;
  process.env.OVLD_HOME = home;

  try {
    writeStoredAuthCredentials({
      type: 'user_token',
      token: 'out_testtoken',
      backendUrl: 'http://127.0.0.1:4310/'
    });

    const filePath = authCredentialsPath();
    assert.ok(existsSync(filePath));

    const stored = readStoredAuthCredentials();
    assert.deepEqual(stored, {
      type: 'user_token',
      token: 'out_testtoken',
      backendUrl: 'http://127.0.0.1:4310',
      updatedAt: stored?.updatedAt
    });
    assert.match(readFileSync(filePath, 'utf8'), /"token": "out_testtoken"/);
  } finally {
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
  }
});

test('signInWithUsernamePassword sends an Origin header so Better Auth accepts the request', async () => {
  const originalFetch = globalThis.fetch;
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedInit = init;
    return new Response(null, {
      status: 200,
      headers: { 'set-auth-token': 'session-token-123' }
    });
  }) as typeof fetch;

  try {
    const token = await signInWithUsernamePassword({
      backendUrl: 'http://127.0.0.1:4310/',
      username: 'jake',
      password: 'hunter2'
    });

    assert.equal(token, 'session-token-123');
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Origin, 'http://127.0.0.1:4310');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveAuthBearerToken prefers environment variables over stored credentials', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-auth-'));
  const previousHome = process.env.OVLD_HOME;
  const previousToken = process.env.OVERLORD_USER_TOKEN;
  process.env.OVLD_HOME = home;

  try {
    writeStoredAuthCredentials({
      type: 'session_bearer',
      token: 'stored-token',
      backendUrl: 'http://127.0.0.1:4310'
    });

    assert.equal(
      resolveAuthBearerToken({
        backendUrl: 'http://127.0.0.1:4310',
        env: { OVERLORD_USER_TOKEN: 'env-token' }
      }),
      'env-token'
    );
    assert.equal(
      resolveAuthBearerToken({
        backendUrl: 'http://127.0.0.1:4310',
        env: {}
      }),
      'stored-token'
    );
    assert.equal(
      resolveAuthBearerToken({
        backendUrl: 'http://127.0.0.1:9999',
        env: {}
      }),
      undefined
    );
  } finally {
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
    if (previousToken === undefined) delete process.env.OVERLORD_USER_TOKEN;
    else process.env.OVERLORD_USER_TOKEN = previousToken;
  }
});
