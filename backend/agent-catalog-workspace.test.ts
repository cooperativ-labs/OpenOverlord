import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// coo:324: each workspace owns its own `settings_json.agentCatalog`, and the
// workspace-scoped catalog functions must authorize against the *target*
// workspace's membership — independent of which workspace the caller currently
// has active. Previously every catalog read/write silently targeted the active
// workspace, so the settings modal could only ever manage the first workspace.
describe('workspace-scoped agent catalog', () => {
  it('reads, edits, and refreshes a secondary workspace catalog while another workspace is active', async () => {
    const dir = mkdtempSync(path.join('/tmp', 'ovld-agent-catalog-ws-'));
    const { bootstrapIntegrationTestDb, seedAuthenticatedOperator, DEFAULT_TEST_ORGANIZATION_ID } =
      await import('./test-helpers.ts');
    const { db, WORKSPACE, setActiveWorkspaceUser, operatorWorkspaceUserId } =
      await bootstrapIntegrationTestDb({
        sqlitePath: path.join(dir, 'Overlord.sqlite')
      });
    // `WORKSPACE` is a live getter over the current active workspace — capture
    // the id as a plain string before `createWorkspace` re-points it.
    const workspaceAId = WORKSPACE.id;

    const { setActiveWorkspace } = await import('./db.ts');
    const { createWorkspace } = await import('./workspaces.ts');
    const { getAgentCatalog, updateAgentCatalog, refreshAgentCatalog } =
      await import('./execution/launch.ts');
    const { ApiError } = await import('./errors.ts');

    // A second workspace in the same org; the operator (org admin) is
    // auto-granted ADMIN there. `createWorkspace` activates the new workspace,
    // so switch back to A — everything below runs with A active while the
    // catalog being managed belongs to B.
    const secondary = await createWorkspace({
      organizationId: DEFAULT_TEST_ORGANIZATION_ID,
      name: 'Catalog Secondary'
    });
    assert.notEqual(secondary.id, workspaceAId);
    await setActiveWorkspace(workspaceAId);
    setActiveWorkspaceUser(operatorWorkspaceUserId);

    const storedCatalogOf = (workspaceId: string): unknown => {
      const row = db
        .prepare(`SELECT settings_json FROM workspaces WHERE id = ?`)
        .get(workspaceId) as { settings_json: string };
      return (JSON.parse(row.settings_json) as Record<string, unknown>).agentCatalog;
    };

    // Reading B's catalog seeds it into B's own settings_json, not A's.
    const secondaryCatalog = await getAgentCatalog(secondary.id);
    assert.ok(secondaryCatalog.agents.length > 0);
    assert.ok(storedCatalogOf(secondary.id), 'secondary workspace must hold its own catalog');

    // Editing B's catalog lands on B and leaves A's catalog untouched.
    const editedAgents = secondaryCatalog.agents.map((agent, index) =>
      index === 0 ? { ...agent, label: 'Secondary Only Label' } : agent
    );
    const updated = await updateAgentCatalog({ agents: editedAgents }, secondary.id);
    assert.equal(updated.agents[0]?.label, 'Secondary Only Label');
    assert.ok(JSON.stringify(storedCatalogOf(secondary.id)).includes('Secondary Only Label'));

    const activeCatalog = await getAgentCatalog();
    assert.ok(
      !JSON.stringify(storedCatalogOf(workspaceAId)).includes('Secondary Only Label'),
      "editing a secondary workspace's catalog must not write to the active workspace"
    );
    assert.ok(activeCatalog.agents.length > 0);

    // Refreshing B's catalog merges bundled defaults but keeps B's edits.
    const refreshed = await refreshAgentCatalog(secondary.id);
    assert.equal(refreshed.agents[0]?.label, 'Secondary Only Label');

    // A member of A with no membership in B gets a 404 (existence must not
    // leak), for reads and writes alike.
    seedAuthenticatedOperator({
      db,
      workspaceId: workspaceAId,
      profileId: 'catalog-outsider-user',
      workspaceUserId: 'catalog-outsider-workspace-user'
    });
    setActiveWorkspaceUser('catalog-outsider-workspace-user');
    await assert.rejects(
      getAgentCatalog(secondary.id),
      (err: unknown) => err instanceof ApiError && err.status === 404
    );
    await assert.rejects(
      updateAgentCatalog({ agents: editedAgents }, secondary.id),
      (err: unknown) => err instanceof ApiError && err.status === 404
    );
    await assert.rejects(
      refreshAgentCatalog(secondary.id),
      (err: unknown) => err instanceof ApiError && err.status === 404
    );
    setActiveWorkspaceUser(operatorWorkspaceUserId);
  });
});
