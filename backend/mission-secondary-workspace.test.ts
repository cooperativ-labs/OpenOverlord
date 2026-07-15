import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  assertScopedToResourceWorkspace,
  setupSecondaryWorkspaceFixture
} from './secondary-workspace-fixture.ts';

// coo:135 follow-up: a mission/objective belonging to a workspace OTHER than the
// caller's currently-active workspace must still load and be editable. The
// backend previously scoped mission/objective reads and writes to
// `getActiveWorkspaceId()` instead of the resource's own `workspace_id`, so
// opening a mission in a secondary workspace 404'd with "Mission not found"
// even for a caller who is a full member of that workspace.
describe('mission and objective access in a secondary (non-active) workspace', () => {
  it('routes protocol lifecycle updates by the hashed session key in a secondary workspace', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-secondary-protocol-session-'));
    const { bootstrapIntegrationTestDb, DEFAULT_TEST_ORGANIZATION_ID } =
      await import('./test-helpers.ts');
    const { WORKSPACE } = await bootstrapIntegrationTestDb({
      sqlitePath: path.join(dir, 'Overlord.sqlite')
    });
    const workspaceAId = WORKSPACE.id;

    const { setActiveWorkspace } = await import('./db.ts');
    const { createWorkspace } = await import('./workspaces.ts');
    const { createProject, createMission } = await import('./repository.ts');
    const { runProtocolSubcommand } = await import('./protocol.ts');

    const secondary = await createWorkspace({
      organizationId: DEFAULT_TEST_ORGANIZATION_ID,
      name: 'Secondary Protocol Workspace'
    });
    const project = await createProject({
      name: 'Secondary Protocol Project',
      workspaceId: secondary.id
    });
    const mission = await createMission({
      projectId: project.id,
      firstObjective: 'Update this mission through its session key'
    });
    await setActiveWorkspace(workspaceAId);

    const attached = (await runProtocolSubcommand('attach', {
      flags: { '--mission-id': mission.id, '--agent': 'codex' }
    })) as { sessionKey: string };
    assert.ok(attached.sessionKey);

    await assert.doesNotReject(
      runProtocolSubcommand('update', {
        flags: {
          '--mission-id': mission.id,
          '--session-key': attached.sessionKey,
          '--summary': 'Verified protocol workspace routing.',
          '--phase': 'execute'
        }
      })
    );
  });

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

    const {
      findActiveMembershipId,
      getActorWorkspaceUserId,
      requireDatabaseClient,
      setActiveWorkspace
    } = await import('./db.ts');
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
      updateProject
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

    const workspaceAActorId = getActorWorkspaceUserId();
    const actorProfile = await requireDatabaseClient().get<{ profile_id: string }>(
      `SELECT profile_id FROM workspace_users WHERE id = ?`,
      [workspaceAActorId]
    );
    assert.ok(actorProfile);
    const workspaceBActorId = await findActiveMembershipId(secondary.id, actorProfile.profile_id);
    assert.ok(workspaceBActorId);
    assert.notEqual(workspaceBActorId, workspaceAActorId);
    const missionChange = await requireDatabaseClient().get<{
      workspace_id: string;
      actor_workspace_user_id: string | null;
    }>(
      `SELECT workspace_id, actor_workspace_user_id
         FROM entity_changes
        WHERE entity_type = 'mission' AND entity_id = ? AND operation = 'update'
        ORDER BY seq DESC LIMIT 1`,
      [mission.id]
    );
    assert.deepEqual(missionChange, {
      workspace_id: secondary.id,
      actor_workspace_user_id: workspaceBActorId
    });

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

    const { setActiveWorkspace, requireDatabaseClient } = await import('./db.ts');
    const { createWorkspace } = await import('./workspaces.ts');
    const {
      createProject,
      updateProject,
      reorderProjects,
      deleteProject,
      listProjectsForWorkspace,
      createProjectTag,
      updateProjectTag,
      deleteProjectTag,
      createProjectResource,
      updateProjectResource,
      deleteProjectResource,
      listProjectResources
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

    const tag = await createProjectTag(first.id, { label: 'Secondary tag' });
    const storedTag = (await requireDatabaseClient().get(
      `SELECT workspace_id FROM project_tags WHERE id = ?`,
      [tag.id]
    )) as { workspace_id: string };
    assert.equal(storedTag.workspace_id, secondary.id);
    const updatedTag = await updateProjectTag(first.id, tag.id, { color: '#123456' });
    assert.equal(updatedTag.color, '#123456');

    const resource = await createProjectResource(first.id, {
      directoryPath: mkdtempSync(path.join('/tmp', 'ovld-secondary-project-resource-')),
      isPrimary: true
    });
    assert.equal(resource.workspaceId, secondary.id);
    assert.ok(
      resource.sources.some(source => source.executionTargetId !== null),
      'the implicit acting-device target must be provisioned in the project workspace'
    );
    const listedResources = await listProjectResources(first.id);
    assert.deepEqual(
      listedResources.map(item => item.id),
      [resource.id]
    );
    const updatedResource = await updateProjectResource(first.id, resource.id, {
      resourceKey: 'secondary-checkout'
    });
    assert.equal(updatedResource.resourceKey, 'secondary-checkout');

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

    await deleteProjectTag(first.id, tag.id);
    await deleteProjectResource(first.id, resource.id);

    await deleteProject(first.id);
    const remaining = await listProjectsForWorkspace(secondary.id);
    assert.deepEqual(
      remaining.map(project => project.id),
      [second.id]
    );
  });
});

// coo:135 objective 12: the runner claims/drives executions across every
// workspace the caller belongs to, not just the active one. Before this, a
// desktop runner never saw executions queued in a secondary workspace, and
// branch-prepared / status transitions 404'd because they scoped to the active
// workspace.
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
    const { launchObjective } = await import('./execution/launch.ts');
    const { claimRunnerRequest, updateRunnerRequestStatus, runnerStatus, recordBranchPrepared } =
      await import('./execution/runner.ts');

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
        resourceKey: 'primary-repo',
        action: 'create',
        cycle: 1
      }
    });
    const branch = (await getMissionDetail(mission.id)).branch;
    assert.equal(branch?.name, 'overlord/run-in-the-secondary-workspace-1');

    const { runProtocolSubcommand } = await import('./protocol.ts');
    const context = (await runProtocolSubcommand('load-context', {
      flags: { '--mission-id': mission.id }
    })) as { mission: { id: string } };
    assert.equal(context.mission.id, mission.id);
  });

  it('claims executions from a workspace in another organization', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-cross-org-runner-'));
    const { bootstrapIntegrationTestDb, seedAuthenticatedOperatorClient } =
      await import('./test-helpers.ts');
    const { WORKSPACE } = await bootstrapIntegrationTestDb({
      sqlitePath: path.join(dir, 'Overlord.sqlite')
    });

    const { requireDatabaseClient, setActiveWorkspace } = await import('./db.ts');
    await seedAuthenticatedOperatorClient({
      client: requireDatabaseClient(),
      organizationId: 'secondary-runner-organization',
      workspaceId: 'secondary-runner-workspace',
      profileId: 'operator-user',
      workspaceUserId: 'secondary-runner-workspace-user'
    });
    await setActiveWorkspace(WORKSPACE.id);

    const { createProject, createProjectResource, createMission } = await import('./repository.ts');
    const { launchObjective } = await import('./execution/launch.ts');
    const { claimRunnerRequest, runnerStatus } = await import('./execution/runner.ts');

    const project = await createProject({
      name: 'Cross-organization Runner Project',
      workspaceId: 'secondary-runner-workspace'
    });
    await createProjectResource(project.id, {
      directoryPath: mkdtempSync(path.join('/tmp', 'ovld-cross-org-runner-resource-')),
      executionTargetId: null,
      isPrimary: true
    });
    const mission = await createMission({
      projectId: project.id,
      firstObjective: 'Run in another organization'
    });
    const queued = await launchObjective(mission.objectives[0]!.id, { agent: 'codex' });

    const { runProtocolSubcommand } = await import('./protocol.ts');
    const discovery = (await runProtocolSubcommand('discover-project', {
      flags: { '--project-id': project.id }
    })) as { projectId: string };
    assert.equal(discovery.projectId, project.id);

    const linked = await createProjectResource(project.id, {
      directoryPath: mkdtempSync(path.join('/tmp', 'ovld-cross-org-linked-resource-')),
      isPrimary: false
    });
    const linkedTarget = await requireDatabaseClient().get<{ workspace_id: string }>(
      `SELECT et.workspace_id
         FROM project_resource_sources prs
         JOIN execution_targets et ON et.id = prs.execution_target_id
        WHERE prs.resource_id = ?`,
      [linked.id]
    );
    assert.equal(linkedTarget?.workspace_id, 'secondary-runner-workspace');

    const status = await runnerStatus();
    assert.ok(
      (status.queue as Array<{ id: string }>).some(request => request.id === queued.id),
      'runner status must include queued work from every workspace membership'
    );

    const claimed = await claimRunnerRequest();
    assert.equal((claimed.request as { id: string } | null)?.id, queued.id);
    assert.equal(
      (claimed.request as { workspaceId: string } | null)?.workspaceId,
      'secondary-runner-workspace'
    );
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

// coo:331 Phase 3: the structural A/B fixture. Each workspace-scoped operation
// must resolve against the *resource's* workspace, not the caller's active one.
// The suite starts with the Phase 0 launch-settings surface and gains a case per
// endpoint converted in Phase 2, all built on the shared fixture so the bug class
// is caught at the door for every newly-converted endpoint.
describe('workspace-scoped operations resolve against the resource workspace, not the active one', () => {
  // Phase 0 — the genuinely per-workspace launch setting. `worktreeBranchAutomationEnabled`
  // lives in `workspaces.settings_json`; before the fix the launch-settings surface
  // read/wrote it against the caller's *active* workspace (launch.ts:114/131/189
  // defaulted to `WORKSPACE.id`), so toggling it while viewing a secondary-workspace
  // project silently configured the active workspace instead. The conversion threads
  // an explicit `workspaceId`, so the toggle lands in — and reads back from — the
  // objective's own workspace B without touching the active workspace A.
  it('reads and writes worktree-branch automation against the objective workspace (Phase 0)', async () => {
    const fixture = await setupSecondaryWorkspaceFixture({ namePrefix: 'Launch Settings' });
    const { getLaunchSettings, updateWorktreeBranchAutomation } =
      await import('./execution/launch.ts');

    await assertScopedToResourceWorkspace({
      fixture,
      message: 'worktree-branch automation',
      write: workspaceId => updateWorktreeBranchAutomation({ enabled: true }, workspaceId),
      read: workspaceId => getLaunchSettings(workspaceId),
      extract: settings => settings.worktreeBranchAutomationEnabled,
      expected: true,
      present: value => value === true
    });
  });

  // Phase 0 — the origin bug, end to end. Per-user launch mechanics (pre-command
  // and flags) are a per-device preference shared across a profile's workspaces,
  // so the scoping guarantee is not "absent in A" but that a config saved through
  // the workspace-scoped surface is the one `launchObjective` resolves when it
  // queues from the objective's OWN (secondary) workspace context. Before Phase 0
  // the webapp read/wrote these against the active workspace while the catalog was
  // already scoped to the project's workspace, and a secondary-workspace mission
  // launched with an empty config.
  it('surfaces the objective-workspace launch config to launchObjective (Phase 0)', async () => {
    const fixture = await setupSecondaryWorkspaceFixture({ namePrefix: 'Launch Config' });
    const { getLaunchSettings, updateAgentLaunchConfig, launchObjective } =
      await import('./execution/launch.ts');

    const expectedConfig = { preCommand: 'echo secondary', flags: ['--secondary'] };

    // Saving through the surface scoped to the objective's workspace B.
    const saved = await updateAgentLaunchConfig('codex', expectedConfig, fixture.secondary.id);
    assert.deepEqual(saved.agentConfigs.codex, expectedConfig);

    // Reading the surface back scoped to B returns it.
    const readB = await getLaunchSettings(fixture.secondary.id);
    assert.deepEqual(readB.agentConfigs.codex, expectedConfig);

    // End-to-end: `launchObjective` builds the objective's own (secondary)
    // workspace context, so the queued request carries the saved config — not the
    // empty config the pre-fix active-workspace path yielded for a B objective.
    const queued = await launchObjective(fixture.objectiveId, { agent: 'codex' });
    assert.equal(queued.status, 'queued');
    assert.equal(
      queued.launchConfig.preCommand,
      expectedConfig.preCommand,
      'the queued request must carry the pre-command resolved from the objective workspace'
    );
    assert.deepEqual(queued.launchConfig.flags, expectedConfig.flags);
  });

  it('resolves a project execution target through the project workspace (Phase 2)', async () => {
    const fixture = await setupSecondaryWorkspaceFixture({ namePrefix: 'Project Target Scope' });
    const { getProjectExecutionTarget } = await import('./execution/project-execution-target.ts');

    await assert.doesNotReject(getProjectExecutionTarget(fixture.project.id));
  });

  it('resolves an attachment through its objective workspace while workspace A is active (Phase 2)', async () => {
    const fixture = await setupSecondaryWorkspaceFixture({ namePrefix: 'Stored Object' });
    const { PERMISSIONS } = await import('@overlord/auth');
    const { resolveStoredObject, uploadObjectiveAttachment } = await import('./storage.ts');

    const attachment = await uploadObjectiveAttachment({
      objectiveId: fixture.objectiveId,
      bytes: Buffer.from('secondary-workspace attachment'),
      filename: 'secondary.txt',
      contentType: 'text/plain'
    });
    const resolved = await resolveStoredObject(
      attachment.bucketKey,
      attachment.storageKey,
      PERMISSIONS.ATTACHMENT_READ
    );

    assert.equal(resolved.filename, 'secondary.txt');
    assert.ok(
      resolved.absolutePath?.includes(`workspace-files/${fixture.secondary.id}/attachments/`),
      "the object must be read from workspace B's bucket even though workspace A remains active"
    );
  });

  it('creates a project webhook in the project workspace while another is active (Phase 2)', async () => {
    const fixture = await setupSecondaryWorkspaceFixture({ namePrefix: 'Webhook Scope' });
    const { createWebhookSubscription } = await import('./webhooks.ts');
    const { requireDatabaseClient } = await import('./db.ts');

    const created = await createWebhookSubscription({
      projectId: fixture.project.id,
      name: 'Secondary workspace hook',
      endpointUrl: 'https://example.com/overlord-hook',
      eventTypes: ['mission.delivered']
    });
    const row = await requireDatabaseClient().get<{ workspace_id: string }>(
      `SELECT workspace_id FROM webhook_subscriptions WHERE id = ?`,
      [created.subscription.id]
    );
    assert.equal(row?.workspace_id, fixture.secondary.id);
  });

  it('reads an Everhour project link from the project workspace while workspace A is active (Phase 2)', async () => {
    const fixture = await setupSecondaryWorkspaceFixture({ namePrefix: 'Everhour Link' });
    const { db, nowIso } = await import('./db.ts');
    const { getProjectEverhourLink } = await import('./ext/everhour/service.ts');

    db.prepare(
      `INSERT INTO ext_everhour_project_links
         (id, workspace_id, project_id, everhour_project_id, everhour_project_name,
          everhour_section_id, everhour_general_task_id, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1)`
    ).run(
      'secondary-everhour-link',
      fixture.secondary.id,
      fixture.project.id,
      'ev:secondary',
      'Secondary Everhour Project',
      nowIso(),
      nowIso()
    );

    assert.deepEqual(await getProjectEverhourLink(fixture.project.id), {
      projectId: fixture.project.id,
      everhourProjectId: 'ev:secondary',
      everhourProjectName: 'Secondary Everhour Project'
    });
  });
});
