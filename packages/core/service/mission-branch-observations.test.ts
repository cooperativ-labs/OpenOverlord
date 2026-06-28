import { createSqliteClient, openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.ts';
import { ensureCallerDeviceTarget } from './execution-targets.ts';
import {
  loadMissionBranchObservationsForMissions,
  mergeMissionBranchObservation,
  recordMissionBranchObservations
} from './mission-branch-observations.ts';
import { createMissionWithObjectives } from './missions.ts';
import { createProject } from './projects.ts';
import { seedServiceOperator } from './test-helpers.ts';

describe('mission branch observations', () => {
  it('records branch observations and merges them into branch DTO state', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    await seedServiceOperator({ db });
    const ctx = await createServiceContext({ db, source: 'cli' });
    const project = await createProject({ ctx, name: 'Branch Observation project' });
    const target = await ensureCallerDeviceTarget({ ctx });
    const { mission } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Observe prepared branch' }]
    });
    const observedAt = new Date().toISOString();

    const result = await recordMissionBranchObservations({
      ctx,
      executionTargetId: target.executionTargetId,
      observations: [
        {
          missionId: mission.id,
          status: 'published',
          dirty: true,
          worktreePath: '/tmp/ovld/worktrees/demo/feature',
          observedAt
        }
      ]
    });
    assert.equal(result.recorded, 1);

    const loaded = await loadMissionBranchObservationsForMissions({
      ctx,
      executionTargetId: target.executionTargetId,
      missionIds: [mission.id]
    });
    const merged = mergeMissionBranchObservation({
      controlPlaneBranch: {
        status: 'created',
        dirty: false,
        worktreePath: '/tmp/fallback'
      },
      observation: loaded.get(mission.id)
    });

    assert.equal(merged.status, 'published');
    assert.equal(merged.dirty, true);
    assert.equal(merged.worktreePath, '/tmp/ovld/worktrees/demo/feature');
    assert.equal(merged.observedAt, observedAt);
    assert.equal(merged.observationSource, 'client');

    await db.close();
  });
});
