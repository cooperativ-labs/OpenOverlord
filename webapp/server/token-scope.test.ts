import assert from 'node:assert/strict';
import test from 'node:test';

import { db, initDatabase, setActiveTokenAuth, setActiveWorkspaceUser } from './db.ts';
import { ApiError } from './errors.ts';
import { actorCan, requirePermission } from './rbac.ts';
import { createUserToken, listUserTokens } from './repository.ts';
import { seedAuthenticatedOperator } from './test-helpers.ts';

// These tests create an explicit ADMIN local operator. They exercise the real
// REST→service path for default expiry, scope persistence, and the unified RBAC
// gate that intersects role grants with token scope.

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
await initDatabase();
const operatorWorkspaceUserId = seedAuthenticatedOperator({ db });
setActiveWorkspaceUser(operatorWorkspaceUserId);

test('createUserToken defaults to a ~90-day expiry when none is given', async () => {
  const { token } = await createUserToken({ label: 'default-expiry' });
  assert.ok(token.expiresAt, 'expected a default expiry');
  const delta = new Date(token.expiresAt).getTime() - Date.now();
  // Allow a wide window for test execution time.
  assert.ok(delta > NINETY_DAYS_MS - 60_000 && delta < NINETY_DAYS_MS + 60_000);
  assert.equal(token.scope, 'full');
  assert.deepEqual(token.scopeGrants, []);
});

test('createUserToken honours an explicit null expiry (never expires)', async () => {
  const { token } = await createUserToken({ label: 'no-expiry', expiresAt: null });
  assert.equal(token.expiresAt, null);
});

test('createUserToken with mission_lifecycle scope persists grants and surfaces them', async () => {
  const { token } = await createUserToken({ label: 'runner', scope: 'mission_lifecycle' });
  assert.equal(token.scope, 'mission_lifecycle');
  assert.ok(token.scopeGrants.includes('mission:*'));
  assert.ok(token.scopeGrants.includes('execution_request:claim'));
  assert.ok(!token.scopeGrants.includes('project:delete'));

  // The list endpoint reflects the same scope.
  const listed = (await listUserTokens()).find(t => t.id === token.id);
  assert.equal(listed?.scope, 'mission_lifecycle');
});

test('a mission_lifecycle token is denied admin/destructive actions but allowed mission/runner work', async () => {
  const scopeGrants = [
    'project:read',
    'mission:*',
    'objective:*',
    'session:*',
    'event:create',
    'event:read',
    'artifact:*',
    'attachment:*',
    'execution_request:create',
    'execution_request:read',
    'execution_request:claim'
  ];
  setActiveTokenAuth({
    workspaceUserId: operatorWorkspaceUserId,
    tokenId: 'tok-test',
    scopeGrants
  });

  assert.equal(await actorCan('mission:create'), true);
  assert.equal(await actorCan('objective:update'), true);
  assert.equal(await actorCan('execution_request:claim'), true);
  assert.equal(await actorCan('project:delete'), false);
  assert.equal(await actorCan('user:create'), false);
  assert.equal(await actorCan('user_token:self:create'), false);

  await assert.rejects(requirePermission('project:delete'), ApiError);
  await requirePermission('mission:create');
});

test('a full token (session/loopback) keeps the operator ADMIN permissions', async () => {
  setActiveWorkspaceUser(operatorWorkspaceUserId);
  assert.equal(await actorCan('project:delete'), true);
  assert.equal(await actorCan('user:create'), true);
});
