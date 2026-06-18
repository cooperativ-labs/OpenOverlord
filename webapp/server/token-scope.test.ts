import assert from 'node:assert/strict';
import test from 'node:test';

import { setActiveTokenAuth, setActiveWorkspaceUser } from './db.ts';
import { ApiError } from './errors.ts';
import { actorCan, requirePermission } from './rbac.ts';
import { createUserToken, listUserTokens } from './repository.ts';

// These tests run against an isolated temp SQLite DB (OVERLORD_SQLITE_PATH set by
// the test runner) seeded with the ADMIN local operator. They exercise the real
// REST→service path for default expiry, scope persistence, and the unified RBAC
// gate that intersects role grants with token scope.

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

test('createUserToken defaults to a ~90-day expiry when none is given', () => {
  const { token } = createUserToken({ label: 'default-expiry' });
  assert.ok(token.expiresAt, 'expected a default expiry');
  const delta = new Date(token.expiresAt).getTime() - Date.now();
  // Allow a wide window for test execution time.
  assert.ok(delta > NINETY_DAYS_MS - 60_000 && delta < NINETY_DAYS_MS + 60_000);
  assert.equal(token.scope, 'full');
  assert.deepEqual(token.scopeGrants, []);
});

test('createUserToken honours an explicit null expiry (never expires)', () => {
  const { token } = createUserToken({ label: 'no-expiry', expiresAt: null });
  assert.equal(token.expiresAt, null);
});

test('createUserToken with ticket_lifecycle scope persists grants and surfaces them', () => {
  const { token } = createUserToken({ label: 'runner', scope: 'ticket_lifecycle' });
  assert.equal(token.scope, 'ticket_lifecycle');
  assert.ok(token.scopeGrants.includes('ticket:*'));
  assert.ok(token.scopeGrants.includes('execution_request:claim'));
  assert.ok(!token.scopeGrants.includes('project:delete'));

  // The list endpoint reflects the same scope.
  const listed = listUserTokens().find(t => t.id === token.id);
  assert.equal(listed?.scope, 'ticket_lifecycle');
});

test('a ticket_lifecycle token is denied admin/destructive actions but allowed ticket/runner work', () => {
  const scopeGrants = [
    'project:read',
    'ticket:*',
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
    workspaceUserId: 'local-workspace-user',
    tokenId: 'tok-test',
    scopeGrants
  });

  assert.equal(actorCan('ticket:create'), true);
  assert.equal(actorCan('objective:update'), true);
  assert.equal(actorCan('execution_request:claim'), true);
  assert.equal(actorCan('project:delete'), false);
  assert.equal(actorCan('user:create'), false);
  assert.equal(actorCan('user_token:self:create'), false);

  assert.throws(() => requirePermission('project:delete'), ApiError);
  // Does not throw for an allowed action.
  requirePermission('ticket:create');
});

test('a full token (session/loopback) keeps the operator ADMIN permissions', () => {
  setActiveWorkspaceUser('local-workspace-user');
  assert.equal(actorCan('project:delete'), true);
  assert.equal(actorCan('user:create'), true);
});
