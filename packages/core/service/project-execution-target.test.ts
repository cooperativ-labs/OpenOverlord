import { createSqliteClient, openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { ensureCallerDeviceTarget } from './execution-targets.js';
import { addProjectResource, createProject } from './projects.js';
import {
  getProjectExecutionTargetSelection,
  PROJECT_EXECUTION_TARGET_PREFERENCE_KEY,
  resolveProjectExecutionTargetForLaunch,
  updateProjectExecutionTargetSelection
} from './project-execution-target.js';
import { seedServiceOperator } from './test-helpers.js';
import { newId, nowIso } from './util.js';

async function setup() {
  const db = createSqliteClient(openInMemoryDatabase());
  await seedServiceOperator({ db });
  const ctx = await createServiceContext({ db, source: 'cli' });
  return { db, ctx };
}

async function insertPrimaryResource({
  ctx,
  projectId,
  executionTargetId,
  resourcePath
}: {
  ctx: Awaited<ReturnType<typeof createServiceContext>>;
  projectId: string;
  executionTargetId: string;
  resourcePath: string;
}): Promise<void> {
  const now = nowIso();
  await ctx.db.run(
    `INSERT INTO project_resources
         (id, workspace_id, project_id, execution_target_id, type, label, path, is_primary, status,
          metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local_directory', 'Primary', ?, 1, 'active', '{}', ?, ?, 1)`,
    [newId(), ctx.workspace.id, projectId, executionTargetId, resourcePath, now, now]
  );
}

async function seedSecondTarget(
  ctx: Awaited<ReturnType<typeof createServiceContext>>,
  label: string
): Promise<string> {
  const now = nowIso();
  const deviceId = newId();
  await ctx.db.run(
    `INSERT INTO devices
         (id, workspace_id, fingerprint, label, platform, status, last_seen_at,
          metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'linux', 'active', ?, '{}', ?, ?, 1)`,
    [deviceId, ctx.workspace.id, `fp-${label}`, label, now, now, now]
  );
  const targetId = newId();
  await ctx.db.run(
    `INSERT INTO execution_targets
         (id, workspace_id, device_id, owner_workspace_user_id, type, label, status,
          connection_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local', ?, 'active', '{}', ?, ?, 1)`,
    [
      targetId,
      ctx.workspace.id,
      deviceId,
      ctx.actorWorkspaceUserId,
      label,
      now,
      now
    ]
  );
  await ctx.db.run(
    `INSERT INTO workspace_user_execution_targets
         (id, workspace_id, workspace_user_id, execution_target_id, access_status,
          created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
    [newId(), ctx.workspace.id, ctx.actorWorkspaceUserId, targetId, now, now]
  );
  return targetId;
}

describe('project execution target selection', () => {
  it('lists eligible targets that have a primary resource on the target', async () => {
    const { ctx } = await setup();
    const project = await createProject({ ctx, name: 'Target Select' });
    const caller = await ensureCallerDeviceTarget({ ctx });
    const resourcePath = mkdtempSync(path.join(tmpdir(), 'ovld-target-select-'));
    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: resourcePath,
      isPrimary: true
    });

    const vmTargetId = await seedSecondTarget(ctx, 'CI VM');
    await insertPrimaryResource({
      ctx,
      projectId: project.id,
      executionTargetId: vmTargetId,
      resourcePath: mkdtempSync(path.join(tmpdir(), 'ovld-target-select-vm-'))
    });

    const selection = await getProjectExecutionTargetSelection({ ctx, projectId: project.id });
    const ids = selection.eligibleTargets.map(t => t.executionTargetId).sort();
    assert.deepEqual(ids, [caller.executionTargetId, vmTargetId].sort());
    assert.equal(selection.selectedExecutionTargetId, null);
  });

  it('persists and resolves the selected execution target for launch', async () => {
    const { ctx } = await setup();
    const project = await createProject({ ctx, name: 'Launch Target' });
    const caller = await ensureCallerDeviceTarget({ ctx });
    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: mkdtempSync(path.join(tmpdir(), 'ovld-launch-target-')),
      isPrimary: true
    });
    const vmTargetId = await seedSecondTarget(ctx, 'Remote VM');
    await insertPrimaryResource({
      ctx,
      projectId: project.id,
      executionTargetId: vmTargetId,
      resourcePath: mkdtempSync(path.join(tmpdir(), 'ovld-launch-target-vm-'))
    });

    await updateProjectExecutionTargetSelection({
      ctx,
      projectId: project.id,
      executionTargetId: vmTargetId
    });

    const selection = await getProjectExecutionTargetSelection({ ctx, projectId: project.id });
    assert.equal(selection.selectedExecutionTargetId, vmTargetId);

    const stamped = await resolveProjectExecutionTargetForLaunch({ ctx, projectId: project.id });
    assert.equal(stamped, vmTargetId);

    await updateProjectExecutionTargetSelection({
      ctx,
      projectId: project.id,
      executionTargetId: null
    });
    const fallback = await resolveProjectExecutionTargetForLaunch({ ctx, projectId: project.id });
    assert.equal(fallback, null);
    assert.notEqual(caller.executionTargetId, vmTargetId);
  });

  it('auto-selects when exactly one eligible target exists', async () => {
    const { ctx } = await setup();
    const project = await createProject({ ctx, name: 'Single Target' });
    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: mkdtempSync(path.join(tmpdir(), 'ovld-single-target-')),
      isPrimary: true
    });
    const caller = await ensureCallerDeviceTarget({ ctx });
    const stamped = await resolveProjectExecutionTargetForLaunch({ ctx, projectId: project.id });
    assert.equal(stamped, caller.executionTargetId);
  });

  it('rejects selecting a target that cannot reach a primary resource', async () => {
    const { ctx } = await setup();
    const project = await createProject({ ctx, name: 'Ineligible' });
    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: mkdtempSync(path.join(tmpdir(), 'ovld-ineligible-')),
      isPrimary: true
    });
    const orphanTargetId = await seedSecondTarget(ctx, 'Orphan');

    await assert.rejects(
      () =>
        updateProjectExecutionTargetSelection({
          ctx,
          projectId: project.id,
          executionTargetId: orphanTargetId
        }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'execution_target_not_eligible');
        return true;
      }
    );
  });

  it('stores preference under the documented preferences_json key', async () => {
    const { ctx } = await setup();
    const project = await createProject({ ctx, name: 'Pref Key' });
    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: mkdtempSync(path.join(tmpdir(), 'ovld-pref-key-')),
      isPrimary: true
    });
    const caller = await ensureCallerDeviceTarget({ ctx });
    await updateProjectExecutionTargetSelection({
      ctx,
      projectId: project.id,
      executionTargetId: caller.executionTargetId
    });
    const row = (await ctx.db.get(
      `SELECT preferences_json FROM project_user_preferences
          WHERE project_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`,
      [project.id, ctx.actorWorkspaceUserId]
    )) as { preferences_json: string };
    const prefs = JSON.parse(row.preferences_json) as Record<string, string>;
    assert.equal(prefs[PROJECT_EXECUTION_TARGET_PREFERENCE_KEY], caller.executionTargetId);
  });
});
