import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('mission reference resolution', () => {
  it('resolves missions by UUID or display_id for detail and child reads', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-mission-ref-'));
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });

    const { WORKSPACE, db, newId, nowIso, setActiveWorkspaceUser } = await import('./db.ts');
    const { seedAuthenticatedOperator } = await import('./test-helpers.ts');
    const workspaceUserId = seedAuthenticatedOperator({ db, workspaceId: WORKSPACE.id });
    setActiveWorkspaceUser(workspaceUserId);
    const {
      createProject,
      createMission,
      getMissionDetail,
      listMissionDeliveries,
      listMissionEvents
    } = await import('./repository.ts');

    const project = await createProject({ name: 'Mission Ref Test' });
    const created = await createMission({
      projectId: project.id,
      firstObjective: 'Resolve by display id'
    });

    assert.equal((await getMissionDetail(created.id)).id, created.id);
    assert.equal((await getMissionDetail(created.displayId)).id, created.id);
    assert.equal((await getMissionDetail(created.displayId)).displayId, created.displayId);
    await assert.doesNotReject(listMissionEvents(created.displayId));

    const actor = db
      .prepare(`SELECT profile_id FROM workspace_users WHERE id = ?`)
      .get(workspaceUserId) as { profile_id: string };
    db.prepare(
      `UPDATE profiles SET display_name = ?, handle = ?, metadata_json = ? WHERE id = ?`
    ).run(
      'Jane Operator',
      'jane',
      JSON.stringify({ avatarUrl: '/avatars/jane.png' }),
      actor.profile_id
    );
    db.prepare(
      `INSERT INTO mission_events
         (id, workspace_id, project_id, mission_id, objective_id, session_id,
          type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'user_follow_up', 'review', ?, '{}', 'hook', ?, ?)`
    ).run(
      newId(),
      WORKSPACE.id,
      project.id,
      created.id,
      created.objectives[0]?.id ?? null,
      'Please publish this prompt.',
      workspaceUserId,
      nowIso()
    );

    const followUp = (await listMissionEvents(created.displayId)).find(
      event => event.summary === 'Please publish this prompt.'
    );
    assert.equal(followUp?.actorWorkspaceUserId, workspaceUserId);
    assert.equal(followUp?.actor?.displayName, 'Jane Operator');
    assert.equal(followUp?.actor?.handle, 'jane');
    assert.equal(followUp?.actor?.avatarUrl, '/avatars/jane.png');

    const deliveryId = newId();
    const deliveredAt = nowIso();
    db.prepare(
      `INSERT INTO deliveries
         (id, workspace_id, project_id, mission_id, objective_id, session_id,
          summary, payload_json, verification_summary, follow_up_notes,
          delivered_at, delivered_by_workspace_user_id, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, NULL, ?, '{}', NULL, NULL, ?, ?, ?, ?, 1)`
    ).run(
      deliveryId,
      WORKSPACE.id,
      project.id,
      created.id,
      created.objectives[0]?.id,
      'Legacy delivery summary',
      deliveredAt,
      workspaceUserId,
      deliveredAt,
      deliveredAt
    );
    db.prepare(
      `INSERT INTO mission_events
         (id, workspace_id, project_id, mission_id, objective_id, session_id,
          type, phase, summary, payload_json, source, actor_workspace_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'delivery', 'deliver', ?, ?, 'agent', ?, ?)`
    ).run(
      newId(),
      WORKSPACE.id,
      project.id,
      created.id,
      created.objectives[0]?.id,
      'Legacy delivery summary',
      JSON.stringify({ deliveryId }),
      workspaceUserId,
      deliveredAt
    );

    const deliveries = await listMissionDeliveries(created.displayId);
    assert.equal(deliveries[0]?.id, deliveryId);
    assert.equal(deliveries[0]?.report.presentation.markdown, 'Legacy delivery summary');
    assert.deepEqual(deliveries[0]?.report.presentation.humanActions, []);
    const deliveryEvent = (await listMissionEvents(created.displayId)).find(
      event => event.deliveryId === deliveryId
    );
    assert.equal(deliveryEvent?.deliveryId, deliveryId);
  });

  it('assigns new missions to the creator by default, unless explicitly unassigned', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-mission-assignee-'));
    const { bootstrapIntegrationTestDb } = await import('./test-helpers.ts');
    await bootstrapIntegrationTestDb({ sqlitePath: path.join(dir, 'Overlord.sqlite') });

    const { createProject, createMission } = await import('./repository.ts');
    const { ACTOR_WORKSPACE_USER_ID } = await import('./db.ts');

    const project = await createProject({ name: 'Mission Assignee Test' });
    const created = await createMission({
      projectId: project.id,
      firstObjective: 'Default assignee to creator'
    });
    assert.equal(created.assignedWorkspaceUserId, ACTOR_WORKSPACE_USER_ID);

    const explicitlyUnassigned = await createMission({
      projectId: project.id,
      firstObjective: 'Allow explicit unassign on create',
      assignedWorkspaceUserId: null
    });
    assert.equal(explicitlyUnassigned.assignedWorkspaceUserId, null);
  });
});
