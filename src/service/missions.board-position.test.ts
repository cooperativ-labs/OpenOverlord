import { openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext } from './context.js';
import { createProject } from './projects.js';
import { createMissionWithObjectives, moveMissionToReview } from './missions.js';

function setup() {
  const db = openInMemoryDatabase();
  const ctx = createServiceContext({ db, source: 'cli' });
  return { db, ctx };
}

function boardPosition(db: ReturnType<typeof openInMemoryDatabase>, missionId: string): number {
  const row = db.prepare(`SELECT board_position FROM missions WHERE id = ?`).get(missionId) as {
    board_position: number;
  };
  return row.board_position;
}

describe('moveMissionToReview board placement', () => {
  it('places the mission above any missions already in the review column', () => {
    const { db, ctx } = setup();
    const project = createProject({ ctx, name: 'Review Ordering' });

    const { mission: firstMission } = createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'First into review' }]
    });
    const { mission: secondMission } = createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Second into review' }]
    });

    moveMissionToReview({ ctx, missionId: firstMission.id });
    const firstPosition = boardPosition(db, firstMission.id);

    moveMissionToReview({ ctx, missionId: secondMission.id });
    const secondPosition = boardPosition(db, secondMission.id);

    assert.ok(
      secondPosition < firstPosition,
      'a mission auto-advanced to review later should sort above one already in the column'
    );
  });
});
