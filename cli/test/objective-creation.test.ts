import {
  addObjectivesToMission,
  createMissionWithObjectives
} from '@overlord/core/service/missions';
import { createProject } from '@overlord/core/service/projects';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSeededCliContext } from './support/seeded-context.ts';

test('mission creation creates one draft objective and future objectives for the rest', async () => {
  const { db, ctx } = await createSeededCliContext();
  const project = await createProject({ ctx, name: 'Objective Creation Test' });

  const { objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [
      { objective: 'First objective' },
      { objective: 'Second objective' },
      { objective: 'Third objective' }
    ]
  });

  assert.deepEqual(
    objectives.map(objective => objective.state),
    ['draft', 'future', 'future']
  );

  await db.close();
});

test('adding objectives to a mission with a draft creates future objectives', async () => {
  const { db, ctx } = await createSeededCliContext();
  const project = await createProject({ ctx, name: 'Add Objectives Test' });
  const { mission } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Existing draft' }]
  });

  const added = await addObjectivesToMission({
    ctx,
    missionId: mission.id,
    objectives: [{ objective: 'Additional objective' }, { objective: 'Another objective' }]
  });

  assert.deepEqual(
    added.map(objective => objective.state),
    ['future', 'future']
  );

  await db.close();
});

test('adding objectives to a mission without a draft creates exactly one draft', async () => {
  const { db, ctx } = await createSeededCliContext();
  const project = await createProject({ ctx, name: 'Refill Draft Test' });
  const { mission, objectives } = await createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Existing objective' }]
  });
  await ctx.db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);

  const added = await addObjectivesToMission({
    ctx,
    missionId: mission.id,
    objectives: [{ objective: 'New next-up' }, { objective: 'Future follow-up' }]
  });

  assert.deepEqual(
    added.map(objective => objective.state),
    ['draft', 'future']
  );

  await db.close();
});
