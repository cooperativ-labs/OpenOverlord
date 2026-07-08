import { createServiceContext } from './context.js';
import { createMissionWithObjectives } from './missions.js';
import { addProjectResource, createProject } from './projects.js';
import { attachSession, loadMissionContext } from './protocol.js';
import { buildProjectResourceManifestEntries } from './project-resource-manifest.js';
import { createSqliteClient, openInMemoryDatabase } from '@overlord/database';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('protocol context manifest', () => {
  it('buildProjectResourceManifestEntries marks current resource and omits instructions for single repo', () => {
    const entries = buildProjectResourceManifestEntries({
      resources: [
        {
          id: 'res-1',
          resourceKey: 'backend',
          label: 'Backend',
          path: '/tmp/backend',
          isPrimary: true,
          status: 'active',
          executionTargetId: 'target-1'
        }
      ],
      executionTargetId: 'target-1',
      currentResourceKey: 'backend',
      observationStatesByResourceId: new Map([['res-1', 'available']])
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.isCurrent, true);
    assert.equal(entries[0]?.path, '/tmp/backend');
    assert.equal(entries[0]?.state, 'available');
  });

  it('loadMissionContext includes projectResources and instructions for multi-resource projects', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'protocol' });
    const project = await createProject({ ctx, name: 'Multi Repo Project' });
    const backendDir = mkdtempSync(path.join(tmpdir(), 'ovld-backend-'));
    const mobileDir = mkdtempSync(path.join(tmpdir(), 'ovld-mobile-'));

    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: backendDir,
      resourceKey: 'backend',
      isPrimary: true
    });
    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: mobileDir,
      resourceKey: 'mobile',
      isPrimary: false
    });

    const { mission, objectives } = createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Cross-repo work', resourceKey: 'backend' }]
    });
    await db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);

    const context = await loadMissionContext({ ctx, missionId: mission.id });
    assert.ok(context.projectResources);
    assert.equal(context.projectResources.length, 2);
    assert.match(context.agentInstructions, /## Project Resources/);
    assert.match(context.agentInstructions, /`backend`/);
    assert.match(context.agentInstructions, /`mobile`/);
  });

  it('attachSession omits project resources instructions for single-resource projects', async () => {
    const db = createSqliteClient(openInMemoryDatabase());
    const ctx = await createServiceContext({ db, source: 'protocol' });
    const project = await createProject({ ctx, name: 'Single Repo Project' });
    await addProjectResource({
      ctx,
      projectId: project.id,
      directoryPath: process.cwd(),
      isPrimary: true
    });

    const { mission, objectives } = createMissionWithObjectives({
      ctx,
      projectId: project.id,
      objectives: [{ objective: 'Single repo work' }]
    });
    await db.run(`UPDATE objectives SET state = 'submitted' WHERE id = ?`, [objectives[0]?.id]);

    const attached = await attachSession({ ctx, missionId: mission.id, agentIdentifier: 'test-agent' });
    assert.doesNotMatch(attached.agentInstructions, /## Project Resources/);
    assert.equal(attached.projectResources?.length, 1);
  });
});
