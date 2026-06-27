import { createSqliteClient, type DatabaseClient, openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { createMissionWithObjectives, moveMissionToReview } from './missions.js';
import { createProject } from './projects.js';

async function setup() {
  const db = createSqliteClient(openInMemoryDatabase());
  const ctx = await createServiceContext({ db, source: 'cli' });
  return { db, ctx };
}

async function boardPosition(db: DatabaseClient, missionId: string): Promise<number> {
  const row = (await db.get(`SELECT board_position FROM missions WHERE id = ?`, [missionId])) as {
    board_position: number;
  };
  return row.board_position;
}

describe('moveMissionToReview board placement', () => {
  it('places the mission above any missions already in the review column', async () => {
    const { db, ctx } = await setup();
    const project = await createProject({ ctx, name: 'Review Ordering' });

    const { mission: firstMission } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'First into review' }]
    });
    const { mission: secondMission } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Second into review' }]
    });

    await moveMissionToReview({ ctx, missionId: firstMission.id });
    const firstPosition = await boardPosition(db, firstMission.id);

    await moveMissionToReview({ ctx, missionId: secondMission.id });
    const secondPosition = await boardPosition(db, secondMission.id);

    assert.ok(
      secondPosition < firstPosition,
      'a mission auto-advanced to review later should sort above one already in the column'
    );
  });
});
