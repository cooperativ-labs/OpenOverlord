import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join('/tmp', 'ovld-protocol-register-target-'));
const { bootstrapIntegrationTestDb, DEFAULT_TEST_ORGANIZATION_ID } =
  await import('./test-helpers.ts');
const { WORKSPACE } = await bootstrapIntegrationTestDb({
  sqlitePath: path.join(tempDir, 'webapp.sqlite')
});
const primaryWorkspaceId = WORKSPACE.id;

const { createWorkspace } = await import('./workspaces.ts');
const { runProtocolSubcommand } = await import('./protocol.ts');

type RegisterTargetResult =
  | {
      status: 'registered';
      executionTarget: {
        executionTargetId: string;
        deviceId: string;
        label: string;
        targetFingerprint: string;
      };
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

test('register-target announces the acting machine in the sole workspace with a name', async () => {
  const result = (await runProtocolSubcommand('register-target', {
    flags: { '--name': 'ci-runner-01' }
  })) as RegisterTargetResult;

  assert.equal(result.status, 'registered');
  if (result.status !== 'registered') return;
  assert.equal(result.workspace.id, primaryWorkspaceId);
  assert.equal(result.executionTarget.label, 'ci-runner-01');
  assert.ok(result.executionTarget.executionTargetId);
});

test('register-target is idempotent and renames the same machine target', async () => {
  const first = (await runProtocolSubcommand('register-target', {
    flags: { '--name': 'runner-a' }
  })) as RegisterTargetResult;
  const second = (await runProtocolSubcommand('register-target', {
    flags: { '--name': 'runner-b' }
  })) as RegisterTargetResult;

  assert.equal(first.status, 'registered');
  assert.equal(second.status, 'registered');
  if (first.status !== 'registered' || second.status !== 'registered') return;
  assert.equal(
    second.executionTarget.executionTargetId,
    first.executionTarget.executionTargetId
  );
  assert.equal(second.executionTarget.label, 'runner-b');
});

test('register-target asks the user to choose when the caller has multiple workspaces', async () => {
  const secondary = await createWorkspace({
    organizationId: DEFAULT_TEST_ORGANIZATION_ID,
    name: 'Second Register Workspace'
  });
  secondaryId = secondary.id;
  secondaryName = secondary.name;

  const result = (await runProtocolSubcommand('register-target', {
    flags: { '--name': 'ambiguous-runner' }
  })) as RegisterTargetResult;

  assert.equal(result.status, 'workspace_selection_required');
  if (result.status !== 'workspace_selection_required') return;
  const ids = result.workspaces.map(w => w.id).sort();
  assert.deepEqual(ids, [primaryWorkspaceId, secondaryId].sort());
});

test('register-target honors an explicit workspace id when memberships are ambiguous', async () => {
  const result = (await runProtocolSubcommand('register-target', {
    flags: { '--name': 'chosen-runner', '--workspace-id': secondaryId }
  })) as RegisterTargetResult;
  assert.equal(result.status, 'registered');
  if (result.status !== 'registered') return;
  assert.equal(result.workspace.id, secondaryId);
});

test('register-target resolves an explicit workspace by name', async () => {
  const result = (await runProtocolSubcommand('register-target', {
    flags: { '--name': 'named-runner', '--workspace-id': secondaryName }
  })) as RegisterTargetResult;
  assert.equal(result.status, 'registered');
  if (result.status !== 'registered') return;
  assert.equal(result.workspace.id, secondaryId);
});

test('register-target rejects a workspace the caller does not belong to', async () => {
  await assert.rejects(
    runProtocolSubcommand('register-target', {
      flags: { '--name': 'orphan-runner', '--workspace-id': 'not-a-real-workspace' }
    }),
    /Workspace not found or not a member/
  );
});
