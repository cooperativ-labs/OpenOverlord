import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ensureCallerDeviceTarget } from './execution-targets.js';
import { addProjectResource, createProject, deriveProjectResourceKey } from './projects.js';
import { createSeededServiceContext } from './test-helpers.js';
import { newId, nowIso } from './util.js';

describe('createProject slug reuse', () => {
  it('allows reusing a slug after the previous project is soft-deleted', async () => {
    const { db, ctx } = await createSeededServiceContext({ source: 'cli' });

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

describe('deriveProjectResourceKey', () => {
  it('prefers explicit key, then label, then directory basename', () => {
    assert.equal(
      deriveProjectResourceKey({
        resourceKey: 'Open Overlord',
        label: 'Ignored',
        directoryPath: '/tmp/ignored'
      }),
      'open-overlord'
    );
    assert.equal(
      deriveProjectResourceKey({
        label: 'Mobile App',
        directoryPath: '/tmp/ignored'
      }),
      'mobile-app'
    );
    assert.equal(
      deriveProjectResourceKey({
        directoryPath: '/tmp/OpenOverlord'
      }),
      'openoverlord'
    );
  });
});

describe('addProjectResource', () => {
  it('stores the local execution target and rewrites the primary project-wide across targets', async () => {
    const { db, ctx } = await createSeededServiceContext({ source: 'cli' });
    const project = await createProject({ ctx, name: 'Execution target resources' });
    const localTarget = await ensureCallerDeviceTarget({ ctx });
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

    // Per-target linkage lives on project_resource_sources since the virtual
    // execution targets migration (20260712000000); project_resources no longer
    // carries execution_target_id, type, or path. Seed two pre-existing primaries
    // whose sources point at different targets to prove primary is project-wide.
    const insertPrimaryResourceWithSource = async ({
      id,
      resourceKey,
      label,
      sourceTargetId,
      dirPath
    }: {
      id: string;
      resourceKey: string;
      label: string;
      sourceTargetId: string;
      dirPath: string;
    }): Promise<void> => {
      await db.run(
        `INSERT INTO project_resources
           (id, workspace_id, project_id, resource_key, label, is_primary, status,
            metadata_json, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, 1, 'active', '{}', ?, ?, 1)`,
        [id, ctx.workspace.id, project.id, resourceKey, label, now, now]
      );
      await db.run(
        `INSERT INTO project_resource_sources
           (id, workspace_id, project_id, resource_id, execution_target_id, source_kind,
            descriptor_json, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, 'local_checkout', ?, ?, ?, 1)`,
        [
          `${id}-source`,
          ctx.workspace.id,
          project.id,
          id,
          sourceTargetId,
          JSON.stringify({ path: dirPath }),
          now,
          now
        ]
      );
    };

    await insertPrimaryResourceWithSource({
      id: 'old-local-resource',
      resourceKey: 'old-local',
      label: 'Old local',
      sourceTargetId: localTarget.executionTargetId,
      dirPath: '/tmp/old-local'
    });

    await insertPrimaryResourceWithSource({
      id: 'other-target-resource',
      resourceKey: 'other-target',
      label: 'Other target',
      sourceTargetId: 'other-target',
      dirPath: '/tmp/other-target'
    });

    // Never point a test resource at the real checkout: addProjectResource
    // writes .overlord/project.json into the directory it links.
    const addedDir = mkdtempSync(path.join(tmpdir(), 'ovld-added-'));
    const added = await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: addedDir,
      isPrimary: true
    });

    assert.equal(added.executionTargetId, localTarget.executionTargetId);
    assert.equal(added.resourceKey, path.basename(addedDir).toLowerCase());

    const rows = (await db.all(
      `SELECT pr.id, prs.execution_target_id, pr.is_primary
           FROM project_resources pr
           LEFT JOIN project_resource_sources prs
             ON prs.resource_id = pr.id AND prs.deleted_at IS NULL
          WHERE pr.project_id = ?
          ORDER BY pr.id ASC`,
      [project.id]
    )) as Array<{
      id: string;
      execution_target_id: string | null;
      is_primary: number;
    }>;

    // Primary is a project-wide property of the logical resource: adding a new
    // primary clears every other primary regardless of which target its source
    // points at, so both pre-existing primaries drop to 0.
    assert.deepEqual(rows, [
      { id: added.id, execution_target_id: localTarget.executionTargetId, is_primary: 1 },
      {
        id: 'old-local-resource',
        execution_target_id: localTarget.executionTargetId,
        is_primary: 0
      },
      { id: 'other-target-resource', execution_target_id: 'other-target', is_primary: 0 }
    ]);

    await db.close();
  });
});
