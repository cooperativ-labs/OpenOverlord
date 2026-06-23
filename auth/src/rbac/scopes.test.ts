import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultAuthorizer, makeActor } from './authorizer.js';
import { grantCoversAction, tokenScopeAllows } from './authorizer.js';
import { PERMISSIONS, scopeGrantsForPreset, MISSION_LIFECYCLE_GRANTS } from './permissions.js';
import { Role } from './types.js';

/** Effective decision: role grants ∩ token scope, mirroring webapp `actorCan`. */
function effectiveCan(roles: Role[], scopeGrants: string[] | null, action: string): boolean {
  const actor = makeActor('wu-1', roles);
  return defaultAuthorizer.can(actor, action).allowed && tokenScopeAllows(scopeGrants, action);
}

test('scopeGrantsForPreset: full has no rows, mission_lifecycle has the runner set', () => {
  assert.deepEqual(scopeGrantsForPreset('full'), []);
  assert.deepEqual(scopeGrantsForPreset('mission_lifecycle'), [...MISSION_LIFECYCLE_GRANTS]);
});

test('tokenScopeAllows: null means no token-level restriction', () => {
  assert.equal(tokenScopeAllows(null, PERMISSIONS.PROJECT_DELETE), true);
  assert.equal(tokenScopeAllows(undefined, PERMISSIONS.PROJECT_DELETE), true);
});

test('grantCoversAction matches wildcards used by the mission_lifecycle preset', () => {
  assert.equal(grantCoversAction('mission:*', PERMISSIONS.MISSION_DELETE), true);
  assert.equal(grantCoversAction('mission:*', PERMISSIONS.PROJECT_DELETE), false);
});

test('full token (no scope) inherits the full ADMIN role', () => {
  assert.equal(effectiveCan([Role.ADMIN], null, PERMISSIONS.PROJECT_DELETE), true);
  assert.equal(effectiveCan([Role.ADMIN], null, PERMISSIONS.USER_CREATE), true);
});

test('mission_lifecycle scope permits mission/objective/runner work', () => {
  const scope = scopeGrantsForPreset('mission_lifecycle');
  assert.equal(effectiveCan([Role.ADMIN], scope, PERMISSIONS.MISSION_CREATE), true);
  assert.equal(effectiveCan([Role.ADMIN], scope, PERMISSIONS.OBJECTIVE_UPDATE), true);
  assert.equal(effectiveCan([Role.ADMIN], scope, PERMISSIONS.SESSION_ATTACH), true);
  assert.equal(effectiveCan([Role.ADMIN], scope, PERMISSIONS.EXECUTION_REQUEST_CLAIM), true);
  assert.equal(effectiveCan([Role.ADMIN], scope, PERMISSIONS.EVENT_CREATE), true);
  assert.equal(effectiveCan([Role.ADMIN], scope, PERMISSIONS.WORKSPACE_READ), true);
});

test('mission_lifecycle scope denies admin/destructive actions even for an ADMIN user', () => {
  const scope = scopeGrantsForPreset('mission_lifecycle');
  assert.equal(effectiveCan([Role.ADMIN], scope, PERMISSIONS.PROJECT_DELETE), false);
  assert.equal(effectiveCan([Role.ADMIN], scope, PERMISSIONS.PROJECT_CREATE), false);
  assert.equal(effectiveCan([Role.ADMIN], scope, PERMISSIONS.USER_CREATE), false);
  assert.equal(effectiveCan([Role.ADMIN], scope, PERMISSIONS.ROLE_ASSIGN), false);
  // A scoped token must not be able to mint further tokens.
  assert.equal(effectiveCan([Role.ADMIN], scope, PERMISSIONS.USER_TOKEN_SELF_CREATE), false);
});

test('scope can only restrict, never widen, the underlying role', () => {
  // A MEMBER lacks project:delete; a full-scope token still cannot delete.
  assert.equal(effectiveCan([Role.MEMBER], null, PERMISSIONS.PROJECT_DELETE), false);
  // mission_lifecycle grants mission:* but a MEMBER role already covers it — allowed.
  const scope = scopeGrantsForPreset('mission_lifecycle');
  assert.equal(effectiveCan([Role.MEMBER], scope, PERMISSIONS.MISSION_DELETE), true);
});
