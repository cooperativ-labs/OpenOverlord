import type { Request, Response } from 'express';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

// The OAuth handlers mint and revoke real USER_TOKENs, so these tests run
// against a real migrated SQLite database with an authenticated ADMIN operator
// (the approval endpoint is `requirePermission`-gated).
const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-oauth-test-'));
const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
const { db } = await bootstrapIntegrationTestDb({
  sqlitePath: path.join(tempDir, 'oauth.sqlite')
});
const oauth = await import('./oauth.ts');
const { hashUserTokenSecret, USER_TOKEN_PREFIX } = await import('@overlord/auth');

const REDIRECT_URI = 'http://127.0.0.1:9876/callback';
const CODE_VERIFIER = 'test-code-verifier-0123456789';
const CODE_CHALLENGE = createHash('sha256').update(CODE_VERIFIER).digest('base64url');

type MockResponse = Response & { statusCode: number; payload: unknown };

function mockResponse(): MockResponse {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.payload = body;
      return res;
    },
    redirect(url: string) {
      res.payload = url;
    }
  };
  return res as unknown as MockResponse;
}

function requestWith(body: Record<string, unknown>): Request {
  return { body, query: {} } as unknown as Request;
}

function registerClient(clientName: string): string {
  const res = mockResponse();
  oauth.handleOAuthRegister(
    requestWith({ client_name: clientName, redirect_uris: [REDIRECT_URI] }),
    res
  );
  assert.equal(res.statusCode, 201);
  return (res.payload as { client_id: string }).client_id;
}

async function approveAndGetCode(clientId: string): Promise<string> {
  const res = mockResponse();
  await oauth.handleOAuthApprove(
    requestWith({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: CODE_CHALLENGE,
      state: 'test-state',
      decision: 'approve'
    }),
    res
  );
  const { redirectTo } = res.payload as { redirectTo: string };
  const code = new URL(redirectTo).searchParams.get('code');
  assert.ok(code, 'approval must redirect back with an authorization code');
  return code;
}

async function exchangeCode(params: {
  code: string;
  clientId: string;
  redirectUri?: string;
  codeVerifier?: string;
}): Promise<MockResponse> {
  const res = mockResponse();
  await oauth.handleOAuthToken(
    requestWith({
      grant_type: 'authorization_code',
      code: params.code,
      client_id: params.clientId,
      redirect_uri: params.redirectUri ?? REDIRECT_URI,
      code_verifier: params.codeVerifier ?? CODE_VERIFIER
    }),
    res
  );
  return res;
}

function mintedTokenRow(clientName: string): { status: string; token_hash: string } {
  const row = db
    .prepare(
      `SELECT status, token_hash FROM user_tokens
        WHERE label = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(`OAuth MCP: ${clientName}`) as { status: string; token_hash: string } | undefined;
  assert.ok(row, `approval must have minted a token for ${clientName}`);
  return row;
}

test('authorization-code exchange delivers the minted USER_TOKEN', async () => {
  const clientId = registerClient('Happy Path Client');
  const code = await approveAndGetCode(clientId);

  const res = await exchangeCode({ code, clientId });
  assert.equal(res.statusCode, 200);
  const { access_token } = res.payload as { access_token: string };

  assert.ok(access_token.startsWith(USER_TOKEN_PREFIX), 'access token is a USER_TOKEN secret');
  const row = mintedTokenRow('Happy Path Client');
  assert.equal(row.status, 'active');
  assert.equal(
    row.token_hash,
    hashUserTokenSecret(access_token),
    'the delivered secret hashes to the stored token_hash (mint and verify share one format)'
  );
});

test('a failed PKCE exchange consumes the code and revokes the minted token', async () => {
  const clientId = registerClient('PKCE Failure Client');
  const code = await approveAndGetCode(clientId);

  const failed = await exchangeCode({ code, clientId, codeVerifier: 'wrong-verifier' });
  assert.equal(failed.statusCode, 400);
  assert.equal((failed.payload as { error: string }).error, 'invalid_grant');
  assert.equal(
    mintedTokenRow('PKCE Failure Client').status,
    'revoked',
    'the token the code would have delivered must not stay active'
  );

  // Single-use: retrying with the correct verifier cannot resurrect the code.
  const retry = await exchangeCode({ code, clientId });
  assert.equal(retry.statusCode, 400);
  assert.equal((retry.payload as { error: string }).error, 'invalid_grant');
});

test('a client mismatch on exchange revokes the minted token', async () => {
  const clientId = registerClient('Mismatch Client');
  const otherClientId = registerClient('Some Other Client');
  const code = await approveAndGetCode(clientId);

  const failed = await exchangeCode({ code, clientId: otherClientId });
  assert.equal(failed.statusCode, 400);
  assert.equal((failed.payload as { error: string }).error, 'invalid_grant');
  assert.equal(mintedTokenRow('Mismatch Client').status, 'revoked');
});

test('an expired unexchanged code revokes its token instead of orphaning it', async () => {
  const clientId = registerClient('Expiring Client');
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const code = await approveAndGetCode(clientId);
    // Past the 5-minute authorization-code TTL.
    mock.timers.setTime(Date.now() + 6 * 60 * 1000);

    const res = await exchangeCode({ code, clientId });
    assert.equal(res.statusCode, 400);
    assert.equal((res.payload as { error: string }).error, 'invalid_grant');
    assert.equal(
      mintedTokenRow('Expiring Client').status,
      'revoked',
      'expiry must revoke the token the code would have delivered'
    );
  } finally {
    mock.timers.reset();
  }
});

test('the approve-time sweep revokes tokens of codes that expired unexchanged', async () => {
  const abandonedClientId = registerClient('Abandoned Client');
  const freshClientId = registerClient('Fresh Client');
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    await approveAndGetCode(abandonedClientId);
    mock.timers.setTime(Date.now() + 6 * 60 * 1000);

    // The next approval sweeps the expired pending code without any exchange
    // attempt ever happening for it.
    await approveAndGetCode(freshClientId);
    assert.equal(mintedTokenRow('Abandoned Client').status, 'revoked');
    assert.equal(mintedTokenRow('Fresh Client').status, 'active');
  } finally {
    mock.timers.reset();
  }
});
