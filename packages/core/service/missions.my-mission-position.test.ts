import { type DatabaseClient } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMissionWithObjectives, moveMissionToReview } from './missions.js';
import { createProject } from './projects.js';
import { createSeededServiceContext } from './test-helpers.js';

async function assignMission(db: DatabaseClient, missionId: string, workspaceUserId: string) {
  await db.run(`UPDATE missions SET assigned_workspace_user_id = ? WHERE id = ?`, [
    workspaceUserId,
    missionId
  ]);
}

describe('moveMissionToReview personal (My Missions) placement', () => {
  it('gives the delivered mission a personal position ahead of missions already positioned in the column', async () => {
    const { db, ctx, workspaceUserId } = await createSeededServiceContext({ source: 'cli' });
    const project = await createProject({ ctx, name: 'Personal Ordering' });

    // A mission already sitting in review that the operator previously
    // dragged, giving it an explicit my_mission_positions row.
    const { mission: alreadyPositioned } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Already in review' }]
    });
    await assignMission(db, alreadyPositioned.id, workspaceUserId);
    await moveMissionToReview({ ctx, missionId: alreadyPositioned.id });
    await db.run(
      `UPDATE my_mission_positions SET position = ? WHERE workspace_user_id = ? AND mission_id = ?`,
      [100, workspaceUserId, alreadyPositioned.id]
    );

    // A second mission delivered afterward should land ahead of it, not just
    // in the unpositioned fallback bucket (which sorts after any explicitly
    // positioned mission regardless of board_position).
    const { mission: delivered } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Newly delivered' }]
    });
    await assignMission(db, delivered.id, workspaceUserId);

    await moveMissionToReview({ ctx, missionId: delivered.id });

    const row = (await db.get(
      `SELECT position FROM my_mission_positions WHERE workspace_user_id = ? AND mission_id = ?`,
      [workspaceUserId, delivered.id]
    )) as { position: number } | undefined;

    assert.ok(row, 'delivery should create a personal position row for the assignee');
    assert.ok(
      row.position < 100,
      'the delivered mission should get a personal position ahead of the already-positioned mission'
    );
  });

  it('does nothing for a mission with no assignee', async () => {
    const { db, ctx } = await createSeededServiceContext({ source: 'cli' });
    const project = await createProject({ ctx, name: 'Unassigned' });

    const { mission } = await createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'No assignee' }]
    });

    await moveMissionToReview({ ctx, missionId: mission.id });

    const row = await db.get(`SELECT id FROM my_mission_positions WHERE mission_id = ?`, [
      mission.id
    ]);
    assert.equal(row, undefined);
  });
});
