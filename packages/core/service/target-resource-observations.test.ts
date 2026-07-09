import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { mapObservationToResourceStatus } from './local-target/resource-status.ts';
import { ensureCallerDeviceTarget } from './execution-targets.ts';
import { createProject } from './projects.ts';
import {
  loadTargetResourceObservations,
  mergeResourceStatusWithObservation,
  recordTargetResourceObservations
} from './target-resource-observations.ts';
import { createSeededServiceContext } from './test-helpers.ts';
import { nowIso } from './util.ts';

describe('target resource observations', () => {
  it('maps observation states onto resource status vocabulary', () => {
    assert.equal(mapObservationToResourceStatus('active', { state: 'available' }), 'active');
    assert.equal(mapObservationToResourceStatus('active', { state: 'missing' }), 'missing');
    assert.equal(mapObservationToResourceStatus('active', null), 'active');
    assert.equal(mapObservationToResourceStatus('archived', { state: 'missing' }), 'archived');
  });

  it('records observations and merges them into resource list status', async () => {
    const { db, ctx } = await createSeededServiceContext({ source: 'cli' });
    const project = await createProject({ ctx, name: 'Observation project' });
    const target = await ensureCallerDeviceTarget({ ctx });
    const resourceDir = mkdtempSync(path.join(tmpdir(), 'ovld-resource-obs-'));
    const now = nowIso();
    const resourceId = 'resource-obs-test';

    await db.run(
      `INSERT INTO project_resources
         (id, workspace_id, project_id, execution_target_id, resource_key, type, label, path,
          is_primary, status, metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'primary', 'local_directory', NULL, ?, 1, 'active', '{}', ?, ?, 1)`,
      [resourceId, ctx.workspace.id, project.id, target.executionTargetId, resourceDir, now, now]
    );

    const missingId = 'resource-obs-missing';
    await db.run(
      `INSERT INTO project_resources
         (id, workspace_id, project_id, execution_target_id, resource_key, type, label, path,
          is_primary, status, metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'missing', 'local_directory', NULL, ?, 0, 'active', '{}', ?, ?, 1)`,
      [
        missingId,
        ctx.workspace.id,
        project.id,
        target.executionTargetId,
        path.join(tmpdir(), 'missing-resource-obs'),
        now,
        now
      ]
    );

    const observedAt = new Date().toISOString();
    const result = await recordTargetResourceObservations({
      ctx,
      executionTargetId: target.executionTargetId,
      observations: [
        {
          resourceId,
          state: existsSync(resourceDir) ? 'available' : 'missing',
          observedAt
        },
        {
          resourceId: missingId,
          state: 'missing',
          observedAt
        }
      ]
    });
    assert.equal(result.recorded, 2);

    const loaded = await loadTargetResourceObservations({
      ctx,
      resourceIds: [resourceId, missingId]
    });
    const available = mergeResourceStatusWithObservation({
      lifecycleStatus: 'active',
      resourceExecutionTargetId: target.executionTargetId,
      observation: loaded.get(resourceId)
    });
    assert.equal(available.status, 'active');
    assert.equal(available.observedAt, observedAt);

    const missing = mergeResourceStatusWithObservation({
      lifecycleStatus: 'active',
      resourceExecutionTargetId: target.executionTargetId,
      observation: loaded.get(missingId)
    });
    assert.equal(missing.status, 'missing');

    await db.close();
  });
});
