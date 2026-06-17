import assert from 'node:assert/strict';
import test from 'node:test';

import { actorIsAdmin, loadActorRoles } from './rbac.ts';
import { readSqlStudioEnabled, writeSqlStudioEnabled } from './workspace-settings.ts';

test('loadActorRoles returns ADMIN for the seeded local workspace user', () => {
  const roles = loadActorRoles({
    workspaceId: 'local-workspace',
    workspaceUserId: 'local-workspace-user'
  });
  assert.deepEqual(roles, ['ADMIN']);
  assert.equal(
    actorIsAdmin({ workspaceId: 'local-workspace', workspaceUserId: 'local-workspace-user' }),
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
