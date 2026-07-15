import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-auth-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');

const dbModule = await import('./db.ts');
const { db, initDatabase, setActiveWorkspaceUser } = dbModule;
await initDatabase();
const { ensureWorkspaceUser } = await import('./auth.ts');
const { getRequestedWorkspaceId } = await import('./auth.ts');
const { DEFAULT_TEST_ORGANIZATION_ID, seedAuthenticatedOperator } =
  await import('./test-helpers.ts');
const { createWorkspace } = await import('./workspaces.ts');

const operatorWorkspaceUserId = seedAuthenticatedOperator({ db });
setActiveWorkspaceUser(operatorWorkspaceUserId);

function insertUnaffiliatedProfile(profileId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, NULL, ?, ?)`
  ).run(profileId, profileId, `${profileId}@overlord.local`, now, now);
}

test('ensureWorkspaceUser resolves an existing member without change', async () => {
  const membership = await ensureWorkspaceUser('operator-user');
  assert.equal(membership?.workspaceUserId, operatorWorkspaceUserId);
  assert.equal(membership?.workspace.id, 'local-workspace');
});

test('ensureWorkspaceUser does not auto-join a second signed-up account into any workspace', async () => {
  // Simulate a second workspace already existing, so we can prove the new
  // signup is not folded into *any* of them, not just the active one.
  await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Second Workspace For Auth Test'
  });

  insertUnaffiliatedProfile('test-user');

  const membership = await ensureWorkspaceUser('test-user');
  assert.equal(membership, null, 'a non-member session must resolve to no active workspace');

  const memberships = db
    .prepare(
      `SELECT workspace_id FROM workspace_users
         WHERE profile_id = ? AND deleted_at IS NULL`
    )
    .all('test-user') as { workspace_id: string }[];
  assert.deepEqual(
    memberships,
    [],
    'a freshly signed-up account must not be a member of any existing workspace'
  );
});

test('ensureWorkspaceUser resolves an explicitly requested workspace the profile belongs to', async () => {
  const second = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Explicit Request Workspace'
  });
  insertUnaffiliatedProfile('multi-workspace-user');
  db.prepare(
    `INSERT INTO workspace_users
       (id, workspace_id, profile_id, member_key, status, metadata_json, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`
  ).run(
    'multi-workspace-user-membership',
    second.id,
    'multi-workspace-user',
    'auth:multi-workspace-user',
    new Date().toISOString(),
    new Date().toISOString()
  );

  const membership = await ensureWorkspaceUser('multi-workspace-user', second.id);
  assert.equal(membership?.workspaceUserId, 'multi-workspace-user-membership');
  assert.equal(membership?.workspace.id, second.id);
});

test('getRequestedWorkspaceId accepts the bearer-client header before the browser cookie', () => {
  const req = {
    headers: { cookie: 'overlord_active_workspace=cookie-workspace' },
    header(name: string) {
      return name.toLowerCase() === 'x-overlord-active-workspace' ? 'header-workspace' : undefined;
    }
  };

  assert.equal(getRequestedWorkspaceId(req as never), 'header-workspace');
});

test('getRequestedWorkspaceId falls back to the browser cookie', () => {
  const req = {
    headers: { cookie: 'overlord_active_workspace=cookie-workspace' },
    header() {
      return undefined;
    }
  };

  assert.equal(getRequestedWorkspaceId(req as never), 'cookie-workspace');
});

test('ensureWorkspaceUser rejects a requested workspace the profile is not a member of', async () => {
  // A live workspace the operator does not belong to: the IDOR guard 403s.
  insertUnaffiliatedProfile('other-tenant-user');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspaces (id, organization_id, slug, name, kind, settings_json, created_at, updated_at, revision)
     VALUES ('other-tenant-workspace', ?, 'other-tenant', 'Other Tenant', 'local', '{}', ?, ?, 1)`
  ).run(DEFAULT_TEST_ORGANIZATION_ID, now, now);
  db.prepare(
    `INSERT INTO workspace_users
       (id, workspace_id, profile_id, member_key, status, metadata_json, created_at, updated_at, revision)
     VALUES (?, 'other-tenant-workspace', 'other-tenant-user', 'auth:other-tenant-user', 'active', '{}', ?, ?, 1)`
  ).run('other-tenant-membership', now, now);

  await assert.rejects(
    () => ensureWorkspaceUser('operator-user', 'other-tenant-workspace'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { status?: number }).status, 403);
      return true;
    }
  );
});

test('ensureWorkspaceUser treats a requested workspace that no longer exists as a stale preference', async () => {
  // A deleted/re-keyed workspace id in the cookie must not wedge the session:
  // it falls back to the profile's default membership instead of erroring.
  const membership = await ensureWorkspaceUser('operator-user', 'some-workspace-that-was-deleted');
  assert.equal(membership?.workspace.id, 'local-workspace');
});

test('a request with no active workspace cleanly 403s through requirePermission instead of throwing', async () => {
  const { withRequestContextAsync, setActiveWorkspaceContext } = dbModule;
  const { requirePermission } = await import('./rbac.ts');
  const { PERMISSIONS } = await import('@overlord/auth');

  await withRequestContextAsync(async () => {
    // Mirrors exactly what `requireAuthenticatedSession` sets for a browser
    // session with no active workspace membership (see `ensureWorkspaceUser`
    // returning `null`): the RBAC gate must reject with a clean 403, not crash,
    // even though `rbac.ts`'s default parameters would otherwise evaluate
    // `getActiveWorkspaceId()` (which throws in this state).
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);

    await assert.rejects(
      () => requirePermission(PERMISSIONS.WORKSPACE_READ, { workspaceId: 'missing-workspace' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { status?: number }).status, 403);
        return true;
      }
    );
  });
});

test.after(async () => {
  rmSync(tempDir, { recursive: true, force: true });
});
