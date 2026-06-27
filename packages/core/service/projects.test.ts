import { createSqliteClient, openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { ensureLocalExecutionTarget } from './execution-targets.js';
import { addProjectResource, createProject } from './projects.js';
import { newId, nowIso } from './util.js';

describe('createProject slug reuse', () => {
  it('allows reusing a slug after the previous project is soft-deleted', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'cli' });

    const first = await createProject({ ctx, name: 'Overlord', slug: 'overlord' });
    await db.run(
      `UPDATE projects SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`,
      [nowIso(), nowIso(), first.id]
    );

    const second = await createProject({ ctx, name: 'Overlord', slug: 'overlord' });
    assert.notEqual(second.id, first.id);
    assert.equal(second.slug, 'overlord');

    await db.close();
  });
});

describe('addProjectResource', () => {
  it('stores the local execution target and only rewrites primaries within that target', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'cli' });
    const project = await createProject({ ctx, name: 'Execution target resources' });
    const localTarget = await ensureLocalExecutionTarget({ ctx });
    const now = nowIso();
    const otherDeviceId = newId();

    await db.run(
      `INSERT INTO devices
         (id, workspace_id, fingerprint, label, platform, status, metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, 'Other device', 'darwin', 'active', '{}', ?, ?, 1)`,
      [otherDeviceId, ctx.workspace.id, `fingerprint-${otherDeviceId}`, now, now]
    );

    await db.run(
      `INSERT INTO execution_targets
         (id, workspace_id, device_id, owner_workspace_user_id, type, label, status,
          connection_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local', 'Other device', 'active', '{}', ?, ?, 1)`,
      ['other-target', ctx.workspace.id, otherDeviceId, ctx.actorWorkspaceUserId, now, now]
    );

    await db.run(
      `INSERT INTO project_resources
         (id, workspace_id, project_id, execution_target_id, type, label, path, is_primary, status,
          metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local_directory', 'Old local', '/tmp/old-local', 1, 'active',
               '{}', ?, ?, 1)`,
      ['old-local-resource', ctx.workspace.id, project.id, localTarget.executionTargetId, now, now]
    );

    await db.run(
      `INSERT INTO project_resources
         (id, workspace_id, project_id, execution_target_id, type, label, path, is_primary, status,
          metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local_directory', 'Other target', '/tmp/other-target', 1, 'active',
               '{}', ?, ?, 1)`,
      ['other-target-resource', ctx.workspace.id, project.id, 'other-target', now, now]
    );

    const added = await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: process.cwd(),
      isPrimary: true
    });

    assert.equal(added.executionTargetId, localTarget.executionTargetId);

    const rows = (await db.all(
      `SELECT id, execution_target_id, is_primary
           FROM project_resources
          WHERE project_id = ?
          ORDER BY id ASC`,
      [project.id]
    )) as Array<{
      id: string;
      execution_target_id: string | null;
      is_primary: number;
    }>;

    assert.deepEqual(rows, [
      { id: added.id, execution_target_id: localTarget.executionTargetId, is_primary: 1 },
      {
        id: 'old-local-resource',
        execution_target_id: localTarget.executionTargetId,
        is_primary: 0
      },
      { id: 'other-target-resource', execution_target_id: 'other-target', is_primary: 1 }
    ]);

    await db.close();
  });
});
