import { createSqliteClient, type DatabaseClient, openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceContext, type ServiceContext } from './context.js';
import { createMissionWithObjectives, moveMissionToReview } from './missions.js';
import { createProject } from './projects.js';
import { newId, nowIso } from './util.js';

// packages/core/service tests don't get a seeded workspace (the org migration
// dropped the old implicit local-workspace seed), so this test seeds the
// minimal chain of rows itself: user -> profile -> workspace -> workspace_user
// -> workspace_statuses.
async function setup(): Promise<{
  db: DatabaseClient;
  ctx: ServiceContext;
  workspaceUserId: string;
}> {
  const db = createSqliteClient(openInMemoryDatabase());
  const now = nowIso();

  // trg_better_auth_user_create_profile auto-inserts the matching profiles row.
  const userId = newId();
  await db.run(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES (?, ?, ?, 0, ?, ?)`,
    [userId, 'Test User', `${userId}@example.com`, now, now]
  );

  const organizationId = newId();
  await db.run(`INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`, [
    organizationId,
    'Test Org',
    now,
    now
  ]);

  const workspaceId = newId();
  await db.run(
    `INSERT INTO workspaces (id, organization_id, slug, name, kind, created_at, updated_at)
       VALUES (?, ?, 'test-ws', 'Test Workspace', 'local', ?, ?)`,
    [workspaceId, organizationId, now, now]
  );

  await db.run(
    `INSERT INTO mission_sequences (id, workspace_id, scope_type, scope_id, counter_name, next_value, updated_at)
       VALUES (?, ?, 'workspace', ?, 'mission', 1, ?)`,
    [newId(), workspaceId, workspaceId, now]
  );

  const workspaceUserId = newId();
  await db.run(
    `INSERT INTO workspace_users (id, workspace_id, profile_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    [workspaceUserId, workspaceId, userId, now, now]
  );

  const statuses: Array<{ type: string; isDefault: boolean }> = [
    { type: 'draft', isDefault: true },
    { type: 'execute', isDefault: false },
    { type: 'review', isDefault: false }
  ];
  for (const [index, status] of statuses.entries()) {
    await db.run(
      `INSERT INTO workspace_statuses
         (id, workspace_id, key, name, type, position, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        workspaceId,
        status.type,
        status.type,
        status.type,
        index,
        status.isDefault ? 1 : 0,
        now,
        now
      ]
    );
  }

  const ctx = await createServiceContext({ db, source: 'cli' });
  return { db, ctx, workspaceUserId };
}

async function assignMission(db: DatabaseClient, missionId: string, workspaceUserId: string) {
  await db.run(`UPDATE missions SET assigned_workspace_user_id = ? WHERE id = ?`, [
    workspaceUserId,
    missionId
  ]);
}

describe('moveMissionToReview personal (My Missions) placement', () => {
  it('gives the delivered mission a personal position ahead of missions already positioned in the column', async () => {
    const { db, ctx, workspaceUserId } = await setup();
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
    const { db, ctx } = await setup();
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
