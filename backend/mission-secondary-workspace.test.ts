import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// coo:135 follow-up: a mission/objective belonging to a workspace OTHER than the
// caller's currently-active workspace must still load and be editable. The
// backend previously scoped mission/objective reads and writes to
// `getActiveWorkspaceId()` instead of the resource's own `workspace_id`, so
// opening a mission in a secondary workspace 404'd with "Mission not found"
// even for a caller who is a full member of that workspace.
describe('mission and objective access in a secondary (non-active) workspace', () => {
  it('loads, reads, and mutates a mission/objectives whose workspace differs from the active one', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-secondary-workspace-'));
    const { bootstrapIntegrationTestDb, DEFAULT_TEST_ORGANIZATION_ID } =
      await import('./test-helpers.ts');
    const { WORKSPACE } = await bootstrapIntegrationTestDb({
      sqlitePath: path.join(dir, 'Overlord.sqlite')
    });
    // `WORKSPACE` is a live getter over the *current* active workspace (see
    // `backend/db.ts`), not a snapshot — capture its id as a plain string now,
    // since `createWorkspace` below will change what it points to.
    const workspaceAId = WORKSPACE.id;

    const { setActiveWorkspace } = await import('./db.ts');
    const { createWorkspace } = await import('./workspaces.ts');
    const {
      createProject,
      createMission,
      getMissionDetail,
      listObjectives,
      listMissionEvents,
      listMissionFileChanges,
      listArtifacts,
      createObjective,
      updateObjective,
      deleteObjective,
      updateMission,
      reorderFutureObjectives,
      getMissionSchedule,
      upsertMissionSchedule,
      clearMissionSchedule,
      reorderBoardColumn,
      deleteMission,
      updateProject,
      deleteProject,
      reorderProjects,
      listProjectsForWorkspace
    } = await import('./repository.ts');

    // A second workspace in the same org. The operator (an org admin, being
    // ADMIN of the only pre-existing workspace) is auto-granted ADMIN here too.
    // `createWorkspace` itself activates the workspace it just created ("New
    // workspaces become the active one, mirroring the team switcher"), so
    // explicitly switch back to workspace A afterward — every call below then
    // runs with A active while the mission/objectives being read/written live
    // in the *secondary*, non-active workspace B, matching the reported bug.
    const secondary = await createWorkspace({
      organizationId: DEFAULT_TEST_ORGANIZATION_ID,
      name: 'Secondary Workspace'
    });
    assert.notEqual(secondary.id, workspaceAId);
    await setActiveWorkspace(workspaceAId);

    const project = await createProject({ name: 'Secondary Project', workspaceId: secondary.id });
    assert.equal(project.workspaceId, secondary.id);

    const mission = await createMission({
      projectId: project.id,
      firstObjective: 'Ship the secondary-workspace fix'
    });
    // Mission creation must stamp the *project's* workspace, not the active one.
    assert.equal(mission.workspaceId, secondary.id);
    assert.match(mission.displayId, new RegExp(`^${secondary.slug}:`));

    // --- Reads: none of these should 404 while workspace A is active. ---
    const detail = await getMissionDetail(mission.id);
    assert.equal(detail.id, mission.id);
    assert.equal(detail.objectives.length, 1);
    assert.ok(detail.statuses.length > 0);
    assert.ok(
      detail.statuses.every(status => status.workspaceId === secondary.id),
      "the status dropdown must reflect the mission's own (secondary) workspace, not the active one"
    );

    await assert.doesNotReject(listObjectives(mission.id));
    await assert.doesNotReject(listMissionEvents(mission.id));
    await assert.doesNotReject(listMissionFileChanges(mission.id));
    await assert.doesNotReject(listArtifacts(mission.id));

    // --- Writes: creating/updating/deleting objectives and the mission itself. ---
    const objective = await createObjective({
      missionId: mission.id,
      instructionText: 'A second objective in the secondary workspace'
    });
    assert.equal(objective.missionId, mission.id);

    const updatedObjective = await updateObjective(objective.id, { title: 'Renamed objective' });
    assert.equal(updatedObjective.title, 'Renamed objective');

    const reordered = await reorderFutureObjectives(mission.id, {
      orderedObjectiveIds: detail.objectives.filter(o => o.state === 'future').map(o => o.id)
    });
    assert.ok(Array.isArray(reordered));

    await deleteObjective(objective.id);

    const updatedMission = await updateMission(mission.id, { title: 'Renamed mission' });
    assert.equal(updatedMission.title, 'Renamed mission');

    const schedule = await getMissionSchedule(mission.id);
    assert.equal(schedule.schedule, null);
    await upsertMissionSchedule(mission.id, {
      periodType: 'd',
      periodInterval: 1,
      timezone: 'UTC',
      daysOfWeek: [{ dayNum: 1, times: ['09:00:00'] }]
    });
    await clearMissionSchedule(mission.id);

    const reorderedBoard = await reorderBoardColumn(project.id, {
      statusId: updatedMission.statusId,
      orderedMissionIds: [mission.id]
    });
    assert.equal(reorderedBoard.length, 1);
    assert.equal(reorderedBoard[0]!.id, mission.id);

    await deleteMission(mission.id);
    await assert.rejects(getMissionDetail(mission.id), /Mission not found/);
  });

  it('updates, reorders, and deletes projects in a secondary workspace while another is active', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-secondary-workspace-projects-'));
    const { bootstrapIntegrationTestDb, DEFAULT_TEST_ORGANIZATION_ID } =
      await import('./test-helpers.ts');
    const { WORKSPACE } = await bootstrapIntegrationTestDb({
      sqlitePath: path.join(dir, 'Overlord.sqlite')
    });
    const workspaceAId = WORKSPACE.id;

    const { setActiveWorkspace } = await import('./db.ts');
    const { createWorkspace } = await import('./workspaces.ts');
    const {
      createProject,
      updateProject,
      reorderProjects,
      deleteProject,
      listProjectsForWorkspace
    } = await import('./repository.ts');

    const secondary = await createWorkspace({
      organizationId: DEFAULT_TEST_ORGANIZATION_ID,
      name: 'Secondary For Projects'
    });
    await setActiveWorkspace(workspaceAId);

    const first = await createProject({ name: 'Secondary One', workspaceId: secondary.id });
    const second = await createProject({ name: 'Secondary Two', workspaceId: secondary.id });
    assert.equal(first.workspaceId, secondary.id);
    assert.equal(second.workspaceId, secondary.id);

    const renamed = await updateProject(first.id, { name: 'Renamed Secondary One' });
    assert.equal(renamed.name, 'Renamed Secondary One');

    const reordered = await reorderProjects({ orderedProjectIds: [second.id, first.id] });
    assert.deepEqual(
      reordered.map(project => project.id),
      [second.id, first.id]
    );

    const listed = await listProjectsForWorkspace(secondary.id);
    assert.deepEqual(
      listed.map(project => ({ id: project.id, position: project.position })),
      [
        { id: second.id, position: 1 },
        { id: first.id, position: 2 }
      ]
    );

    await deleteProject(first.id);
    const remaining = await listProjectsForWorkspace(secondary.id);
    assert.deepEqual(
      remaining.map(project => project.id),
      [second.id]
    );
  });
});
