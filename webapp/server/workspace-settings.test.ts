import assert from 'node:assert/strict';
import test from 'node:test';

import { db, initDatabase, setActiveWorkspaceUser } from './db.ts';
import { actorIsAdmin, loadActorRoles } from './rbac.ts';
import { seedAuthenticatedOperator } from './test-helpers.ts';
import { readSqlStudioEnabled, writeSqlStudioEnabled } from './workspace-settings.ts';

await initDatabase();
const operatorWorkspaceUserId = seedAuthenticatedOperator({ db });
setActiveWorkspaceUser(operatorWorkspaceUserId);

test('loadActorRoles returns ADMIN for the authenticated workspace operator', async () => {
  const roles = await loadActorRoles({
    workspaceId: 'local-workspace',
    workspaceUserId: operatorWorkspaceUserId
  });
  assert.deepEqual(roles, ['ADMIN']);
  assert.equal(
    await actorIsAdmin({ workspaceId: 'local-workspace', workspaceUserId: operatorWorkspaceUserId }),
    true
  );
});

test('writeSqlStudioEnabled persists per workspace and readSqlStudioEnabled reads it back', async () => {
  const workspaceId = 'local-workspace';
  const initial = await readSqlStudioEnabled({ workspaceId });

  await writeSqlStudioEnabled({ workspaceId, enabled: !initial });
  assert.equal(await readSqlStudioEnabled({ workspaceId }), !initial);

  await writeSqlStudioEnabled({ workspaceId, enabled: initial });
  assert.equal(await readSqlStudioEnabled({ workspaceId }), initial);
});
