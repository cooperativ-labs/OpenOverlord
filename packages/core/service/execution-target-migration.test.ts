import { createSqliteClient, openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.ts';
import { backendHostFingerprint, ensureCallerDeviceTarget } from './execution-targets.ts';
import {
  isStaleBackendHostDeviceFingerprint,
  loadExecutionTargetMigrationDiagnostics
} from './execution-target-migration.ts';
import { createMissionWithObjectives } from './missions.ts';
import { createProject } from './projects.ts';
import { nowIso } from './util.ts';

describe('execution target migration diagnostics', () => {
  it('treats the backend host fingerprint as stale on hosted backends only', () => {
    assert.equal(isStaleBackendHostDeviceFingerprint(backendHostFingerprint()), true);
    assert.equal(isStaleBackendHostDeviceFingerprint('not-the-backend-host'), false);
  });

  it('returns no stale targets on co-located sqlite backends', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'cli' });
    await ensureCallerDeviceTarget({ ctx });

    const diagnostics = await loadExecutionTargetMigrationDiagnostics({ ctx });
    assert.equal(diagnostics.hostedBackend, false);
    assert.equal(diagnostics.staleBackendHostTargets.length, 0);
    assert.equal(diagnostics.staleQueuedExecutionRequestCount, 0);
  });

  it('detects backend-host execution targets and queued requests on hosted backends', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'webapp' });
    const target = await ensureCallerDeviceTarget({ ctx });
    const project = await createProject({ ctx, name: 'Migration project' });
    const mission = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Test migration diagnostics' }]
    });
    const now = nowIso();

    Object.defineProperty(db, 'dialect', { value: 'postgres' as const });

    await db.run(
      `UPDATE devices SET fingerprint = ? WHERE id = (
      SELECT device_id FROM execution_targets WHERE id = ?
    )`,
      [backendHostFingerprint(), target.executionTargetId]
    );

    const requestId = randomUUID();
    await db.run(
      `INSERT INTO execution_requests
         (id, workspace_id, project_id, mission_id, objective_id, execution_target_id,
          launch_mode, launch_flags_json, target_kind, requested_source, status,
          attempt_count, metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, 'run', '{}', 'local', 'manual_run', 'queued',
               0, '{}', ?, ?, 1)`,
      [
        requestId,
        ctx.workspace.id,
        project.id,
        mission.mission.id,
        mission.objectives[0]!.id,
        target.executionTargetId,
        now,
        now
      ]
    );

    const diagnostics = await loadExecutionTargetMigrationDiagnostics({ ctx });
    assert.equal(diagnostics.hostedBackend, true);
    assert.equal(diagnostics.staleBackendHostTargets.length, 1);
    assert.equal(
      diagnostics.staleBackendHostTargets[0]!.executionTargetId,
      target.executionTargetId
    );
    assert.equal(diagnostics.staleQueuedExecutionRequestCount, 1);
  });
});
