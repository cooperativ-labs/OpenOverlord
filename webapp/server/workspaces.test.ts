import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-workspaces-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');

const dbModule = await import('./db.ts');
const { db, resolveActorForWorkspace, setActiveWorkspace, setActiveWorkspaceUser } = dbModule;
const { actorCan, loadActorRoles } = await import('./rbac.ts');
const { createMission, createObjective, createProject } = await import('./repository.ts');
const { seedAuthenticatedOperator } = await import('./test-helpers.ts');
const { completeInitialSetup, createWorkspace, exportWorkspaceObjectivesCsv, needsInitialSetup } =
  await import('./workspaces.ts');

const operatorWorkspaceUserId = seedAuthenticatedOperator({ db });
setActiveWorkspaceUser(operatorWorkspaceUserId);

test('createWorkspace grants ADMIN to the creator so switching workspaces keeps permissions', () => {
  const created = createWorkspace({ name: 'Second Workspace' });
  const workspaceUserId = resolveActorForWorkspace(created.id);
  assert.ok(workspaceUserId, 'expected a workspace user for the new workspace');

  assert.deepEqual(loadActorRoles({ workspaceId: created.id, workspaceUserId }), ['ADMIN']);

  setActiveWorkspaceUser(workspaceUserId);
  assert.equal(actorCan('project:read'), true);
  assert.equal(actorCan('workspace:update'), true);
});

test('createWorkspace accepts a custom workspace ID and rejects collisions', () => {
  const created = createWorkspace({ id: 'engineering-hq', name: 'Engineering HQ' });
  assert.equal(created.id, 'engineering-hq');

  assert.throws(
    () => createWorkspace({ id: 'engineering-hq', name: 'Duplicate HQ' }),
    /already exists/
  );
});

test('createWorkspace defaults the workspace ID from the full name', () => {
  const created = createWorkspace({ name: 'Client Success West' });
  assert.equal(created.id, 'client-success-west');
});

test('completeInitialSetup can re-key the seeded first workspace', () => {
  setActiveWorkspace('local-workspace');
  setActiveWorkspaceUser(operatorWorkspaceUserId);
  assert.equal(needsInitialSetup(), true);

  const updated = completeInitialSetup({
    id: 'acme-operations',
    name: 'Acme Operations',
    slug: 'aco'
  });

  assert.equal(updated.id, 'acme-operations');
  assert.equal(dbModule.WORKSPACE.id, 'acme-operations');
  assert.equal(dbModule.WORKSPACE.slug, 'aco');
  assert.equal(needsInitialSetup(), false);
  assert.equal(resolveActorForWorkspace('acme-operations'), operatorWorkspaceUserId);

  const missionSequence = db
    .prepare(`SELECT workspace_id, scope_id FROM mission_sequences WHERE id = ?`)
    .get('local-workspace-mission-sequence') as { workspace_id: string; scope_id: string };
  assert.deepEqual(missionSequence, {
    workspace_id: 'acme-operations',
    scope_id: 'acme-operations'
  });
});

test('exportWorkspaceObjectivesCsv exports the requested workspace objectives as CSV', () => {
  const workspace = createWorkspace({ name: 'Export Target Workspace' });
  const workspaceUserId = resolveActorForWorkspace(workspace.id);
  assert.ok(workspaceUserId, 'expected operator membership in the export workspace');
  setActiveWorkspaceUser(workspaceUserId);

  const project = createProject({ name: 'Operations' });
  const mission = createMission({
    projectId: project.id,
    title: 'Quarterly Review',
    objectives: [{ objective: 'Prepare agenda' }]
  });
  createObjective({
    missionId: mission.id,
    instructionText: 'Line 1,\n"quoted" value'
  });

  const exported = exportWorkspaceObjectivesCsv(workspace.id);

  assert.match(exported.filename, /^exp-objectives-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(
    exported.content,
    /"Mission name","Objective instructions","Date created","Project name","Mission status"/
  );
  assert.match(exported.content, /"Quarterly Review","Prepare agenda",/);
  assert.match(exported.content, /"Quarterly Review","Line 1,\n""quoted"" value",/);
  assert.match(exported.content, /,"Operations","Backlog"/);
});

test('exportWorkspaceObjectivesCsv checks admin access on the requested workspace', () => {
  const target = createWorkspace({ name: 'Export Access Target' });
  const targetWorkspaceUserId = resolveActorForWorkspace(target.id);
  assert.ok(targetWorkspaceUserId, 'expected operator membership in the target workspace');
  setActiveWorkspaceUser(targetWorkspaceUserId);

  const second = createWorkspace({ name: 'Second Workspace Export Test' });
  const secondWorkspaceUserId = resolveActorForWorkspace(second.id);
  assert.ok(secondWorkspaceUserId, 'expected operator membership in the second workspace');
  setActiveWorkspaceUser(secondWorkspaceUserId);

  assert.doesNotThrow(() => exportWorkspaceObjectivesCsv(target.id));

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

  setActiveWorkspace(target.id);
  setActiveWorkspaceUser('viewer-workspace-user');
  assert.throws(() => exportWorkspaceObjectivesCsv(target.id), /Admin role required/);
});

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  setActiveWorkspace('local-workspace');
  setActiveWorkspaceUser(operatorWorkspaceUserId);
});
