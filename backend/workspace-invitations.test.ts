import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(tmpdir(), 'overlord-webapp-workspace-invitations-'));
process.env.OVERLORD_SQLITE_PATH = path.join(tempDir, 'webapp.sqlite');
delete process.env.RESEND_API_KEY;

const dbModule = await import('./db.ts');
const {
  db,
  getActiveWorkspaceId,
  getActorWorkspaceUserId,
  initDatabase,
  setActiveProfileId,
  setActiveWorkspaceContext,
  setActiveWorkspaceUser,
  withRequestContextAsync
} = dbModule;
await initDatabase();
const { loadActorRoles, actorCan } = await import('./rbac.ts');
const { PERMISSIONS } = await import('@overlord/auth');
const { seedAuthenticatedOperator } = await import('./test-helpers.ts');
const {
  acceptWorkspaceInvitation,
  createWorkspace,
  inviteWorkspaceMember,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  listWorkspaces,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
  updateWorkspaceMemberRole
} = await import('./workspaces.ts');

const operatorWorkspaceUserId = seedAuthenticatedOperator({ db });
setActiveWorkspaceUser(operatorWorkspaceUserId);

function insertProfile(profileId: string, email: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, NULL, ?, ?)`
  ).run(profileId, profileId, email, now, now);
}

function tokenFromAcceptUrl(acceptUrl: string): string {
  const token = new URL(acceptUrl).searchParams.get('token');
  assert.ok(token, 'expected acceptUrl to carry a token query param');
  return token;
}

test('admin can invite an email and the invitee joins only that workspace with the granted role', async () => {
  // A second workspace the invitee is never invited to, so we can prove
  // acceptance does not leak membership into it.
  const otherWorkspace = await createWorkspace({ name: 'Not Invited Here' });

  const inviteResult = await inviteWorkspaceMember('local-workspace', {
    email: 'test@cooperativ.io',
    roleKey: 'MEMBER'
  });
  assert.equal(inviteResult.invitation.status, 'pending');
  assert.equal(inviteResult.invitation.email, 'test@cooperativ.io');
  assert.equal(inviteResult.invitation.roleKey, 'MEMBER');
  assert.ok(
    inviteResult.acceptUrl,
    'expected a manual accept URL with no RESEND_API_KEY configured'
  );

  const invitations = await listWorkspaceInvitations('local-workspace');
  assert.ok(invitations.some(inv => inv.id === inviteResult.invitation.id));

  const token = tokenFromAcceptUrl(inviteResult.acceptUrl!);
  insertProfile('invited-test-user', 'test@cooperativ.io');

  const joinedWorkspace = await withRequestContextAsync(async () => {
    setActiveProfileId('invited-test-user');
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);

    const workspace = await acceptWorkspaceInvitation({ token });

    const visibleWorkspaces = await listWorkspaces();
    assert.deepEqual(
      visibleWorkspaces.map(w => w.id),
      ['local-workspace'],
      'the invitee must see only the workspace they were invited to, not other workspaces'
    );

    return workspace;
  });
  assert.equal(joinedWorkspace.id, 'local-workspace');

  const membership = db
    .prepare(
      `SELECT id FROM workspace_users
         WHERE workspace_id = 'local-workspace' AND profile_id = 'invited-test-user'
           AND status = 'active' AND deleted_at IS NULL`
    )
    .get() as { id: string } | undefined;
  assert.ok(membership, 'expected the invitee to gain a workspace_users row');
  assert.deepEqual(
    await loadActorRoles({ workspaceId: 'local-workspace', workspaceUserId: membership!.id }),
    ['MEMBER'],
    'the invitee must be granted exactly the invited role, not ADMIN'
  );

  const otherWorkspaceMembers = db
    .prepare(
      `SELECT id FROM workspace_users WHERE workspace_id = ? AND profile_id = 'invited-test-user'`
    )
    .all(otherWorkspace.id);
  assert.deepEqual(
    otherWorkspaceMembers,
    [],
    'accepting must not leak into an uninvited workspace'
  );
});

test('accepting an invitation attributes subsequent request changes to the invitee, not the oldest member', async () => {
  // `local-workspace` already has an older member (the seeded operator) plus the
  // invitees other tests joined earlier — so the workspace's *oldest* active
  // member is emphatically not this invitee. Before the fix, `setActiveWorkspace`
  // resolved that oldest member and wrote it into the request context, so any
  // change recorded after `acceptWorkspaceInvitation` returned was misattributed.
  const invite = await inviteWorkspaceMember('local-workspace', {
    email: 'attribution-invitee@cooperativ.io',
    roleKey: 'MEMBER'
  });
  insertProfile('attribution-invitee-user', 'attribution-invitee@cooperativ.io');

  await withRequestContextAsync(async () => {
    setActiveProfileId('attribution-invitee-user');
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);

    await acceptWorkspaceInvitation({ token: tokenFromAcceptUrl(invite.acceptUrl!) });

    const inviteeWorkspaceUserId = (
      db
        .prepare(
          `SELECT id FROM workspace_users
             WHERE workspace_id = 'local-workspace' AND profile_id = 'attribution-invitee-user'
               AND status = 'active' AND deleted_at IS NULL`
        )
        .get() as { id: string }
    ).id;

    const oldestMember = db
      .prepare(
        `SELECT id FROM workspace_users
           WHERE workspace_id = 'local-workspace' AND status = 'active' AND deleted_at IS NULL
           ORDER BY created_at ASC LIMIT 1`
      )
      .get() as { id: string };
    assert.notEqual(
      oldestMember.id,
      inviteeWorkspaceUserId,
      'sanity: the invitee must not be the oldest member, or the test proves nothing'
    );

    assert.equal(
      getActiveWorkspaceId(),
      'local-workspace',
      'accepting should drop the invitee into the joined workspace'
    );
    assert.equal(
      getActorWorkspaceUserId(),
      inviteeWorkspaceUserId,
      'changes after accepting must be attributed to the invitee, not the workspace oldest member'
    );
  });
});

test('accepting an invitation never leaks into the process-wide default workspace/actor', async () => {
  // `createWorkspace` here runs with no request context (like the rest of this
  // file's top-level setup), so it legitimately updates the process-wide
  // fallback itself — that's the bootstrap/loopback path, not what this test
  // is checking. Snapshot the fallback *after* creation, immediately before
  // the request-scoped accept, which must leave it untouched.
  const otherWorkspace = await createWorkspace({ name: 'Leak Check Workspace' });
  const defaultWorkspaceIdBefore = dbModule.WORKSPACE.id;
  const defaultActorBefore = dbModule.ACTOR_WORKSPACE_USER_ID;

  const invite = await inviteWorkspaceMember(otherWorkspace.id, {
    email: 'no-leak-invitee@cooperativ.io',
    roleKey: 'MEMBER'
  });
  insertProfile('no-leak-invitee-user', 'no-leak-invitee@cooperativ.io');

  await withRequestContextAsync(async () => {
    setActiveProfileId('no-leak-invitee-user');
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);

    await acceptWorkspaceInvitation({ token: tokenFromAcceptUrl(invite.acceptUrl!) });

    assert.equal(
      getActiveWorkspaceId(),
      otherWorkspace.id,
      'this request must see the newly-joined workspace as active'
    );
  });

  // Outside the request, the process-wide fallback must be exactly what it
  // was before — the request-scoped switch must never have mutated it.
  assert.equal(
    dbModule.WORKSPACE.id,
    defaultWorkspaceIdBefore,
    'a request-scoped workspace switch must not leak into the process-wide default workspace'
  );
  assert.equal(
    dbModule.ACTOR_WORKSPACE_USER_ID,
    defaultActorBefore,
    'a request-scoped workspace switch must not leak into the process-wide default actor'
  );
});

test('a user who was never invited cannot join with a fabricated token', async () => {
  insertProfile('never-invited-user', 'never-invited@cooperativ.io');

  await withRequestContextAsync(async () => {
    setActiveProfileId('never-invited-user');
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);

    await assert.rejects(
      () => acceptWorkspaceInvitation({ token: 'inv_not-a-real-token' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { status?: number }).status, 404);
        return true;
      }
    );

    const memberships = db
      .prepare(`SELECT id FROM workspace_users WHERE profile_id = 'never-invited-user'`)
      .all();
    assert.deepEqual(memberships, []);
  });
});

test('a revoked invitation can no longer be accepted', async () => {
  const inviteResult = await inviteWorkspaceMember('local-workspace', {
    email: 'revoked-invitee@cooperativ.io'
  });
  const token = tokenFromAcceptUrl(inviteResult.acceptUrl!);

  await revokeWorkspaceInvitation('local-workspace', inviteResult.invitation.id);
  const invitations = await listWorkspaceInvitations('local-workspace');
  const revoked = invitations.find(inv => inv.id === inviteResult.invitation.id);
  assert.equal(revoked?.status, 'revoked');

  insertProfile('revoked-invitee', 'revoked-invitee@cooperativ.io');
  await withRequestContextAsync(async () => {
    setActiveProfileId('revoked-invitee');
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);

    await assert.rejects(
      () => acceptWorkspaceInvitation({ token }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { status?: number }).status, 409);
        return true;
      }
    );
  });
});

test('an expired invitation is marked expired and can no longer be accepted', async () => {
  const inviteResult = await inviteWorkspaceMember('local-workspace', {
    email: 'expired-invitee@cooperativ.io'
  });
  const token = tokenFromAcceptUrl(inviteResult.acceptUrl!);

  db.prepare(
    `UPDATE workspace_invitations
        SET expires_at = ?
      WHERE id = ?`
  ).run('2000-01-01T00:00:00.000Z', inviteResult.invitation.id);

  insertProfile('expired-invitee', 'expired-invitee@cooperativ.io');
  await withRequestContextAsync(async () => {
    setActiveProfileId('expired-invitee');
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);

    await assert.rejects(
      () => acceptWorkspaceInvitation({ token }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { status?: number }).status, 410);
        return true;
      }
    );
  });

  const expired = db
    .prepare(`SELECT status FROM workspace_invitations WHERE id = ?`)
    .get(inviteResult.invitation.id) as { status: string } | undefined;
  assert.equal(expired?.status, 'expired');

  const memberships = db
    .prepare(`SELECT id FROM workspace_users WHERE profile_id = 'expired-invitee'`)
    .all();
  assert.deepEqual(memberships, []);
});

test('a non-admin member cannot invite anyone', async () => {
  insertProfile('plain-member', 'plain-member@cooperativ.io');
  const now = new Date().toISOString();
  const memberWorkspaceUserId = 'plain-member-workspace-user';
  db.prepare(
    `INSERT INTO workspace_users
       (id, workspace_id, profile_id, member_key, status, metadata_json, created_at, updated_at, revision)
     VALUES (?, 'local-workspace', 'plain-member', 'auth:plain-member', 'active', '{}', ?, ?, 1)`
  ).run(memberWorkspaceUserId, now, now);
  db.prepare(
    `INSERT INTO role_assignments
       (id, workspace_id, workspace_user_id, role_key, resource_type, resource_id,
        assigned_by_workspace_user_id, created_at, updated_at, revision)
     VALUES (?, 'local-workspace', ?, 'MEMBER', '', '', ?, ?, ?, 1)`
  ).run(`${memberWorkspaceUserId}-role`, memberWorkspaceUserId, memberWorkspaceUserId, now, now);

  const previousActor = operatorWorkspaceUserId;
  setActiveWorkspaceUser(memberWorkspaceUserId);
  try {
    await assert.rejects(
      () => inviteWorkspaceMember('local-workspace', { email: 'someone@cooperativ.io' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { status?: number }).status, 403);
        return true;
      }
    );
  } finally {
    setActiveWorkspaceUser(previousActor);
  }
});

test("an admin can remove a member, but not the workspace's only remaining member", async () => {
  // A dedicated workspace so its membership count isn't polluted by the
  // invitees other tests already accepted into 'local-workspace'.
  const workspace = await createWorkspace({ name: 'Removal Guard Workspace' });
  const creatorWorkspaceUserId = (await listWorkspaceMembers(workspace.id))[0]?.workspaceUserId;
  assert.ok(creatorWorkspaceUserId);

  const inviteResult = await inviteWorkspaceMember(workspace.id, {
    email: 'removable-member@cooperativ.io'
  });
  const token = tokenFromAcceptUrl(inviteResult.acceptUrl!);
  insertProfile('removable-member', 'removable-member@cooperativ.io');

  const removableWorkspaceUserId = await withRequestContextAsync(async () => {
    setActiveProfileId('removable-member');
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);
    await acceptWorkspaceInvitation({ token });

    const row = db
      .prepare(
        `SELECT id FROM workspace_users
           WHERE workspace_id = ? AND profile_id = 'removable-member'`
      )
      .get(workspace.id) as { id: string };
    return row.id;
  });

  await removeWorkspaceMember(workspace.id, removableWorkspaceUserId);
  const remainingMembers = await listWorkspaceMembers(workspace.id);
  assert.deepEqual(
    remainingMembers.map(m => m.workspaceUserId),
    [creatorWorkspaceUserId]
  );

  // Now only the creator remains active in this workspace; removing them too
  // must be refused.
  await assert.rejects(
    () => removeWorkspaceMember(workspace.id, creatorWorkspaceUserId!),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { status?: number }).status, 409);
      return true;
    }
  );
});

test('admins can promote and demote members, but cannot remove or demote the last admin', async () => {
  const workspace = await createWorkspace({ name: 'Role Guard Workspace' });
  const creatorWorkspaceUserId = (await listWorkspaceMembers(workspace.id))[0]?.workspaceUserId;
  assert.ok(creatorWorkspaceUserId);

  const inviteResult = await inviteWorkspaceMember(workspace.id, {
    email: 'role-managed-member@cooperativ.io'
  });
  const token = tokenFromAcceptUrl(inviteResult.acceptUrl!);
  insertProfile('role-managed-member', 'role-managed-member@cooperativ.io');

  const memberWorkspaceUserId = await withRequestContextAsync(async () => {
    setActiveProfileId('role-managed-member');
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);
    await acceptWorkspaceInvitation({ token });

    const row = db
      .prepare(
        `SELECT id FROM workspace_users
           WHERE workspace_id = ? AND profile_id = 'role-managed-member'`
      )
      .get(workspace.id) as { id: string };
    return row.id;
  });

  assert.deepEqual(
    await loadActorRoles({ workspaceId: workspace.id, workspaceUserId: memberWorkspaceUserId }),
    ['MEMBER']
  );

  const promoted = await updateWorkspaceMemberRole(workspace.id, memberWorkspaceUserId, {
    roleKey: 'ADMIN'
  });
  assert.equal(promoted.isAdmin, true);
  assert.deepEqual(promoted.roleKeys, ['ADMIN']);

  const demoted = await updateWorkspaceMemberRole(workspace.id, memberWorkspaceUserId, {
    roleKey: 'MEMBER'
  });
  assert.equal(demoted.isAdmin, false);
  assert.deepEqual(demoted.roleKeys, ['MEMBER']);

  await assert.rejects(
    () => updateWorkspaceMemberRole(workspace.id, creatorWorkspaceUserId!, { roleKey: 'MEMBER' }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { status?: number }).status, 409);
      return true;
    }
  );

  await assert.rejects(
    () => removeWorkspaceMember(workspace.id, creatorWorkspaceUserId!),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { status?: number }).status, 409);
      return true;
    }
  );
});

test('an invited MEMBER can switch (activate) between the workspaces they belong to', async () => {
  // Regression: the `/api/workspaces/:id/activate` route is gated by
  // `WORKSPACE_ACTIVATE`. Before the fix the default MEMBER role lacked that
  // grant, so an invited member could see a workspace in their switcher but
  // every activate call 403'd — the switch appeared to fail and they were left
  // on (bounced back to) their default workspace.
  const invite = await inviteWorkspaceMember('local-workspace', {
    email: 'switcher@cooperativ.io',
    roleKey: 'MEMBER'
  });
  insertProfile('switcher-user', 'switcher@cooperativ.io');

  // The member owns their own workspace and accepts the invite to a second one.
  let ownWorkspaceId = '';
  let jakeMemberId = '';
  await withRequestContextAsync(async () => {
    setActiveProfileId('switcher-user');
    setActiveWorkspaceContext(null);
    setActiveWorkspaceUser(null);
    ownWorkspaceId = (await createWorkspace({ name: 'Switcher Own' })).id;
    await acceptWorkspaceInvitation({ token: tokenFromAcceptUrl(invite.acceptUrl!) });
  });

  jakeMemberId = (
    db
      .prepare(
        `SELECT id FROM workspace_users
           WHERE workspace_id = 'local-workspace' AND profile_id = 'switcher-user'
             AND status = 'active'`
      )
      .get() as { id: string }
  ).id;
  assert.deepEqual(
    await loadActorRoles({ workspaceId: 'local-workspace', workspaceUserId: jakeMemberId }),
    ['MEMBER'],
    'the invitee joins the invited workspace as a plain MEMBER'
  );

  // Acting as that MEMBER inside the invited workspace, the activate route gate
  // (evaluated in the current workspace context) must permit switching.
  await withRequestContextAsync(async () => {
    setActiveProfileId('switcher-user');
    setActiveWorkspaceContext({
      id: 'local-workspace',
      slug: 'local',
      name: 'Local',
      kind: 'user'
    });
    setActiveWorkspaceUser(jakeMemberId);
    assert.ok(
      await actorCan(PERMISSIONS.WORKSPACE_ACTIVATE),
      'a MEMBER must be able to activate/switch their workspace'
    );
  });
  assert.ok(ownWorkspaceId, 'sanity: the member also owns their onboarding workspace');
});

test.after(async () => {
  rmSync(tempDir, { recursive: true, force: true });
});
