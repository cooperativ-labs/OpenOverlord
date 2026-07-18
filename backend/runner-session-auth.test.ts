import express, { type NextFunction, type Request, type Response } from 'express';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

/**
 * Regression: desktop/hosted web authenticate `/api/runner/*` with a Better Auth
 * bearer session token. Those routes are also a non-browser (CLI/loopback) surface,
 * but session resolution must still run — otherwise cloud clients get
 * "Authentication required" while CLI USER_TOKEN auth continues to work.
 */

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-runner-session-auth-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'runner-session-auth.sqlite');
process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret-32-chars-min';
process.env.BETTER_AUTH_URL = 'http://127.0.0.1:4311';

const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
await bootstrapIntegrationTestDb({
  sqlitePath: process.env.OVERLORD_SQLITE_PATH
});

const { getActiveProfileId } = await import('./db.ts');
const { auth, requireAuthenticatedSession } = await import('./auth.ts');

async function withApiServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.set('trust proxy', true);
  app.use('/api', requireAuthenticatedSession);
  app.get('/api/runner/status', (_req, res) => {
    res.json({ profileId: getActiveProfileId() });
  });
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error && typeof error === 'object' && 'status' in error && 'message' in error) {
      const apiError = error as { status: number; message: string };
      res.status(apiError.status).json({ error: apiError.message });
      return;
    }
    next(error);
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  }
}

describe('runner status session auth', () => {
  it('accepts a Better Auth bearer session on /api/runner/status', async () => {
    const email = 'runner-session@test.local';
    const password = 'password12345';

    const signUp = await auth.api.signUpEmail({
      body: { email, password, name: 'Runner Session' },
      returnHeaders: true
    });
    assert.ok(signUp.response, 'expected sign-up to return a response');

    const signIn = await auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true
    });
    assert.ok(signIn.response, 'expected sign-in to return a response');

    const bearerToken = signIn.headers?.get('set-auth-token')?.trim();
    assert.ok(bearerToken, 'expected sign-in to return set-auth-token');
    assert.ok(!bearerToken.startsWith('out_'), 'session token must not look like a USER_TOKEN');

    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${bearerToken}` })
    });
    // Prefer handler-backed resolution when getSession misses bearer tokens.
    const sessionUserId =
      session?.user.id ??
      (
        await (
          await import('./http/bearer-session.ts')
        ).resolveSessionFromBrowserRequest({
          auth,
          req: { headers: { authorization: `Bearer ${bearerToken}` } } as never
        })
      )?.user.id;
    assert.ok(sessionUserId, 'expected a resolved session user id');

    await withApiServer(async baseUrl => {
      const response = await fetch(`${baseUrl}/api/runner/status`, {
        headers: { Authorization: `Bearer ${bearerToken}` }
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { profileId: string | null };
      assert.equal(
        body.profileId,
        sessionUserId,
        'runner status must authenticate as the session user, not fall through to loopback'
      );
    });
  });
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
