import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveAuthCredentialSource,
  resolveAuthStatus
} from '../src/auth-status.ts';
import { writeStoredAuthCredentials } from '../src/auth-credentials.ts';

test('resolveAuthCredentialSource prefers environment tokens over stored credentials', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-auth-status-'));
  const previousHome = process.env.OVLD_HOME;
  process.env.OVLD_HOME = home;

  try {
    writeStoredAuthCredentials({
      type: 'session_bearer',
      token: 'stored-token',
      backendUrl: 'http://127.0.0.1:4310'
    });

    assert.deepEqual(
      resolveAuthCredentialSource({
        backendUrl: 'http://127.0.0.1:4310',
        env: { OVERLORD_USER_TOKEN: 'out_envtoken' }
      }),
      {
        source: 'environment',
        type: 'user_token',
        credentialsPath: null
      }
    );
  } finally {
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
  }
});

test('resolveAuthCredentialSource reports stored credential backend mismatches', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-auth-status-'));
  const previousHome = process.env.OVLD_HOME;
  process.env.OVLD_HOME = home;

  try {
    writeStoredAuthCredentials({
      type: 'user_token',
      token: 'out_stored',
      backendUrl: 'http://127.0.0.1:4310'
    });

    const credential = resolveAuthCredentialSource({
      backendUrl: 'http://127.0.0.1:9999',
      env: {}
    });

    assert.equal(credential.source, 'stored_mismatch');
    assert.equal(credential.type, 'user_token');
    assert.match(credential.credentialsPath ?? '', /auth\.json$/);
  } finally {
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
  }
});

test('resolveAuthStatus reports logged_in=true when bearer validation succeeds', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

  const previousToken = process.env.OVERLORD_USER_TOKEN;
  process.env.OVERLORD_USER_TOKEN = 'out_valid';

  try {
    const status = await resolveAuthStatus();
    assert.equal(status.loggedIn, true);
    assert.equal(status.credentialSource, 'environment');
    assert.equal(status.credentialType, 'user_token');
    assert.equal(status.validationError, null);
    assert.match(status.backendUrl, /^https?:\/\//);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.OVERLORD_USER_TOKEN;
    else process.env.OVERLORD_USER_TOKEN = previousToken;
  }
});

test('resolveAuthStatus reports logged_in=false when bearer validation fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    })) as typeof fetch;

  const previousToken = process.env.OVERLORD_USER_TOKEN;
  process.env.OVERLORD_USER_TOKEN = 'out_invalid';

  try {
    const status = await resolveAuthStatus();
    assert.equal(status.loggedIn, false);
    assert.equal(status.credentialSource, 'environment');
    assert.match(status.validationError ?? '', /Invalid token/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.OVERLORD_USER_TOKEN;
    else process.env.OVERLORD_USER_TOKEN = previousToken;
  }
});

test('resolveAuthStatus reports logged_in=false when no credentials are configured', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'overlord-auth-status-'));
  const previousHome = process.env.OVLD_HOME;
  const previousToken = process.env.OVERLORD_USER_TOKEN;
  const previousOvldToken = process.env.OVLD_USER_TOKEN;
  const previousUserToken = process.env.USER_TOKEN;
  process.env.OVLD_HOME = home;
  delete process.env.OVERLORD_USER_TOKEN;
  delete process.env.OVLD_USER_TOKEN;
  delete process.env.USER_TOKEN;

  try {
    const status = await resolveAuthStatus({ env: process.env });
    assert.equal(status.loggedIn, false);
    assert.equal(status.credentialSource, 'none');
    assert.equal(status.credentialType, null);
    assert.equal(status.validationError, null);
  } finally {
    if (previousHome === undefined) delete process.env.OVLD_HOME;
    else process.env.OVLD_HOME = previousHome;
    if (previousToken === undefined) delete process.env.OVERLORD_USER_TOKEN;
    else process.env.OVERLORD_USER_TOKEN = previousToken;
    if (previousOvldToken === undefined) delete process.env.OVLD_USER_TOKEN;
    else process.env.OVLD_USER_TOKEN = previousOvldToken;
    if (previousUserToken === undefined) delete process.env.USER_TOKEN;
    else process.env.USER_TOKEN = previousUserToken;
  }
});
