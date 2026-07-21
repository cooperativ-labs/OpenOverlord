import { createSqliteClient, openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { ServiceError } from './errors.js';
import { ensureCallerDeviceTarget, ensureClientDeviceTarget } from './execution-targets.js';
import { createMissionWithObjectives } from './missions.js';
import {
  deleteWorkspaceExecutionTarget,
  getProjectExecutionTargetSelection,
  listEligibleProjectExecutionTargets,
  listWorkspaceExecutionTargets,
  parseAgentConfigs,
  PROJECT_EXECUTION_TARGET_PREFERENCE_KEY,
  renameWorkspaceExecutionTarget,
  resolveLaunchExecutionTarget,
  resolveProjectExecutionTargetForLaunch,
  updateProjectExecutionTargetSelection
} from './project-execution-target.js';
import { addProjectResource, createProject } from './projects.js';
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
  const resourceId = newId();
  await ctx.db.run(
    `INSERT INTO project_resources
         (id, workspace_id, project_id, resource_key, label, is_primary, status,
          metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, 'primary', 'Primary', 1, 'active', '{}', ?, ?, 1)`,
    [resourceId, ctx.workspace.id, projectId, now, now]
  );
  await ctx.db.run(
    `INSERT INTO project_resource_sources
         (id, workspace_id, project_id, resource_id, execution_target_id, source_kind, descriptor_json,
          created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, 'local_checkout', ?, ?, ?, 1)`,
    [
      newId(),
      ctx.workspace.id,
      projectId,
      resourceId,
      executionTargetId,
      JSON.stringify({ path: resourcePath }),
      now,
      now
    ]
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
    [targetId, ctx.workspace.id, deviceId, ctx.actorWorkspaceUserId, label, now, now]
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
  it('listing eligible targets does not provision the caller device target', async () => {
    const { ctx, db } = await setup();
    const project = await createProject({ ctx, name: 'Read-only list' });
    const before = (await db.get(
      `SELECT COUNT(*) AS n FROM execution_targets WHERE workspace_id = ? AND deleted_at IS NULL`,
      [ctx.workspace.id]
    )) as { n: number };

    await listEligibleProjectExecutionTargets({ ctx, projectId: project.id });

    const after = (await db.get(
      `SELECT COUNT(*) AS n FROM execution_targets WHERE workspace_id = ? AND deleted_at IS NULL`,
      [ctx.workspace.id]
    )) as { n: number };
    assert.equal(after.n, before.n);
  });

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

  it('resolveLaunchExecutionTarget does not fall back to caller device configs when ambiguous', async () => {
    const { ctx } = await setup();
    const project = await createProject({ ctx, name: 'Ambiguous Launch' });
    const caller = await ensureCallerDeviceTarget({ ctx });
    await ctx.db.run(
      `UPDATE user_execution_target_preferences
          SET agent_configs_json = ?
        WHERE id = ?`,
      [
        JSON.stringify({ codex: { preCommand: 'caller-only', flags: ['--x'] } }),
        caller.preferenceId
      ]
    );
    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: mkdtempSync(path.join(tmpdir(), 'ovld-ambiguous-launch-')),
      isPrimary: true
    });
    const vmTargetId = await seedSecondTarget(ctx, 'Other VM');
    await insertPrimaryResource({
      ctx,
      projectId: project.id,
      executionTargetId: vmTargetId,
      resourcePath: mkdtempSync(path.join(tmpdir(), 'ovld-ambiguous-launch-vm-'))
    });

    const launch = await resolveLaunchExecutionTarget({ ctx, projectId: project.id });
    assert.equal(launch.executionTargetId, null);
    assert.deepEqual(launch.agentConfigs, {});
  });

  it('resolveLaunchExecutionTarget loads configs for the stamped target', async () => {
    const { ctx } = await setup();
    const project = await createProject({ ctx, name: 'Stamped Configs' });
    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: mkdtempSync(path.join(tmpdir(), 'ovld-stamped-configs-')),
      isPrimary: true
    });
    const caller = await ensureCallerDeviceTarget({ ctx });
    await ctx.db.run(
      `UPDATE user_execution_target_preferences
          SET agent_configs_json = ?
        WHERE id = ?`,
      [JSON.stringify({ codex: { preCommand: 'run-it', flags: [] } }), caller.preferenceId]
    );

    const launch = await resolveLaunchExecutionTarget({ ctx, projectId: project.id });
    assert.equal(launch.executionTargetId, caller.executionTargetId);
    assert.deepEqual(launch.agentConfigs.codex, { preCommand: 'run-it', flags: [] });
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

describe('execution target lifecycle', () => {
  it('refuses to provision browser clients as execution targets', async () => {
    const { ctx } = await setup();
    await assert.rejects(
      () =>
        ensureClientDeviceTarget({
          ctx,
          deviceFingerprint: 'browser-fingerprint-abc',
          deviceLabel: 'browser',
          devicePlatform: 'browser'
        }),
      (error: unknown) =>
        error instanceof ServiceError && error.code === 'browser_not_execution_target'
    );
  });

  it('excludes browser device targets from workspace listing', async () => {
    const { ctx } = await setup();
    const now = nowIso();
    const deviceId = newId();
    await ctx.db.run(
      `INSERT INTO devices
           (id, workspace_id, fingerprint, label, platform, status, last_seen_at,
            metadata_json, created_at, updated_at, revision)
         VALUES (?, ?, ?, 'browser', 'browser', 'active', ?, '{}', ?, ?, 1)`,
      [deviceId, ctx.workspace.id, 'browser-only-fp', now, now, now]
    );
    const targetId = newId();
    await ctx.db.run(
      `INSERT INTO execution_targets
           (id, workspace_id, device_id, owner_workspace_user_id, type, label, status,
            connection_json, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, 'local', 'browser', 'active', '{}', ?, ?, 1)`,
      [targetId, ctx.workspace.id, deviceId, ctx.actorWorkspaceUserId, now, now]
    );

    const listed = await listWorkspaceExecutionTargets({ ctx });
    assert.equal(
      listed.some(target => target.id === targetId),
      false
    );
  });

  it('soft-deletes a workspace execution target and clears project preferences', async () => {
    const { ctx, db } = await setup();
    const project = await createProject({ ctx, name: 'Delete target project' });
    const staleTargetId = await seedSecondTarget(ctx, 'stale-runner');
    await insertPrimaryResource({
      ctx,
      projectId: project.id,
      executionTargetId: staleTargetId,
      resourcePath: mkdtempSync(path.join(tmpdir(), 'ovld-delete-target-'))
    });
    await updateProjectExecutionTargetSelection({
      ctx,
      projectId: project.id,
      executionTargetId: staleTargetId
    });

    await deleteWorkspaceExecutionTarget({ ctx, executionTargetId: staleTargetId });

    const row = (await db.get(`SELECT deleted_at FROM execution_targets WHERE id = ?`, [
      staleTargetId
    ])) as { deleted_at: string | null };
    assert.ok(row.deleted_at);

    const sourceRow = (await db.get(
      `SELECT deleted_at FROM project_resource_sources
        WHERE execution_target_id = ? AND deleted_at IS NOT NULL`,
      [staleTargetId]
    )) as { deleted_at: string | null } | undefined;
    assert.ok(sourceRow?.deleted_at);

    const selection = await getProjectExecutionTargetSelection({ ctx, projectId: project.id });
    assert.equal(selection.selectedExecutionTargetId, null);
  });

  it('renames a workspace execution target', async () => {
    const { ctx, db } = await setup();
    const targetId = await seedSecondTarget(ctx, 'old-name');

    const updated = await renameWorkspaceExecutionTarget({
      ctx,
      executionTargetId: targetId,
      label: 'renamed-runner'
    });
    assert.equal(updated.id, targetId);
    assert.equal(updated.label, 'renamed-runner');

    const row = (await db.get(`SELECT label FROM execution_targets WHERE id = ?`, [targetId])) as {
      label: string;
    };
    assert.equal(row.label, 'renamed-runner');
  });

  it('rejects renaming with a blank label', async () => {
    const { ctx } = await setup();
    const targetId = await seedSecondTarget(ctx, 'keep-name');
    await assert.rejects(
      () => renameWorkspaceExecutionTarget({ ctx, executionTargetId: targetId, label: '   ' }),
      (error: unknown) => error instanceof ServiceError && error.code === 'validation_error'
    );
  });

  it('blocks delete when active queue rows reference the target', async () => {
    const { ctx, db } = await setup();
    const caller = await ensureCallerDeviceTarget({ ctx });
    const project = await createProject({ ctx, name: 'Queued target project' });
    const mission = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Queued work' }]
    });
    const now = nowIso();
    await db.run(
      `INSERT INTO execution_requests
         (id, workspace_id, project_id, mission_id, objective_id, execution_target_id,
          launch_mode, launch_flags_json, target_kind, requested_source, status,
          attempt_count, metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, 'run', '{}', 'local', 'manual_run', 'queued',
               0, '{}', ?, ?, 1)`,
      [
        newId(),
        ctx.workspace.id,
        project.id,
        mission.mission.id,
        mission.objectives[0]!.id,
        caller.executionTargetId,
        now,
        now
      ]
    );

    await assert.rejects(
      () => deleteWorkspaceExecutionTarget({ ctx, executionTargetId: caller.executionTargetId }),
      (error: unknown) =>
        error instanceof ServiceError && error.code === 'execution_target_has_active_queue'
    );
  });

  it('parseAgentConfigs normalizes legacy string flags into name/value pairs', () => {
    assert.deepEqual(
      parseAgentConfigs(
        JSON.stringify({
          claude: {
            preCommand: 'nvm use 20',
            flags: ['--verbose', '--permission-mode auto']
          }
        })
      ),
      {
        claude: {
          preCommand: 'nvm use 20',
          flags: [{ name: '--verbose' }, { name: '--permission-mode', value: 'auto' }]
        }
      }
    );
  });
});
