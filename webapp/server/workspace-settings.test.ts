import assert from 'node:assert/strict';
import test from 'node:test';

import { db, setActiveWorkspaceUser } from './db.ts';
import { actorIsAdmin, loadActorRoles } from './rbac.ts';
import { seedAuthenticatedOperator } from './test-helpers.ts';
import { readSqlStudioEnabled, writeSqlStudioEnabled } from './workspace-settings.ts';

const operatorWorkspaceUserId = seedAuthenticatedOperator({ db });
setActiveWorkspaceUser(operatorWorkspaceUserId);

test('loadActorRoles returns ADMIN for the authenticated workspace operator', () => {
  const roles = loadActorRoles({
    workspaceId: 'local-workspace',
    workspaceUserId: operatorWorkspaceUserId
  });
  assert.deepEqual(roles, ['ADMIN']);
  assert.equal(
    actorIsAdmin({ workspaceId: 'local-workspace', workspaceUserId: operatorWorkspaceUserId }),
    true
  );
});

test('writeSqlStudioEnabled persists per workspace and readSqlStudioEnabled reads it back', () => {
  const workspaceId = 'local-workspace';
  const initial = readSqlStudioEnabled({ workspaceId });

  writeSqlStudioEnabled({ workspaceId, enabled: !initial });
  assert.equal(readSqlStudioEnabled({ workspaceId }), !initial);

  writeSqlStudioEnabled({ workspaceId, enabled: initial });
  assert.equal(readSqlStudioEnabled({ workspaceId }), initial);
});
