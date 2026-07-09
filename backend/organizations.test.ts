import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-organizations-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');
delete process.env.RESEND_API_KEY;

const dbModule = await import('./db.ts');
const {
  db,
  initDatabase,
  setActiveProfileId,
  setActiveWorkspaceContext,
  setActiveWorkspaceUser,
  withRequestContextAsync
} = dbModule;
await initDatabase();

const { DEFAULT_TEST_ORGANIZATION_ID, seedAuthenticatedOperator } =
  await import('./test-helpers.ts');
const {
  acceptWorkspaceInvitation,
  createOrganizationOnboarding,
  createWorkspace,
  deleteWorkspace,
  inviteWorkspaceMember,
  listWorkspaceMembers,
  updateWorkspaceMemberRole
} = await import('./workspaces.ts');
const {
  addOrganizationAdmin,
  listOrganizationAdmins,
  removeOrganizationAdmin,
  updateOrganization
} = await import('./organizations.ts');
const { buildMeta } = await import('./http/meta.ts');

const operatorWorkspaceUserId = seedAuthenticatedOperator({ db });
setActiveWorkspaceUser(operatorWorkspaceUserId);

let profileCounter = 0;
function insertProfile(): { profileId: string; email: string } {
  profileCounter += 1;
  const profileId = `org-test-profile-${profileCounter}`;
  const email = `${profileId}@overlord.local`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, NULL, ?, ?)`
  ).run(profileId, profileId, email, now, now);
  return { profileId, email };
}

function tokenFromAcceptUrl(acceptUrl: string): string {
  const token = new URL(acceptUrl).searchParams.get('token');
  assert.ok(token, 'expected acceptUrl to carry a token query param');
  return token;
}

/** Invite `email` into `workspaceId` and accept as a brand-new profile, returning their workspace_user id. */
async function inviteAndAccept({
  workspaceId,
  roleKey
}: {
  workspaceId: string;
  roleKey?: string;
}): Promise<{ profileId: string; workspaceUserId: string }> {
  const { profileId, email } = insertProfile();
  const inviteResult = await inviteWorkspaceMember(workspaceId, { email, roleKey });
  const token = tokenFromAcceptUrl(inviteResult.acceptUrl!);

  const workspaceUserId = await withRequestContextAsync(async () => {
    setActiveProfileId(profileId);
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);
    await acceptWorkspaceInvitation({ token });
    const row = db
      .prepare(`SELECT id FROM workspace_users WHERE workspace_id = ? AND profile_id = ?`)
      .get(workspaceId, profileId) as { id: string };
    return row.id;
  });

  return { profileId, workspaceUserId };
}

function assertRejectsWithStatus(promise: Promise<unknown>, status: number): Promise<void> {
  return assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal((err as { status?: number }).status, status);
    return true;
  });
}

async function workspaceUserIdFor(workspaceId: string, profileId: string): Promise<string> {
  const row = db
    .prepare(`SELECT id FROM workspace_users WHERE workspace_id = ? AND profile_id = ?`)
    .get(workspaceId, profileId) as { id: string } | undefined;
  assert.ok(row, `expected ${profileId} to be a member of ${workspaceId}`);
  return row!.id;
}

/**
 * A brand-new, fully isolated organization with two workspaces, both owned by
 * a single founder profile — so admin-count assertions in a test can't be
 * polluted by admins other tests added to the shared DEFAULT_TEST_ORGANIZATION_ID.
 */
async function freshOrgWithTwoWorkspaces(): Promise<{
  founderProfileId: string;
  orgId: string;
  workspaceAId: string;
  workspaceBId: string;
}> {
  const { profileId: founderProfileId } = insertProfile();

  const workspaceA = await withRequestContextAsync(async () => {
    setActiveProfileId(founderProfileId);
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);
    return createOrganizationOnboarding({
      organizationName: `Isolated Org ${founderProfileId}`,
      workspaceName: 'Workspace A'
    });
  });

  const workspaceB = await withRequestContextAsync(async () => {
    setActiveProfileId(founderProfileId);
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(await workspaceUserIdFor(workspaceA.id, founderProfileId));
    return createWorkspace({ organizationId: workspaceA.organizationId, name: 'Workspace B' });
  });

  return {
    founderProfileId,
    orgId: workspaceA.organizationId,
    workspaceAId: workspaceA.id,
    workspaceBId: workspaceB.id
  };
}

test('org admin (ADMIN of every constituent workspace) is the sole listed admin for a fresh org', async () => {
  const secondWorkspace = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Org Admin Test Workspace'
  });

  const admins = await listOrganizationAdmins(DEFAULT_TEST_ORGANIZATION_ID);
  assert.deepEqual(admins.map(admin => admin.userId).sort(), ['operator-user']);

  // Creating a workspace auto-grants ADMIN in the new workspace to every
  // current org admin (Q3), so the operator stays a full org admin.
  const members = await listWorkspaceMembers(secondWorkspace.id);
  assert.deepEqual(
    members.filter(m => m.roleKeys.includes('ADMIN')).map(m => m.workspaceUserId),
    [members[0]?.workspaceUserId]
  );
});

test('R1 — a single-workspace admin cannot escalate to organization admin', async () => {
  const workspace = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Escalation Guard Workspace'
  });
  const { profileId, workspaceUserId } = await inviteAndAccept({ workspaceId: workspace.id });
  await updateWorkspaceMemberRole(workspace.id, workspaceUserId, { roleKey: 'ADMIN' });

  // Now ADMIN of `workspace` only — not an organization admin, since the
  // organization has other constituent workspaces this profile isn't ADMIN of.
  await withRequestContextAsync(async () => {
    setActiveProfileId(profileId);
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(workspaceUserId);

    await assertRejectsWithStatus(
      addOrganizationAdmin(DEFAULT_TEST_ORGANIZATION_ID, { userId: profileId }),
      403
    );
    await assertRejectsWithStatus(
      updateOrganization(DEFAULT_TEST_ORGANIZATION_ID, { name: 'Hijacked Org Name' }),
      403
    );
  });
});

test('addOrganizationAdmin grants ADMIN in every constituent workspace, auto-joining missing ones', async () => {
  const workspace = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Add Admin Target Workspace'
  });
  const { profileId, workspaceUserId } = await inviteAndAccept({ workspaceId: workspace.id });
  await updateWorkspaceMemberRole(workspace.id, workspaceUserId, { roleKey: 'ADMIN' });

  const admins = await addOrganizationAdmin(DEFAULT_TEST_ORGANIZATION_ID, { userId: profileId });
  assert.ok(admins.some(admin => admin.userId === profileId));
  assert.ok(admins.some(admin => admin.userId === 'operator-user'));

  // They were never a member of 'local-workspace' — addOrganizationAdmin must
  // auto-join them there and grant ADMIN so the org-admin invariant holds.
  const localMembers = await listWorkspaceMembers('local-workspace');
  const joined = localMembers.find(m => m.userId === profileId);
  assert.ok(
    joined,
    'expected the promoted user to be auto-joined into every constituent workspace'
  );
  assert.deepEqual(joined!.roleKeys, ['ADMIN']);
});

test('removeOrganizationAdmin demotes to MEMBER everywhere but refuses to remove the last admin', async () => {
  // An isolated fresh org (rather than the shared DEFAULT_TEST_ORGANIZATION_ID)
  // so the admin count here can't be polluted by admins other tests added.
  const { founderProfileId, orgId, workspaceAId, workspaceBId } = await freshOrgWithTwoWorkspaces();

  const { profileId, workspaceUserId } = await withRequestContextAsync(async () => {
    setActiveProfileId(founderProfileId);
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(await workspaceUserIdFor(workspaceBId, founderProfileId));
    return inviteAndAccept({ workspaceId: workspaceBId });
  });
  await withRequestContextAsync(async () => {
    setActiveProfileId(founderProfileId);
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(await workspaceUserIdFor(workspaceBId, founderProfileId));
    await updateWorkspaceMemberRole(workspaceBId, workspaceUserId, { roleKey: 'ADMIN' });
    await addOrganizationAdmin(orgId, { userId: profileId });
  });

  await withRequestContextAsync(async () => {
    setActiveProfileId(founderProfileId);
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(await workspaceUserIdFor(workspaceAId, founderProfileId));

    const afterAdd = await listOrganizationAdmins(orgId);
    assert.deepEqual(
      afterAdd.map(admin => admin.userId).sort(),
      [founderProfileId, profileId].sort()
    );

    const afterRemoval = await removeOrganizationAdmin(orgId, { userId: profileId });
    assert.deepEqual(
      afterRemoval.map(admin => admin.userId),
      [founderProfileId]
    );
    const workspaceAMembers = await listWorkspaceMembers(workspaceAId);
    assert.deepEqual(workspaceAMembers.find(m => m.userId === profileId)?.roleKeys, ['MEMBER']);

    await assertRejectsWithStatus(
      removeOrganizationAdmin(orgId, { userId: founderProfileId }),
      409
    );
  });
});

test('updateOrganization requires a full organization admin and fans out one entity_changes row per workspace', async () => {
  const workspace = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Rename Fanout Workspace'
  });

  const before = db
    .prepare(
      `SELECT COUNT(*) AS count FROM entity_changes WHERE entity_type = 'organization' AND entity_id = ?`
    )
    .get(DEFAULT_TEST_ORGANIZATION_ID) as { count: number };

  const updated = await updateOrganization(DEFAULT_TEST_ORGANIZATION_ID, {
    name: 'Renamed Organization'
  });
  assert.equal(updated.name, 'Renamed Organization');

  const workspaceCount = db
    .prepare(
      `SELECT COUNT(*) AS count FROM workspaces WHERE organization_id = ? AND deleted_at IS NULL`
    )
    .get(DEFAULT_TEST_ORGANIZATION_ID) as { count: number };
  assert.ok(
    workspaceCount.count >= 2,
    'expected the org to have accumulated workspaces from earlier tests'
  );

  const after = db
    .prepare(
      `SELECT COUNT(*) AS count FROM entity_changes WHERE entity_type = 'organization' AND entity_id = ?`
    )
    .get(DEFAULT_TEST_ORGANIZATION_ID) as { count: number };
  assert.equal(after.count - before.count, workspaceCount.count);

  void workspace;
});

test('deleting the last workspace of an organization tombstones the organization (Q9)', async () => {
  const { profileId, email } = insertProfile();
  void email;

  const orphanedOrgId = await withRequestContextAsync(async () => {
    setActiveProfileId(profileId);
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);

    const created = await createOrganizationOnboarding({
      organizationName: 'Soon Deleted Org',
      workspaceName: 'Only Workspace'
    });
    return created.organizationId;
  });

  const orgRow = () =>
    db.prepare(`SELECT deleted_at FROM organizations WHERE id = ?`).get(orphanedOrgId) as {
      deleted_at: string | null;
    };
  assert.equal(orgRow().deleted_at, null);

  const workspaceRow = db
    .prepare(`SELECT id FROM workspaces WHERE organization_id = ? AND deleted_at IS NULL`)
    .get(orphanedOrgId) as { id: string };

  await withRequestContextAsync(async () => {
    setActiveProfileId(profileId);
    setActiveWorkspaceContext(null);
    const workspaceUser = db
      .prepare(`SELECT id FROM workspace_users WHERE workspace_id = ? AND profile_id = ?`)
      .get(workspaceRow.id, profileId) as { id: string };
    setActiveWorkspaceUser(workspaceUser.id);
    await deleteWorkspace(workspaceRow.id);
  });

  assert.ok(
    orgRow().deleted_at,
    'expected deleting the last workspace to tombstone the organization'
  );
});

test('MANAGER caps: may invite/promote up to MANAGER, never grant, demote, or remove ADMIN', async () => {
  const workspace = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Manager Cap Workspace'
  });
  const adminWorkspaceUserId = (await listWorkspaceMembers(workspace.id))[0]?.workspaceUserId;
  assert.ok(adminWorkspaceUserId, 'expected workspace to have an admin member');

  const manager = await inviteAndAccept({ workspaceId: workspace.id });
  await updateWorkspaceMemberRole(workspace.id, manager.workspaceUserId, { roleKey: 'MANAGER' });

  await withRequestContextAsync(async () => {
    setActiveProfileId(manager.profileId);
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(manager.workspaceUserId);

    // May invite up to MANAGER, never ADMIN.
    const { email: memberEmail } = insertProfile();
    const memberInvite = await inviteWorkspaceMember(workspace.id, {
      email: memberEmail,
      roleKey: 'MANAGER'
    });
    assert.equal(memberInvite.invitation.roleKey, 'MANAGER');

    const { email: adminEmail } = insertProfile();
    await assertRejectsWithStatus(
      inviteWorkspaceMember(workspace.id, { email: adminEmail, roleKey: 'ADMIN' }),
      403
    );

    // May not promote an existing member to ADMIN.
    const other = await inviteAndAccept({ workspaceId: workspace.id });
    await assertRejectsWithStatus(
      updateWorkspaceMemberRole(workspace.id, other.workspaceUserId, { roleKey: 'ADMIN' }),
      403
    );

    // May not demote or remove the workspace's existing ADMIN.
    await assertRejectsWithStatus(
      updateWorkspaceMemberRole(workspace.id, adminWorkspaceUserId, { roleKey: 'MEMBER' }),
      403
    );
  });
});

test('zero-workspace boot: buildMeta returns nulls/empties before onboarding', async () => {
  const { profileId } = insertProfile();

  await withRequestContextAsync(async () => {
    setActiveProfileId(profileId);
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);

    const meta = await buildMeta();
    assert.equal(meta.organization, null);
    assert.deepEqual(meta.organizations, []);
    assert.deepEqual(meta.workspaces, []);
    assert.equal(meta.workspace, null);
  });
});
