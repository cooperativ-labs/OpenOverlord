import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join('/tmp', 'ovld-protocol-create-project-'));
const { bootstrapIntegrationTestDb, DEFAULT_TEST_ORGANIZATION_ID } =
  await import('./test-helpers.ts');
const { WORKSPACE } = await bootstrapIntegrationTestDb({
  sqlitePath: path.join(tempDir, 'webapp.sqlite')
});
const primaryWorkspaceId = WORKSPACE.id;

const { createWorkspace } = await import('./workspaces.ts');
const { runProtocolSubcommand } = await import('./protocol.ts');

type CreateProjectResult =
  | {
      status: 'created';
      project: { id: string; name: string; slug: string };
      workspace: { id: string; name: string; slug: string };
    }
  | {
      status: 'workspace_selection_required';
      message: string;
      workspaces: Array<{ id: string; name: string; slug: string }>;
    };

// Assigned by the first multi-workspace test so later tests can target it.
let secondaryId = '';
let secondaryName = '';

test('create-project uses the sole workspace when the caller has one membership', async () => {
  const result = (await runProtocolSubcommand('create-project', {
    flags: { '--name': 'Solo Workspace Project' }
  })) as CreateProjectResult;
  assert.equal(result.status, 'created');
  assert.equal(result.status === 'created' && result.project.name, 'Solo Workspace Project');
  assert.equal(result.status === 'created' && result.workspace.id, primaryWorkspaceId);
});

test('create-project asks the user to choose when the caller has multiple workspaces', async () => {
  const secondary = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Second Workspace'
  });
  secondaryId = secondary.id;
  secondaryName = secondary.name;

  const result = (await runProtocolSubcommand('create-project', {
    flags: { '--name': 'Ambiguous Project' }
  })) as CreateProjectResult;

  assert.equal(result.status, 'workspace_selection_required');
  if (result.status !== 'workspace_selection_required') return;
  const ids = result.workspaces.map(w => w.id).sort();
  assert.deepEqual(ids, [primaryWorkspaceId, secondaryId].sort());
});

test('create-project honors an explicit workspace id when memberships are ambiguous', async () => {
  const result = (await runProtocolSubcommand('create-project', {
    flags: { '--name': 'Chosen Project', '--workspace-id': secondaryId }
  })) as CreateProjectResult;
  assert.equal(result.status, 'created');
  assert.equal(result.status === 'created' && result.workspace.id, secondaryId);
});

test('create-project resolves an explicit workspace by name', async () => {
  const result = (await runProtocolSubcommand('create-project', {
    flags: { '--name': 'Named Workspace Project', '--workspace-id': secondaryName }
  })) as CreateProjectResult;
  assert.equal(result.status, 'created');
  assert.equal(result.status === 'created' && result.workspace.id, secondaryId);
});

test('create-project rejects a workspace the caller does not belong to', async () => {
  await assert.rejects(
    runProtocolSubcommand('create-project', {
      flags: { '--name': 'Orphan Project', '--workspace-id': 'not-a-real-workspace' }
    }),
    /Workspace not found or not a member/
  );
});
