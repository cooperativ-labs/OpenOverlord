import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runOvld } from '../../../test/support/cli.ts';

/**
 * Self-contained (unlike the sibling protocol e2e suite, which assumes a
 * developer has already started a backend and logged in): this file boots
 * its own `ovld serve` against a scratch SQLite database and mints a
 * USER_TOKEN directly in that database (bypassing the better-auth login UI),
 * so `--if-needed`/zero-membership behavior can be asserted without a manual
 * login step. Gated the same way as the sibling suite.
 */
const protocolE2e = process.env.OVLD_PROTOCOL_E2E === '1' ? test : test.skip;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = 4327;
const BACKEND_URL = `http://127.0.0.1:${PORT}`;

let serverProcess: ChildProcess | null = null;
let sqlitePath: string;

async function waitForHealth(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Backend at ${BACKEND_URL} did not become healthy in time`);
}

/** Insert a `user` row + an active, non-workspace-scoped USER_TOKEN directly (Phase 1: user_tokens.workspace_id is nullable — coo:135). */
function mintHeadlessToken(dbPath: string, userId: string): string {
  const db = new Database(dbPath);
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, NULL, ?, ?)`
    ).run(userId, userId, `${userId}@overlord.local`, now, now);

    const rawToken = `out_${randomBytes(32).toString('base64url')}`;
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const tokenPrefix = rawToken.slice(0, 12);
    db.prepare(
      `INSERT INTO user_tokens (
         id, workspace_id, profile_id, workspace_user_id, label, token_prefix, token_hash,
         hash_algorithm, status, expires_at, created_at, updated_at, revision
       ) VALUES (?, NULL, ?, NULL, 'e2e', ?, ?, 'sha256', 'active', NULL, ?, ?, 1)`
    ).run(`${userId}-token`, userId, tokenPrefix, tokenHash, now, now);

    return rawToken;
  } finally {
    db.close();
  }
}

before(async () => {
  if (process.env.OVLD_PROTOCOL_E2E !== '1') return;

  const dir = mkdtempSync(path.join('/tmp', 'open-overlord-e2e-org-setup-'));
  sqlitePath = path.join(dir, 'Overlord.sqlite');

  serverProcess = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'backend', 'index.ts')],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OVERLORD_WEB_HOST: '127.0.0.1',
        OVERLORD_WEB_PORT: String(PORT),
        OVERLORD_SQLITE_PATH: sqlitePath
      },
      stdio: 'ignore'
    }
  );
  await waitForHealth();
});

after(async () => {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
});

function clientEnv(userId: string): NodeJS.ProcessEnv {
  return {
    OVERLORD_ALLOW_CONFIG_WRITE: '1',
    OVERLORD_BACKEND_URL: BACKEND_URL,
    OVERLORD_USER_TOKEN: mintHeadlessToken(sqlitePath, userId)
  };
}

protocolE2e(
  'ovld org-setup onboards a zero-membership profile into a new org + workspace',
  async () => {
    const env = clientEnv('e2e-onboard-user');

    const setup = await runOvld({
      args: [
        'org-setup',
        '--org-name',
        'E2E Org',
        '--workspace-name',
        'E2E Workspace',
        '--no-input',
        '--json'
      ],
      env
    });
    assert.equal(setup.exitCode, 0, setup.stderr);

    const result = JSON.parse(setup.stdout) as {
      organization: { id: string; name: string };
      workspace: { id: string; slug: string; name: string } | null;
      logoWarning: string | null;
    };
    assert.equal(result.organization.name, 'E2E Org');
    assert.equal(result.workspace?.name, 'E2E Workspace');
    assert.equal(result.logoWarning, null);
  }
);

protocolE2e('ovld org-setup --if-needed is a no-op once memberships already exist', async () => {
  const env = clientEnv('e2e-if-needed-user');

  const first = await runOvld({
    args: ['org-setup', '--org-name', 'First Org', '--no-input', '--json'],
    env
  });
  assert.equal(first.exitCode, 0, first.stderr);

  const second = await runOvld({
    args: ['org-setup', '--org-name', 'Second Org', '--no-input', '--if-needed', '--json'],
    env
  });
  assert.equal(second.exitCode, 0, second.stderr);
  const result = JSON.parse(second.stdout) as { skipped: boolean };
  assert.equal(result.skipped, true);
});

protocolE2e(
  'ovld org-setup without --if-needed errors once memberships already exist',
  async () => {
    const env = clientEnv('e2e-already-member-user');
    await runOvld({ args: ['org-setup', '--org-name', 'First Org', '--no-input', '--json'], env });

    const second = await runOvld({
      args: ['org-setup', '--org-name', 'Second Org', '--no-input', '--json'],
      env
    });
    assert.notEqual(second.exitCode, 0);
    assert.match(second.stderr, /already belong to at least one organization/);
  }
);

protocolE2e('ovld org-setup --no-input fails fast on a missing --org-name', async () => {
  const env = clientEnv('e2e-missing-org-name-user');

  const result = await runOvld({ args: ['org-setup', '--no-input', '--json'], env });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Missing --org-name/);
});
