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
const { seedAuthenticatedOperator } = await import('./test-helpers.ts');
const { completeInitialSetup, createWorkspace, needsInitialSetup } =
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

  const ticketSequence = db
    .prepare(`SELECT workspace_id, scope_id FROM ticket_sequences WHERE id = ?`)
    .get('local-workspace-ticket-sequence') as { workspace_id: string; scope_id: string };
  assert.deepEqual(ticketSequence, {
    workspace_id: 'acme-operations',
    scope_id: 'acme-operations'
  });
});

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  setActiveWorkspace('local-workspace');
  setActiveWorkspaceUser(operatorWorkspaceUserId);
});
