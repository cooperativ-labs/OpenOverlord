import { loadBetterSqlite3 } from '@overlord/database';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAuth, type EmailOTPType, githubOAuthConfigFromEnv } from './config.ts';

/**
 * Path to the checked-in Better Auth SQLite schema (`user`, `session`,
 * `account`, `verification`). Applied to a temp database so the created auth
 * instance has the tables its OTP/verification flows write to.
 */
const BETTER_AUTH_MIGRATION = fileURLToPath(
  new URL('../../../database/sqlite/migrations/001_better_auth.sql', import.meta.url)
);

/** Create an isolated on-disk SQLite database with the Better Auth schema applied. */
function createMigratedDatabasePath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'auth-otp-test-'));
  const path = join(dir, 'auth.sqlite');
  const Database = loadBetterSqlite3();
  const db = new Database(path);
  db.exec(readFileSync(BETTER_AUTH_MIGRATION, 'utf8'));
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Read the stored OTP for an email-verification identifier straight from SQLite. */
function readStoredEmailVerificationOTP(path: string, email: string): string | undefined {
  const Database = loadBetterSqlite3();
  const db = new Database(path);
  try {
    const row = db
      .prepare('SELECT value FROM verification WHERE identifier = ?')
      .get(`email-verification-otp-${email}`) as { value: string } | undefined;
    if (!row) return undefined;
    // Better Auth stores the code as `<otp>:<attempts>`; the code is everything
    // before the final colon (see the emailOTP plugin's splitAtLastColon).
    const lastColon = row.value.lastIndexOf(':');
    return lastColon === -1 ? row.value : row.value.slice(0, lastColon);
  } finally {
    db.close();
  }
}

// A single Better Auth instance drives every assertion: creating multiple
// instances concurrently in one process cross-contaminates the plugin's OTP
// verification state under the test runner, which does not happen in the
// single-instance production process.
test('emailOTP: sign-up mints a verifiable 6-digit code, not the JWT token', async () => {
  const { path, cleanup } = createMigratedDatabasePath();
  const captured: Array<{ email: string; token: string; otp: string | undefined }> = [];
  const otpCalls: EmailOTPType[] = [];
  try {
    const auth = createAuth({
      database: { type: 'sqlite', path },
      sendVerificationEmail: async ({ user, token, otp }) => {
        captured.push({ email: user.email, token, otp });
      },
      sendEmailOTP: async ({ type }) => {
        otpCalls.push(type);
      }
    });

    // Configuring a sender wires the plugin's server endpoints.
    assert.equal(
      typeof (auth.api as Record<string, unknown>).createVerificationOTP,
      'function',
      'plugin endpoints must be present with a sender'
    );

    const email = 'new-user@example.com';
    await auth.api.signUpEmail({ body: { email, password: 'password123', name: 'New User' } });

    // The sign-up confirmation email carries a real 6-digit code, minted
    // alongside — and distinct from — the long verification link token.
    assert.equal(captured.length, 1, 'sign-up must trigger exactly one verification email');
    const { token, otp } = captured[0]!;
    assert.match(otp ?? '', /^\d{6}$/, 'the email must carry a real 6-digit OTP');
    assert.notEqual(otp, token, 'the OTP must not be the raw verification token');
    assert.ok(
      token.length > 6,
      'the raw verification token is a long link token, kept off the code block'
    );

    // The emailed code is exactly the verification code Better Auth persisted —
    // i.e. the one `/email-otp/verify-email` will accept — not a display-only
    // value. (Reading the row directly is deterministic; the plugin's own verify
    // endpoint compares against this same stored value.)
    assert.equal(
      readStoredEmailVerificationOTP(path, email),
      otp,
      'the emailed OTP must equal the stored, verifiable code'
    );

    // The standalone sign-in/reset OTP callback is only invoked for those flows,
    // never for the sign-up confirmation handled above.
    assert.deepEqual(otpCalls, [], 'sign-up must not route through the standalone OTP sender');
  } finally {
    cleanup();
  }
});

test('emailOTP plugin is left off when no sender is configured', () => {
  const { path, cleanup } = createMigratedDatabasePath();
  try {
    const auth = createAuth({ database: { type: 'sqlite', path } });
    assert.equal(
      typeof (auth.api as Record<string, unknown>).createVerificationOTP,
      'undefined',
      'plugin endpoints must be absent without a sender'
    );
  } finally {
    cleanup();
  }
});

test('githubOAuthConfigFromEnv: requires both id and secret', () => {
  const prevId = process.env.GITHUB_CLIENT_ID;
  const prevSecret = process.env.GITHUB_CLIENT_SECRET;
  try {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    assert.equal(githubOAuthConfigFromEnv(), null, 'no creds → null (Local default)');

    process.env.GITHUB_CLIENT_ID = 'client-id';
    assert.equal(githubOAuthConfigFromEnv(), null, 'id alone is insufficient');

    process.env.GITHUB_CLIENT_SECRET = 'client-secret';
    assert.deepEqual(
      githubOAuthConfigFromEnv(),
      { clientId: 'client-id', clientSecret: 'client-secret' },
      'both present → creds returned'
    );
  } finally {
    if (prevId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = prevSecret;
  }
});

test('github social provider is wired only when credentials are supplied', () => {
  const { path, cleanup } = createMigratedDatabasePath();
  try {
    const withGithub = createAuth({
      database: { type: 'sqlite', path },
      github: { clientId: 'id', clientSecret: 'secret' }
    });
    const providers = (withGithub.options as { socialProviders?: Record<string, unknown> })
      .socialProviders;
    assert.ok(providers?.github, 'github provider present when creds supplied');

    const withoutGithub = createAuth({ database: { type: 'sqlite', path }, github: null });
    const noProviders = (withoutGithub.options as { socialProviders?: Record<string, unknown> })
      .socialProviders;
    assert.ok(!noProviders?.github, 'github provider absent when explicitly disabled');
  } finally {
    cleanup();
  }
});

test('session freshAge is disabled so valid sessions never age out of sensitive ops', () => {
  const { path, cleanup } = createMigratedDatabasePath();
  try {
    const auth = createAuth({ database: { type: 'sqlite', path } });
    const session = (auth.options as { session?: { freshAge?: number } }).session;
    assert.equal(
      session?.freshAge,
      0,
      'freshAge must be 0 to avoid failing sensitive ops after 24h on a valid session'
    );
  } finally {
    cleanup();
  }
});
