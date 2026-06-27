import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-workspaces-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');

const dbModule = await import('./db.ts');
const { db, initDatabase, resolveActorForWorkspace, setActiveWorkspace, setActiveWorkspaceUser } =
  dbModule;
await initDatabase();
const { actorCan, loadActorRoles } = await import('./rbac.ts');
const { createMission, createObjective, createProject } = await import('./repository.ts');
const { seedAuthenticatedOperator } = await import('./test-helpers.ts');
const { completeInitialSetup, createWorkspace, exportWorkspaceObjectivesCsv, needsInitialSetup } =
  await import('./workspaces.ts');

const operatorWorkspaceUserId = seedAuthenticatedOperator({ db });
setActiveWorkspaceUser(operatorWorkspaceUserId);

test('createWorkspace grants ADMIN to the creator so switching workspaces keeps permissions', async () => {
  const created = await createWorkspace({ name: 'Second Workspace' });
  const workspaceUserId = await resolveActorForWorkspace(created.id);
  assert.ok(workspaceUserId, 'expected a workspace user for the new workspace');

  assert.deepEqual(await loadActorRoles({ workspaceId: created.id, workspaceUserId }), ['ADMIN']);

  setActiveWorkspaceUser(workspaceUserId);
  assert.equal(await actorCan('project:read'), true);
  assert.equal(await actorCan('workspace:update'), true);
});

test('createWorkspace accepts a custom workspace ID and rejects collisions', async () => {
  const created = await createWorkspace({ id: 'engineering-hq', name: 'Engineering HQ' });
  assert.equal(created.id, 'engineering-hq');

  await assert.rejects(
    createWorkspace({ id: 'engineering-hq', name: 'Duplicate HQ' }),
    /already exists/
  );
});

test('createWorkspace defaults the workspace ID from the full name', async () => {
  const created = await createWorkspace({ name: 'Client Success West' });
  assert.equal(created.id, 'client-success-west');
});

test('completeInitialSetup can re-key the seeded first workspace', async () => {
  await setActiveWorkspace('local-workspace');
  setActiveWorkspaceUser(operatorWorkspaceUserId);
  assert.equal(await needsInitialSetup(), true);

  const updated = await completeInitialSetup({
    id: 'acme-operations',
    name: 'Acme Operations',
    slug: 'aco'
  });

  assert.equal(updated.id, 'acme-operations');
  assert.equal(dbModule.WORKSPACE.id, 'acme-operations');
  assert.equal(dbModule.WORKSPACE.slug, 'aco');
  assert.equal(await needsInitialSetup(), false);
  assert.equal(await resolveActorForWorkspace('acme-operations'), operatorWorkspaceUserId);

  const missionSequence = db
    .prepare(`SELECT workspace_id, scope_id FROM mission_sequences WHERE id = ?`)
    .get('local-workspace-mission-sequence') as { workspace_id: string; scope_id: string };
  assert.deepEqual(missionSequence, {
    workspace_id: 'acme-operations',
    scope_id: 'acme-operations'
  });
});

test('exportWorkspaceObjectivesCsv exports the requested workspace objectives as CSV', async () => {
  const workspace = await createWorkspace({ name: 'Export Target Workspace' });
  const workspaceUserId = await resolveActorForWorkspace(workspace.id);
  assert.ok(workspaceUserId, 'expected operator membership in the export workspace');
  setActiveWorkspaceUser(workspaceUserId);

  const project = await createProject({ name: 'Operations' });
  const mission = await createMission({
    projectId: project.id,
    title: 'Quarterly Review',
    objectives: [{ objective: 'Prepare agenda' }]
  });
  await createObjective({
    missionId: mission.id,
    instructionText: 'Line 1,\n"quoted" value'
  });

  const exported = await exportWorkspaceObjectivesCsv(workspace.id);

  assert.match(exported.filename, /^exp-objectives-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(
    exported.content,
    /"Mission name","Objective instructions","Date created","Project name","Mission status"/
  );
  assert.match(exported.content, /"Quarterly Review","Prepare agenda",/);
  assert.match(exported.content, /"Quarterly Review","Line 1,\n""quoted"" value",/);
  assert.match(exported.content, /,"Operations","Backlog"/);
});

test('exportWorkspaceObjectivesCsv checks admin access on the requested workspace', async () => {
  const target = await createWorkspace({ name: 'Export Access Target' });
  const targetWorkspaceUserId = await resolveActorForWorkspace(target.id);
  assert.ok(targetWorkspaceUserId, 'expected operator membership in the target workspace');
  setActiveWorkspaceUser(targetWorkspaceUserId);

  const second = await createWorkspace({ name: 'Second Workspace Export Test' });
  const secondWorkspaceUserId = await resolveActorForWorkspace(second.id);
  assert.ok(secondWorkspaceUserId, 'expected operator membership in the second workspace');
  setActiveWorkspaceUser(secondWorkspaceUserId);

  await exportWorkspaceObjectivesCsv(target.id);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, NULL, ?, ?)`
  ).run('viewer-user', 'viewer-user', 'viewer@overlord.local', now, now);
  db.prepare(
    `INSERT INTO workspace_users
       (id, workspace_id, profile_id, member_key, status, metadata_json,
        created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, 'active', '{}', ?, ?, 1)`
  ).run('viewer-workspace-user', target.id, 'viewer-user', 'auth:viewer-user', now, now);

  await setActiveWorkspace(target.id);
  setActiveWorkspaceUser('viewer-workspace-user');
  await assert.rejects(exportWorkspaceObjectivesCsv(target.id), /Admin role required/);
});

test.after(async () => {
  rmSync(tempDir, { recursive: true, force: true });
  await setActiveWorkspace('local-workspace');
  setActiveWorkspaceUser(operatorWorkspaceUserId);
});
