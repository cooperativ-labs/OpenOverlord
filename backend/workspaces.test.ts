import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-workspaces-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');

const dbModule = await import('./db.ts');
const {
  db,
  initDatabase,
  resolveActorForWorkspace,
  setActiveProfileId,
  setActiveWorkspace,
  setActiveWorkspaceContext,
  setActiveWorkspaceUser,
  withRequestContextAsync
} = dbModule;
await initDatabase();
const { actorCan, loadActorRoles } = await import('./rbac.ts');
const { createMission, createObjective, createProject, listProjects } =
  await import('./repository.ts');
const { DEFAULT_TEST_ORGANIZATION_ID, seedAuthenticatedOperator } =
  await import('./test-helpers.ts');
const {
  createOrganizationOnboarding,
  createWorkspace,
  deleteWorkspace,
  exportWorkspaceObjectivesCsv,
  listWorkspaceMembers,
  listWorkspaces,
  updateWorkspace
} = await import('./workspaces.ts');

const operatorWorkspaceUserId = seedAuthenticatedOperator({ db });
setActiveWorkspaceUser(operatorWorkspaceUserId);

test('createWorkspace grants ADMIN to the creator so switching workspaces keeps permissions', async () => {
  const created = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Second Workspace'
  });
  const workspaceUserId = await resolveActorForWorkspace(created.id);
  assert.ok(workspaceUserId, 'expected a workspace user for the new workspace');

  assert.deepEqual(await loadActorRoles({ workspaceId: created.id, workspaceUserId }), ['ADMIN']);

  setActiveWorkspaceUser(workspaceUserId);
  assert.equal(await actorCan('project:read'), true);
  assert.equal(await actorCan('workspace:update'), true);
});

test('a brand-new authenticated user onboards into their own organization and workspace', async () => {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, NULL, ?, ?)`
  ).run('brand-new-user', 'brand-new-user', 'brand-new@overlord.local', now, now);

  await withRequestContextAsync(async () => {
    setActiveProfileId('brand-new-user');
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);

    const created = await createOrganizationOnboarding({
      organizationName: 'Brand New Org',
      workspaceName: 'Brand New User Workspace'
    });
    const members = db
      .prepare(
        `SELECT id, profile_id FROM workspace_users
         WHERE workspace_id = ? AND status = 'active' AND deleted_at IS NULL`
      )
      .all(created.id) as { id: string; profile_id: string }[];

    assert.equal(members.length, 1);
    assert.equal(members[0]?.profile_id, 'brand-new-user');
    assert.deepEqual(
      await loadActorRoles({ workspaceId: created.id, workspaceUserId: members[0]?.id }),
      ['ADMIN']
    );

    const visibleWorkspaces = await listWorkspaces();
    assert.deepEqual(
      visibleWorkspaces.map(workspace => workspace.id),
      [created.id],
      'new user should only see the workspace they created'
    );

    await createProject({ name: 'Private Project' });
    assert.deepEqual(
      (await listProjects()).map(project => project.name),
      ['Private Project'],
      'new user should only see data in their own active workspace'
    );
  });
});

test('onboarding refuses a profile that already has a workspace membership', async () => {
  await assert.rejects(
    createOrganizationOnboarding({ organizationName: 'Second Org For Same User' }),
    /only available before your first workspace membership/
  );
});

test('createWorkspace assigns a UUID id and derives the slug from the name', async () => {
  const created = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Client Success West'
  });
  assert.match(created.id, /^[0-9a-f-]{36}$/i, 'workspace ids are now server-generated UUIDs');
  assert.equal(created.slug, 'cli', 'the slug defaults to the first three letters of the name');
  assert.equal(created.organizationId, DEFAULT_TEST_ORGANIZATION_ID);
});

test('createWorkspace uniquifies max-length slug collisions without looping', async () => {
  const slug = 'a'.repeat(48);
  const first = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'First Long Slug Workspace',
    slug
  });
  const second = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Second Long Slug Workspace',
    slug
  });

  assert.equal(first.slug, slug);
  assert.equal(second.slug, `${'a'.repeat(46)}-2`);
  assert.equal(second.slug.length, 48);
});

test('createWorkspace rejects a caller who is not an admin of the organization', async () => {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, NULL, ?, ?)`
  ).run('non-org-admin-user', 'non-org-admin-user', 'non-org-admin@overlord.local', now, now);

  await withRequestContextAsync(async () => {
    setActiveProfileId('non-org-admin-user');
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);

    await assert.rejects(
      createWorkspace({ organizationId: DEFAULT_TEST_ORGANIZATION_ID, name: 'Should Not Exist' }),
      /Organization admin required/
    );
  });
});

test('exportWorkspaceObjectivesCsv exports the requested workspace objectives as CSV', async () => {
  const workspace = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Export Target Workspace'
  });
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
  const target = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Export Access Target'
  });
  const targetWorkspaceUserId = await resolveActorForWorkspace(target.id);
  assert.ok(targetWorkspaceUserId, 'expected operator membership in the target workspace');
  setActiveWorkspaceUser(targetWorkspaceUserId);

  const second = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Second Workspace Export Test'
  });
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

test('workspace mutations and member lists are gated on the target workspace, not the active one', async () => {
  // Restore the org-admin actor: the previous test leaves the active actor as
  // a plain viewer of one workspace, who is no longer an organization admin.
  setActiveWorkspaceUser(operatorWorkspaceUserId);
  const target = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Tenancy Gate Target'
  });

  // An admin of their *own* workspace is still an outsider to `target`.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, NULL, ?, ?)`
  ).run('outsider-user', 'outsider-user', 'outsider@overlord.local', now, now);

  await withRequestContextAsync(async () => {
    setActiveProfileId('outsider-user');
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);
    await createOrganizationOnboarding({
      organizationName: 'Outsider Org',
      workspaceName: 'Outsider Workspace'
    });

    await assert.rejects(
      updateWorkspace(target.id, { name: 'Hijacked' }),
      /no active membership/,
      'an outsider must not be able to rename another tenant'
    );
    await assert.rejects(
      deleteWorkspace(target.id),
      /no active membership/,
      'an outsider must not be able to delete another tenant'
    );
    await assert.rejects(
      listWorkspaceMembers(target.id),
      /no active membership/,
      "an outsider must not be able to enumerate another tenant's members"
    );
  });

  // A plain MEMBER of the target may list its members but not administer it.
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, NULL, ?, ?)`
  ).run('gate-member-user', 'gate-member-user', 'gate-member@overlord.local', now, now);
  db.prepare(
    `INSERT INTO workspace_users
       (id, workspace_id, profile_id, member_key, status, metadata_json,
        created_at, updated_at, revision)
     VALUES (?, ?, 'gate-member-user', 'auth:gate-member-user', 'active', '{}', ?, ?, 1)`
  ).run('gate-member-membership', target.id, now, now);
  db.prepare(
    `INSERT INTO role_assignments
       (id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
        assigned_by_workspace_user_id, created_at, updated_at, revision)
     VALUES (?, ?, 'gate-member-membership', 'MEMBER', '', '', 'gate-member-membership', ?, ?, 1)`
  ).run('gate-member-membership-role', target.id, now, now);

  await withRequestContextAsync(async () => {
    setActiveProfileId('gate-member-user');
    await setActiveWorkspace(target.id);

    const members = await listWorkspaceMembers(target.id);
    const self = members.find(member => member.workspaceUserId === 'gate-member-membership');
    assert.ok(self, 'a member sees their own workspace member list');
    assert.equal(self.isOperator, true, 'isOperator marks the calling profile');

    await assert.rejects(
      updateWorkspace(target.id, { name: 'Renamed By Member' }),
      /Manager role required/
    );
    await assert.rejects(deleteWorkspace(target.id), /Admin role required/);
  });

  const row = db.prepare(`SELECT name, deleted_at FROM workspaces WHERE id = ?`).get(target.id) as {
    name: string;
    deleted_at: string | null;
  };
  assert.equal(row.name, 'Tenancy Gate Target');
  assert.equal(row.deleted_at, null);
});

test('deleteWorkspace tombstones the workspace and activates the oldest remaining one', async () => {
  setActiveWorkspaceUser(operatorWorkspaceUserId);
  const doomed = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Doomed Workspace'
  });
  assert.equal(dbModule.WORKSPACE.id, doomed.id, 'creation makes the new workspace active');

  const list = await deleteWorkspace(doomed.id);

  assert.ok(
    list.every(workspace => workspace.id !== doomed.id),
    'the deleted workspace disappears from the list'
  );
  const row = db.prepare(`SELECT deleted_at FROM workspaces WHERE id = ?`).get(doomed.id) as {
    deleted_at: string | null;
  };
  assert.ok(row.deleted_at, 'the workspace row is tombstoned, not removed');
  assert.notEqual(dbModule.WORKSPACE.id, doomed.id, 'the active workspace moved off the tombstone');
});

test.after(async () => {
  rmSync(tempDir, { recursive: true, force: true });
  await setActiveWorkspace('local-workspace');
  setActiveWorkspaceUser(operatorWorkspaceUserId);
});
