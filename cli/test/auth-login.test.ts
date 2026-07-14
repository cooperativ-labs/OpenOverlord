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
  createFullUserTokenFromSession,
  formatUserTokenLoginCommand,
  normalizeEmail,
  signInWithEmailPassword,
  validateEmail
} from '../src/auth-login.ts';

test('formatUserTokenLoginCommand builds the non-interactive login command', () => {
  assert.equal(formatUserTokenLoginCommand('out_abc123'), 'ovld auth login --token out_abc123');
});

test('normalizeEmail lowercases and trims', () => {
  assert.equal(normalizeEmail('  Jake.Smith@Example.com  '), 'jake.smith@example.com');
});

test('validateEmail enforces a valid email address', () => {
  assert.equal(validateEmail('not-an-email'), 'Enter a valid email address.');
  assert.equal(validateEmail('jake@example.com'), null);
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
      updatedAt: stored?.updatedAt,
      expiresAt: null
    });
    assert.match(readFileSync(filePath, 'utf8'), /"token": "out_testtoken"/);
  } finally {
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
  }
});

test('signInWithEmailPassword sends an Origin header so Better Auth accepts the request', async () => {
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
    const token = await signInWithEmailPassword({
      backendUrl: 'http://127.0.0.1:4310/',
      email: 'jake@example.com',
      password: 'hunter2'
    });

    assert.equal(token, 'session-token-123');
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Origin, 'http://127.0.0.1:4310');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createFullUserTokenFromSession mints a full USER_TOKEN using the session bearer', async () => {
  const originalFetch = globalThis.fetch;
  let capturedInput: unknown;
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    capturedInput = input;
    capturedInit = init;
    return new Response(
      JSON.stringify({
        token: {
          id: 'tok-1',
          label: 'CLI login on test-host',
          tokenPrefix: 'out_abcd',
          status: 'active',
          scope: 'full',
          scopeGrants: [],
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(0).toISOString()
        },
        secret: 'out_generated_secret'
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }) as typeof fetch;

  try {
    const token = await createFullUserTokenFromSession({
      backendUrl: 'https://overlord.example.com/',
      sessionToken: 'session-token-123',
      label: 'CLI login on test-host'
    });

    assert.equal(token.secret, 'out_generated_secret');
    assert.equal(token.expiresAt, null);
    assert.equal(capturedInput, 'https://overlord.example.com/api/user-tokens');
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer session-token-123');
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      label: 'CLI login on test-host',
      scope: 'full'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createFullUserTokenFromSession captures the backend expiry when present', async () => {
  const originalFetch = globalThis.fetch;
  const expiry = new Date(90 * 24 * 60 * 60 * 1000).toISOString();

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        token: { expiresAt: expiry },
        secret: 'out_generated_secret'
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  try {
    const token = await createFullUserTokenFromSession({
      backendUrl: 'https://overlord.example.com/',
      sessionToken: 'session-token-123'
    });

    assert.equal(token.secret, 'out_generated_secret');
    assert.equal(token.expiresAt, expiry);
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
