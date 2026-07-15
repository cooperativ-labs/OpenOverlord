import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveSessionFromBrowserRequest } from './http/bearer-session.ts';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-bearer-session-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');
process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret-32-chars-min';
process.env.BETTER_AUTH_URL = 'http://127.0.0.1:4310';

const dbModule = await import('./db.ts');
await dbModule.initDatabase();
const { auth } = await import('./auth.ts');

describe('resolveSessionFromBrowserRequest', () => {
  it('accepts a bearer session token on /api-style requests', async () => {
    const email = 'bearer-session@test.local';
    const password = 'password12345';

    const signUp = await auth.api.signUpEmail({
      body: {
        email,
        password,
        name: 'Bearer Session Test'
      },
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

    const req = {
      headers: {
        authorization: `Bearer ${bearerToken}`,
        origin: 'https://app.ovld.ai'
      }
    };

    const directSession = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${bearerToken}` })
    });

    const session = await resolveSessionFromBrowserRequest({ auth, req: req as never });
    assert.ok(session);
    assert.equal(session.user.email, email);
    if (!directSession) {
      assert.ok(session, 'handler-backed bearer resolution should succeed when needed');
    }
  });
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});
