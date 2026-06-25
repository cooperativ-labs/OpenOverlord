import { openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { ensureLocalExecutionTarget } from './execution-targets.js';
import { addProjectResource, createProject } from './projects.js';
import { newId, nowIso } from './util.js';

describe('createProject slug reuse', () => {
  it('allows reusing a slug after the previous project is soft-deleted', () => {
    const db = openInMemoryDatabase();
    const ctx = createServiceContext({ db, source: 'cli' });

    const first = createProject({ ctx, name: 'Overlord', slug: 'overlord' });
    db.prepare(
      `UPDATE projects SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`
    ).run(nowIso(), nowIso(), first.id);

    const second = createProject({ ctx, name: 'Overlord', slug: 'overlord' });
    assert.notEqual(second.id, first.id);
    assert.equal(second.slug, 'overlord');

    db.close();
  });
});

describe('addProjectResource', () => {
  it('stores the local execution target and only rewrites primaries within that target', () => {
    const db = openInMemoryDatabase();
    const ctx = createServiceContext({ db, source: 'cli' });
    const project = createProject({ ctx, name: 'Execution target resources' });
    const localTarget = ensureLocalExecutionTarget({ ctx });
    const now = nowIso();
    const otherDeviceId = newId();

    db.prepare(
      `INSERT INTO devices
         (id, workspace_id, fingerprint, label, platform, status, metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, 'Other device', 'darwin', 'active', '{}', ?, ?, 1)`
    ).run(otherDeviceId, ctx.workspace.id, `fingerprint-${otherDeviceId}`, now, now);

    db.prepare(
      `INSERT INTO execution_targets
         (id, workspace_id, device_id, owner_workspace_user_id, type, label, status,
          connection_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local', 'Other device', 'active', '{}', ?, ?, 1)`
    ).run('other-target', ctx.workspace.id, otherDeviceId, ctx.actorWorkspaceUserId, now, now);

    db.prepare(
      `INSERT INTO project_resources
         (id, workspace_id, project_id, execution_target_id, type, label, path, is_primary, status,
          metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local_directory', 'Old local', '/tmp/old-local', 1, 'active',
               '{}', ?, ?, 1)`
    ).run(
      'old-local-resource',
      ctx.workspace.id,
      project.id,
      localTarget.executionTargetId,
      now,
      now
    );

    db.prepare(
      `INSERT INTO project_resources
         (id, workspace_id, project_id, execution_target_id, type, label, path, is_primary, status,
          metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local_directory', 'Other target', '/tmp/other-target', 1, 'active',
               '{}', ?, ?, 1)`
    ).run('other-target-resource', ctx.workspace.id, project.id, 'other-target', now, now);

    const added = addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: process.cwd(),
      isPrimary: true
    });

    assert.equal(added.executionTargetId, localTarget.executionTargetId);

    const rows = db
      .prepare(
        `SELECT id, execution_target_id, is_primary
           FROM project_resources
          WHERE project_id = ?
          ORDER BY id ASC`
      )
      .all(project.id) as Array<{
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

    db.close();
  });
});
