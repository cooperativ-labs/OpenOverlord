import { migrateDatabase } from '@overlord/database';
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createServiceContext } from '@overlord/core/service/context';
import {
  addObjectivesToMission,
  createMissionWithObjectives
} from '@overlord/core/service/missions';
import { createProject } from '@overlord/core/service/projects';

function createContext() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  return { db, ctx: createServiceContext({ db, source: 'cli' }) };
}

test('mission creation creates one draft objective and future objectives for the rest', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Objective Creation Test' });

  const { objectives } = createMissionWithObjectives({
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

  db.close();
});

test('adding objectives to a mission with a draft creates future objectives', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Add Objectives Test' });
  const { mission } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Existing draft' }]
  });

  const added = addObjectivesToMission({
    ctx,
    missionId: mission.id,
    objectives: [{ objective: 'Additional objective' }, { objective: 'Another objective' }]
  });

  assert.deepEqual(
    added.map(objective => objective.state),
    ['future', 'future']
  );

  db.close();
});

test('adding objectives to a mission without a draft creates exactly one draft', () => {
  const { db, ctx } = createContext();
  const project = createProject({ ctx, name: 'Refill Draft Test' });
  const { mission, objectives } = createMissionWithObjectives({
    ctx,
    projectId: project.id,
    objectives: [{ objective: 'Existing objective' }]
  });
  ctx.db.prepare(`UPDATE objectives SET state = 'submitted' WHERE id = ?`).run(objectives[0]?.id);

  const added = addObjectivesToMission({
    ctx,
    missionId: mission.id,
    objectives: [{ objective: 'New next-up' }, { objective: 'Future follow-up' }]
  });

  assert.deepEqual(
    added.map(objective => objective.state),
    ['draft', 'future']
  );

  db.close();
});
