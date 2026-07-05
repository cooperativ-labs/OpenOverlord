import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-my-missions-'));
const { bootstrapIntegrationTestDb, DEFAULT_TEST_ORGANIZATION_ID } =
  await import('./test-helpers.ts');
await bootstrapIntegrationTestDb({ sqlitePath: path.join(tempDir, 'webapp.sqlite') });

const {
  db,
  setActiveProfileId,
  setActiveWorkspaceContext,
  setActiveWorkspaceUser,
  nowIso,
  withRequestContextAsync
} = await import('./db.ts');
const {
  createProject,
  createMission,
  updateMission,
  deleteMission,
  listMissions,
  listWorkspaceStatuses,
  listWorkspaceMyMissions,
  reorderWorkspaceMyMissions
} = await import('./repository.ts');
const { ApiError } = await import('./errors.ts');

// Operator is seeded by bootstrapIntegrationTestDb.
const operatorId = 'operator-workspace-user';

const statuses = await listWorkspaceStatuses();
const backlog = statuses.find(s => s.key === 'backlog')!;
const inProgress = statuses.find(s => s.key === 'in_progress')!;

test('the test database seeds the active operator workspace user', async () => {
  const row = db.prepare(`SELECT status FROM workspace_users WHERE id = ?`).get(operatorId) as
    | { status: string }
    | undefined;
  assert.ok(row, 'bootstrap should seed the operator workspace user');
  assert.equal(row.status, 'active', 'the seeded operator must be active');
});

test('lists missions assigned to the operator across projects, with project context', async () => {
  const projectA = await createProject({ name: 'MT Project A', color: '#112233' });
  const projectB = await createProject({ name: 'MT Project B' });
  const a1 = await createMission({ projectId: projectA.id, firstObjective: 'A1' });
  const b1 = await createMission({ projectId: projectB.id, firstObjective: 'B1' });
  const unassigned = await createMission({ projectId: projectA.id, firstObjective: 'U' });
  await updateMission(unassigned.id, { assignedWorkspaceUserId: null });
  const deleted = await createMission({ projectId: projectA.id, firstObjective: 'D' });
  await deleteMission(deleted.id);

  const ids = (await listWorkspaceMyMissions()).missions.map(t => t.id);
  assert.ok(ids.includes(a1.id));
  assert.ok(ids.includes(b1.id));
  assert.ok(!ids.includes(unassigned.id), 'unassigned mission must be excluded');
  assert.ok(!ids.includes(deleted.id), 'deleted mission must be excluded');

  const a1Dto = (await listWorkspaceMyMissions()).missions.find(t => t.id === a1.id)!;
  assert.equal(a1Dto.projectName, 'MT Project A');
  assert.equal(a1Dto.projectColor, '#112233');
  assert.equal(a1Dto.myPosition, null);
});

test('within-column reorder writes personal position and leaves board_position untouched', async () => {
  const project = await createProject({ name: 'MT Reorder' });
  const t1 = await createMission({ projectId: project.id, firstObjective: 'r1' });
  const t2 = await createMission({ projectId: project.id, firstObjective: 'r2' });
  const beforeBoard = new Map((await listMissions(project.id)).map(t => [t.id, t.boardPosition]));

  // Put t2 above t1 in the backlog column.
  await reorderWorkspaceMyMissions({ statusId: backlog.id, orderedMissionIds: [t2.id, t1.id] });

  const afterBoard = new Map((await listMissions(project.id)).map(t => [t.id, t.boardPosition]));
  assert.equal(afterBoard.get(t1.id), beforeBoard.get(t1.id), 'board_position must not change');
  assert.equal(afterBoard.get(t2.id), beforeBoard.get(t2.id), 'board_position must not change');

  const missions = (await listWorkspaceMyMissions()).missions;
  assert.equal(missions.find(t => t.id === t2.id)!.myPosition, 100);
  assert.equal(missions.find(t => t.id === t1.id)!.myPosition, 200);
  const order = missions.filter(t => t.id === t1.id || t.id === t2.id).map(t => t.id);
  assert.deepEqual(order, [t2.id, t1.id], 'positioned missions sort by personal position');
});

test('cross-column drag changes the mission status, type, and board_position', async () => {
  const project = await createProject({ name: 'MT CrossCol' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'x' });
  assert.equal(
    (await listMissions(project.id)).find(t => t.id === mission.id)!.statusId,
    backlog.id
  );

  await reorderWorkspaceMyMissions({ statusId: inProgress.id, orderedMissionIds: [mission.id] });

  const after = (await listMissions(project.id)).find(t => t.id === mission.id)!;
  assert.equal(after.statusId, inProgress.id);
  assert.equal(after.statusType, 'execute');
  assert.equal(after.boardPosition, 100, 'board_position resets to top-of-new-column');

  const moved = (await listWorkspaceMyMissions()).missions.find(t => t.id === mission.id)!;
  assert.equal(moved.statusId, inProgress.id);
  assert.equal(moved.myPosition, 100);
});

test('a personal position is ignored once the mission leaves that column via another surface', async () => {
  const project = await createProject({ name: 'MT Stale' });
  const mission = await createMission({ projectId: project.id, firstObjective: 's' });
  await reorderWorkspaceMyMissions({ statusId: backlog.id, orderedMissionIds: [mission.id] });
  // Move it via the project-board status-change path; the stored position keeps
  // its old status_id and must no longer apply.
  await updateMission(mission.id, { statusId: inProgress.id });

  const moved = (await listWorkspaceMyMissions()).missions.find(t => t.id === mission.id)!;
  assert.equal(moved.statusId, inProgress.id);
  assert.equal(moved.myPosition, null, 'stale position is ignored at read time');
});

test('reorder into a status the workspace lacks is rejected with a typed code', async () => {
  const project = await createProject({ name: 'MT Reject' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'rej' });
  await assert.rejects(
    reorderWorkspaceMyMissions({ statusId: 'does-not-exist', orderedMissionIds: [mission.id] }),
    (err: unknown) =>
      err instanceof ApiError &&
      err.status === 409 &&
      err.code === 'STATUS_UNAVAILABLE_FOR_WORKSPACE'
  );
});

test('excludes missions whose project has been deleted', async () => {
  const project = await createProject({ name: 'MT DeletedProj' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'dp' });
  assert.ok((await listWorkspaceMyMissions()).missions.some(t => t.id === mission.id));

  db.prepare(`UPDATE projects SET deleted_at = ? WHERE id = ?`).run(nowIso(), project.id);
  assert.ok(
    !(await listWorkspaceMyMissions()).missions.some(t => t.id === mission.id),
    'a mission in a deleted project must be excluded'
  );
});

test('a personal position survives reassignment and is restored when the mission returns', async () => {
  const project = await createProject({ name: 'MT Reassign' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'ra' });
  await reorderWorkspaceMyMissions({ statusId: backlog.id, orderedMissionIds: [mission.id] });

  await updateMission(mission.id, { assignedWorkspaceUserId: null });
  assert.ok(!(await listWorkspaceMyMissions()).missions.some(t => t.id === mission.id));

  await updateMission(mission.id, { assignedWorkspaceUserId: operatorId });
  const restored = (await listWorkspaceMyMissions()).missions.find(t => t.id === mission.id)!;
  assert.equal(restored.myPosition, 100, 'the personal position row persists across reassignment');
});

test('reorder rejects a mission not assigned to the operator', async () => {
  const project = await createProject({ name: 'MT NotMine' });
  const mission = await createMission({ projectId: project.id, firstObjective: 'nm' });
  await updateMission(mission.id, { assignedWorkspaceUserId: null });
  await assert.rejects(
    reorderWorkspaceMyMissions({ statusId: backlog.id, orderedMissionIds: [mission.id] }),
    (err: unknown) => err instanceof ApiError && err.status === 403
  );
});

test('different tenants only see their own My Missions entries', async () => {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, NULL, ?, ?)`
  ).run('tenant-b-user', 'tenant-b-user', 'tenant-b@overlord.local', now, now);
  db.prepare(
    `INSERT INTO workspaces
       (id, organization_id, slug, name, kind, settings_json, created_at, updated_at, revision)
     VALUES ('tenant-b', ?, 'tenant-b', 'Tenant B', 'local', '{}', ?, ?, 1)`
  ).run(DEFAULT_TEST_ORGANIZATION_ID, now, now);
  db.prepare(
    `INSERT INTO workspace_users
       (id, workspace_id, profile_id, member_key, status, metadata_json, created_at, updated_at, revision)
     VALUES (?, 'tenant-b', 'tenant-b-user', 'auth:tenant-b-user', 'active', '{}', ?, ?, 1)`
  ).run('tenant-b-workspace-user', now, now);
  db.prepare(
    `INSERT INTO role_assignments
       (id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
        assigned_by_workspace_user_id, created_at, updated_at, revision)
     VALUES (?, 'tenant-b', 'tenant-b-workspace-user', 'ADMIN', '', '', ?, ?, ?, 1)`
  ).run('tenant-b-admin-role', 'tenant-b-workspace-user', now, now);
  db.prepare(
    `INSERT INTO workspace_statuses
       (id, workspace_id, key, name, type, position, is_default, is_terminal, created_at, updated_at, revision)
     VALUES ('tenant-b-backlog', 'tenant-b', 'backlog', 'Backlog', 'draft', 100, 1, 0, ?, ?, 1)`
  ).run(now, now);

  const operatorProject = await createProject({ name: 'Tenant A Project' });
  const operatorMission = await createMission({
    projectId: operatorProject.id,
    firstObjective: 'tenant-a-objective'
  });

  const tenantBWorkspace = { id: 'tenant-b', slug: 'tenant-b', name: 'Tenant B', kind: 'local' };
  const tenantBMissionId = await withRequestContextAsync(async () => {
    setActiveProfileId('tenant-b-user');
    setActiveWorkspaceContext(tenantBWorkspace);
    setActiveWorkspaceUser('tenant-b-workspace-user');

    const tenantBProject = await createProject({ name: 'Tenant B Project' });
    const tenantBMission = await createMission({
      projectId: tenantBProject.id,
      firstObjective: 'tenant-b-objective'
    });

    const visibleIds = (await listWorkspaceMyMissions()).missions.map(mission => mission.id);
    assert.ok(visibleIds.includes(tenantBMission.id));
    assert.ok(!visibleIds.includes(operatorMission.id));
    return tenantBMission.id;
  });

  const operatorVisibleIds = (await listWorkspaceMyMissions()).missions.map(mission => mission.id);
  assert.ok(operatorVisibleIds.includes(operatorMission.id));
  assert.ok(!operatorVisibleIds.includes(tenantBMissionId));
});

test.after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});
