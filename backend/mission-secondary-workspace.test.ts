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

    // Branch metadata must resolve against the mission's own workspace too:
    // the project slug feeds the predicted worktree path and the
    // project-configured default branch feeds baseBranch. Both formerly
    // queried `projects` scoped to the *active* workspace, silently falling
    // back to 'project'/'main' for a secondary-workspace mission.
    await updateProject(project.id, { defaultBranch: 'develop' });
    const detailWithBranch = await getMissionDetail(mission.id);
    assert.ok(detailWithBranch.branch?.worktreePath, 'mission detail must predict a worktree path');
    assert.ok(
      detailWithBranch.branch.worktreePath.includes('secondary-project'),
      `worktree path must use the secondary project's slug, got ${detailWithBranch.branch.worktreePath}`
    );
    assert.equal(detailWithBranch.branch.baseBranch, 'develop');

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

// coo:135 objective 12: the runner claims/drives executions across every
// workspace the caller belongs to in the active org (the My Missions
// precedent), not just the active one. Before this, a desktop runner never saw
// executions queued in a secondary workspace, and branch-prepared / status
// transitions 404'd because they scoped to the active workspace.
describe('runner claims and drives executions in a secondary (non-active) workspace', () => {
  it('claims a secondary-workspace execution, transitions it, and records its prepared branch', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-secondary-runner-'));
    const { bootstrapIntegrationTestDb, DEFAULT_TEST_ORGANIZATION_ID } =
      await import('./test-helpers.ts');
    const { WORKSPACE } = await bootstrapIntegrationTestDb({
      sqlitePath: path.join(dir, 'Overlord.sqlite')
    });
    const workspaceAId = WORKSPACE.id;

    const { setActiveWorkspace } = await import('./db.ts');
    const { createWorkspace } = await import('./workspaces.ts');
    const { createProject, createProjectResource, createMission, getMissionDetail } =
      await import('./repository.ts');
    const { launchObjective } = await import('./launch.ts');
    const { claimRunnerRequest, updateRunnerRequestStatus, runnerStatus, recordBranchPrepared } =
      await import('./runner.ts');

    const secondary = await createWorkspace({
      organizationId: DEFAULT_TEST_ORGANIZATION_ID,
      name: 'Secondary Runner Workspace'
    });
    // Back to A: everything below runs with A active while the queued execution
    // lives in the secondary workspace B — exactly the reported runner bug.
    await setActiveWorkspace(workspaceAId);

    const project = await createProject({
      name: 'Secondary Runner Project',
      workspaceId: secondary.id
    });
    // A primary resource gives the launch a real working directory to resolve;
    // the runner claim re-checks it exists (sqlite dialect), so it must be real.
    await createProjectResource(project.id, {
      directoryPath: mkdtempSync(path.join('/tmp', 'ovld-secondary-runner-resource-')),
      executionTargetId: null,
      isPrimary: true
    });
    const mission = await createMission({
      projectId: project.id,
      firstObjective: 'Run in the secondary workspace'
    });
    assert.equal(mission.workspaceId, secondary.id);
    const objectiveId = mission.objectives[0]!.id;

    // Queue an execution in B (launchObjective resolves the objective's own
    // workspace), then confirm the runner — polling with A active — sees it.
    const queued = await launchObjective(objectiveId, { agent: 'codex' });
    assert.equal(queued.status, 'queued');

    const statusBeforeClaim = await runnerStatus();
    assert.ok(
      (statusBeforeClaim.queue as Array<{ id: string; workspaceId: string }>).some(
        request => request.id === queued.id && request.workspaceId === secondary.id
      ),
      'runner status must include the secondary-workspace queued execution'
    );

    // Claim it while A is active — the fix claims across org memberships.
    const claimed = await claimRunnerRequest();
    assert.ok(claimed.request, 'runner must claim the secondary-workspace execution');
    assert.equal((claimed.request as { id: string }).id, queued.id);
    assert.equal((claimed.request as { workspaceId: string }).workspaceId, secondary.id);
    assert.equal((claimed.request as { status: string }).status, 'claimed');

    // Drive the claimed request through its launch transitions.
    const launching = await updateRunnerRequestStatus({
      requestId: queued.id,
      status: 'launching'
    });
    assert.equal((launching as { status: string }).status, 'launching');
    const launched = await updateRunnerRequestStatus({ requestId: queued.id, status: 'launched' });
    assert.equal((launched as { status: string }).status, 'launched');

    // Record a prepared branch for the secondary-workspace mission by display_id
    // (unique per workspace) — this formerly 404'd against the active workspace.
    await recordBranchPrepared({
      missionId: mission.displayId,
      requestId: queued.id,
      payload: {
        branchName: 'overlord/run-in-the-secondary-workspace-1',
        baseBranch: 'main',
        worktreePath: '/tmp/.ovld/worktrees/secondary/overlord-run-1',
        action: 'create',
        cycle: 1
      }
    });
    const branch = (await getMissionDetail(mission.id)).branch;
    assert.equal(branch?.name, 'overlord/run-in-the-secondary-workspace-1');
  });

  it('manages a secondary workspace’s card statuses while another is active', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-secondary-statuses-'));
    const { bootstrapIntegrationTestDb, DEFAULT_TEST_ORGANIZATION_ID } =
      await import('./test-helpers.ts');
    const { WORKSPACE } = await bootstrapIntegrationTestDb({
      sqlitePath: path.join(dir, 'Overlord.sqlite')
    });
    const workspaceAId = WORKSPACE.id;

    const { setActiveWorkspace } = await import('./db.ts');
    const { createWorkspace } = await import('./workspaces.ts');
    const { createWorkspaceStatus, listWorkspaceStatusesForWorkspace } =
      await import('./repository.ts');

    const secondary = await createWorkspace({
      organizationId: DEFAULT_TEST_ORGANIZATION_ID,
      name: 'Secondary Statuses Workspace'
    });
    await setActiveWorkspace(workspaceAId);

    const before = await listWorkspaceStatusesForWorkspace(secondary.id);
    const aBefore = await listWorkspaceStatusesForWorkspace(workspaceAId);

    // Create a status in the secondary workspace while A is active — the
    // workspace-scoped route stamps B, not the active workspace.
    const created = await createWorkspaceStatus(
      { name: 'Awaiting QA Signoff', type: 'draft' },
      secondary.id
    );
    assert.equal(created.workspaceId, secondary.id);

    const after = await listWorkspaceStatusesForWorkspace(secondary.id);
    assert.equal(after.length, before.length + 1);
    assert.ok(
      after.some(status => status.id === created.id && status.name === 'Awaiting QA Signoff')
    );

    // The active workspace's statuses must be untouched.
    const aAfter = await listWorkspaceStatusesForWorkspace(workspaceAId);
    assert.equal(aAfter.length, aBefore.length);
    assert.ok(!aAfter.some(status => status.name === 'Awaiting QA Signoff'));
  });
});
